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
import {
  listTargets,
  refreshSettlement,
  resolveSettlement,
  sendSettlement,
  setSettlementTarget,
} from '../../modules/settlements-auto.js';
import type { MerchantSettlementTarget } from '@prisma/client';

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

const targetBody = z.object({
  environment: z.enum(['test', 'live']),
  provider: z.string().min(1).max(40),
  phone: z.string().min(8).max(30),
  network: z.string().max(30).optional(),
  beneficiary_name: z.string().min(2).max(120),
  auto_enabled: z.boolean().default(false),
  min_amount: z.number().int().min(100).default(5000),
});

const sendBody = z.object({
  environment: z.enum(['test', 'live']),
  provider: z.string().min(1).max(40),
  /** Facultatif : tout le disponible par defaut. */
  amount: z.number().int().positive().optional(),
});

const resolveBody = z.object({
  outcome: z.enum(['paid', 'failed']),
  reason: z.string().min(5).max(500),
  external_reference: z.string().min(3).max(120).optional(),
});

function serializeTarget(t: MerchantSettlementTarget) {
  return {
    environment: t.environment,
    provider: t.providerId,
    country: t.country,
    currency: t.currency,
    phone: t.phone,
    network: t.network,
    beneficiary_name: t.beneficiaryName,
    auto_enabled: t.autoEnabled,
    min_amount: t.minAmount,
    updated_at: t.updatedAt.toISOString(),
  };
}

export async function settlementRoutes(app: FastifyInstance) {
  /** Cote marchand : solde du et historique, dans l'environnement courant. */
  app.get('/v1/settlements', { preHandler: app.authenticate }, async (request) => {
    const ctx = request.auth!;
    const [balances, rows, targets] = await Promise.all([
      heldBalances(ctx.merchantId),
      listSettlements(ctx.merchantId, ctx.environment),
      listTargets(ctx.merchantId),
    ]);
    return {
      object: 'list',
      environment: ctx.environment,
      balances: balances.filter((b) => b.environment === ctx.environment).map(serializeBalance),
      targets: targets.filter((t) => t.environment === ctx.environment).map(serializeTarget),
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
      const [balances, rows, targets] = await Promise.all([heldBalances(id), listSettlements(id), listTargets(id)]);
      return {
        object: 'list',
        balances: balances.map(serializeBalance),
        targets: targets.map(serializeTarget),
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

  /* ---------------------------------------------------------------------- */
  /* Reversement automatique (mobile money, depuis un compte d'Afripaie)    */
  /* ---------------------------------------------------------------------- */

  /** Destination des reversements automatiques : administrateur uniquement. */
  app.put(
    '/v1/admin/merchants/:id/settlement-targets',
    { preHandler: [app.authenticate, app.requireAdmin] },
    async (request) => {
      const ctx = request.auth!;
      const { id } = z.object({ id: z.string() }).parse(request.params);
      const body = targetBody.parse(request.body);
      const target = await setSettlementTarget({
        merchantId: id,
        environment: body.environment,
        providerId: body.provider,
        phone: body.phone,
        ...(body.network ? { network: body.network } : {}),
        beneficiaryName: body.beneficiary_name,
        autoEnabled: body.auto_enabled,
        minAmount: body.min_amount,
        actorEmail: ctx.userEmail ?? 'inconnu',
      });
      request.log.warn(
        { merchant: id, provider: target.providerId, phone: target.phone, auto: target.autoEnabled, by: ctx.userEmail },
        'Destination de reversement modifiee',
      );
      return serializeTarget(target);
    },
  );

  /** Envoie maintenant un reversement mobile money. */
  app.post(
    '/v1/admin/merchants/:id/settlements/send',
    { preHandler: [app.authenticate, app.requireAdmin] },
    async (request, reply) => {
      const ctx = request.auth!;
      const { id } = z.object({ id: z.string() }).parse(request.params);
      const body = sendBody.parse(request.body);
      const settlement = await sendSettlement({
        merchantId: id,
        environment: body.environment,
        providerId: body.provider,
        ...(body.amount !== undefined ? { amount: body.amount } : {}),
        actorId: ctx.userId ?? ctx.sessionId ?? 'inconnu',
        actorEmail: ctx.userEmail ?? 'inconnu',
      });
      request.log.warn(
        { merchant: id, settlement: settlement.id, amount: settlement.amount, status: settlement.status, by: ctx.userEmail },
        'Reversement automatique envoye par un administrateur',
      );
      return reply.status(201).send(serializeSettlement(settlement, true));
    },
  );

  app.post(
    '/v1/admin/settlements/:id/refresh',
    { preHandler: [app.authenticate, app.requireAdmin] },
    async (request) => {
      const { id } = z.object({ id: z.string() }).parse(request.params);
      return serializeSettlement(await refreshSettlement(id), true);
    },
  );

  /** Tranche un reversement douteux apres verification chez l'agregateur. */
  app.post(
    '/v1/admin/settlements/:id/resolve',
    { preHandler: [app.authenticate, app.requireAdmin] },
    async (request) => {
      const ctx = request.auth!;
      const { id } = z.object({ id: z.string() }).parse(request.params);
      const body = resolveBody.parse(request.body);
      const settlement = await resolveSettlement({
        settlementId: id,
        outcome: body.outcome,
        reason: body.reason,
        ...(body.external_reference ? { externalReference: body.external_reference } : {}),
        actorEmail: ctx.userEmail ?? 'inconnu',
      });
      request.log.warn({ settlement: id, outcome: body.outcome, by: ctx.userEmail }, 'Reversement douteux tranche');
      return serializeSettlement(settlement, true);
    },
  );
}
