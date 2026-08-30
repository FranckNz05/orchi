import { createHmac, timingSafeEqual } from 'node:crypto';
import type { Channel } from '../catalog/coverage.js';
import { ProviderError } from './errors.js';
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
 * Simulateur interne.
 *
 * Il n'existe pas pour "faire semblant" en attendant les vrais agregateurs,
 * mais pour produire a la demande les situations qu'aucun sandbox tiers ne sait
 * declencher de maniere fiable : timeout reseau, panne, quota depasse, client
 * qui ne confirme jamais, webhook duplique. Ce sont precisement les cas ou un
 * orchestrateur perd de l'argent.
 *
 * Le scenario est choisi de facon DETERMINISTE :
 *   1. `metadata.sandbox_scenario` s'il est fourni (seule option en carte) ;
 *   2. sinon les 4 derniers chiffres du numero de telephone ;
 *   3. sinon succes.
 *
 * Actif uniquement en environnement `test` : `createCharge` refuse un contexte
 * `live`.
 */

export const SANDBOX_PROVIDER_ID = 'sandbox';

export type SandboxScenario =
  | 'success'
  | 'slow_success'
  | 'declined'
  | 'timeout'
  | 'unavailable'
  | 'rate_limited'
  | 'auth_error'
  | 'expired';

/** Suffixes de numero declenchant chaque scenario. */
export const SCENARIO_BY_PHONE_SUFFIX: Readonly<Record<string, SandboxScenario>> = {
  '0000': 'success',
  '0001': 'slow_success',
  '0002': 'declined',
  '0003': 'timeout',
  '0004': 'unavailable',
  '0005': 'rate_limited',
  '0006': 'auth_error',
  '0007': 'expired',
};

/** Nombre d'interrogations avant confirmation en scenario `slow_success`. */
const SLOW_SUCCESS_POLLS = 2;
/** Duree de validite d'un push USSD simule. */
const ACTION_TTL_MS = 5 * 60 * 1000;

interface SandboxRecord {
  providerReference: string;
  direction: Direction;
  reference: string;
  amount: number;
  currency: string;
  scenario: SandboxScenario;
  status: AttemptStatus;
  polls: number;
  createdAt: number;
  action: CustomerAction;
  providerCode?: string;
  providerMessage?: string;
}

/**
 * Etat en memoire du processus. Suffisant et volontaire : le simulateur doit
 * pouvoir etre remis a zero entre deux tests sans toucher a la base.
 */
const store = new Map<string, SandboxRecord>();
/** Index par reference de tentative : rejouer la meme reference ne cree rien. */
const byReference = new Map<string, string>();

export function resetSandbox(): void {
  store.clear();
  byReference.clear();
}

export function sandboxRecord(providerReference: string): SandboxRecord | undefined {
  return store.get(providerReference);
}

function pickScenario(
  metadata: Record<string, string> | undefined,
  phone: string | undefined,
): SandboxScenario {
  const explicit = metadata?.sandbox_scenario;
  if (explicit) {
    if (!(explicit in SCENARIO_LOOKUP)) {
      throw new ProviderError({
        providerId: SANDBOX_PROVIDER_ID,
        code: 'invalid_request',
        message: `Scenario sandbox inconnu : ${explicit}.`,
      });
    }
    return explicit as SandboxScenario;
  }

  if (phone) {
    const digits = phone.replace(/\D/g, '');
    const suffix = digits.slice(-4);
    const mapped = SCENARIO_BY_PHONE_SUFFIX[suffix];
    if (mapped) return mapped;
  }

  return 'success';
}

const SCENARIO_LOOKUP: Record<SandboxScenario, true> = {
  success: true,
  slow_success: true,
  declined: true,
  timeout: true,
  unavailable: true,
  rate_limited: true,
  auth_error: true,
  expired: true,
};

/** Traduit les scenarios d'echec immediat en ProviderError typee. */
function throwIfImmediateFailure(scenario: SandboxScenario): void {
  switch (scenario) {
    case 'timeout':
      // Volontairement `timeout` : outcome `unknown`, donc aucun rejeu autorise.
      throw new ProviderError({
        providerId: SANDBOX_PROVIDER_ID,
        code: 'timeout',
        message: 'Aucune reponse du simulateur (scenario timeout).',
      });
    case 'unavailable':
      throw new ProviderError({
        providerId: SANDBOX_PROVIDER_ID,
        code: 'unavailable',
        message: 'Simulateur indisponible (scenario unavailable).',
        httpStatus: 503,
      });
    case 'rate_limited':
      throw new ProviderError({
        providerId: SANDBOX_PROVIDER_ID,
        code: 'rate_limited',
        message: 'Quota simule depasse.',
        httpStatus: 429,
      });
    case 'auth_error':
      throw new ProviderError({
        providerId: SANDBOX_PROVIDER_ID,
        code: 'authentication',
        message: 'Credentials sandbox invalides.',
        httpStatus: 401,
      });
    default:
      return;
  }
}

