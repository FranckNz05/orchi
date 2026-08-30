import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { withIdempotency } from '../../core/idempotency.js';
import {
  createPayment,
  listPayments,
  refreshPayment,
  retryPayment,
  serializePayment,
} from '../../modules/payments.js';

const CHANNELS = ['mobile_money', 'card', 'bank_transfer'] as const;

const createBody = z.object({
  /** Reference du marchand. Filet definitif contre les doublons. */
  reference: z.string().min(1).max(120),
  /** Montant en unites mineures. 15000 XOF = 15 000 francs. */
  amount: z.number().int().positive(),
  currency: z.string().length(3),
  country: z.string().length(2),
  channel: z.enum(CHANNELS),
  network: z.string().max(60).optional(),
  customer: z
    .object({
      phone: z.string().min(6).max(20).optional(),
      email: z.string().email().optional(),
      name: z.string().max(120).optional(),
    })
    .default({}),
  description: z.string().max(500).optional(),
  metadata: z.record(z.string()).optional(),
  return_url: z.string().url().optional(),
  /** Force un agregateur precis. Reserve au debogage et aux cas contractuels. */
  provider: z.string().optional(),
});

const listQuery = z.object({
  status: z.enum(['CREATED', 'PROCESSING', 'SUCCEEDED', 'FAILED', 'EXPIRED']).optional(),
  country: z.string().length(2).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  starting_after: z.string().optional(),
});

function idempotencyKey(request: FastifyRequest): string | undefined {
  const header = request.headers['idempotency-key'];
  return Array.isArray(header) ? header[0] : header;
}

export async function paymentRoutes(app: FastifyInstance) {
  /**
   * Creation d'un encaissement.
   *
   * La reponse ne dit jamais "paye" : elle renvoie un statut et une ACTION a
   * faire executer par le client final. Un paiement mobile money est asynchrone
   * par nature — l'operateur envoie un push USSD, et la confirmation arrive
   * plus tard.
   */
  app.post(
    '/v1/payments',
    { preHandler: [app.authenticate, app.requireScope('payments:write')] },
    async (request, reply) => {
      const body = createBody.parse(request.body);
      const auth = request.auth!;

      const result = await withIdempotency({
        merchantId: auth.merchantId,
        key: idempotencyKey(request),
        endpoint: 'POST /v1/payments',
        payload: body,
        execute: async (linkResource) => {
          const { payment, attempts } = await createPayment(
            {
              merchantId: auth.merchantId,
              environment: auth.environment,
              reference: body.reference,
              amount: body.amount,
              currency: body.currency,
              country: body.country,
              channel: body.channel,
              ...(body.network ? { network: body.network } : {}),
              customer: body.customer,
              ...(body.description ? { description: body.description } : {}),
              ...(body.metadata ? { metadata: body.metadata } : {}),
              ...(body.return_url ? { returnUrl: body.return_url } : {}),
              ...(body.provider ? { preferredProviderId: body.provider } : {}),
            },
            linkResource,
          );
          return { status: 201, body: serializePayment(payment, attempts) };
        },
      });

      reply.header('Idempotent-Replayed', String(result.replayed));
      return reply.status(result.status).send(result.body);
    },
  );

  /** Liste paginee, du plus recent au plus ancien. */
  app.get('/v1/payments', { preHandler: app.authenticate }, async (request) => {
    const query = listQuery.parse(request.query);
    return listPayments(request.auth!.merchantId, {
      ...(query.status ? { status: query.status } : {}),
      ...(query.country ? { country: query.country } : {}),
      ...(query.starting_after ? { startingAfter: query.starting_after } : {}),
      limit: query.limit,
    });
  });

  /**
   * Lecture. Interroge l'agregateur si la tentative en cours n'est pas
   * terminee : a l'etape 3 c'est le seul moteur d'avancement, les webhooks
   * arrivant a l'etape 6.
   */
  app.get('/v1/payments/:id', { preHandler: app.authenticate }, async (request) => {
    const { id } = z.object({ id: z.string() }).parse(request.params);
    const { payment, attempts } = await refreshPayment(request.auth!.merchantId, id);
    return serializePayment(payment, attempts);
  });

  /** Nouvelle tentative chez un autre agregateur. */
  app.post(
    '/v1/payments/:id/retry',
    { preHandler: [app.authenticate, app.requireScope('payments:write')] },
    async (request) => {
      const { id } = z.object({ id: z.string() }).parse(request.params);
      const auth = request.auth!;
      const { payment, attempts } = await retryPayment(auth.merchantId, id, auth.environment);
      return serializePayment(payment, attempts);
    },
  );
}
