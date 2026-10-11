import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { errors } from '../../core/errors.js';
import { prisma } from '../../db/client.js';
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
