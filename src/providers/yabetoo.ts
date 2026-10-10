import { createHmac, timingSafeEqual } from 'node:crypto';
import type { Channel } from '../catalog/coverage.js';
import { ProviderError, isProviderError } from './errors.js';
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
 * Adaptateur Yabetoo Pay — mobile money MTN / Airtel, Congo-Brazzaville (XAF).
 *
 * Ecrit en deux temps : d'apres l'integration PHP d'une application cliente
 * (flux, en-tetes, signature de webhook), puis CONFRONTE a leur sandbox le
 * 10/10/2026. Ce qui suit distingue ce que l'appel reel a confirme de ce qu'il
 * a corrige, et de ce qui reste a verifier.
 *
 * ┌─ CONTRAT API ────────────────────────────────────────────────────────────┐
 * │ VERIFIE PAR APPEL REEL (sandbox, cle sk_test_) :                         │
 * │   - auth : `Authorization: Bearer <sk_...>`                              │
 * │   - hote : sandbox pour sk_test_, hote de production sinon               │
 * │   - encaissement en DEUX temps :                                         │
 * │       POST /v1/payment-intents          -> { id: pi_…, clientSecret }    │
 * │       POST /v1/payment-intents/{id}/confirm                              │
 * │         { client_secret, payment_method_data: { type: 'momo', momo:      │
 * │           { country, msisdn, operator_name: 'mtn' | 'airtel' } } }       │
 * │   - GET /v1/payment-intents/{id}, GET /v1/disbursements/{id}             │
 * │   - decaissement : POST /v1/disbursements, reponse synchrone             │
 * │   - `Idempotency-Key` HONOREE sur l'intent ET sur le decaissement : la   │
 * │     meme cle renvoie la meme ressource. Sans cle, deux appels identiques │
 * │     creent deux versements.                                              │
 * │   - la casse de `country` est indifferente (« cg » comme « CG »)         │
 * │   - minimum d'encaissement : 100 XAF (`E_MINIMUM_AMOUNT`)                │
 * │   - erreurs : 422 { code, message, detail } ou { errors: [{ rule }] }    │
 * │                                                                          │
 * │ CORRIGE PAR L'APPEL REEL — le SDK PHP laissait croire autre chose :      │
 * │   - la creation renvoie `clientSecret` (camelCase) et AUCUN `status`     │
 * │   - la confirmation est SYNCHRONE en sandbox : `status: "succeeded"`     │
 * │     des la reponse. En reel, un push mobile money restera en attente.    │
 * │   - les FRAIS n'apparaissent qu'a la relecture de l'intent, dans         │
 * │     `walletTransaction.amountFee`, et sont DECIMAUX (77.5) alors que XAF │
 * │     n'a pas de subdivision.                                              │
 * │   - `receivedAmount` vaut 0 sur un intent `succeeded` : inutilisable.    │
 * │   - FRAIS D'ENCAISSEMENT = 3,5 % + 25 XAF (3 % operateur + 0,5 % + 25), │
 * │     mesure sur onze montants de 100 a 100 000. Pas un pourcentage fixe :  │
 * │     28,5 % a 100 XAF, 5,17 % a 1 500, 3,52 % a 100 000. Sous 1 667 XAF le │
 * │     cout depasse les 5 % d'Afripaie, dont la part tombe alors a zero.    │
 * │   - DECAISSEMENT : 1,5 % preleve sur la somme versee, portefeuille debite│
 * │     du montant demande. Voir `payoutResult`.                             │
 * │   - un decaissement Airtel echoue en sandbox : HTTP 200, `status:        │
 * │     "failed"`, « only available in live mode ». MTN fonctionne.          │
 * │                                                                          │
 * │ NON VERIFIE :                                                            │
 * │   - la signature des webhooks : aucun webhook recu, aucun secret fourni. │
 * │     Implementee d'apres l'integration PHP, qui l'a vue fonctionner.      │
 * │   - tout echec d'encaissement : le sandbox REUSSIT TOUJOURS, meme avec   │
 * │     un numero inexistant. Les codes d'echec viennent du code PHP.        │
 * │   - le comportement en reel (statut intermediaire, delais).              │
 * └──────────────────────────────────────────────────────────────────────────┘
 */

