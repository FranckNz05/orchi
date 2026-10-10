import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  SETTLEMENT_METHODS,
  cancelSettlement,
  heldBalances,
  listSettlements,
  recordSettlement,
  serializeBalance,
  serializeSettlement,
} from '../../modules/settlements.js';

/**
 * Reversements : ce qu'Afripaie doit au marchand, et ce qu'elle lui a verse.
 *
 * Le marchand LIT (session ou cle API). Seul un administrateur ENREGISTRE ou
 * annule : un reversement constate un virement reel, et le marchand qui le
 * recoit ne doit pas pouvoir en ecrire un.
 */

const recordBody = z.object({
  environment: z.enum(['test', 'live']),
  currency: z.string().length(3),
  amount: z.number().int().positive(),
  source_provider: z.string().min(1).max(40),
  method: z.enum(SETTLEMENT_METHODS),
  destination: z.string().min(3).max(200),
  external_reference: z.string().min(3).max(120),
  note: z.string().max(500).optional(),
});

const cancelBody = z.object({ reason: z.string().min(5).max(500) });

export async function settlementRoutes(app: FastifyInstance) {
  /** Cote marchand : solde du et historique, dans l'environnement courant. */
  app.get('/v1/settlements', { preHandler: app.authenticate }, async (request) => {
    const ctx = request.auth!;
    const [balances, rows] = await Promise.all([
      heldBalances(ctx.merchantId),
      listSettlements(ctx.merchantId, ctx.environment),
    ]);
    return {
      object: 'list',
      environment: ctx.environment,
      balances: balances.filter((b) => b.environment === ctx.environment).map(serializeBalance),
      count: rows.length,
      data: rows.map((s) => serializeSettlement(s)),
    };
  });

  /* ---------------------------------------------------------------------- */
  /* Administration                                                         */
  /* ---------------------------------------------------------------------- */

  app.get(
    '/v1/admin/merchants/:id/settlements',
    { preHandler: [app.authenticate, app.requireAdmin] },
    async (request) => {
      const { id } = z.object({ id: z.string() }).parse(request.params);
      const [balances, rows] = await Promise.all([heldBalances(id), listSettlements(id)]);
      return {
        object: 'list',
        balances: balances.map(serializeBalance),
        count: rows.length,
        data: rows.map((s) => serializeSettlement(s, true)),
      };
    },
  );

  app.post(
    '/v1/admin/merchants/:id/settlements',
    { preHandler: [app.authenticate, app.requireAdmin] },
    async (request, reply) => {
      const ctx = request.auth!;
      const { id } = z.object({ id: z.string() }).parse(request.params);
      const body = recordBody.parse(request.body);

      const settlement = await recordSettlement({
        merchantId: id,
        environment: body.environment,
        currency: body.currency,
        amount: body.amount,
        sourceProviderId: body.source_provider,
        method: body.method,
        destination: body.destination,
        externalReference: body.external_reference,
        ...(body.note ? { note: body.note } : {}),
        actorId: ctx.userId ?? ctx.sessionId ?? 'inconnu',
        actorEmail: ctx.userEmail ?? 'inconnu',
      });

      request.log.warn(
        { merchant: id, settlement: settlement.id, amount: settlement.amount, currency: settlement.currency, by: ctx.userEmail },
        'Reversement marchand enregistre',
      );
      return reply.status(201).send(serializeSettlement(settlement, true));
    },
  );

  app.post(
    '/v1/admin/settlements/:id/cancel',
    { preHandler: [app.authenticate, app.requireAdmin] },
    async (request) => {
      const ctx = request.auth!;
      const { id } = z.object({ id: z.string() }).parse(request.params);
      const body = cancelBody.parse(request.body);

      const settlement = await cancelSettlement({
        settlementId: id,
        reason: body.reason,
        actorEmail: ctx.userEmail ?? 'inconnu',
      });
      request.log.warn({ settlement: id, by: ctx.userEmail }, 'Reversement marchand annule');
      return serializeSettlement(settlement, true);
    },
  );
}
