import { createHash } from 'node:crypto';
import { AppError } from './errors.js';
import { ID_PREFIX, newId } from './ids.js';
import { prisma } from '../db/client.js';

/**
 * Idempotence des endpoints qui deplacent de l'argent.
 *
 * Regle : l'enregistrement est cree AVANT tout appel agregateur. Un rejeu
 * pendant le traitement recoit une 409 explicite plutot que de declencher un
 * second paiement en parallele.
 *
 * Ce mecanisme n'est PAS la seule protection : l'unicite de
 * (merchantId, reference) sur Payment et Payout est le filet definitif. Une cle
 * d'idempotence expire au bout de 24 h, une reference marchand jamais.
 */

const TTL_HOURS = 24;

/** Serialisation stable : l'ordre des cles ne doit pas changer l'empreinte. */
function canonicalize(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${JSON.stringify(k)}:${canonicalize(v)}`);
  return `{${entries.join(',')}}`;
}

export function hashPayload(payload: unknown): string {
  return createHash('sha256').update(canonicalize(payload)).digest('hex');
}

/* -------------------------------------------------------------------------- */
/* Erreurs specifiques                                                        */
/* -------------------------------------------------------------------------- */

export const idempotencyErrors = {
  keyRequired: () =>
    new AppError({
      type: 'idempotency_error',
      code: 'idempotency_key_required',
      message: "En-tete Idempotency-Key obligatoire sur cet endpoint.",
      httpStatus: 400,
      retriable: false,
    }),

  keyReused: (endpoint: string) =>
    new AppError({
      type: 'idempotency_error',
      code: 'idempotency_key_reused',
      message:
        "Cette cle d'idempotence a deja ete utilisee avec un corps de requete different.",
      httpStatus: 409,
      retriable: false,
      details: { endpoint },
    }),

  inProgress: (resourceId: string | null) =>
    new AppError({
      type: 'idempotency_error',
      code: 'request_in_progress',
      message:
        "Une requete portant cette cle d'idempotence est en cours de traitement. " +
        'Ne la rejouez pas : interrogez la ressource.',
      httpStatus: 409,
      retriable: true,
      details: { ...(resourceId ? { resource_id: resourceId } : {}), retry_after: 2 },
    }),
} as const;

/* -------------------------------------------------------------------------- */

export interface IdempotentExecution<T> {
  status: number;
  body: T;
}

export interface IdempotencyResult<T> extends IdempotentExecution<T> {
  /** true si la reponse provient d'un traitement anterieur. */
  replayed: boolean;
}

export interface WithIdempotencyOptions<T> {
  merchantId: string;
  key: string | undefined;
  endpoint: string;
  /** Corps de la requete, servant d'empreinte. */
  payload: unknown;
  /**
   * `linkResource` doit etre appele des que l'identifiant de la ressource
   * existe, avant tout appel sortant : c'est ce qui permet a un rejeu
   * concurrent de recevoir une 409 qui DESIGNE la ressource, au lieu d'une
   * erreur aveugle.
   */
  execute: (linkResource: (resourceId: string) => Promise<void>) => Promise<IdempotentExecution<T>>;
}

interface StoredRecord {
  requestHash: string;
  endpoint: string;
  status: string;
  responseStatus: number | null;
  responseBody: string | null;
  resourceId: string | null;
}

function replayOrReject<T>(existing: StoredRecord, requestHash: string): IdempotencyResult<T> {
  if (existing.requestHash !== requestHash) throw idempotencyErrors.keyReused(existing.endpoint);

  if (existing.status === 'COMPLETED' && existing.responseBody !== null) {
    return {
      replayed: true,
      status: existing.responseStatus ?? 200,
      body: JSON.parse(existing.responseBody) as T,
    };
  }

  // Traitement encore en cours : surtout pas un second appel agregateur.
  throw idempotencyErrors.inProgress(existing.resourceId);
}

export async function withIdempotency<T>(
  options: WithIdempotencyOptions<T>,
): Promise<IdempotencyResult<T>> {
  const { merchantId, key, endpoint, payload } = options;
  if (!key || key.trim().length === 0) throw idempotencyErrors.keyRequired();

  const requestHash = hashPayload(payload);
  const now = new Date();
  const recordId = newId(ID_PREFIX.webhookEvent);

  // Chemin rapide : un rejeu est un cas NOMINAL sur une API de paiement, pas
  // une anomalie. Le lire d'abord evite de produire une violation de contrainte
  // — et le log d'erreur qui va avec — a chaque reprise.
  const known = await prisma.idempotencyRecord.findUnique({
    where: { merchantId_key: { merchantId, key } },
  });
  if (known) return replayOrReject<T>(known, requestHash);

  let created = true;
  try {
    await prisma.idempotencyRecord.create({
      data: {
        id: recordId,
        merchantId,
        key,
        requestHash,
        endpoint,
        status: 'IN_PROGRESS',
        expiresAt: new Date(now.getTime() + TTL_HOURS * 3600 * 1000),
      },
    });
  } catch {
    // Violation d'unicite : une requete portant cette cle existe deja.
    created = false;
  }

  if (!created) {
    // Course entre deux requetes portant la meme cle : la perdante relit.
    const existing = await prisma.idempotencyRecord.findUnique({
      where: { merchantId_key: { merchantId, key } },
    });
    if (!existing) throw idempotencyErrors.inProgress(null);
    return replayOrReject<T>(existing, requestHash);
  }

  const linkResource = async (resourceId: string) => {
    await prisma.idempotencyRecord.update({ where: { id: recordId }, data: { resourceId } });
  };

  const result = await options.execute(linkResource);

  await prisma.idempotencyRecord.update({
    where: { id: recordId },
    data: {
      status: 'COMPLETED',
      responseStatus: result.status,
      responseBody: JSON.stringify(result.body),
    },
  });

  return { ...result, replayed: false };
}

/**
 * Purge des cles expirees. Appelee par un worker a l'etape 6 ; exposee ici pour
 * que la duree de vie reste definie au meme endroit que la regle.
 */
export async function purgeExpiredIdempotencyKeys(now = new Date()): Promise<number> {
  const { count } = await prisma.idempotencyRecord.deleteMany({
    where: { expiresAt: { lt: now } },
  });
  return count;
}
