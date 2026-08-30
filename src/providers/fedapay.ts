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
 * Adaptateur FedaPay (UEMOA : BJ, TG, CI, SN, NE).
 *
 * ┌─ CONTRAT API ────────────────────────────────────────────────────────────┐
 * │ Ecrit d'apres la documentation publique (docs.fedapay.com), consultee le  │
 * │ 29/08/2026. AUCUN appel n'a ete verifie contre un compte sandbox reel.    │
 * │                                                                          │
 * │ CONFIRME par la documentation :                                          │
 * │   - hotes sandbox / production et prefixe /v1                            │
 * │   - Authorization: Bearer <cle secrete>                                   │
 * │   - POST /transactions puis POST /transactions/{id}/token -> {token,url}  │
 * │   - POST /transactions/{mode} avec {token, phone_number}                  │
 * │   - statuts transaction : pending, approved, canceled, declined,          │
 * │     transferred                                                           │
 * │   - POST /payouts {amount, currency:{iso}, mode, customer}                │
 * │   - statuts payout : pending, scheduled, sent, failed                     │
 * │   - en-tete de webhook X-FEDAPAY-SIGNATURE                                │
 * │                                                                          │
 * │ A CONFIRMER en sandbox avant toute mise en production :                   │
 * │   - enveloppe de reponse : FedaPay encapsule dans {"v1/transaction": {}}. │
 * │     Le parseur ci-dessous accepte les deux formes, par prudence.          │
 * │   - format exact de la signature de webhook (schema type Stripe          │
 * │     `t=...,s=...` suppose ici)                                            │
 * │   - endpoint de declenchement du payout (PUT /payouts/start)              │
 * │   - libelles exacts des modes operateur par pays                          │
 * └──────────────────────────────────────────────────────────────────────────┘
 *
 * Tant que ces points ne sont pas verifies, cet agregateur reste `PLANNED` au
 * catalogue et n'est pas enregistre dans le registre : aucune transaction reelle
 * ne peut lui etre confiee par megarde.
 */

export const FEDAPAY_PROVIDER_ID = 'fedapay';

const HOSTS = {
  test: 'https://sandbox-api.fedapay.com/v1',
  live: 'https://api.fedapay.com/v1',
} as const;

/**
 * Correspondance reseau Orchi -> mode operateur FedaPay.
 *
 * Point de correction n°1 en cas de divergence avec la documentation : tout est
 * ici, rien n'est devine ailleurs dans le fichier.
 */
const MODE_BY_NETWORK: Readonly<Record<string, string>> = {
  MTN_BENIN: 'mtn',
  MOOV_BENIN: 'moov',
  TMONEY: 'togocel',
  MOOV_TOGO: 'moov_tg',
  MTN_CI: 'mtn_ci',
  MOOV_CI: 'moov_ci',
  ORANGE_CI: 'orange_ci',
  WAVE_CI: 'wave_ci',
  ORANGE_SN: 'orange_sn',
  FREE_SN: 'free_sn',
  WAVE_SN: 'wave_sn',
  AIRTEL_NE: 'airtel_ne',
  ZAMANI: 'zamani_ne',
};

/** Pays desservis par FedaPay, d'apres son offre publique. */
const COUNTRIES = new Set(['BJ', 'TG', 'CI', 'SN', 'NE']);

/* -------------------------------------------------------------------------- */
/* Statuts                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Traduction des statuts FedaPay vers la taxonomie Orchi.
 *
 * `pending` devient `awaiting_customer` en encaissement (le client doit valider
 * son push USSD) mais `pending` en decaissement (rien n'est attendu de
 * personne). Un statut inconnu ne devient JAMAIS `failed` : il devient
 * `unknown`, ce qui bloque tout rejeu au lieu d'en autoriser un a tort.
 */
