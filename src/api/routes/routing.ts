import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { env } from '../../core/env.js';
import { errors } from '../../core/errors.js';
import { prisma } from '../../db/client.js';
import { snapshot } from '../../routing/circuit-breaker.js';
import { healthKey, stats } from '../../routing/health.js';

/**
 * Observabilite du routage.
 *
 * Deux questions doivent trouver une reponse immediate :
 *   - « pourquoi ma transaction est-elle partie chez cet agregateur ? »
 *   - « pourquoi cet agregateur ne recoit-il plus rien ? »
 *
 * Sans ces endpoints, le routage est une boite noire, et une contestation
 * marchand devient indefendable.
 */
export async function routingRoutes(app: FastifyInstance) {
  /**
   * Etat des disjoncteurs et sante observee, par (agregateur, pays, canal).
   *
   * RESERVE AUX ADMINISTRATEURS : ces chiffres couvrent toute la plateforme. Un
   * client n'a pas a savoir quels agregateurs Afripaie utilise ni dans quel etat
   * ils sont.
   */
  app.get('/v1/routing/health', { preHandler: [app.authenticate, app.requireAdmin] }, async () => ({
    object: 'list',
    ...healthList(),
  }));

  /**
   * Agregateurs de la plateforme, pour l'administration : comptes connectes
   * (ceux d'Afripaie et ceux qu'un marchand a branches lui-meme), sans aucun
   * secret, et sante du routage.
   */
  app.get('/v1/admin/providers', { preHandler: [app.authenticate, app.requireAdmin] }, async () => {
    const accounts = await prisma.providerAccount.findMany({
      include: { merchant: { select: { id: true, name: true } } },
      orderBy: [{ environment: 'desc' }, { providerId: 'asc' }],
    });
    const platformId = env.PLATFORM_MERCHANT_ID;
    return {
      object: 'admin_providers',
      accounts: accounts.map((a) => ({
        id: a.id,
        provider: a.providerId,
        environment: a.environment,
        status: a.status,
        priority: a.priority,
        owner: { id: a.merchant.id, name: a.merchant.name, platform: a.merchantId === platformId },
        last_used_at: a.lastUsedAt?.toISOString() ?? null,
        created_at: a.createdAt.toISOString(),
      })),
      health: healthList().data,
    };
  });

  function healthList() {
    const breakers = snapshot();

    const data = breakers.map((b) => {
      const s = stats(healthKey(b.providerId, b.country, b.channel));
      return {
        provider: b.providerId,
        country: b.country,
        channel: b.channel,
        state: b.state,
        success_rate: Number(s.successRate.toFixed(4)),
        observations: s.observations,
        successes: s.successes,
        technical_failures: s.technicalFailures,
        /** Suivis mais sans effet sur le disjoncteur : ce n'est pas une panne. */
        declines: s.declines,
        latency_p95_ms: s.latencyP95Ms,
        opened_at: b.openedAt ? new Date(b.openedAt).toISOString() : null,
        next_probe_at: b.nextProbeAt ? new Date(b.nextProbeAt).toISOString() : null,
        last_failure_code: b.lastFailureCode,
      };
    });

    return { count: data.length, data };
  }

  /** Decisions de routage d'une transaction : candidats, scores, ecartes. */
  app.get('/v1/routing/decisions', { preHandler: app.authenticate }, async (request) => {
    const query = z
      .object({ payment: z.string().optional(), payout: z.string().optional() })
      .refine((q) => Boolean(q.payment) !== Boolean(q.payout), {
        message: 'Indiquez exactement un parametre : payment ou payout.',
      })
      .parse(request.query);

    const merchantId = request.auth!.merchantId;
    const refType = query.payment ? 'payment' : 'payout';
    const refId = (query.payment ?? query.payout)!;

    const owned = query.payment
      ? await prisma.payment.findFirst({ where: { id: refId, merchantId }, select: { id: true } })
      : await prisma.payout.findFirst({ where: { id: refId, merchantId }, select: { id: true } });
    if (!owned) throw errors.notFound(refType === 'payment' ? 'Paiement' : 'Decaissement', refId);

    const decisions = await prisma.routingDecision.findMany({
      where: { merchantId, refType, refId },
      orderBy: { createdAt: 'asc' },
    });

    return {
      object: 'list',
      count: decisions.length,
      data: decisions.map((d) => ({
        id: d.id,
        attempt_id: d.attemptId,
        country: d.countryIso2,
        channel: d.channel,
        direction: d.direction,
        chosen: d.chosenProviderId,
        reason: d.reason,
        ...(JSON.parse(d.candidates) as Record<string, unknown>),
        created_at: d.createdAt.toISOString(),
      })),
    };
  });
}