export const YABETOO_PROVIDER_ID = 'yabetoo';

const SANDBOX_HOST = 'https://pay.sandbox.yabetoopay.com';
const LIVE_HOST = 'https://pay.api.yabetoopay.com';

const COUNTRY = 'CG';
const CURRENCY = 'XAF';
const PHONE_PREFIX = '242';

/** Montant minimal d'un encaissement, verifie contre le sandbox. */
const MIN_PAYIN_XAF = 100;

/** Delai plus long que le defaut : la confirmation attend l'operateur. */
const SLOW_TIMEOUT_MS = 25_000;

/** Reseau Afripaie -> `operator_name` Yabetoo. */
const OPERATOR_BY_NETWORK: Readonly<Record<string, string>> = {
  MTN_CG: 'mtn',
  AIRTEL_CG: 'airtel',
};

/* -------------------------------------------------------------------------- */
/* Statuts                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Un statut inconnu devient `unknown`, jamais `failed` : declarer un echec a
 * tort autoriserait une relance sur une transaction peut-etre aboutie.
 */
function mapStatus(raw: unknown): AttemptStatus {
  switch (String(raw ?? '').toLowerCase()) {
    case 'succeeded':
    case 'success':
    case 'completed':
    case 'paid':
      return 'succeeded';
    case 'failed':
    case 'canceled':
    case 'cancelled':
      return 'failed';
    case 'expired':
      return 'expired';
    case 'pending':
    case 'processing':
    case 'requires_action':
    case 'requires_confirmation':
    case 'requires_payment_method':
      return 'pending';
    default:
      return 'unknown';
  }
}

/* -------------------------------------------------------------------------- */
/* Types de reponse                                                           */
/* -------------------------------------------------------------------------- */

interface YabetooCharge {
  id?: string;
  intentId?: string;
  status?: string;
  failureCode?: string | null;
  failureMessage?: string | null;
}

interface YabetooIntent {
  id?: string;
  status?: string;
  clientSecret?: string;
  client_secret?: string;
  failureCode?: string | null;
  failureMessage?: string | null;
  charges?: YabetooCharge[];
  walletTransaction?: { amountFee?: number };
}

interface YabetooDisbursement {
  id?: string;
  status?: string;
  amount?: number;
  failureCode?: string | null;
  failureMessage?: string | null;
}

/* -------------------------------------------------------------------------- */
/* Utilitaires                                                                */
/* -------------------------------------------------------------------------- */

/**
 * La cle fixe l'environnement, et les deux doivent concorder.
 *
 * C'EST UNE PROTECTION, PAS UNE FORMALITE. Le sandbox Yabetoo REUSSIT TOUJOURS :
 * constate avec un numero inexistant, avec 99 999 999 XAF. Si une cle `sk_test_`
 * etait branchee par erreur sur un marchand `live`, chaque vente serait
 * enregistree comme payee sans qu'un franc ne bouge. A l'inverse, une cle de
 * production utilisee dans l'environnement `test` ferait de vrais encaissements
 * depuis du trafic d'essai.
 */
function secretKey(ctx: ProviderContext): string {
  const key = ctx.credentials.secret_key;
  if (!key) {
    throw new ProviderError({
      providerId: YABETOO_PROVIDER_ID,
      code: 'authentication',
      message: 'Credential secret_key requis.',
    });
  }

  const isTestKey = key.startsWith('sk_test_');

  if (ctx.environment === 'live' && isTestKey) {
    throw new ProviderError({
      providerId: YABETOO_PROVIDER_ID,
      code: 'authentication',
      message:
        'Une cle Yabetoo de test (sk_test_...) ne peut pas servir en environnement reel : ' +
        'le sandbox reussit toujours, et des ventes seraient enregistrees sans mouvement de fonds.',
    });
  }
  if (ctx.environment === 'test' && !isTestKey) {
    throw new ProviderError({
      providerId: YABETOO_PROVIDER_ID,
      code: 'authentication',
      message:
        "Une cle Yabetoo de production ne peut pas servir en environnement de test : " +
        'elle ferait de vrais encaissements.',
    });
  }
  return key;
}

