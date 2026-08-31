import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  disablePartner,
  listPartners,
  listSettlements,
  pendingByPartner,
  upsertPartner,
} from '../../modules/partners.js';

const recipient = z.object({
  phone: z.string().min(1).optional(),
  network: z.string().min(1).optional(),
  account_number: z.string().min(1).optional(),
  bank_code: z.string().min(1).optional(),
  name: z.string().min(1).optional(),
});

const upsertBody = z.object({
  /** Reference du marchand : rejouer la meme met a jour, ne duplique pas. */
  reference: z.string().min(1).max(120),
  name: z.string().min(1).max(200),
  country: z.string().length(2),
  currency: z.string().length(3),
  channel: z.enum(['mobile_money', 'bank_transfer']),
  /** Part due, en points de base. 250 = 2,50 %. */
  share_bps: z.number().int().positive(),
  /**
   * `net` (defaut) : part calculee sur ce que le marchand garde reellement,
   * apres commission agregateur et commission Orchi.
   * `gross` : part calculee sur le montant paye par le client final.
   */
  share_base: z.enum(['gross', 'net']).optional(),
  recipient,
});

export async function partnerRoutes(app: FastifyInstance) {
  app.post(
    '/v1/partners',
    { preHandler: [app.authenticate, app.requireScope('accounts:write')] },
    async (request, reply) => {
      const body = upsertBody.parse(request.body);
      const partner = await upsertPartner({
        merchantId: request.auth!.merchantId,
        environment: request.auth!.environment,
        reference: body.reference,
        name: body.name,
        country: body.country,
        currency: body.currency,
        channel: body.channel,
        shareBps: body.share_bps,
        ...(body.share_base ? { shareBase: body.share_base } : {}),
        recipient: {
          ...(body.recipient.phone ? { phone: body.recipient.phone } : {}),
          ...(body.recipient.network ? { network: body.recipient.network } : {}),
          ...(body.recipient.account_number ? { accountNumber: body.recipient.account_number } : {}),
          ...(body.recipient.bank_code ? { bankCode: body.recipient.bank_code } : {}),
          ...(body.recipient.name ? { name: body.recipient.name } : {}),
        },
      });
      return reply.status(201).send(partner);
    },
  );

  app.get('/v1/partners', { preHandler: app.authenticate }, async (request) => {
    const partners = await listPartners(request.auth!.merchantId, request.auth!.environment);
    return { object: 'list', count: partners.length, data: partners };
  });

  app.delete(
    '/v1/partners/:id',
    { preHandler: [app.authenticate, app.requireScope('accounts:write')] },
    async (request, reply) => {
      const { id } = z.object({ id: z.string() }).parse(request.params);
      await disablePartner(request.auth!.merchantId, id);
      return reply.status(204).send();
    },
  );

  /**
   * Ce qui est du et pas encore verse.
   *
   * C'est la vue qui manque le plus a un marchand : elle repond a « combien
   * dois-je a qui, en ce moment », entre deux versements groupes.
   */
  app.get('/v1/partners/pending', { preHandler: app.authenticate }, async (request) => {
    const lignes = await pendingByPartner(request.auth!.merchantId, request.auth!.environment);
    return {
      object: 'list',
      count: lignes.length,
      data: lignes.map((l) => ({
        partner: l.partner,
        currency: l.currency,
        pending_amount: l.pending,
        accrual_count: l.accruals,
      })),
    };
  });

  app.get('/v1/partner-settlements', { preHandler: app.authenticate }, async (request) => {
    const query = z.object({ limit: z.coerce.number().int().positive().max(200).optional() });
    const { limit } = query.parse(request.query);
    const settlements = await listSettlements(
      request.auth!.merchantId,
      request.auth!.environment,
      limit ?? 50,
    );
    return {
      object: 'list',
      count: settlements.length,
      data: settlements.map((s) => ({
        id: s.id,
        partner_id: s.partnerId,
        currency: s.currency,
        amount: s.amount,
        accrual_count: s.accrualCount,
        status: s.status,
        payout_id: s.payoutId,
        failure_reason: s.failureReason,
        created_at: s.createdAt.toISOString(),
      })),
    };
  });
}
