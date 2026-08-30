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
        verified_merchants: verified,
        payments,
        payouts,
        active_live_keys: keys,
      };
    },
  );
}