function baseUrl(key: string): string {
  return providerHost('YABETOO_BASE_URL', key.startsWith('sk_test_') ? SANDBOX_HOST : LIVE_HOST);
}

function headers(key: string, idempotencyKey?: string): Record<string, string> {
  return {
    Authorization: `Bearer ${key}`,
    ...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {}),
  };
}

/**
 * Corps d'erreur Yabetoo, relu depuis la cause conservee par `providerFetch`.
 * Deux formes ont ete constatees : `{ code, message, detail }` et
 * `{ errors: [{ message, rule, field }] }`.
 */
function errorBody(e: unknown): { code?: string; detail?: string } {
  const cause = isProviderError(e) ? (e as { cause?: unknown }).cause : undefined;
  if (typeof cause !== 'string') return {};
  try {
    const parsed = JSON.parse(cause) as {
      code?: string;
      detail?: string;
      message?: string;
      errors?: Array<{ rule?: string; message?: string }>;
    };
    const code = parsed.code ?? parsed.errors?.[0]?.rule;
    const detail = parsed.detail ?? parsed.errors?.[0]?.message ?? parsed.message;
    return {
      ...(code ? { code } : {}),
      ...(detail ? { detail } : {}),
    };
  } catch {
    return {};
  }
}

/**
 * Affine une erreur HTTP : `providerFetch` classe tout 422 en `invalid_request`,
 * or un solde insuffisant est un REFUS explicite, pas une requete malformee.
 */
function refine(e: unknown): never {
  if (!isProviderError(e)) throw e;

  const { code, detail } = errorBody(e);

  if (code === 'E_INSUFFICIENT_BALANCE') {
    throw new ProviderError({
      providerId: YABETOO_PROVIDER_ID,
      code: 'declined',
      message: 'Solde du compte Yabetoo insuffisant pour cette operation.',
      providerCode: code,
      ...(e.httpStatus !== undefined ? { httpStatus: e.httpStatus } : {}),
    });
  }

  if (code !== undefined) {
    throw new ProviderError({
      providerId: YABETOO_PROVIDER_ID,
      code: e.code,
      message: `Yabetoo : ${detail ?? code}`,
      providerCode: code,
      ...(e.httpStatus !== undefined ? { httpStatus: e.httpStatus } : {}),
    });
  }

  throw e;
}

/**
 * Normalise un numero congolais en `+242` + 9 chiffres.
 *
 * Le zero local est CONSERVE : les numeros du Congo-Brazzaville ont neuf
 * chiffres (06 xxx xxxx, 05 xxx xxxx). Un numero a huit chiffres est refuse
 * plutot que complete a l'aveugle — deviner un chiffre manquant enverrait un
 * push chez un inconnu.
 */
export function formatMsisdn(raw: string): string | null {
  const digits = raw.replace(/\D+/g, '');
  const local = digits.startsWith(PHONE_PREFIX) ? digits.slice(PHONE_PREFIX.length) : digits;
  return local.length === 9 ? `+${PHONE_PREFIX}${local}` : null;
}