function mapChargeStatus(status: string): AttemptStatus {
  switch (status) {
    case 'pending':
      return 'awaiting_customer';
    case 'approved':
    case 'transferred':
      return 'succeeded';
    case 'canceled':
    case 'declined':
    case 'refunded':
      return 'failed';
    case 'expired':
      return 'expired';
    default:
      return 'unknown';
  }
}

function mapPayoutStatus(status: string): AttemptStatus {
  switch (status) {
    case 'pending':
    case 'scheduled':
    case 'started':
      return 'pending';
    case 'sent':
    case 'approved':
      return 'succeeded';
    case 'failed':
    case 'canceled':
      return 'failed';
    default:
      return 'unknown';
  }
}

/* -------------------------------------------------------------------------- */
/* Utilitaires                                                                */
/* -------------------------------------------------------------------------- */

interface FedaPayEntity {
  id?: number | string;
  reference?: string;
  status?: string;
  amount?: number;
  fees?: number;
  commission?: number;
  last_error_code?: string | null;
  [key: string]: unknown;
}

/**
 * FedaPay encapsule ses reponses sous une cle typee (`v1/transaction`,
 * `v1/payout`). Certaines reponses documentees apparaissent a plat. On accepte
 * les deux plutot que de parier sur une seule.
 */
function unwrap(body: unknown, expectedKey: string): FedaPayEntity {
  if (body && typeof body === 'object') {
    const record = body as Record<string, unknown>;
    const wrapped = record[expectedKey];
    if (wrapped && typeof wrapped === 'object') return wrapped as FedaPayEntity;
    if ('id' in record || 'status' in record) return record as FedaPayEntity;
  }
  throw new ProviderError({
    providerId: FEDAPAY_PROVIDER_ID,
    code: 'malformed_response',
    message: `Reponse FedaPay illisible : cle ${expectedKey} absente.`,
  });
}

function headers(ctx: ProviderContext): Record<string, string> {
  const secret = ctx.credentials.secret_key;
  if (!secret) {
    throw new ProviderError({
      providerId: FEDAPAY_PROVIDER_ID,
      code: 'authentication',
      message: 'Credential secret_key absent.',
    });
  }
  return { authorization: `Bearer ${secret}` };
}

function baseUrl(ctx: ProviderContext): string {
  // La surcharge sert aux tests de contrat et a un eventuel proxy sortant ;
  // en son absence, l'hote depend strictement de l'environnement de la cle.
  return providerHost('FEDAPAY_BASE_URL', HOSTS[ctx.environment]);
}

/** FedaPay attend le numero sans indicatif et le pays a part. */
function splitPhone(phone: string | undefined, country: string) {
  if (!phone) return undefined;
  return { number: phone.startsWith('+') ? phone : `+${phone}`, country: country.toUpperCase() };
}

function splitName(name: string | undefined): { firstname: string; lastname: string } {
  const parts = (name ?? '').trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return { firstname: 'Client', lastname: 'Orchi' };
  if (parts.length === 1) return { firstname: parts[0]!, lastname: parts[0]! };
  return { firstname: parts[0]!, lastname: parts.slice(1).join(' ') };
}

function modeFor(network: string | undefined, channel: Channel): string {
  if (channel === 'card') return 'card';
  if (!network) {
    throw new ProviderError({
      providerId: FEDAPAY_PROVIDER_ID,
      code: 'invalid_request',
      message: 'Reseau mobile money requis (network) pour FedaPay.',
    });
  }
  const mode = MODE_BY_NETWORK[network.toUpperCase()];
  if (!mode) {
    throw new ProviderError({
      providerId: FEDAPAY_PROVIDER_ID,
      code: 'invalid_request',
      message: `Reseau non pris en charge par FedaPay : ${network}.`,
    });
  }
  return mode;
}

/* -------------------------------------------------------------------------- */
/* Adaptateur                                                                 */
/* -------------------------------------------------------------------------- */

