import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { decryptSecret, encryptSecret } from '../../core/crypto.js';
import { env } from '../../core/env.js';
import { errors } from '../../core/errors.js';
import { ID_PREFIX, newId } from '../../core/ids.js';
import { logger } from '../../core/logger.js';
import { prisma } from '../../db/client.js';

/**
 * Webhooks sortants : Orchi vers le marchand.
 *
 * Deux garanties, et une seule non-garantie assumee :
 *
 *   - AU MOINS UNE FOIS. Une livraison est retentee jusqu'a acceptation. Le
 *     marchand doit donc traiter nos evenements de facon idempotente : l'`id`
 *     de l'evenement est stable et sert exactement a cela.
 *   - SIGNEE. Le marchand peut prouver que l'evenement vient de nous.
 *   - PAS D'ORDRE GARANTI. Un `payment.succeeded` peut arriver avant le
 *     `payment.failed` d'une tentative anterieure. C'est pourquoi la charge
 *     contient l'etat COMPLET de la ressource, jamais un simple delta : le
 *     marchand n'a pas a reconstituer une chronologie.
 */

export const SIGNATURE_HEADER = 'orchi-signature';

/** Espacement des tentatives : 30 s, 2 min, 10 min, 1 h, 6 h. */
const BACKOFF_MS = [30_000, 120_000, 600_000, 3_600_000, 21_600_000];
export const MAX_DELIVERY_ATTEMPTS = BACKOFF_MS.length;

export type EventType =
  | 'payment.succeeded'
  | 'payment.failed'
  | 'payment.expired'
  | 'payment.processing'
  | 'payout.succeeded'
  | 'payout.failed'
  | 'payout.indeterminate';

/* -------------------------------------------------------------------------- */
/* Endpoints                                                                  */
/* -------------------------------------------------------------------------- */

export interface EndpointView {
  id: string;
  url: string;
  events: string[];
  environment: string;
  status: string;
  description: string | null;
  created_at: string;
}

export async function createEndpoint(input: {
  merchantId: string;
  environment: 'test' | 'live';
  url: string;
  events?: string[];
  description?: string;
}): Promise<EndpointView & { secret: string }> {
  // Le secret n'est montre qu'ici. Il est chiffre au repos comme les
  // credentials agregateurs : une fuite de la base ne doit pas permettre de
  // forger un evenement credible vers un marchand.
  const secret = `whsec_${randomBytes(24).toString('base64url')}`;

  const endpoint = await prisma.webhookEndpoint.create({
    data: {
      id: newId(ID_PREFIX.webhookEvent),
      merchantId: input.merchantId,
      environment: input.environment,
      url: input.url,
      secret: encryptSecret(secret),
      events: (input.events ?? ['*']).join(','),
      description: input.description ?? null,
    },
  });

  return { ...toView(endpoint), secret };
}

function toView(endpoint: {
  id: string;
  url: string;
  events: string;
  environment: string;
  status: string;
  description: string | null;
  createdAt: Date;
}): EndpointView {
  return {
    id: endpoint.id,
    url: endpoint.url,
    events: endpoint.events.split(',').map((e) => e.trim()).filter(Boolean),
    environment: endpoint.environment,
    status: endpoint.status,
    description: endpoint.description,
    created_at: endpoint.createdAt.toISOString(),
  };
}

export async function listEndpoints(
  merchantId: string,
  environment: 'test' | 'live',
): Promise<EndpointView[]> {
  const rows = await prisma.webhookEndpoint.findMany({
    where: { merchantId, environment },
    orderBy: { createdAt: 'asc' },
  });
  return rows.map(toView);
}

export async function disableEndpoint(merchantId: string, id: string): Promise<void> {
  const endpoint = await prisma.webhookEndpoint.findFirst({ where: { id, merchantId } });
  if (!endpoint) throw errors.notFound('Endpoint de webhook', id);
  await prisma.webhookEndpoint.update({ where: { id }, data: { status: 'DISABLED' } });
}

/* -------------------------------------------------------------------------- */
/* Signature                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * `t=<horodatage>,v1=<hmac>` ou le HMAC-SHA256 porte sur `<t>.<corps brut>`.
 *
 * L'horodatage est DANS la signature : sans lui, un attaquant qui capture un
 * evenement valide pourrait le rejouer indefiniment.
 */
export function signPayload(payload: string, secret: string, timestamp = Date.now()): string {
  const t = Math.floor(timestamp / 1000);
  const signature = createHmac('sha256', secret).update(`${t}.${payload}`).digest('hex');
  return `t=${t},v1=${signature}`;
}

