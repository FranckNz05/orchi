import type { Channel } from '../catalog/coverage.js';
import { ProviderError } from './errors.js';
import { providerHost } from './hosts.js';
import { parseJson, providerFetch } from './http.js';
import type {
  AttemptResult,
  AttemptStatus,
  ChargeRequest,
  Direction,
  PaymentProvider,
  PayoutRequest,
  ProviderContext,
  WebhookInput,
  WebhookVerdict,
} from './types.js';

/**
 * Adaptateur CinetPay (UEMOA + CEMAC).
 *
 * ┌─ CONTRAT API ────────────────────────────────────────────────────────────┐
 * │ Ecrit d'apres la documentation publique (docs.cinetpay.com), consultee le │
 * │ 29/08/2026. AUCUN appel n'a ete verifie contre un compte sandbox reel.    │
 * │                                                                          │
 * │ CONFIRME par la documentation :                                          │
 * │   - POST https://api-checkout.cinetpay.com/v2/payment, corps JSON avec    │
 * │     apikey, site_id, transaction_id, amount, currency, notify_url,        │
 * │     channels, et les champs customer_*                                    │
 * │   - reponse contenant code, message, data.payment_token, data.payment_url │
 * │   - POST /v2/payment/check pour connaitre l'etat d'une transaction        │
 * │   - la notification (notify_url) arrive en POST avec cpm_trans_id         │
 * │   - API de transfert sur un autre hote : login (jeton valable 5 min),     │
 * │     puis envoi ; le beneficiaire doit exister comme contact               │
 * │                                                                          │
 * │ A CONFIRMER en sandbox avant toute mise en production :                   │
 * │   - liste exhaustive des codes retour et des statuts de data.status       │
 * │   - chemins exacts de l'API de transfert et forme de la reponse           │
 * │   - montants : CinetPay impose des multiples de 5 en zone franc CFA       │
 * └──────────────────────────────────────────────────────────────────────────┘
 *
 * DECISION DE CONCEPTION — la notification n'est pas une source de verite.
 * CinetPay ne signe pas sa notification d'une maniere que nous puissions
 * verifier de facon fiable et documentee. Plutot que d'inventer un schema de
 * signature, `verifyWebhook` traite la notification comme un simple SIGNAL :
 * elle renvoie le statut `pending`, ce qui declenche une interrogation de
 * /v2/payment/check. L'etat vient donc toujours d'un appel sortant authentifie,
 * jamais d'un corps HTTP entrant. C'est d'ailleurs ce que recommande CinetPay.
 */

export const CINETPAY_PROVIDER_ID = 'cinetpay';

const checkoutHost = () => providerHost('CINETPAY_CHECKOUT_URL', 'https://api-checkout.cinetpay.com/v2');
const transferHost = () => providerHost('CINETPAY_TRANSFER_URL', 'https://client.cinetpay.com/v1');

/** Pays desservis par CinetPay, d'apres son offre publique. */
const COUNTRIES = new Set(['CI', 'BJ', 'TG', 'ML', 'BF', 'NE', 'SN', 'GW', 'GN', 'CM', 'CD']);

/** Code retour d'une initialisation acceptee. */
const INIT_OK = '201';
/** Code retour d'une verification aboutie. */
const CHECK_OK = '00';

/* -------------------------------------------------------------------------- */
/* Statuts                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Un statut inconnu devient `unknown`, jamais `failed` : declarer un echec a
 * tort autoriserait une relance sur une transaction peut-etre aboutie.
 */
function mapStatus(status: string, direction: Direction): AttemptStatus {
  switch (status.toUpperCase()) {
    case 'ACCEPTED':
    case 'SUCCES':
    case 'SUCCESS':
      return 'succeeded';
    case 'REFUSED':
    case 'FAILED':
    case 'CANCELED':
    case 'INSUFFICIENT_BALANCE':
      return 'failed';
    case 'EXPIRED':
      return 'expired';
    case 'WAITING_FOR_CUSTOMER':
    case 'PENDING':
    case 'CREATED':
    case 'INITIATED':
      return direction === 'payin' ? 'awaiting_customer' : 'pending';
    default:
      return 'unknown';
  }
}

/* -------------------------------------------------------------------------- */
/* Utilitaires                                                                */
/* -------------------------------------------------------------------------- */

interface Credentials {
  apikey: string;
  site_id: string;
  /** Requis uniquement pour l'API de transfert (decaissement). */
  transfer_login?: string;
  transfer_password?: string;
}

