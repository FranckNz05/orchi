import { createHmac, timingSafeEqual } from 'node:crypto';
import type { Channel } from '../catalog/coverage.js';
import { ProviderError } from './errors.js';
import { providerHost } from './hosts.js';
import { parseJson, providerFetch } from './http.js';
import type {
  AttemptResult,
  AttemptStatus,
  ChargeRequest,
  CustomerAction,
  Direction,
  PaymentProvider,
  PayoutRequest,
  ProviderContext,
  WebhookInput,
  WebhookVerdict,
} from './types.js';

/**
 * Adaptateur GeniusPay.
 *
 * ┌─ CONTRAT API ────────────────────────────────────────────────────────────┐
 * │ Ecrit d'apres la documentation publique (geniuspay.ci/docs/api),          │
 * │ consultee le 29/08/2026. AUCUN appel n'a ete verifie contre un compte     │
 * │ sandbox reel.                                                            │
 * │                                                                          │
 * │ CONFIRME par la documentation :                                          │
 * │   - base https://geniuspay.ci/api/v1/merchant                            │
 * │   - authentification par DEUX en-tetes : X-API-Key + X-API-Secret        │
 * │   - POST /payments ; omettre `payment_method` renvoie une `checkout_url` │
 * │   - GET /payments/{reference}, reference au format MTX-XXXXXXXXXX        │
 * │   - statuts : pending, processing, completed, failed, cancelled,         │
 * │     refunded, expired                                                    │
 * │   - `fees` et `net_amount` presents dans les reponses                    │
 * │   - webhooks signes HMAC-SHA256 sur `timestamp + "." + payload`          │
 * │   - montant minimum 200 XOF                                              │
 * │                                                                          │
 * │ NON DOCUMENTE PUBLIQUEMENT :                                             │
 * │   - l'API de DECAISSEMENT. Les evenements `cashout.*` existent, mais     │
 * │     aucun endpoint de creation n'est publie. `supports()` renvoie donc   │
 * │     false pour les payouts : mieux vaut ne pas router que deviner une    │
 * │     route qui deplace de l'argent.                                       │
 * └──────────────────────────────────────────────────────────────────────────┘
 */

export const GENIUSPAY_PROVIDER_ID = 'geniuspay';

const DEFAULT_HOST = 'https://geniuspay.ci/api/v1/merchant';

/** Montant minimal impose par GeniusPay, en XOF. */
const MIN_AMOUNT_XOF = 200;

/**
 * Pays desservis, d'apres la couverture regionale publiee.
 *
 * La documentation annonce « 23 pays » en tete de page mais n'en detaille que
 * 21 dans ses tableaux. On encode ce qui est ENUMERE : promettre deux pays de
 * plus que ceux qu'on sait nommer se paierait au premier paiement refuse.
 */
const COUNTRIES: Readonly<Record<string, { currency: string; networks: string[] }>> = {
  // UEMOA
  CI: { currency: 'XOF', networks: ['WAVE_CI', 'ORANGE_CI', 'MTN_CI', 'MOOV_CI'] },
  SN: { currency: 'XOF', networks: ['ORANGE_SN', 'FREE_SN', 'WAVE_SN'] },
  ML: { currency: 'XOF', networks: ['ORANGE_ML'] },
  BF: { currency: 'XOF', networks: ['ORANGE_BF', 'MOOV_BF'] },
  BJ: { currency: 'XOF', networks: ['MTN_BENIN', 'MOOV_BENIN'] },
  TG: { currency: 'XOF', networks: ['MOOV_TOGO'] },
  NE: { currency: 'XOF', networks: ['ORANGE_NE'] },
  GW: { currency: 'XOF', networks: ['ORANGE_GW'] },
  // Afrique de l'Ouest hors UEMOA
  GH: { currency: 'GHS', networks: ['MTN_GH', 'AIRTELTIGO_GH'] },
  NG: { currency: 'NGN', networks: ['NIBSS'] },
  SL: { currency: 'SLE', networks: ['ORANGE_SL'] },
  // Afrique centrale
  CM: { currency: 'XAF', networks: ['MTN_CM', 'ORANGE_CM'] },
  GA: { currency: 'XAF', networks: ['AIRTEL_GA'] },
  CG: { currency: 'XAF', networks: ['AIRTEL_CG', 'MTN_CG'] },
  CF: { currency: 'XAF', networks: ['ORANGE_CF'] },
  CD: { currency: 'CDF', networks: ['AIRTEL_CD', 'ORANGE_CD', 'MPESA_CD'] },
  // Afrique de l'Est
  KE: { currency: 'KES', networks: ['MPESA_KE', 'AIRTEL_KE'] },
  RW: { currency: 'RWF', networks: ['MTN_RW', 'AIRTEL_RW'] },
  UG: { currency: 'UGX', networks: ['MTN_UG', 'AIRTEL_UG'] },
  // Afrique australe
  ZM: { currency: 'ZMW', networks: ['MTN_ZM', 'ZAMTEL'] },
  ZA: { currency: 'ZAR', networks: ['EFT_ZA'] },
};