/** Verification cote marchand, fournie ici pour servir de reference. */
export function verifySignature(
  payload: string,
  header: string,
  secret: string,
  toleranceSeconds = 300,
  now = Date.now(),
): boolean {
  const parts = Object.fromEntries(
    header.split(',').map((p) => {
      const [k = '', ...rest] = p.trim().split('=');
      return [k, rest.join('=')];
    }),
  );
  const t = Number(parts.t);
  if (!Number.isFinite(t) || Math.abs(now / 1000 - t) > toleranceSeconds) return false;

  const expected = createHmac('sha256', secret).update(`${t}.${payload}`).digest('hex');
  const a = Buffer.from(parts.v1 ?? '', 'utf8');
  const b = Buffer.from(expected, 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
}

/* -------------------------------------------------------------------------- */
/* Emission                                                                   */
/* -------------------------------------------------------------------------- */

function subscribes(endpointEvents: string, type: EventType): boolean {
  const events = endpointEvents.split(',').map((e) => e.trim());
  return events.includes('*') || events.includes(type);
}

/**
 * Met en file un evenement pour tous les endpoints concernes du marchand.
 *
 * `eventId` doit etre STABLE : il est derive de la ressource et de son etat,
 * pas d'un aleas. Deux emissions du meme changement d'etat produisent donc le
 * meme identifiant, la contrainte d'unicite absorbe le doublon, et le marchand
 * n'est pas notifie deux fois.
 */
export async function emitEvent(input: {
  merchantId: string;
  environment: 'test' | 'live';
  type: EventType;
  resourceId: string;
  data: unknown;
}): Promise<number> {
  const endpoints = await prisma.webhookEndpoint.findMany({
    where: { merchantId: input.merchantId, environment: input.environment, status: 'ACTIVE' },
  });

  const targets = endpoints.filter((e) => subscribes(e.events, input.type));
  if (targets.length === 0) return 0;

  const eventId = `evt_${input.resourceId}_${input.type}`;
  const payload = JSON.stringify({
    id: eventId,
    type: input.type,
    created_at: new Date().toISOString(),
    // Etat COMPLET de la ressource : l'ordre de livraison n'etant pas garanti,
    // un delta serait ininterpretable.
    data: input.data,
  });

  let queued = 0;
  for (const endpoint of targets) {
    try {
      await prisma.outboundDelivery.create({
        data: {
          id: newId(ID_PREFIX.webhookEvent),
          merchantId: input.merchantId,
          endpointId: endpoint.id,
          eventType: input.type,
          eventId,
          payload,
          nextAttemptAt: new Date(),
        },
      });
      queued += 1;
    } catch {
      // Violation d'unicite : cet evenement est deja en file pour cet endpoint.
      // C'est le comportement voulu, pas une erreur.
    }
  }

  return queued;
}

/* -------------------------------------------------------------------------- */
/* Livraison                                                                  */
/* -------------------------------------------------------------------------- */

export interface DeliveryOutcome {
  delivered: number;
  failed: number;
  exhausted: number;
}

/**
 * Livre les evenements dus. Appelee par le worker, et directement par les
 * tests pour rester deterministe.
 */
export async function deliverDueEvents(limit = 20, now = new Date()): Promise<DeliveryOutcome> {
  const due = await prisma.outboundDelivery.findMany({
    where: { status: 'PENDING', nextAttemptAt: { lte: now } },
    include: { endpoint: true },
    orderBy: { nextAttemptAt: 'asc' },
    take: limit,
  });

  const outcome: DeliveryOutcome = { delivered: 0, failed: 0, exhausted: 0 };

  for (const delivery of due) {
    if (delivery.endpoint.status !== 'ACTIVE') {
      await prisma.outboundDelivery.update({
        where: { id: delivery.id },
        data: { status: 'FAILED', lastError: 'Endpoint desactive.' },
      });
      outcome.exhausted += 1;
      continue;
    }

    const attempt = delivery.attempts + 1;
    let secret: string;
    try {
      secret = decryptSecret(delivery.endpoint.secret);
    } catch (e) {
      logger.error({ err: e, endpoint: delivery.endpointId }, 'Secret de webhook illisible');
      await prisma.outboundDelivery.update({
        where: { id: delivery.id },
        data: { status: 'FAILED', lastError: 'Secret illisible.' },
      });
      outcome.exhausted += 1;
      continue;
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), env.WEBHOOK_DELIVERY_TIMEOUT_MS);

    let statusCode: number | null = null;
    let error: string | null = null;

    try {
      const response = await fetch(delivery.endpoint.url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          [SIGNATURE_HEADER]: signPayload(delivery.payload, secret),
          'orchi-event-id': delivery.eventId,
          'orchi-event-type': delivery.eventType,
          'orchi-delivery-attempt': String(attempt),
        },
        body: delivery.payload,
        signal: controller.signal,
      });
      statusCode = response.status;
      if (!response.ok) error = `HTTP ${response.status}`;
    } catch (e) {
      error = e instanceof Error ? e.message : 'Echec reseau';
    } finally {
      clearTimeout(timer);
    }

    if (error === null) {
      await prisma.outboundDelivery.update({
        where: { id: delivery.id },
        data: {
          status: 'DELIVERED',
          attempts: attempt,
          lastStatusCode: statusCode,
          lastError: null,
          deliveredAt: new Date(),
        },
      });
      outcome.delivered += 1;
      continue;
    }

    const exhausted = attempt >= MAX_DELIVERY_ATTEMPTS;
    await prisma.outboundDelivery.update({
      where: { id: delivery.id },
      data: {
        status: exhausted ? 'FAILED' : 'PENDING',
        attempts: attempt,
        lastStatusCode: statusCode,
        lastError: error.slice(0, 500),
        nextAttemptAt: new Date(
          now.getTime() + (BACKOFF_MS[Math.min(attempt, BACKOFF_MS.length - 1)] ?? 0),
        ),
      },
    });

    if (exhausted) {
      outcome.exhausted += 1;
      logger.warn(
        { delivery: delivery.id, endpoint: delivery.endpointId, attempts: attempt },
        'Livraison abandonnee apres epuisement des tentatives',
      );
    } else {
      outcome.failed += 1;
    }
  }

  return outcome;
}