export const fedapayProvider: PaymentProvider = {
  id: FEDAPAY_PROVIDER_ID,
  name: 'FedaPay',
  requiredCredentials: ['secret_key', 'webhook_secret'],

  supports(country: string, channel: Channel, _direction: Direction): boolean {
    return COUNTRIES.has(country.toUpperCase()) && channel !== 'bank_transfer';
  },

  async createCharge(request: ChargeRequest, ctx: ProviderContext): Promise<AttemptResult> {
    const url = baseUrl(ctx);
    const name = splitName(request.customer.name);

    // Le mode operateur est resolu AVANT tout appel sortant : un reseau non
    // desservi doit echouer sans avoir cree chez FedaPay une transaction que
    // personne ne paiera jamais.
    const mode = request.channel === 'card' ? null : modeFor(request.network, request.channel);

    // 1. Creation de la transaction.
    const created = await providerFetch({
      providerId: FEDAPAY_PROVIDER_ID,
      method: 'POST',
      url: `${url}/transactions`,
      headers: headers(ctx),
      mutating: true,
      ...(ctx.timeoutMs !== undefined ? { timeoutMs: ctx.timeoutMs } : {}),
      body: JSON.stringify({
        description: request.description ?? `Paiement ${request.reference}`,
        amount: request.amount,
        currency: { iso: request.currency },
        callback_url: request.callbackUrl,
        // La reference Orchi voyage avec la transaction : c'est ce qui permet
        // de rapprocher un settlement FedaPay de nos propres ecritures.
        custom_metadata: { orchi_reference: request.reference, ...request.metadata },
        customer: {
          firstname: name.firstname,
          lastname: name.lastname,
          ...(request.customer.email ? { email: request.customer.email } : {}),
          ...(splitPhone(request.customer.phone, request.country)
            ? { phone_number: splitPhone(request.customer.phone, request.country) }
            : {}),
        },
      }),
    });

    const transaction = unwrap(parseJson(FEDAPAY_PROVIDER_ID, created.body), 'v1/transaction');
    const transactionId = String(transaction.id ?? '');
    if (!transactionId) {
      throw new ProviderError({
        providerId: FEDAPAY_PROVIDER_ID,
        code: 'malformed_response',
        message: 'Transaction FedaPay creee sans identifiant.',
      });
    }

    // 2. Jeton de paiement + lien hebergé.
    const tokenResponse = await providerFetch({
      providerId: FEDAPAY_PROVIDER_ID,
      method: 'POST',
      url: `${url}/transactions/${transactionId}/token`,
      headers: headers(ctx),
      mutating: true,
      ...(ctx.timeoutMs !== undefined ? { timeoutMs: ctx.timeoutMs } : {}),
      body: '{}',
    });

    const tokenBody = parseJson<{ token?: string; url?: string }>(
      FEDAPAY_PROVIDER_ID,
      tokenResponse.body,
    );
    if (!tokenBody.token) {
      throw new ProviderError({
        providerId: FEDAPAY_PROVIDER_ID,
        code: 'malformed_response',
        message: 'Jeton de paiement FedaPay absent.',
      });
    }

    // 3. Carte : on rend la main au navigateur. Mobile money : on declenche le
    //    push operateur, et le client valide sur son telephone.
    let action: CustomerAction;
    let status: AttemptStatus;

    if (mode === null) {
      action = { type: 'redirect', url: tokenBody.url ?? '' };
      status = 'awaiting_customer';
    } else {
      const sent = await providerFetch({
        providerId: FEDAPAY_PROVIDER_ID,
        method: 'POST',
        url: `${url}/transactions/${mode}`,
        headers: headers(ctx),
        mutating: true,
        ...(ctx.timeoutMs !== undefined ? { timeoutMs: ctx.timeoutMs } : {}),
        body: JSON.stringify({
          token: tokenBody.token,
          phone_number: splitPhone(request.customer.phone, request.country),
        }),
      });
      parseJson(FEDAPAY_PROVIDER_ID, sent.body);

      action = {
        type: 'ussd_push',
        instructions:
          'Une demande de paiement a ete envoyee sur le telephone du client. ' +
          'Il doit la valider avec son code PIN.',
      };
      status = 'awaiting_customer';
    }

    return {
      providerReference: transactionId,
      status,
      action,
      ...(transaction.reference ? { providerCode: String(transaction.reference) } : {}),
      raw: { transaction, token: { url: tokenBody.url } },
    };
  },

  async getCharge(providerReference: string, ctx: ProviderContext): Promise<AttemptResult> {
    const response = await providerFetch({
      providerId: FEDAPAY_PROVIDER_ID,
      method: 'GET',
      url: `${baseUrl(ctx)}/transactions/${providerReference}`,
      headers: headers(ctx),
      mutating: false,
      ...(ctx.timeoutMs !== undefined ? { timeoutMs: ctx.timeoutMs } : {}),
    });

    const transaction = unwrap(parseJson(FEDAPAY_PROVIDER_ID, response.body), 'v1/transaction');
    const status = mapChargeStatus(String(transaction.status ?? ''));

    return {
      providerReference,
      status,
      action: { type: 'none' },
      ...(typeof transaction.fees === 'number' ? { providerFeeAmount: transaction.fees } : {}),
      ...(transaction.status ? { providerCode: String(transaction.status) } : {}),
      ...(transaction.last_error_code
        ? { providerMessage: String(transaction.last_error_code) }
        : {}),
      raw: transaction,
    };
  },

  async createPayout(request: PayoutRequest, ctx: ProviderContext): Promise<AttemptResult> {
    const url = baseUrl(ctx);
    const name = splitName(request.recipient.name);

    const created = await providerFetch({
      providerId: FEDAPAY_PROVIDER_ID,
      method: 'POST',
      url: `${url}/payouts`,
      headers: headers(ctx),
      mutating: true,
      ...(ctx.timeoutMs !== undefined ? { timeoutMs: ctx.timeoutMs } : {}),
      body: JSON.stringify({
        amount: request.amount,
        currency: { iso: request.currency },
        mode: modeFor(request.recipient.network, request.channel),
        merchant_reference: request.reference,
        customer: {
          firstname: name.firstname,
          lastname: name.lastname,
          ...(splitPhone(request.recipient.phone, request.country)
            ? { phone_number: splitPhone(request.recipient.phone, request.country) }
            : {}),
        },
      }),
    });

    const payout = unwrap(parseJson(FEDAPAY_PROVIDER_ID, created.body), 'v1/payout');
    const payoutId = String(payout.id ?? '');
    if (!payoutId) {
      throw new ProviderError({
        providerId: FEDAPAY_PROVIDER_ID,
        code: 'malformed_response',
        message: 'Payout FedaPay cree sans identifiant.',
      });
    }

    /**
     * Un payout cree n'est pas un payout envoye : il faut le declencher.
     *
     * A partir d'ici, toute erreur laisse un decaissement dans un etat que nous
     * ne connaissons pas — d'ou la ProviderError `indeterminate` plutot qu'un
     * echec franc. Le moteur bloquera alors tout rejeu.
     */
    try {
      await providerFetch({
        providerId: FEDAPAY_PROVIDER_ID,
        method: 'PUT',
        url: `${url}/payouts/start`,
        headers: headers(ctx),
        mutating: true,
        ...(ctx.timeoutMs !== undefined ? { timeoutMs: ctx.timeoutMs } : {}),
        body: JSON.stringify({ payouts: [{ id: payout.id }] }),
      });
    } catch (e) {
      if (e instanceof ProviderError && e.outcome === 'failed') {
        // Le declenchement a ete refuse : le payout existe mais dort. On le
        // signale comme indetermine car il pourrait etre repris cote FedaPay.
        throw new ProviderError({
          providerId: FEDAPAY_PROVIDER_ID,
          code: 'indeterminate',
          message: `Payout ${payoutId} cree mais non declenche : ${e.message}`,
          cause: e,
        });
      }
      throw e;
    }

    return {
      providerReference: payoutId,
      status: mapPayoutStatus(String(payout.status ?? 'pending')),
      action: { type: 'none' },
      ...(typeof payout.fees === 'number' ? { providerFeeAmount: payout.fees } : {}),
      raw: payout,
    };
  },

  async getPayout(providerReference: string, ctx: ProviderContext): Promise<AttemptResult> {
    const response = await providerFetch({
      providerId: FEDAPAY_PROVIDER_ID,
      method: 'GET',
      url: `${baseUrl(ctx)}/payouts/${providerReference}`,
      headers: headers(ctx),
      mutating: false,
      ...(ctx.timeoutMs !== undefined ? { timeoutMs: ctx.timeoutMs } : {}),
    });

    const payout = unwrap(parseJson(FEDAPAY_PROVIDER_ID, response.body), 'v1/payout');

    return {
      providerReference,
      status: mapPayoutStatus(String(payout.status ?? '')),
      action: { type: 'none' },
      ...(typeof payout.fees === 'number' ? { providerFeeAmount: payout.fees } : {}),
      ...(payout.status ? { providerCode: String(payout.status) } : {}),
      ...(payout.last_error_code ? { providerMessage: String(payout.last_error_code) } : {}),
      raw: payout,
    };
  },

  /**
   * Signature FedaPay : en-tete `X-FEDAPAY-SIGNATURE`, schema suppose de type
   * `t=<horodatage>,s=<hmac>` ou le HMAC-SHA256 porte sur `<t>.<corps brut>`.
   *
   * Ce schema est a CONFIRMER en sandbox. En cas de divergence, seule cette
   * fonction est a corriger. Une tolerance d'horodatage de 5 minutes protege du
   * rejeu d'un webhook capture.
   */
  verifyWebhook(input: WebhookInput, ctx: ProviderContext): WebhookVerdict {
    const secret = ctx.credentials.webhook_secret;
    if (!secret) return { valid: false, reason: 'webhook_secret absent des credentials.' };

    const raw = input.headers['x-fedapay-signature'];
    const header = Array.isArray(raw) ? raw[0] : raw;
    if (!header) return { valid: false, reason: 'Signature absente.' };

    const parts = Object.fromEntries(
      header.split(',').map((p) => {
        const [k = '', ...rest] = p.trim().split('=');
        return [k, rest.join('=')];
      }),
    );
    const timestamp = parts.t;
    const signature = parts.s;
    if (!timestamp || !signature) return { valid: false, reason: 'Signature malformee.' };

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

    let event: { name?: unknown; entity?: FedaPayEntity; id?: unknown };
    try {
      event = JSON.parse(input.rawBody) as typeof event;
    } catch {
      return { valid: false, reason: 'Corps non JSON.' };
    }

    const name = typeof event.name === 'string' ? event.name : '';
    const entity = event.entity ?? {};
    const reference = entity.id !== undefined ? String(entity.id) : undefined;
    if (!reference) return { valid: false, reason: 'Entite sans identifiant.' };

    const kind: Direction | 'unknown' = name.startsWith('payout.')
      ? 'payout'
      : name.startsWith('transaction.')
        ? 'payin'
        : 'unknown';

    const status =
      kind === 'payout'
        ? mapPayoutStatus(String(entity.status ?? ''))
        : mapChargeStatus(String(entity.status ?? ''));

    return {
      valid: true,
      eventId: event.id !== undefined ? String(event.id) : `${name}:${reference}`,
      kind,
      providerReference: reference,
      status,
      ...(entity.status ? { providerCode: String(entity.status) } : {}),
      raw: event,
    };
  },
};