export const GENIUSPAY_COUNTRIES = Object.keys(COUNTRIES);

/**
 * Reseau Orchi -> code operateur PawaPay.
 *
 * Point de correction n°1 : tout est ici. Un reseau absent de cette table
 * n'echoue pas — on laisse GeniusPay router lui-meme depuis le numero, ce que
 * sa documentation presente comme le mode recommande.
 */
const MMO_BY_NETWORK: Readonly<Record<string, string>> = {
  ORANGE_SN: 'ORANGE_SEN',
  FREE_SN: 'FREE_SEN',
  ORANGE_CI: 'ORANGE_CIV',
  MTN_CI: 'MTN_MOMO_CIV',
  MOOV_CI: 'MOOV_CIV',
  WAVE_CI: 'WAVE_CIV',
  MTN_BENIN: 'MTN_MOMO_BEN',
  MOOV_BENIN: 'MOOV_BEN',
  MTN_CM: 'MTN_MOMO_CMR',
  ORANGE_CM: 'ORANGE_CMR',
  AIRTEL_CD: 'AIRTEL_COD',
  ORANGE_CD: 'ORANGE_COD',
  MPESA_CD: 'VODACOM_MPESA_COD',
  AIRTEL_GA: 'AIRTEL_GAB',
  MPESA_KE: 'MPESA_KEN',
  AIRTEL_CG: 'AIRTEL_COG',
  MTN_CG: 'MTN_MOMO_COG',
  AIRTEL_RW: 'AIRTEL_RWA',
  MTN_RW: 'MTN_MOMO_RWA',
  ORANGE_SL: 'ORANGE_SLE',
  AIRTEL_UG: 'AIRTEL_UGA',
  MTN_UG: 'MTN_MOMO_UGA',
  MTN_ZM: 'MTN_MOMO_ZMB',
  ZAMTEL: 'ZAMTEL_ZMB',
};

/** Reseau Orchi -> `payment_method` GeniusPay, quand un gateway direct existe. */
const METHOD_BY_NETWORK: Readonly<Record<string, string>> = {
  WAVE_CI: 'wave',
  WAVE_SN: 'wave',
  ORANGE_SN: 'orange_money',
  ORANGE_CI: 'orange_money',
  ORANGE_ML: 'orange_money',
  ORANGE_BF: 'orange_money',
  ORANGE_CM: 'orange_money',
  ORANGE_CD: 'orange_money',
  ORANGE_CG: 'orange_money',
  ORANGE_SL: 'orange_money',
  MTN_CI: 'mtn_money',
  MTN_CM: 'mtn_money',
  MTN_CG: 'mtn_money',
  MTN_RW: 'mtn_money',
  MTN_UG: 'mtn_money',
  MTN_ZM: 'mtn_money',
  MOOV_CI: 'moov_money',
  MOOV_TOGO: 'moov_money',
  MOOV_BF: 'moov_money',
  AIRTEL_CD: 'airtel_money',
  AIRTEL_CG: 'airtel_money',
  AIRTEL_KE: 'airtel_money',
  AIRTEL_RW: 'airtel_money',
  AIRTEL_UG: 'airtel_money',
};

/* -------------------------------------------------------------------------- */
/* Statuts                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Un statut inconnu devient `unknown`, jamais `failed` : GeniusPay peut en
 * introduire un nouveau, et declarer un echec a tort autoriserait une relance
 * sur une transaction peut-etre aboutie.
 */