function credentials(ctx: ProviderContext): Credentials {
  const apikey = ctx.credentials.apikey;
  const siteId = ctx.credentials.site_id;
  if (!apikey || !siteId) {
    throw new ProviderError({
      providerId: CINETPAY_PROVIDER_ID,
      code: 'authentication',
      message: 'Credentials apikey et site_id requis.',
    });
  }
  return {
    apikey,
    site_id: siteId,
    ...(ctx.credentials.transfer_login ? { transfer_login: ctx.credentials.transfer_login } : {}),
    ...(ctx.credentials.transfer_password
      ? { transfer_password: ctx.credentials.transfer_password }
      : {}),
  };
}

interface CheckoutResponse {
  code?: string | number;
  message?: string;
  description?: string;
  data?: {
    payment_token?: string;
    payment_url?: string;
    status?: string;
    amount?: number;
    fund_availability_date?: string;
    payment_method?: string;
    operator_id?: string;
    [key: string]: unknown;
  };
  api_response_id?: string;
}

function assertCode(body: CheckoutResponse, expected: string, step: string): void {
  const code = String(body.code ?? '');
  if (code === expected) return;

  // Les codes 6xx de CinetPay signalent une requete refusee, pas une panne :
  // les classer en `invalid_request` evite un failover inutile vers un autre
  // agregateur qui refuserait pour la meme raison.
  const isClientError = code.startsWith('6') || code.startsWith('4');
  throw new ProviderError({
    providerId: CINETPAY_PROVIDER_ID,
    code: isClientError ? 'invalid_request' : 'unavailable',
    message: `${step} refuse par CinetPay (${code}) : ${body.message ?? body.description ?? '—'}`,
    providerCode: code,
  });
}

/* -------------------------------------------------------------------------- */
/* Jeton de transfert                                                         */
/* -------------------------------------------------------------------------- */

interface CachedToken {
  token: string;
  expiresAt: number;
}

/**
 * Le jeton de l'API de transfert ne vit que 5 minutes. On le met en cache par
 * marchand, avec une marge de securite : redemander un jeton a chaque
 * decaissement doublerait la latence et le risque d'echec.
 */
const tokenCache = new Map<string, CachedToken>();
const TOKEN_MARGIN_MS = 30 * 1000;

export function resetTransferTokens(): void {
  tokenCache.clear();
}

async function transferToken(ctx: ProviderContext): Promise<string> {
  const creds = credentials(ctx);
  if (!creds.transfer_login || !creds.transfer_password) {
    throw new ProviderError({
      providerId: CINETPAY_PROVIDER_ID,
      code: 'authentication',
      message:
        "Credentials transfer_login et transfer_password requis pour les decaissements CinetPay.",
    });
  }

  const cacheKey = `${ctx.merchantId}:${creds.site_id}`;
  const cached = tokenCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.token;

  const response = await providerFetch({
    providerId: CINETPAY_PROVIDER_ID,
    method: 'POST',
    url: `${transferHost()}/auth/login`,
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    mutating: false,
    ...(ctx.timeoutMs !== undefined ? { timeoutMs: ctx.timeoutMs } : {}),
    body: new URLSearchParams({
      apikey: creds.apikey,
      password: creds.transfer_password,
    }).toString(),
  });

  const body = parseJson<{ code?: number | string; data?: { token?: string } }>(
    CINETPAY_PROVIDER_ID,
    response.body,
  );
  const token = body.data?.token;
  if (!token) {
    throw new ProviderError({
      providerId: CINETPAY_PROVIDER_ID,
      code: 'authentication',
      message: 'Jeton de transfert CinetPay non obtenu.',
      providerCode: String(body.code ?? ''),
    });
  }

  tokenCache.set(cacheKey, { token, expiresAt: Date.now() + 5 * 60 * 1000 - TOKEN_MARGIN_MS });
  return token;
}

/** CinetPay separe l'indicatif du numero sur l'API de transfert. */
function splitPhone(phone: string, country: string): { prefix: string; phone: string } {
  const digits = phone.replace(/\D/g, '');
  const PREFIXES: Record<string, string> = {
    CI: '225', BJ: '229', TG: '228', ML: '223', BF: '226',
    NE: '227', SN: '221', GW: '245', GN: '224', CM: '237', CD: '243',
  };
  const prefix = PREFIXES[country.toUpperCase()] ?? '';
  const local = prefix && digits.startsWith(prefix) ? digits.slice(prefix.length) : digits;
  return { prefix, phone: local };
}

/* -------------------------------------------------------------------------- */
/* Adaptateur                                                                 */
/* -------------------------------------------------------------------------- */