function deterministicReference(direction: Direction, reference: string): string {
  const digest = createHmac('sha256', 'orchi-sandbox').update(`${direction}:${reference}`).digest('hex');
  return `sbx_${direction === 'payin' ? 'ch' : 'po'}_${digest.slice(0, 20)}`;
}

/**
 * L'action depend du STATUT atteint, pas du scenario : seul un encaissement
 * laisse en attente du client demande une action. Un decaissement part sans
 * intervention, un refus n'a rien a proposer.
 */
function initialAction(
  channel: Channel,
  direction: Direction,
  status: AttemptStatus,
): CustomerAction {
  if (direction !== 'payin' || status !== 'awaiting_customer') return { type: 'none' };
  const expiresAt = new Date(Date.now() + ACTION_TTL_MS).toISOString();
  if (channel === 'card') {
    return { type: 'redirect', url: `https://sandbox.orchi.local/pay/${Date.now()}`, expiresAt };
  }
  return {
    type: 'ussd_push',
    instructions: 'Un push a ete envoye sur le telephone du client. Il doit saisir son code PIN.',
    expiresAt,
  };
}

function toResult(record: SandboxRecord): AttemptResult {
  return {
    providerReference: record.providerReference,
    status: record.status,
    action: record.status === 'awaiting_customer' ? record.action : { type: 'none' },
    ...(record.providerCode !== undefined ? { providerCode: record.providerCode } : {}),
    ...(record.providerMessage !== undefined ? { providerMessage: record.providerMessage } : {}),
    raw: { ...record },
  };
}

function assertTestEnvironment(ctx: ProviderContext): void {
  if (ctx.environment !== 'test') {
    throw new ProviderError({
      providerId: SANDBOX_PROVIDER_ID,
      code: 'invalid_request',
      message: "Le simulateur est interdit en environnement live.",
    });
  }
}

function create(
  direction: Direction,
  request: { reference: string; amount: number; currency: string; channel: Channel; metadata?: Record<string, string> },
  phone: string | undefined,
  ctx: ProviderContext,
): AttemptResult {
  assertTestEnvironment(ctx);

  const existingRef = byReference.get(`${direction}:${request.reference}`);
  if (existingRef) {
    // Un agregateur serieux refuse deux fois la meme reference. Le simulateur
    // renvoie l'etat existant : c'est ce qui permet de tester l'idempotence.
    return toResult(store.get(existingRef)!);
  }

  const scenario = pickScenario(request.metadata, phone);
  throwIfImmediateFailure(scenario);

  const providerReference = deterministicReference(direction, request.reference);

  let status: AttemptStatus;
  let providerCode: string | undefined;
  let providerMessage: string | undefined;

  if (scenario === 'declined') {
    status = 'failed';
    providerCode = 'insufficient_funds';
    providerMessage = 'Solde insuffisant sur le compte du client.';
  } else if (scenario === 'success') {
    // Un decaissement part immediatement ; un encaissement attend le client.
    status = direction === 'payout' ? 'succeeded' : 'awaiting_customer';
  } else {
    status = direction === 'payout' ? 'pending' : 'awaiting_customer';
  }

  const record: SandboxRecord = {
    providerReference,
    direction,
    reference: request.reference,
    amount: request.amount,
    currency: request.currency,
    scenario,
    status,
    polls: 0,
    createdAt: Date.now(),
    action: initialAction(request.channel, direction, status),
    ...(providerCode !== undefined ? { providerCode } : {}),
    ...(providerMessage !== undefined ? { providerMessage } : {}),
  };

  store.set(providerReference, record);
  byReference.set(`${direction}:${request.reference}`, providerReference);
  return toResult(record);
}

function advance(record: SandboxRecord): SandboxRecord {
  if (record.status === 'succeeded' || record.status === 'failed' || record.status === 'expired') {
    return record;
  }

  record.polls += 1;

  switch (record.scenario) {
    case 'success':
      record.status = 'succeeded';
      break;
    case 'slow_success':
      if (record.polls >= SLOW_SUCCESS_POLLS) record.status = 'succeeded';
      else record.status = record.direction === 'payout' ? 'pending' : 'awaiting_customer';
      break;
    case 'expired':
      if (Date.now() - record.createdAt >= ACTION_TTL_MS) {
        record.status = 'expired';
        record.providerCode = 'customer_timeout';
        record.providerMessage = "Le client n'a jamais confirme.";
      }
      break;
    default:
      break;
  }

  return record;
}