function mapStatus(status: string): AttemptStatus {
  switch (status.toLowerCase()) {
    case 'pending':
      return 'awaiting_customer';
    case 'processing':
      return 'pending';
    case 'completed':
      return 'succeeded';
    case 'failed':
    case 'cancelled':
    case 'canceled':
    case 'refunded':
      return 'failed';
    case 'expired':
      return 'expired';
    default:
      return 'unknown';
  }
}

/* -------------------------------------------------------------------------- */
/* Utilitaires                                                                */
/* -------------------------------------------------------------------------- */

interface GeniusPayEnvelope<T> {
  success?: boolean;
  data?: T;
  error?: { code?: string; message?: string };
}

interface GeniusPayPayment {
  id?: number | string;
  reference?: string;
  amount?: number;
  currency?: string;
  fees?: number;
  net_amount?: number;
  status?: string;
  payment_url?: string;
  checkout_url?: string;
  gateway?: string;
  payment_method?: string;
  environment?: string;
  expires_at?: string;
  metadata?: Record<string, unknown>;
}

function baseUrl(): string {
  return providerHost('GENIUSPAY_BASE_URL', DEFAULT_HOST);
}

function headers(ctx: ProviderContext): Record<string, string> {
  const key = ctx.credentials.api_key;
  const secret = ctx.credentials.api_secret;
  if (!key || !secret) {
    throw new ProviderError({
      providerId: GENIUSPAY_PROVIDER_ID,
      code: 'authentication',
      message: 'Credentials api_key et api_secret requis.',
    });
  }
  // GeniusPay authentifie par DEUX en-tetes, pas par un jeton porteur : la cle
  // publique identifie, la cle secrete prouve.
  return { 'X-API-Key': key, 'X-API-Secret': secret };
}

function unwrap(body: string): GeniusPayPayment {
  const parsed = parseJson<GeniusPayEnvelope<GeniusPayPayment>>(GENIUSPAY_PROVIDER_ID, body);

  if (parsed.success === false || parsed.error) {
    const code = parsed.error?.code ?? '';
    // Leurs codes distinguent nettement ce qui vient de nous de ce qui vient
    // d'eux : les confondre declencherait des bascules inutiles vers un autre
    // agregateur, qui refuserait pour la meme raison.
    const mapped =
      code === 'MISSING_API_KEY' || code === 'INVALID_API_KEY' || code === 'MERCHANT_INACTIVE'
        ? 'authentication'
        : code === 'VALIDATION_ERROR' ||
            code === 'COUNTRY_NOT_SUPPORTED' ||
            code === 'TRANSACTION_NOT_FOUND'
          ? 'invalid_request'
          : 'unavailable';

    throw new ProviderError({
      providerId: GENIUSPAY_PROVIDER_ID,
      code: mapped,
      message: parsed.error?.message ?? 'Requete refusee par GeniusPay.',
      providerCode: code,
    });
  }

  if (!parsed.data) {
    throw new ProviderError({
      providerId: GENIUSPAY_PROVIDER_ID,
      code: 'malformed_response',
      message: 'Reponse GeniusPay sans champ `data`.',
    });
  }
  return parsed.data;
}

function toResult(payment: GeniusPayPayment, fallbackAction: CustomerAction): AttemptResult {
  const reference = payment.reference;
  if (!reference) {
    throw new ProviderError({
      providerId: GENIUSPAY_PROVIDER_ID,
      code: 'malformed_response',
      message: 'Paiement GeniusPay sans reference.',
    });
  }

  const status = mapStatus(String(payment.status ?? ''));

  return {
    providerReference: reference,
    status,
    action: status === 'awaiting_customer' ? fallbackAction : { type: 'none' },
    // `fees` est la commission REELLE de GeniusPay : elle prime sur toute
    // estimation catalogue dans le calcul de la part Orchi.
    ...(typeof payment.fees === 'number' ? { providerFeeAmount: Math.round(payment.fees) } : {}),
    ...(payment.status ? { providerCode: String(payment.status) } : {}),
    ...(payment.gateway ? { providerMessage: `gateway: ${payment.gateway}` } : {}),
    raw: payment,
  };
}

