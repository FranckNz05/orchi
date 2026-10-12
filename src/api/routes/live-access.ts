import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { errors } from '../../core/errors.js';
import { prisma } from '../../db/client.js';
import { heldBalances } from '../../modules/settlements.js';
import {
  requestLiveAccess,
  reviewLiveAccess,
  revokeLiveAccess,
  serializeForReview,
  serializeLiveState,
  correctMerchantIdentity,
  merchantAuditTrail,
} from '../../modules/live-access.js';

/**
 * Demande d'acces au reel (cote marchand) et examen des dossiers (cote
 * plateforme).
 *
 * Les deux familles de routes vivent dans le meme fichier parce qu'elles
 * decrivent les deux moities d'une seule regle. Les separer donnerait deux
 * fichiers qu'on modifie toujours ensemble.
 */

const requestBody = z.object({
  activity: z.string().min(20).max(600),
  website: z.string().url().max(300).optional(),
  monthly_volume_minor: z.number().int().min(0).optional(),
  registration_number: z.string().min(3).max(80).optional(),
});

/**
 * Au moins un champ doit etre fourni : une requete vide ne corrige rien et
 * produirait une ligne d'audit sans objet.
 */
const identityBody = z
  .object({
    name: z.string().min(2).max(160).optional(),
    country: z.string().length(2).optional(),
    legal_type: z.enum(['COMPANY', 'INDIVIDUAL']).optional(),
    registration_number: z.string().max(80).nullable().optional(),
    reason: z.string().max(800).optional(),
    /** Accepte de retirer l'acces reel quand le pays d'un marchand verifie change. */
    revoke_live: z.boolean().optional(),
  })
  .refine(
    (b) =>
      b.name !== undefined ||
      b.country !== undefined ||
      b.legal_type !== undefined ||
      b.registration_number !== undefined,
    { message: 'Au moins un champ identitaire doit etre fourni.' },
  );

const reviewBody = z.object({
  decision: z.enum(['approve', 'reject', 'revoke']),
  note: z.string().max(800).optional(),
});