export const cinetpayProvider: PaymentProvider = {
  id: CINETPAY_PROVIDER_ID,
  name: 'CinetPay',
  requiredCredentials: ['apikey', 'site_id'],

  supports(country: string, channel: Channel, _direction: Direction): boolean {
    return COUNTRIES.has(country.toUpperCase()) && channel !== 'bank_transfer';
  },

  async createCharge(request: ChargeRequest, ctx: ProviderContext): Promise<AttemptResult> {
    const creds = credentials(ctx);

    // CinetPay refuse les montants qui ne sont pas multiples de 5 en zone franc.
    if ((request.currency === 'XOF' || request.currency === 'XAF') && request.amount % 5 !== 0) {
      throw new ProviderError({
        providerId: CINETPAY_PROVIDER_ID,
        code: 'invalid_request',
        message: `CinetPay exige un montant multiple de 5 en ${request.currency} (recu ${request.amount}).`,
      });
    }

    const response = await providerFetch({
      providerId: CINETPAY_PROVIDER_ID,
      method: 'POST',
      url: `${checkoutHost()}/payment`,
      mutating: true,
      ...(ctx.timeoutMs !== undefined ? { timeoutMs: ctx.timeoutMs } : {}),
      body: JSON.stringify({
        apikey: creds.apikey,
        site_id: creds.site_id,
        // Notre reference de tentative devient l'identifiant CinetPay : c'est
        // ce qui rend l'appel idempotent de leur cote.
        transaction_id: request.reference,
        amount: request.amount,
        currency: request.currency,
        description: request.description ?? `Paiement ${request.reference}`,
        notify_url: request.callbackUrl,
        ...(request.returnUrl ? { return_url: request.returnUrl } : {}),
        channels: request.channel === 'card' ? 'CREDIT_CARD' : 'MOBILE_MONEY',
        ...(request.customer.name ? { customer_name: request.customer.name } : {}),
        ...(request.customer.email ? { customer_email: request.customer.email } : {}),
        ...(request.customer.phone ? { customer_phone_number: request.customer.phone } : {}),
        metadata: request.reference,
      }),
    });

    const body = parseJson<CheckoutResponse>(CINETPAY_PROVIDER_ID, response.body);
    assertCode(body, INIT_OK, 'Initialisation');

    const paymentUrl = body.data?.payment_url;
    const token = body.data?.payment_token;
    if (!paymentUrl || !token) {
      throw new ProviderError({
        providerId: CINETPAY_PROVIDER_ID,
        code: 'malformed_response',
        message: 'payment_url ou payment_token absent de la reponse CinetPay.',
      });
    }

    return {
      // La reference d'interrogation est NOTRE transaction_id : c'est le seul
      // identifiant que /v2/payment/check accepte a coup sur.
      providerReference: request.reference,
      status: 'awaiting_customer',
      // Guichet hebergé : meme en mobile money, le client passe par la page
      // CinetPay qui choisit l'operateur. Il n'y a pas de push direct.
      action: { type: 'redirect', url: paymentUrl },
      providerCode: String(body.code ?? ''),
      raw: body,
    };
  },

  async getCharge(providerReference: string, ctx: ProviderContext): Promise<AttemptResult> {
    const creds = credentials(ctx);

    const response = await providerFetch({
      providerId: CINETPAY_PROVIDER_ID,
      method: 'POST',
      url: `${checkoutHost()}/payment/check`,
      mutating: false,
      ...(ctx.timeoutMs !== undefined ? { timeoutMs: ctx.timeoutMs } : {}),
      body: JSON.stringify({
        apikey: creds.apikey,
        site_id: creds.site_id,
        transaction_id: providerReference,
      }),
    });

    const body = parseJson<CheckoutResponse>(CINETPAY_PROVIDER_ID, response.body);
    const code = String(body.code ?? '');

    // 662 : transaction encore en attente cote CinetPay. Ce n'est pas une
    // erreur, c'est une reponse.
    if (code !== CHECK_OK && code !== '662') {
      assertCode(body, CHECK_OK, 'Verification');
    }

    const status =
      code === '662'
        ? 'awaiting_customer'
        : mapStatus(String(body.data?.status ?? ''), 'payin');

    return {
      providerReference,
      status,
      action: { type: 'none' },
      providerCode: code,
      ...(body.message ? { providerMessage: body.message } : {}),
      raw: body,
    };
  },

  async createPayout(request: PayoutRequest, ctx: ProviderContext): Promise<AttemptResult> {
    const creds = credentials(ctx);
    const token = await transferToken(ctx);

    if (!request.recipient.phone) {
      throw new ProviderError({
        providerId: CINETPAY_PROVIDER_ID,
        code: 'invalid_request',
        message: 'Numero de telephone requis pour un decaissement CinetPay.',
      });
    }

    const { prefix, phone } = splitPhone(request.recipient.phone, request.country);

    const response = await providerFetch({
      providerId: CINETPAY_PROVIDER_ID,
      method: 'POST',
      url: `${transferHost()}/transfer/money/send/contact?token=${encodeURIComponent(token)}&lang=fr`,
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      mutating: true,
      ...(ctx.timeoutMs !== undefined ? { timeoutMs: ctx.timeoutMs } : {}),
      body: new URLSearchParams({
        data: JSON.stringify([
          {
            prefix,
            phone,
            amount: request.amount,
            client_transaction_id: request.reference,
            notify_url: request.callbackUrl,
          },
        ]),
      }).toString(),
    });

    const body = parseJson<{
      code?: number | string;
      message?: string;
      data?: Array<{
        transaction_id?: string;
        client_transaction_id?: string;
        sending_status?: string;
        treatment_status?: string;
      }>;
    }>(CINETPAY_PROVIDER_ID, response.body);

    const entry = body.data?.[0];
    if (!entry) {
      // Reponse sans detail sur une requete mutante : etat inconnu, pas echec.
      throw new ProviderError({
        providerId: CINETPAY_PROVIDER_ID,
        code: 'malformed_response',
        message: `Reponse de transfert CinetPay sans detail (code ${String(body.code ?? '')}).`,
      });
    }

    return {
      providerReference: entry.transaction_id ?? request.reference,
      status: mapStatus(entry.treatment_status ?? entry.sending_status ?? '', 'payout'),
      action: { type: 'none' },
      providerCode: String(body.code ?? ''),
      ...(body.message ? { providerMessage: body.message } : {}),
      raw: body,
    };
  },

  async getPayout(providerReference: string, ctx: ProviderContext): Promise<AttemptResult> {
    const token = await transferToken(ctx);

    const response = await providerFetch({
      providerId: CINETPAY_PROVIDER_ID,
      method: 'GET',
      url:
        `${transferHost()}/transfer/check/money?token=${encodeURIComponent(token)}` +
        `&client_transaction_id=${encodeURIComponent(providerReference)}&lang=fr`,
      mutating: false,
      ...(ctx.timeoutMs !== undefined ? { timeoutMs: ctx.timeoutMs } : {}),
    });

    const body = parseJson<{
      code?: number | string;
      message?: string;
      data?: Array<{ treatment_status?: string; transaction_id?: string }>;
    }>(CINETPAY_PROVIDER_ID, response.body);

    const entry = body.data?.[0];

    return {
      providerReference,
      status: mapStatus(entry?.treatment_status ?? '', 'payout'),
      action: { type: 'none' },
      providerCode: String(body.code ?? ''),
      ...(body.message ? { providerMessage: body.message } : {}),
      raw: body,
    };
  },

  /**
   * La notification CinetPay est un SIGNAL, pas une source de verite.
   *
   * Elle n'est pas signee d'une maniere que nous puissions verifier de facon
   * documentee. On en extrait donc seulement l'identifiant de transaction, et
   * on renvoie `pending` : l'orchestrateur ira interroger /v2/payment/check,
   * appel sortant authentifie dont la reponse, elle, fait foi.
   *
   * Consequence : un attaquant qui forgerait une notification ne pourrait
   * jamais faire passer un paiement en SUCCEEDED — au pire, il declencherait
   * une verification inutile.
   */
  verifyWebhook(input: WebhookInput, _ctx: ProviderContext): WebhookVerdict {
    let transactionId: string | undefined;

    try {
      const parsed = JSON.parse(input.rawBody) as { cpm_trans_id?: unknown };
      if (typeof parsed.cpm_trans_id === 'string') transactionId = parsed.cpm_trans_id;
    } catch {
      // La notification arrive aussi en formulaire encode.
      const params = new URLSearchParams(input.rawBody);
      transactionId = params.get('cpm_trans_id') ?? undefined;
    }

    if (!transactionId) return { valid: false, reason: 'cpm_trans_id absent.' };

    return {
      valid: true,
      // Pas d'identifiant d'evenement chez CinetPay : on deduplique sur la
      // transaction, ce qui est suffisant puisque la notification ne porte
      // aucune information d'etat.
      eventId: `cinetpay:${transactionId}`,
      kind: 'payin',
      providerReference: transactionId,
      // Volontairement `pending` : seule /v2/payment/check fait foi.
      status: 'pending',
      raw: { cpm_trans_id: transactionId, note: 'signal uniquement, etat a verifier' },
    };
  },
};