/* -------------------------------------------------------------------------- */
/* Adaptateur                                                                 */
/* -------------------------------------------------------------------------- */

export const geniuspayProvider: PaymentProvider = {
  id: GENIUSPAY_PROVIDER_ID,
  name: 'GeniusPay',
  requiredCredentials: ['api_key', 'api_secret', 'webhook_secret'],

  supports(country: string, channel: Channel, direction: Direction): boolean {
    // Le decaissement n'est pas documente publiquement : on ne route pas de
    // l'argent sortant vers un endpoint suppose.
    if (direction === 'payout') return false;
    if (channel === 'bank_transfer') return false;
    return COUNTRIES[country.toUpperCase()] !== undefined;
  },

  async createCharge(request: ChargeRequest, ctx: ProviderContext): Promise<AttemptResult> {
    const country = COUNTRIES[request.country.toUpperCase()];
    if (!country) {
      throw new ProviderError({
        providerId: GENIUSPAY_PROVIDER_ID,
        code: 'invalid_request',
        message: `Pays non desservi par GeniusPay : ${request.country}.`,
      });
    }

    // Verifie AVANT l'appel : creer une transaction vouee au refus laisserait
    // une trace a reconcilier pour rien.
    if ((request.currency === 'XOF' || request.currency === 'XAF') && request.amount < MIN_AMOUNT_XOF) {
      throw new ProviderError({
        providerId: GENIUSPAY_PROVIDER_ID,
        code: 'invalid_request',
        message: `GeniusPay impose un montant minimum de ${MIN_AMOUNT_XOF} ${request.currency}.`,
      });
    }

    const network = request.network?.toUpperCase();
    const method = request.channel === 'card' ? 'card' : network ? METHOD_BY_NETWORK[network] : undefined;
    const mmo = network ? MMO_BY_NETWORK[network] : undefined;

    const response = await providerFetch({
      providerId: GENIUSPAY_PROVIDER_ID,
      method: 'POST',
      url: `${baseUrl()}/payments`,
      headers: headers(ctx),
      mutating: true,
      ...(ctx.timeoutMs !== undefined ? { timeoutMs: ctx.timeoutMs } : {}),
      body: JSON.stringify({
        amount: request.amount,
        currency: request.currency,
        // Sans `payment_method`, GeniusPay renvoie sa propre page de checkout.
        // On ne la demande que si aucun reseau n'a ete choisi en amont : quand
        // le client a deja choisi son operateur sur NOTRE page, le renvoyer sur
        // une seconde page de choix serait une friction gratuite.
        ...(method ? { payment_method: method } : {}),
        ...(mmo ? { mmo_provider: mmo } : {}),
        ...(request.description ? { description: request.description.slice(0, 500) } : {}),
        customer: {
          ...(request.customer.name ? { name: request.customer.name } : {}),
          ...(request.customer.email ? { email: request.customer.email } : {}),
          ...(request.customer.phone ? { phone: request.customer.phone } : {}),
          country: request.country.toUpperCase(),
        },
        ...(request.returnUrl ? { success_url: request.returnUrl, error_url: request.returnUrl } : {}),
        // Notre reference voyage avec la transaction : c'est ce qui permet de
        // rapprocher un settlement GeniusPay de nos propres ecritures.
        metadata: { orchi_reference: request.reference, ...request.metadata },
      }),
    });

    const payment = unwrap(response.body);
    const url = payment.payment_url ?? payment.checkout_url;

    if (!url) {
      throw new ProviderError({
        providerId: GENIUSPAY_PROVIDER_ID,
        code: 'malformed_response',
        message: 'Ni payment_url ni checkout_url dans la reponse GeniusPay.',
      });
    }

    return toResult(payment, {
      type: 'redirect',
      url,
      ...(payment.expires_at ? { expiresAt: payment.expires_at } : {}),
    });
  },

  async getCharge(providerReference: string, ctx: ProviderContext): Promise<AttemptResult> {
    const response = await providerFetch({
      providerId: GENIUSPAY_PROVIDER_ID,
      method: 'GET',
      url: `${baseUrl()}/payments/${encodeURIComponent(providerReference)}`,
      headers: headers(ctx),
      mutating: false,
      ...(ctx.timeoutMs !== undefined ? { timeoutMs: ctx.timeoutMs } : {}),
    });

    return toResult(unwrap(response.body), { type: 'none' });
  },

  async createPayout(_request: PayoutRequest, _ctx: ProviderContext): Promise<AttemptResult> {
    // Refus explicite plutot qu'un appel devine : deplacer de l'argent vers un
    // endpoint non documente est le genre d'erreur qui ne se rattrape pas.
    throw new ProviderError({
      providerId: GENIUSPAY_PROVIDER_ID,
      code: 'invalid_request',
      message:
        "L'API de decaissement GeniusPay n'est pas documentee publiquement. " +
        'Aucun decaissement ne sera route vers cet agregateur.',
    });
  },

  async getPayout(_providerReference: string, _ctx: ProviderContext): Promise<AttemptResult> {
    throw new ProviderError({
      providerId: GENIUSPAY_PROVIDER_ID,
      code: 'invalid_request',
      message: "L'API de decaissement GeniusPay n'est pas documentee publiquement.",
    });
  },

  /**
   * Signature : HMAC-SHA256 sur `horodatage + "." + charge`.
   *
   * On verifie sur le CORPS BRUT recu, pas sur un JSON reserialise. L'exemple
   * PHP de leur documentation reserialise (`json_encode($payload)`), ce qui ne
   * fonctionne que si l'ordre des cles et l'echappement sont identiques —
   * hypothese fragile d'un langage a l'autre. Le corps brut est exactement ce
   * qu'ils ont signe.
   */
  verifyWebhook(input: WebhookInput, ctx: ProviderContext): WebhookVerdict {
    const secret = ctx.credentials.webhook_secret;
    if (!secret) return { valid: false, reason: 'webhook_secret absent des credentials.' };

    const pick = (name: string): string | undefined => {
      const raw = input.headers[name];
      return Array.isArray(raw) ? raw[0] : raw;
    };

    const signature = pick('x-webhook-signature');
    const timestamp = pick('x-webhook-timestamp');
    if (!signature || !timestamp) return { valid: false, reason: 'Signature ou horodatage absent.' };

    const age = Math.abs(Date.now() / 1000 - Number(timestamp));
    if (!Number.isFinite(age) || age > 300) {
      return { valid: false, reason: 'Signature expiree (plus de 5 minutes).' };
    }

    const expected = createHmac('sha256', secret)
      .update(`${timestamp}.${input.rawBody}`)
      .digest('hex');
    const a = Buffer.from(signature, 'utf8');
    const b = Buffer.from(expected, 'utf8');
    if (a.length !== b.length || !timingSafeEqual(a, b)) {
      return { valid: false, reason: 'Signature invalide.' };
    }

    let event: {
      id?: unknown;
      event?: unknown;
      data?: { reference?: unknown; status?: unknown; fees?: unknown };
    };
    try {
      event = JSON.parse(input.rawBody) as typeof event;
    } catch {
      return { valid: false, reason: 'Corps non JSON.' };
    }

    const name = typeof event.event === 'string' ? event.event : '';
    const reference = typeof event.data?.reference === 'string' ? event.data.reference : undefined;
    if (!reference) return { valid: false, reason: 'Reference absente de la charge.' };

    // Les evenements `cashout.*` concernent les retraits du marchand chez
    // GeniusPay, pas nos decaissements : on ne les rattache a aucune tentative.
    const kind: Direction | 'unknown' = name.startsWith('payment.') ? 'payin' : 'unknown';

    const status =
      typeof event.data?.status === 'string'
        ? mapStatus(event.data.status)
        : name === 'payment.success'
          ? 'succeeded'
          : name === 'payment.failed' || name === 'payment.cancelled'
            ? 'failed'
            : name === 'payment.expired'
              ? 'expired'
              : 'unknown';

    return {
      valid: true,
      eventId: typeof event.id === 'string' ? event.id : `${name}:${reference}:${timestamp}`,
      kind,
      providerReference: reference,
      status,
      ...(name ? { providerCode: name } : {}),
      raw: event,
    };
  },
};