function read(direction: Direction, providerReference: string, ctx: ProviderContext): AttemptResult {
  assertTestEnvironment(ctx);
  const record = store.get(providerReference);
  if (!record || record.direction !== direction) {
    throw new ProviderError({
      providerId: SANDBOX_PROVIDER_ID,
      code: 'invalid_request',
      message: `Reference simulateur inconnue : ${providerReference}.`,
      httpStatus: 404,
    });
  }
  return toResult(advance(record));
}

/* -------------------------------------------------------------------------- */
/* Webhooks                                                                   */
/* -------------------------------------------------------------------------- */

export const SANDBOX_SIGNATURE_HEADER = 'x-orchi-sandbox-signature';

export function signSandboxPayload(payload: string, secret: string): string {
  return createHmac('sha256', secret).update(payload).digest('hex');
}

/** Fabrique un webhook signe, tel que l'enverrait un vrai agregateur. */
export function buildSandboxWebhook(
  providerReference: string,
  secret: string,
  overrides: Partial<{ eventId: string; status: AttemptStatus }> = {},
): { body: string; headers: Record<string, string> } {
  const record = store.get(providerReference);
  if (!record) throw new Error(`Reference simulateur inconnue : ${providerReference}.`);

  const body = JSON.stringify({
    event_id: overrides.eventId ?? `evt_sbx_${record.providerReference.slice(-12)}_${record.polls}`,
    type: record.direction === 'payin' ? 'charge.updated' : 'payout.updated',
    reference: record.providerReference,
    merchant_reference: record.reference,
    status: overrides.status ?? record.status,
    amount: record.amount,
    currency: record.currency,
  });

  return { body, headers: { [SANDBOX_SIGNATURE_HEADER]: signSandboxPayload(body, secret) } };
}

interface SandboxWebhookBody {
  event_id?: unknown;
  type?: unknown;
  reference?: unknown;
  status?: unknown;
}

const WEBHOOK_STATUSES: readonly AttemptStatus[] = [
  'pending',
  'awaiting_customer',
  'succeeded',
  'failed',
  'expired',
  'unknown',
];

/* -------------------------------------------------------------------------- */
/* L'adaptateur                                                               */
/* -------------------------------------------------------------------------- */

export const sandboxProvider: PaymentProvider = {
  id: SANDBOX_PROVIDER_ID,
  name: 'Orchi Sandbox',
  requiredCredentials: ['webhook_secret'],

  supports(_country: string, _channel: Channel, _direction: Direction): boolean {
    return true;
  },

  async createCharge(request: ChargeRequest, ctx: ProviderContext): Promise<AttemptResult> {
    return create('payin', request, request.customer.phone, ctx);
  },

  async getCharge(providerReference: string, ctx: ProviderContext): Promise<AttemptResult> {
    return read('payin', providerReference, ctx);
  },

  async createPayout(request: PayoutRequest, ctx: ProviderContext): Promise<AttemptResult> {
    return create('payout', request, request.recipient.phone, ctx);
  },

  async getPayout(providerReference: string, ctx: ProviderContext): Promise<AttemptResult> {
    return read('payout', providerReference, ctx);
  },

  verifyWebhook(input: WebhookInput, ctx: ProviderContext): WebhookVerdict {
    const secret = ctx.credentials.webhook_secret;
    if (!secret) return { valid: false, reason: 'webhook_secret absent des credentials.' };

    const header = input.headers[SANDBOX_SIGNATURE_HEADER];
    const received = Array.isArray(header) ? header[0] : header;
    if (!received) return { valid: false, reason: 'Signature absente.' };

    const expected = signSandboxPayload(input.rawBody, secret);
    const a = Buffer.from(received, 'utf8');
    const b = Buffer.from(expected, 'utf8');
    if (a.length !== b.length || !timingSafeEqual(a, b)) {
      return { valid: false, reason: 'Signature invalide.' };
    }

    let parsed: SandboxWebhookBody;
    try {
      parsed = JSON.parse(input.rawBody) as SandboxWebhookBody;
    } catch {
      return { valid: false, reason: 'Corps non JSON.' };
    }

    const reference = typeof parsed.reference === 'string' ? parsed.reference : undefined;
    const eventId = typeof parsed.event_id === 'string' ? parsed.event_id : undefined;
    const status = parsed.status as AttemptStatus;

    if (!reference || !eventId) return { valid: false, reason: 'Champs reference / event_id manquants.' };
    if (!WEBHOOK_STATUSES.includes(status)) {
      return { valid: false, reason: `Statut inconnu : ${String(parsed.status)}.` };
    }

    return {
      valid: true,
      eventId,
      kind: parsed.type === 'payout.updated' ? 'payout' : 'payin',
      providerReference: reference,
      status,
      raw: parsed,
    };
  },
};