export async function liveAccessRoutes(app: FastifyInstance) {
  /* ---------------------------------------------------------------------- */
  /* Cote marchand                                                          */
  /* ---------------------------------------------------------------------- */

  app.get('/v1/live-access', { preHandler: app.authenticate }, async (request) => {
    const merchant = await prisma.merchant.findUnique({ where: { id: request.auth!.merchantId } });
    if (!merchant) throw errors.notFound('merchant');
    return serializeLiveState(merchant);
  });

  /**
   * Depot d'un dossier.
   *
   * Reserve a une session : c'est un engagement du marchand sur son activite
   * reelle, pas un appel d'integration. Une cle API ne doit pas pouvoir
   * declencher une procedure de conformite au nom de quelqu'un.
   */
  app.post('/v1/live-access', { preHandler: app.authenticate }, async (request, reply) => {
    const ctx = request.auth!;
    if (ctx.via !== 'session') {
      throw errors.forbidden('session (une demande d\'acces engage le marchand)');
    }

    const body = requestBody.parse(request.body);
    const merchant = await requestLiveAccess({
      merchantId: ctx.merchantId,
      activity: body.activity,
      ...(body.website ? { website: body.website } : {}),
      ...(body.monthly_volume_minor !== undefined
        ? { monthlyVolumeMinor: body.monthly_volume_minor }
        : {}),
      ...(body.registration_number ? { registrationNumber: body.registration_number } : {}),
    });

    return reply.status(202).send(serializeLiveState(merchant));
  });

  /* ---------------------------------------------------------------------- */
  /* Cote plateforme                                                        */
  /* ---------------------------------------------------------------------- */

  app.get(
    '/v1/admin/merchants',
    { preHandler: [app.authenticate, app.requireAdmin] },
    async (request) => {
      const query = z
        .object({
          status: z.enum(['UNVERIFIED', 'PENDING', 'VERIFIED', 'REJECTED', 'ALL']).default('ALL'),
          limit: z.coerce.number().int().min(1).max(200).default(100),
        })
        .parse(request.query ?? {});

      const merchants = await prisma.merchant.findMany({
        where: query.status === 'ALL' ? {} : { kybStatus: query.status },
        include: { _count: { select: { users: true, payments: true, apiKeys: true } } },
        // Les dossiers deposes remontent en premier : c'est la file de travail.
        // A defaut de demande, les comptes recents priment.
        orderBy: [{ liveRequestedAt: 'desc' }, { createdAt: 'desc' }],
        take: query.limit,
      });

      const counts = await prisma.merchant.groupBy({
        by: ['kybStatus'],
        _count: { _all: true },
      });

      return {
        object: 'list',
        data: merchants.map(serializeForReview),
        counts: Object.fromEntries(counts.map((c) => [c.kybStatus, c._count._all])),
      };
    },
  );

  app.get(
    '/v1/admin/merchants/:id',
    { preHandler: [app.authenticate, app.requireAdmin] },
    async (request) => {
      const { id } = z.object({ id: z.string() }).parse(request.params);
      const merchant = await prisma.merchant.findUnique({
        where: { id },
        include: { _count: { select: { users: true, payments: true, apiKeys: true } } },
      });
      if (!merchant) throw errors.notFound('merchant', id);

      const users = await prisma.user.findMany({
        where: { merchantId: id },
        select: { email: true, name: true, role: true, createdAt: true, lastLoginAt: true },
      });

      return {
        ...serializeForReview(merchant),
        users: users.map((u) => ({
          email: u.email,
          name: u.name,
          role: u.role,
          created_at: u.createdAt.toISOString(),
          last_login_at: u.lastLoginAt?.toISOString() ?? null,
        })),
      };
    },
  );

  /**
   * Decision sur un dossier.
   *
   * `revoke` n'est pas un simple refus tardif : il revoque aussi les cles
   * `live` deja emises et ramene les sessions ouvertes en `test`. Sans cela,
   * un marchand suspendu continuerait d'encaisser avec une cle distribuee la
   * veille, et la suspension ne serait qu'un changement d'affichage.
   */
  app.post(
    '/v1/admin/merchants/:id/review',
    { preHandler: [app.authenticate, app.requireAdmin] },
    async (request) => {
      const ctx = request.auth!;
      const { id } = z.object({ id: z.string() }).parse(request.params);
      const body = reviewBody.parse(request.body);

      const common = {
        merchantId: id,
        ...(body.note ? { note: body.note } : {}),
        reviewerId: ctx.sessionId ?? 'inconnu',
        reviewerEmail: ctx.userEmail ?? 'inconnu',
      };

      const merchant =
        body.decision === 'revoke'
          ? await revokeLiveAccess({ ...common, decision: 'reject' })
          : await reviewLiveAccess({ ...common, decision: body.decision });

      request.log.info(
        { merchant: id, decision: body.decision, by: ctx.userEmail },
        'Dossier d\'acces reel tranche',
      );

      return serializeForReview(merchant);
    },
  );

  /**
   * Correction d'identite.
   *
   * Reservee a un administrateur : le pays et la forme juridique determinent
   * les pieces exigees a la verification, et un marchand qui pourrait les
   * changer apres coup viderait cette verification de son sens.
   */
  app.patch(
    '/v1/admin/merchants/:id/identity',
    { preHandler: [app.authenticate, app.requireAdmin] },
    async (request) => {
      const ctx = request.auth!;
      const { id } = z.object({ id: z.string() }).parse(request.params);
      const body = identityBody.parse(request.body);

      const merchant = await correctMerchantIdentity({
        merchantId: id,
        patch: {
          ...(body.name !== undefined ? { name: body.name } : {}),
          ...(body.country !== undefined ? { country: body.country } : {}),
          ...(body.legal_type !== undefined ? { legalType: body.legal_type } : {}),
          ...(body.registration_number !== undefined
            ? { registrationNumber: body.registration_number }
            : {}),
        },
        ...(body.reason ? { reason: body.reason } : {}),
        actorId: ctx.sessionId ?? 'inconnu',
        actorEmail: ctx.userEmail ?? 'inconnu',
        ...(body.revoke_live !== undefined ? { revokeLive: body.revoke_live } : {}),
      });

      request.log.warn(
        { merchant: id, by: ctx.userEmail, champs: Object.keys(body) },
        'Identite marchand corrigee par un administrateur',
      );

      return serializeForReview(merchant);
    },
  );

  /** Historique des corrections d'identite. */
  app.get(
    '/v1/admin/merchants/:id/audit',
    { preHandler: [app.authenticate, app.requireAdmin] },
    async (request) => {
      const { id } = z.object({ id: z.string() }).parse(request.params);
      const lignes = await merchantAuditTrail(id);
      return {
        object: 'list',
        count: lignes.length,
        data: lignes.map((l) => ({
          id: l.id,
          field: l.field,
          old_value: l.oldValue,
          new_value: l.newValue,
          actor: l.actorEmail,
          reason: l.reason,
          created_at: l.createdAt.toISOString(),
        })),
      };
    },
  );

  /**
   * Demandes de paiement de TOUS les marchands, les plus recentes d'abord.
   *
   * Sans cela, l'administrateur ne voit que les dossiers et les retraits : il ne
   * peut pas savoir ce qui se passe reellement chez ses clients. Le numero du
   * client final est masque (indicatif et 2 derniers chiffres) : la supervision
   * n'a pas besoin du numero entier.
   */
  app.get(
    '/v1/admin/payments',
    { preHandler: [app.authenticate, app.requireAdmin] },
    async (request) => {
      const q = z
        .object({
          environment: z.enum(['test', 'live']).optional(),
          status: z.enum(['CREATED', 'PROCESSING', 'SUCCEEDED', 'FAILED', 'EXPIRED']).optional(),
          merchant: z.string().optional(),
          limit: z.coerce.number().int().min(1).max(200).default(50),
        })
        .parse(request.query);

      const rows = await prisma.payment.findMany({
        where: {
          ...(q.environment ? { environment: q.environment } : {}),
          ...(q.status ? { status: q.status } : {}),
          ...(q.merchant ? { merchantId: q.merchant } : {}),
        },
        orderBy: { createdAt: 'desc' },
        take: q.limit,
        include: {
          merchant: { select: { name: true } },
          attempts: { orderBy: { attemptNumber: 'asc' } },
        },
      });

      const mask = (phone: string | null) =>
        phone ? `${phone.slice(0, 4)}•••••${phone.slice(-2)}` : null;

      return {
        object: 'list',
        count: rows.length,
        data: rows.map((p) => {
          const last = p.attempts[p.attempts.length - 1];
          return {
            id: p.id,
            reference: p.reference,
            merchant: { id: p.merchantId, name: p.merchant.name },
            environment: p.environment,
            status: p.status,
            amount: p.amount,
            currency: p.currency,
            country: p.country,
            channel: p.channel,
            network: p.network,
            customer_phone: mask(p.customerPhone),
            provider: last?.providerId ?? null,
            failure: last?.status === 'FAILED' || last?.status === 'EXPIRED' ? (last.providerMessage ?? last.providerCode ?? null) : null,
            fees: { provider: p.providerFeeAmount, platform: p.platformFeeAmount },
            created_at: p.createdAt.toISOString(),
            succeeded_at: p.succeededAt?.toISOString() ?? null,
          };
        }),
      };
    },
  );

  /**
   * Chiffres de TOUTE la plateforme, pour la vue d'ensemble de l'administration.
   *
   * Le tableau de bord /app d'un administrateur est celui du compte plateforme,
   * qui n'encaisse rien lui-meme : sans cette vue, l'administrateur ne voyait
   * aucun chiffre alors que ses clients encaissaient.
   */
  app.get(
    '/v1/admin/stats',
    { preHandler: [app.authenticate, app.requireAdmin] },
    async (request) => {
      const q = z
        .object({
          environment: z.enum(['test', 'live']).default('live'),
          days: z.coerce.number().int().min(7).max(90).default(14),
        })
        .parse(request.query);

      const since = new Date();
      since.setHours(0, 0, 0, 0);
      since.setDate(since.getDate() - (q.days - 1));

      const [payments, merchants] = await Promise.all([
        prisma.payment.findMany({
          where: { environment: q.environment },
          select: {
            merchantId: true, status: true, amount: true, currency: true,
            providerFeeAmount: true, platformFeeAmount: true, createdAt: true,
          },
        }),
        prisma.merchant.findMany({ select: { id: true, name: true, kybStatus: true, country: true } }),
      ]);
      const names = new Map(merchants.map((m) => [m.id, m]));

      type Agg = {
        ok: number; failed: number; expired: number; pending: number;
        paid: number; aggregator_fees: number; afripaie_fees: number; merchant_net: number;
      };
      const blank = (): Agg => ({ ok: 0, failed: 0, expired: 0, pending: 0, paid: 0, aggregator_fees: 0, afripaie_fees: 0, merchant_net: 0 });
      const add = (a: Agg, p: (typeof payments)[number]) => {
        if (p.status === 'SUCCEEDED') {
          const agg = p.providerFeeAmount ?? 0;
          const afr = p.platformFeeAmount ?? 0;
          a.ok += 1; a.paid += p.amount; a.aggregator_fees += agg; a.afripaie_fees += afr;
          a.merchant_net += p.amount - agg - afr;
        } else if (p.status === 'FAILED') a.failed += 1;
        else if (p.status === 'EXPIRED') a.expired += 1;
        else a.pending += 1;
      };

      const totals = new Map<string, Agg>();
      const byMerchant = new Map<string, Agg & { last: Date | null }>();
      const daily = new Map<string, { ok: number; ko: number; paid: number; afripaie: number }>();
      for (const p of payments) {
        const t = totals.get(p.currency) ?? blank(); add(t, p); totals.set(p.currency, t);
        const key = `${p.merchantId}:${p.currency}`;
        const m = byMerchant.get(key) ?? { ...blank(), last: null };
        add(m, p);
        if (!m.last || p.createdAt > m.last) m.last = p.createdAt;
        byMerchant.set(key, m);
        if (p.createdAt >= since) {
          const day = `${p.createdAt.toISOString().slice(0, 10)}:${p.currency}`;
          const d = daily.get(day) ?? { ok: 0, ko: 0, paid: 0, afripaie: 0 };
          if (p.status === 'SUCCEEDED') { d.ok += 1; d.paid += p.amount; d.afripaie += p.platformFeeAmount ?? 0; }
          else if (p.status === 'FAILED' || p.status === 'EXPIRED') d.ko += 1;
          daily.set(day, d);
        }
      }

      // Ce qu'Afripaie doit aux marchands (encaisse sur ses comptes, pas encore retire).
      const owed = new Map<string, number>();
      for (const m of merchants) {
        for (const b of await heldBalances(m.id)) {
          if (b.environment === q.environment) owed.set(b.currency, (owed.get(b.currency) ?? 0) + b.held);
        }
      }

      return {
        object: 'admin_stats',
        environment: q.environment,
        days: q.days,
        totals: [...totals.entries()].map(([currency, a]) => ({ currency, ...a, owed_to_merchants: owed.get(currency) ?? 0 })),
        by_merchant: [...byMerchant.entries()]
          .map(([key, a]) => {
            const [id, currency] = key.split(':');
            const m = names.get(id!);
            return {
              merchant: { id, name: m?.name ?? id, country: m?.country ?? null, kyb_status: m?.kybStatus ?? null },
              currency, ...a, last_payment_at: a.last?.toISOString() ?? null,
            };
          })
          .sort((x, y) => y.paid - x.paid),
        daily: [...daily.entries()].map(([key, d]) => {
          const [date, currency] = key.split(':');
          return { date, currency, ...d };
        }),
      };
    },
  );

  app.get(
    '/v1/admin/overview',
    { preHandler: [app.authenticate, app.requireAdmin] },
    async () => {
      const [merchants, pending, verified, payments, payouts, keys] = await Promise.all([
        prisma.merchant.count(),
        prisma.merchant.count({ where: { kybStatus: 'PENDING' } }),
        prisma.merchant.count({ where: { kybStatus: 'VERIFIED' } }),
        prisma.payment.count(),
        prisma.payout.count(),
        prisma.apiKey.count({ where: { environment: 'live', revokedAt: null } }),
      ]);

      return {
        object: 'admin_overview',
        merchants,
        pending_reviews: pending,
        pending_withdrawals: await prisma.merchantSettlement.count({ where: { status: 'PENDING_APPROVAL' } }),
        verified_merchants: verified,
        payments,
        payouts,
        active_live_keys: keys,
      };
    },
  );
}