/** Certains operateurs refusent les caracteres exotiques dans le nom du payeur. */
function cleanName(raw: string | undefined, fallback: string): string {
  const cleaned = (raw ?? '')
    .replace(/[^\p{L}\s'-]/gu, '')
    .replace(/\s+/g, ' ')
    .trim();
  return cleaned.length > 0 ? cleaned.slice(0, 60) : fallback;
}

function splitName(full: string | undefined): { first: string; last: string } {
  const cleaned = cleanName(full, '');
  if (!cleaned) return { first: 'Beneficiaire', last: 'Afripaie' };
  const [first, ...rest] = cleaned.split(' ');
  return { first: first!, last: rest.join(' ') || 'Afripaie' };
}

/** Yabetoo rejette les metadonnees nulles ou vides (422) : elles sont retirees. */
function cleanMetadata(meta: Record<string, string> | undefined): Record<string, string> {
  return Object.fromEntries(
    Object.entries(meta ?? {}).filter(([, v]) => typeof v === 'string' && v !== ''),
  );
}

function failureOf(o: { failureCode?: string | null; failureMessage?: string | null; charges?: YabetooCharge[] }) {
  const charge = o.charges?.[0];
  const code = charge?.failureCode ?? o.failureCode ?? undefined;
  const message = charge?.failureMessage ?? o.failureMessage ?? undefined;
  return {
    ...(code ? { providerCode: String(code) } : {}),
    ...(message ? { providerMessage: String(message) } : {}),
  };
}

const PUSH_ACTION: CustomerAction = {
  type: 'ussd_push',
  instructions: 'Un push Mobile Money a ete envoye sur le telephone du client. Il doit saisir son code PIN.',
};

/**
 * Frais reels d'un encaissement, en unites mineures.
 *
 * Absents de la creation comme de la confirmation : seule la relecture de
 * l'intent les porte, sous `walletTransaction.amountFee`. DECIMAUX constates
 * (77.5 sur 1 500) : arrondis au demi-superieur, comme `applyBps`, puisque XAF
 * n'a pas de subdivision.
 */
function feeOf(intent: YabetooIntent): { providerFeeAmount?: number } {
  const fee = intent.walletTransaction?.amountFee;
  return typeof fee === 'number' && Number.isFinite(fee) && fee >= 0
    ? { providerFeeAmount: Math.floor(fee + 0.5) }
    : {};
}

/* -------------------------------------------------------------------------- */
/* L'adaptateur                                                               */
/* -------------------------------------------------------------------------- */

export const yabetooProvider: PaymentProvider = {
  id: YABETOO_PROVIDER_ID,
  name: 'Yabetoo Pay',
  requiredCredentials: ['secret_key', 'webhook_secret'],

  supports(country: string, channel: Channel, _direction: Direction): boolean {
    // Encaissement ET decaissement. Carte et virement ne sont pas proposes.
    return country.toUpperCase() === COUNTRY && channel === 'mobile_money';
  },

  /* -------------------------------------------------------------- Encaisser */

  async createCharge(request: ChargeRequest, ctx: ProviderContext): Promise<AttemptResult> {
    const key = secretKey(ctx);

    // Tout ce qui suit est verifie AVANT l'appel : creer une transaction vouee
    // au refus laisserait une trace a reconcilier pour rien.
    if (request.currency.toUpperCase() !== CURRENCY) {
      throw invalid(`Yabetoo n'accepte que ${CURRENCY} (recu ${request.currency}).`);
    }
    if (request.amount < MIN_PAYIN_XAF) {
      throw invalid(`Yabetoo impose un montant minimum de ${MIN_PAYIN_XAF} ${CURRENCY}.`);
    }

    // L'operateur est obligatoire cote Yabetoo et ne se devine pas : un numero
    // congolais ne dit pas de facon fiable s'il est MTN ou Airtel.
    const operator = request.network ? OPERATOR_BY_NETWORK[request.network.toUpperCase()] : undefined;
    if (!operator) {
      throw invalid('Reseau requis : MTN_CG ou AIRTEL_CG.');
    }

    const msisdn = request.customer.phone ? formatMsisdn(request.customer.phone) : null;
    if (!msisdn) {
      throw invalid('Numero congolais attendu : +242 suivi de 9 chiffres (ex. 06 123 4567).');
    }

    const base = baseUrl(key);

    /* --- 1. L'intent. Aucun fonds ne peut avoir bouge a ce stade : un intent
     *        non confirme n'est qu'une intention. Un echec ici, y compris un
     *        delai depasse, est donc un echec FRANC et non un etat inconnu. */
    let intent: YabetooIntent;
    try {
      const created = await providerFetch({
        providerId: YABETOO_PROVIDER_ID,
        method: 'POST',
        url: `${base}/v1/payment-intents`,
        headers: headers(key, request.reference),
        // Faux a dessein : voir ci-dessus, aucune requete mutante au sens de
        // l'argent. Un 5xx ici se lit « reessayez », pas « peut-etre debite ».
        mutating: false,
        ...(ctx.timeoutMs !== undefined ? { timeoutMs: ctx.timeoutMs } : {}),
        body: JSON.stringify({
          amount: request.amount,
          currency: CURRENCY,
          ...(request.description ? { description: request.description.slice(0, 500) } : {}),
          metadata: {
            afripaie_reference: request.reference,
            ...cleanMetadata(request.metadata),
          },
        }),
      });
      intent = parseJson<YabetooIntent>(YABETOO_PROVIDER_ID, created.body);
    } catch (e) {
      // Avant toute confirmation, aucun etat « inconnu » n'est possible.
      if (isProviderError(e) && (e.code === 'timeout' || e.code === 'malformed_response' || e.code === 'indeterminate')) {
        throw new ProviderError({
          providerId: YABETOO_PROVIDER_ID,
          code: 'unavailable',
          message: 'Yabetoo n a pas repondu a la creation de l intent : aucun debit possible.',
          cause: e,
        });
      }
      return refine(e);
    }

    const intentId = intent.id;
    const clientSecret = intent.clientSecret ?? intent.client_secret;
    if (!intentId || !clientSecret) {
      throw new ProviderError({
        providerId: YABETOO_PROVIDER_ID,
        code: 'unavailable',
        message: 'Reponse Yabetoo sans identifiant ou sans clientSecret.',
      });
    }

    /* --- 2. La confirmation : c'est elle qui envoie le push et qui debite. */
    const customerName = request.customer.name?.trim();
    const nameParts = customerName ? splitName(customerName) : undefined;

    let charge: YabetooCharge;
    try {
      const confirmed = await providerFetch({
        providerId: YABETOO_PROVIDER_ID,
        method: 'POST',
        url: `${base}/v1/payment-intents/${encodeURIComponent(intentId)}/confirm`,
        headers: headers(key),
        mutating: true,
        timeoutMs: ctx.timeoutMs ?? SLOW_TIMEOUT_MS,
        body: JSON.stringify({
          client_secret: clientSecret,
          payment_method_data: {
            type: 'momo',
            momo: { country: COUNTRY.toLowerCase(), msisdn, operator_name: operator },
          },
          ...(nameParts ? { first_name: nameParts.first, last_name: nameParts.last } : {}),
          ...(request.customer.email ? { receipt_email: request.customer.email } : {}),
        }),
      });
      charge = parseJson<YabetooCharge>(YABETOO_PROVIDER_ID, confirmed.body);
    } catch (e) {
      // Deja confirme : Yabetoo repond 422 E_INVALID_STATE_TRANSITION. Le push
      // est DEJA parti — annoncer un echec serait faux. On lit l'etat reel.
      if (errorBody(e).code === 'E_INVALID_STATE_TRANSITION') {
        return this.getCharge(intentId, ctx);
      }

      // Aucune reponse, ou reponse illisible, APRES l'envoi de la confirmation :
      // le push est peut-etre parti. On ne leve pas — on rend un resultat
      // `unknown` qui PORTE l'identifiant de l'intent. Lever perdrait cette
      // reference, et le balayeur ne pourrait plus jamais trancher.
      if (isProviderError(e) && e.outcome === 'unknown') {
        return {
          providerReference: intentId,
          status: 'unknown',
          action: { type: 'none' },
          providerCode: e.code,
          providerMessage: 'Confirmation sans reponse : le push a peut-etre ete envoye.',
          raw: { intent_id: intentId, error: e.code },
        };
      }
      return refine(e);
    }

    const status = mapStatus(charge.status);

    // La confirmation ne porte pas les frais : une relecture, tolerante a
    // l'echec, les ajoute. Sans eux, la part Afripaie retombe sur l'estimation
    // du catalogue au lieu du cout reel.
    let fee: { providerFeeAmount?: number } = {};
    if (status === 'succeeded') {
      try {
        const reread = await providerFetch({
          providerId: YABETOO_PROVIDER_ID,
          method: 'GET',
          url: `${base}/v1/payment-intents/${encodeURIComponent(intentId)}`,
          headers: headers(key),
          mutating: false,
        });
        fee = feeOf(parseJson<YabetooIntent>(YABETOO_PROVIDER_ID, reread.body));
      } catch {
        // Les frais sont une information, pas une condition du succes.
      }
    }

    return {
      providerReference: intentId,
      status,
      action: status === 'pending' ? PUSH_ACTION : { type: 'none' },
      ...fee,
      ...failureOf(charge),
      raw: charge,
    };
  },

  async getCharge(providerReference: string, ctx: ProviderContext): Promise<AttemptResult> {
    const key = secretKey(ctx);

    const response = await providerFetch({
      providerId: YABETOO_PROVIDER_ID,
      method: 'GET',
      url: `${baseUrl(key)}/v1/payment-intents/${encodeURIComponent(providerReference)}`,
      headers: headers(key),
      mutating: false,
      ...(ctx.timeoutMs !== undefined ? { timeoutMs: ctx.timeoutMs } : {}),
    }).catch(refine);

    const intent = parseJson<YabetooIntent>(YABETOO_PROVIDER_ID, response.body);
    const status = mapStatus(intent.status);

    return {
      providerReference: intent.id ?? providerReference,
      status,
      action: status === 'pending' ? PUSH_ACTION : { type: 'none' },
      ...(status === 'succeeded' ? feeOf(intent) : {}),
      ...failureOf(intent),
      raw: intent,
    };
  },

  /* ------------------------------------------------------------- Decaisser */

  async createPayout(request: PayoutRequest, ctx: ProviderContext): Promise<AttemptResult> {
    const key = secretKey(ctx);

    if (request.currency.toUpperCase() !== CURRENCY) {
      throw invalid(`Yabetoo n'accepte que ${CURRENCY} (recu ${request.currency}).`);
    }

    const operator = request.recipient.network
      ? OPERATOR_BY_NETWORK[request.recipient.network.toUpperCase()]
      : undefined;
    if (!operator) throw invalid('Reseau du beneficiaire requis : MTN_CG ou AIRTEL_CG.');

    const msisdn = request.recipient.phone ? formatMsisdn(request.recipient.phone) : null;
    if (!msisdn) {
      throw invalid('Numero beneficiaire attendu : +242 suivi de 9 chiffres.');
    }

    const { first, last } = splitName(request.recipient.name);

    // Les trois regles d'un decaissement, par ordre d'importance :
    //  - `mutating: true` : un 5xx ou un delai depasse ici veut dire « peut-etre
    //    paye », jamais « echec ». C'est la lecon de l'integration PHP, ou un 5xx
    //    traite comme un refus a fait payer deux fois des organisateurs.
    //  - `Idempotency-Key` = la reference de la tentative : constate chez
    //    Yabetoo, la meme cle renvoie le meme decaissement. C'est une seconde
    //    ligne de defense, que l'integration PHP n'utilisait pas.
    //  - AUCUN rejeu ici : l'adaptateur n'en tente jamais.
    let body: string;
    try {
      const response = await providerFetch({
        providerId: YABETOO_PROVIDER_ID,
        method: 'POST',
        url: `${baseUrl(key)}/v1/disbursements`,
        headers: headers(key, request.reference),
        mutating: true,
        timeoutMs: ctx.timeoutMs ?? SLOW_TIMEOUT_MS,
        body: JSON.stringify({
          amount: request.amount,
          currency: CURRENCY,
          first_name: first,
          last_name: last,
          payment_method_data: {
            type: 'momo',
            momo: { country: COUNTRY, msisdn, operator_name: operator },
          },
          metadata: {
            afripaie_reference: request.reference,
            ...cleanMetadata(request.metadata),
          },
        }),
      });
      body = response.body;
    } catch (e) {
      return refine(e);
    }

    const disbursement = parseJson<YabetooDisbursement>(YABETOO_PROVIDER_ID, body);
    if (!disbursement.id) {
      // Reponse sans identifiant : impossible de savoir ce qui s'est passe.
      throw new ProviderError({
        providerId: YABETOO_PROVIDER_ID,
        code: 'malformed_response',
        message: 'Decaissement Yabetoo sans identifiant.',
      });
    }

    return payoutResult(disbursement, request.amount);
  },

  async getPayout(providerReference: string, ctx: ProviderContext): Promise<AttemptResult> {
    const key = secretKey(ctx);

    const response = await providerFetch({
      providerId: YABETOO_PROVIDER_ID,
      method: 'GET',
      url: `${baseUrl(key)}/v1/disbursements/${encodeURIComponent(providerReference)}`,
      headers: headers(key),
      mutating: false,
      ...(ctx.timeoutMs !== undefined ? { timeoutMs: ctx.timeoutMs } : {}),
    }).catch(refine);

    return payoutResult(parseJson<YabetooDisbursement>(YABETOO_PROVIDER_ID, response.body));
  },

  /* --------------------------------------------------------------- Webhook */

  /**
   * Signature : HMAC-SHA256 sur `horodatage + "." + corps brut`, en-tetes
   * `X-Yabetoo-Webhook-Signature` (`v1=<hex>`) et `X-Yabetoo-Webhook-Timestamp`.
   *
   * NON VERIFIE contre un vrai webhook : implemente d'apres l'integration PHP,
   * qui l'a vu fonctionner. Verifie sur les octets RECUS, pas sur un JSON
   * reserialise.
   */
  verifyWebhook(input: WebhookInput, ctx: ProviderContext): WebhookVerdict {
    const secret = ctx.credentials.webhook_secret;
    if (!secret) return { valid: false, reason: 'webhook_secret absent des credentials.' };

    const pick = (...names: string[]): string | undefined => {
      for (const name of names) {
        const raw = input.headers[name];
        const value = Array.isArray(raw) ? raw[0] : raw;
        if (value) return value;
      }
      return undefined;
    };

    // Plusieurs noms d'en-tete ont ete observes cote client : on les accepte
    // tous plutot que de rejeter un evenement authentique sur une variante.
    const signatureHeader = pick(
      'x-yabetoo-webhook-signature',
      'x-yabetoo-signature',
      'yabetoo-signature',
      'x-signature',
    );
    const timestamp = pick('x-yabetoo-webhook-timestamp', 'x-yabetoo-timestamp');
    if (!signatureHeader || !timestamp) {
      return { valid: false, reason: 'Signature ou horodatage absent.' };
    }

    const age = Math.abs(Date.now() / 1000 - Number(timestamp));
    if (!Number.isFinite(age) || age > 300) {
      return { valid: false, reason: 'Signature expiree (plus de 5 minutes).' };
    }

    // `v1=<hex>`, eventuellement plusieurs versions separees par des virgules ;
    // a defaut, la valeur brute.
    let provided = signatureHeader.trim();
    for (const part of signatureHeader.split(',')) {
      const [k, v] = part.trim().split('=', 2);
      if (k?.toLowerCase() === 'v1' && v) {
        provided = v;
        break;
      }
    }

    const expected = createHmac('sha256', secret).update(`${timestamp}.${input.rawBody}`).digest('hex');
    const a = Buffer.from(provided, 'utf8');
    const b = Buffer.from(expected, 'utf8');
    if (a.length !== b.length || !timingSafeEqual(a, b)) {
      return { valid: false, reason: 'Signature invalide.' };
    }

    let event: { id?: unknown; type?: unknown; event?: unknown; data?: unknown };
    try {
      event = JSON.parse(input.rawBody) as typeof event;
    } catch {
      return { valid: false, reason: 'Corps non JSON.' };
    }

    const type = String(event.type ?? event.event ?? '');

    // L'objet metier se trouve dans des enveloppes differentes selon
    // l'evenement : `charge`, `intent`, `disbursement`, `object`, ou `data`
    // directement. Ces cles ne portent pas toujours un objet — Yabetoo y met
    // parfois une chaine (`data.object = "disbursement"`).
    const data = event.data && typeof event.data === 'object' ? (event.data as Record<string, unknown>) : {};
    let object: Record<string, unknown> = data;
    for (const envelope of ['charge', 'intent', 'disbursement', 'object']) {
      const candidate = data[envelope];
      if (candidate && typeof candidate === 'object' && !Array.isArray(candidate)) {
        object = candidate as Record<string, unknown>;
        break;
      }
    }

    const str = (v: unknown): string | undefined => (typeof v === 'string' && v !== '' ? v : undefined);
    const id = str(object.id);
    const intentId = str(object.intentId) ?? str(object.intent_id) ?? (id?.startsWith('pi_') ? id : undefined);
    const disbursementId =
      str(object.disbursementId) ?? str(object.disbursement_id) ?? (id?.startsWith('dis_') ? id : undefined);

    const kind: Direction | 'unknown' =
      type.startsWith('disbursement.') || disbursementId
        ? 'payout'
        : type.startsWith('intent.') || intentId
          ? 'payin'
          : 'unknown';

    const providerReference = kind === 'payout' ? (disbursementId ?? id) : (intentId ?? id);

    // Un evenement authentique mais etranger a nos tentatives (les `withdraw.*`
    // concernent des operations menees directement chez Yabetoo) n'est pas une
    // signature invalide : il est accepte, sans reference exploitable, et le
    // moteur l'ignorera.
    const eventId = str(event.id) ?? `yab_${timestamp}_${providerReference ?? 'x'}`;

    const rawStatus = str(object.status);
    let status: AttemptStatus = mapStatus(rawStatus);
    if (status === 'unknown') {
      // Le suffixe du type tranche quand le champ `status` est absent.
      if (/completed|succeeded/.test(type)) status = 'succeeded';
      else if (/failed|canceled|cancelled/.test(type)) status = 'failed';
      else if (/expired/.test(type)) status = 'expired';
    }

    const code = str(object.failureCode);
    const message = str(object.failureMessage);

    return {
      valid: true,
      eventId,
      kind,
      providerReference: providerReference ?? eventId,
      status,
      ...(code ? { providerCode: code } : {}),
      ...(message ? { providerMessage: message } : {}),
      raw: event,
    };
  },
};

/* -------------------------------------------------------------------------- */

function invalid(message: string): ProviderError {
  return new ProviderError({ providerId: YABETOO_PROVIDER_ID, code: 'invalid_request', message });
}

/**
 * Resultat d'un decaissement.
 *
 * CONSTATE CONTRE LE SANDBOX : Yabetoo preleve EXACTEMENT 1,5 % sur la somme
 * versee, a tous les montants essayes (100 -> 98,5 ; 1 000 -> 985 ; 5 000 ->
 * 4 925 ; 20 000 -> 19 700 ; 50 000 -> 49 250). Le portefeuille, lui, est debite
 * de la somme DEMANDEE : 1 422,5 puis 422,5 apres deux decaissements de 500. Ces
 * 1,5 % sont donc supportes par le BENEFICIAIRE, pas par le marchand.
 *
 * `providerFeeAmount` est declare a ZERO, explicitement, et c'est le point
 * delicat. Le laisser absent n'est pas neutre : le moteur retombe alors sur
 * l'estimation du catalogue, et le grand livre afficherait des frais qui n'ont
 * jamais ete payes (constate en bout en bout : 52 pour 1 000, soit 1 052 debites
 * d'un portefeuille qui n'a perdu que 1 000). Y mettre l'ecart reel (15) serait
 * faux aussi : le grand livre credite `clearing` de la somme demandee, puis les
 * frais EN PLUS, et compterait 1 015 sorties.
 *
 * L'ecart reste visible dans le message et dans la charge brute.
 *
 * Un decaissement REFUSE reste un HTTP 200 : constate pour Airtel en sandbox,
 * `status: "failed"` avec « Airtel transfer is only available in live mode ».
 * Le statut se lit donc dans le corps, jamais dans le code HTTP.
 */
function payoutResult(d: YabetooDisbursement, requested?: number): AttemptResult {
  const status = mapStatus(d.status);

  const shortfall =
    requested !== undefined && typeof d.amount === 'number' && d.amount !== requested
      ? `Yabetoo annonce ${d.amount} pour ${requested} demandes.`
      : undefined;

  const failure = failureOf(d);

  return {
    providerReference: d.id ?? '',
    status,
    action: { type: 'none' },
    providerFeeAmount: 0,
    ...failure,
    ...(shortfall && !failure.providerMessage ? { providerMessage: shortfall } : {}),
    raw: d,
  };
}
