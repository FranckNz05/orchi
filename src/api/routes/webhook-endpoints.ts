import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { reconciliationReport } from '../../modules/reconciliation.js';
import {
  createEndpoint,
  disableEndpoint,
  listEndpoints,
} from '../../modules/webhooks/outbound.js';
import { prisma } from '../../db/client.js';

const createBody = z.object({
  url: z.string().url(),
  /** Evenements souscrits. `*` par defaut. */
  events: z.array(z.string().min(1)).optional(),
  description: z.string().max(200).optional(),
});

export async function webhookEndpointRoutes(app: FastifyInstance) {
  /**
   * Declare un endpoint. Le secret de signature n'est renvoye qu'ici : il n'est
   * jamais relisible ensuite, comme une cle API.
   */
  app.post(
    '/v1/webhook-endpoints',
    { preHandler: [app.authenticate, app.requireScope('accounts:write')] },
    async (request, reply) => {
      const body = createBody.parse(request.body);
      const auth = request.auth!;
      const endpoint = await createEndpoint({
        merchantId: auth.merchantId,
        environment: auth.environment,
        url: body.url,
        ...(body.events ? { events: body.events } : {}),
        ...(body.description ? { description: body.description } : {}),
      });
      return reply.status(201).send(endpoint);
    },
  );

  app.get('/v1/webhook-endpoints', { preHandler: app.authenticate }, async (request) => {
    const auth = request.auth!;
    const data = await listEndpoints(auth.merchantId, auth.environment);
    return { object: 'list', count: data.length, data };
  });

  app.delete(
    '/v1/webhook-endpoints/:id',
    { preHandler: [app.authenticate, app.requireScope('accounts:write')] },
    async (request, reply) => {
      const { id } = z.object({ id: z.string() }).parse(request.params);
      await disableEndpoint(request.auth!.merchantId, id);
      return reply.status(204).send();
    },
  );

  /** Journal de livraison : indispensable au support d'une integration. */
  app.get('/v1/webhook-deliveries', { preHandler: app.authenticate }, async (request) => {
    const query = z
      .object({
        status: z.enum(['PENDING', 'DELIVERED', 'FAILED']).optional(),
        limit: z.coerce.number().int().min(1).max(100).default(50),
      })
      .parse(request.query);

    const rows = await prisma.outboundDelivery.findMany({
      where: {
        merchantId: request.auth!.merchantId,
        ...(query.status ? { status: query.status } : {}),
      },
      orderBy: { createdAt: 'desc' },
      take: query.limit,
    });

    return {
      object: 'list',
      count: rows.length,
      data: rows.map((d) => ({
        id: d.id,
        endpoint_id: d.endpointId,
        event_id: d.eventId,
        event_type: d.eventType,
        status: d.status,
        attempts: d.attempts,
        last_status_code: d.lastStatusCode,
        last_error: d.lastError,
        next_attempt_at: d.nextAttemptAt.toISOString(),
        delivered_at: d.deliveredAt?.toISOString() ?? null,
        created_at: d.createdAt.toISOString(),
      })),
    };
  });

  /**
   * Journal des notifications RECUES des agregateurs.
   *
   * Distinct des livraisons sortantes : c'est le seul endroit ou l'on voit
   * qu'un agregateur envoie des webhooks mal signes — signal de securite qui
   * n'apparait nulle part ailleurs.
   */
  app.get('/v1/inbound-webhooks', { preHandler: app.authenticate }, async (request) => {
    const query = z
      .object({
        outcome: z.enum(['APPLIED', 'IGNORED', 'REJECTED', 'POLLED', 'RECEIVED']).optional(),
        limit: z.coerce.number().int().min(1).max(100).default(50),
      })
      .parse(request.query);

    const rows = await prisma.inboundWebhook.findMany({
      where: {
        merchantId: request.auth!.merchantId,
        ...(query.outcome ? { outcome: query.outcome } : {}),
      },
      orderBy: { createdAt: 'desc' },
      take: query.limit,
    });

    return {
      object: 'list',
      count: rows.length,
      data: rows.map((w) => ({
        id: w.id,
        provider: w.providerId,
        event_id: w.eventId,
        kind: w.kind,
        status: w.status,
        signature_valid: w.signatureValid,
        outcome: w.outcome,
        note: w.note,
        reject_reason: w.rejectReason,
        provider_reference: w.providerReference,
        created_at: w.createdAt.toISOString(),
      })),
    };
  });

  /**
   * Etat des points a trancher : decaissements indetermines, paiements
   * enlises, evenements non livres, webhooks rejetes.
   */
  app.get('/v1/reconciliation', { preHandler: app.authenticate }, async (request) => {
    return reconciliationReport(request.auth!.merchantId);
  });
}
