import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { withIdempotency } from '../../core/idempotency.js';
import {
  createPayout,
  listPayouts,
  refreshPayout,
  retryPayout,
  serializePayout,
} from '../../modules/payouts.js';

const CHANNELS = ['mobile_money', 'card', 'bank_transfer'] as const;

const createBody = z.object({
  reference: z.string().min(1).max(120),
  amount: z.number().int().positive(),
  currency: z.string().length(3),
  country: z.string().length(2),
  channel: z.enum(CHANNELS).default('mobile_money'),
  recipient: z.object({
    phone: z.string().min(6).max(20).optional(),
    network: z.string().max(60).optional(),
    account_number: z.string().max(64).optional(),
    bank_code: z.string().max(32).optional(),
    name: z.string().max(120).optional(),
  }),
  description: z.string().max(500).optional(),
  metadata: z.record(z.string()).optional(),
  provider: z.string().optional(),
});

const listQuery = z.object({
  status: z.enum(['CREATED', 'PROCESSING', 'SUCCEEDED', 'FAILED', 'UNKNOWN']).optional(),
  country: z.string().length(2).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  starting_after: z.string().optional(),
});

function idempotencyKey(request: FastifyRequest): string | undefined {
  const header = request.headers['idempotency-key'];
  return Array.isArray(header) ? header[0] : header;
}

export async function payoutRoutes(app: FastifyInstance) {
  /**
   * Creation d'un decaissement.
   *
   * `Idempotency-Key` est obligatoire, et la `reference` marchand constitue le
   * second filet : contrairement a la cle, elle n'expire jamais.
   */
  app.post(
    '/v1/payouts',
    { preHandler: [app.authenticate, app.requireScope('payouts:write')] },
    async (request, reply) => {
      const body = createBody.parse(request.body);
      const auth = request.auth!;

      const result = await withIdempotency({
        merchantId: auth.merchantId,
        key: idempotencyKey(request),
        endpoint: 'POST /v1/payouts',
        payload: body,
        execute: async (linkResource) => {
          const { payout, attempts } = await createPayout(
            {
              merchantId: auth.merchantId,
              environment: auth.environment,
              reference: body.reference,
              amount: body.amount,
              currency: body.currency,
              country: body.country,
              channel: body.channel,
              recipient: {
                ...(body.recipient.phone ? { phone: body.recipient.phone } : {}),
                ...(body.recipient.network ? { network: body.recipient.network } : {}),
                ...(body.recipient.account_number
                  ? { accountNumber: body.recipient.account_number }
                  : {}),
                ...(body.recipient.bank_code ? { bankCode: body.recipient.bank_code } : {}),
                ...(body.recipient.name ? { name: body.recipient.name } : {}),
              },
              ...(body.description ? { description: body.description } : {}),
              ...(body.metadata ? { metadata: body.metadata } : {}),
              ...(body.provider ? { preferredProviderId: body.provider } : {}),
            },
            linkResource,
          );
          return { status: 201, body: serializePayout(payout, attempts) };
        },
      });

      reply.header('Idempotent-Replayed', String(result.replayed));
      return reply.status(result.status).send(result.body);
    },
  );

  /** Liste paginee, du plus recent au plus ancien. */
  app.get('/v1/payouts', { preHandler: app.authenticate }, async (request) => {
    const query = listQuery.parse(request.query);
    return listPayouts(request.auth!.merchantId, {
      ...(query.status ? { status: query.status } : {}),
      ...(query.country ? { country: query.country } : {}),
      ...(query.starting_after ? { startingAfter: query.starting_after } : {}),
      limit: query.limit,
    });
  });

  /**
   * Lecture. C'est le seul mecanisme capable de sortir un decaissement de
   * l'etat UNKNOWN : il demande a l'agregateur ce qu'il a reellement fait.
   */
  app.get('/v1/payouts/:id', { preHandler: app.authenticate }, async (request) => {
    const { id } = z.object({ id: z.string() }).parse(request.params);
    const { payout, attempts } = await refreshPayout(request.auth!.merchantId, id);
    return serializePayout(payout, attempts);
  });

  /** Relance. Refusee tant qu'une tentative est en etat indetermine. */
  app.post(
    '/v1/payouts/:id/retry',
    { preHandler: [app.authenticate, app.requireScope('payouts:write')] },
    async (request) => {
      const { id } = z.object({ id: z.string() }).parse(request.params);
      const auth = request.auth!;
      const { payout, attempts } = await retryPayout(auth.merchantId, id, auth.environment);
      return serializePayout(payout, attempts);
    },
  );
}
