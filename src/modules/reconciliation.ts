import { env } from '../core/env.js';
import { logger } from '../core/logger.js';
import { prisma } from '../db/client.js';
import { refreshPayment } from './payments.js';
import { refreshPayout } from './payouts.js';

/**
 * Balayeur et reconciliation.
 *
 * Les webhooks mentent : ils se perdent, arrivent en double, arrivent dans le
 * desordre, ou n'arrivent jamais parce qu'un deploiement a coupe le service
 * cinq minutes. Une transaction ne doit JAMAIS dependre uniquement d'eux.
 *
 * Ce balayeur est le filet : il reprend toute tentative restee non terminale
 * au-dela d'un seuil et va demander son etat a l'agregateur.
 *
 * L'ORDRE DE PRIORITE N'EST PAS ARBITRAIRE :
 *   1. decaissements INDETERMINES — de l'argent est peut-etre parti sans que
 *      nous le sachions, et le marchand est bloque tant que ce n'est pas tranche ;
 *   2. decaissements en cours ;
 *   3. encaissements en cours — un client qui n'a pas paye ne coute rien.
 */

/** Delai apres expiration de l'action avant de declarer un paiement expire. */
const EXPIRY_GRACE_MS = 5 * 60 * 1000;

export interface SweepResult {
  polled: number;
  resolved: number;
  expired: number;
  failures: number;
}

interface Candidate {
  kind: 'payment' | 'payout';
  attemptId: string;
  resourceId: string;
  merchantId: string;
}

export async function sweepStaleAttempts(limit = 25, now = new Date()): Promise<SweepResult> {
  const cutoff = new Date(now.getTime() - env.SWEEPER_MIN_AGE_MS);
  const result: SweepResult = { polled: 0, resolved: 0, expired: 0, failures: 0 };

  const candidates = await collect(limit, cutoff);

  for (const candidate of candidates) {
    try {
      if (candidate.kind === 'payout') {
        const before = await prisma.payout.findUnique({ where: { id: candidate.resourceId } });
        const { payout } = await refreshPayout(candidate.merchantId, candidate.resourceId);
        result.polled += 1;
        if (before && before.status !== payout.status) result.resolved += 1;
      } else {
        const before = await prisma.payment.findUnique({ where: { id: candidate.resourceId } });
        const { payment } = await refreshPayment(candidate.merchantId, candidate.resourceId);
        result.polled += 1;
        if (before && before.status !== payment.status) result.resolved += 1;
      }
    } catch (e) {
      result.failures += 1;
      logger.warn({ err: e, ...candidate }, 'Balayage en echec sur une tentative');
    }
  }

  result.expired = await expireStalePayments(now);
  return result;
}

/**
 * Rassemble les tentatives a interroger, decaissements indetermines d'abord.
 */
async function collect(limit: number, cutoff: Date): Promise<Candidate[]> {
  const out: Candidate[] = [];

  const indeterminate = await prisma.payoutAttempt.findMany({
    where: { status: 'UNKNOWN' },
    include: { payout: { select: { id: true, merchantId: true } } },
    orderBy: { updatedAt: 'asc' },
    take: limit,
  });
  for (const a of indeterminate) {
    out.push({
      kind: 'payout',
      attemptId: a.id,
      resourceId: a.payout.id,
      merchantId: a.payout.merchantId,
    });
  }
  if (out.length >= limit) return out.slice(0, limit);

  const pendingPayouts = await prisma.payoutAttempt.findMany({
    where: { status: 'PENDING', updatedAt: { lt: cutoff } },
    include: { payout: { select: { id: true, merchantId: true } } },
    orderBy: { updatedAt: 'asc' },
    take: limit - out.length,
  });
  for (const a of pendingPayouts) {
    out.push({
      kind: 'payout',
      attemptId: a.id,
      resourceId: a.payout.id,
      merchantId: a.payout.merchantId,
    });
  }
  if (out.length >= limit) return out.slice(0, limit);

  const pendingPayments = await prisma.paymentAttempt.findMany({
    where: { status: { in: ['PENDING', 'AWAITING_CUSTOMER', 'UNKNOWN'] }, updatedAt: { lt: cutoff } },
    include: { payment: { select: { id: true, merchantId: true } } },
    orderBy: { updatedAt: 'asc' },
    take: limit - out.length,
  });
  for (const a of pendingPayments) {
    out.push({
      kind: 'payment',
      attemptId: a.id,
      resourceId: a.payment.id,
      merchantId: a.payment.merchantId,
    });
  }

  return out;
}

/**
 * Clot les encaissements dont l'action client a expire.
 *
 * Uniquement les ENCAISSEMENTS, et uniquement passe un delai de grace apres la
 * date d'expiration annoncee par l'agregateur : le client peut valider son push
 * a la derniere seconde, et la notification peut trainer. Un decaissement, lui,
 * n'expire jamais de notre propre chef — seul l'agregateur peut dire qu'un
 * virement n'a pas eu lieu.
 */
async function expireStalePayments(now: Date): Promise<number> {
  const deadline = new Date(now.getTime() - EXPIRY_GRACE_MS);

  const stale = await prisma.paymentAttempt.findMany({
    where: {
      status: 'AWAITING_CUSTOMER',
      actionExpiresAt: { not: null, lt: deadline },
    },
    include: { payment: { select: { id: true, status: true } } },
    take: 50,
  });

  let expired = 0;
  for (const attempt of stale) {
    await prisma.paymentAttempt.update({
      where: { id: attempt.id },
      data: { status: 'EXPIRED', completedAt: now, providerCode: 'orchi_expired' },
    });
    if (attempt.payment.status !== 'SUCCEEDED') {
      await prisma.payment.update({
        where: { id: attempt.payment.id },
        data: { status: 'EXPIRED' },
      });
    }
    expired += 1;
  }

  if (expired > 0) logger.info({ expired }, 'Encaissements expires par le balayeur');
  return expired;
}

/* -------------------------------------------------------------------------- */
/* Rapport                                                                    */
/* -------------------------------------------------------------------------- */

export interface ReconciliationReport {
  indeterminate_payouts: Array<{
    id: string;
    reference: string;
    amount: number;
    currency: string;
    provider: string | null;
    since: string;
  }>;
  stuck_payments: number;
  undelivered_events: number;
  rejected_webhooks_24h: number;
}

/**
 * Etat des points a trancher pour un marchand.
 *
 * Les decaissements indetermines sont listes en detail : ce sont les seuls
 * elements qui peuvent demander une decision humaine, et le montant en jeu doit
 * etre visible immediatement.
 */
export async function reconciliationReport(
  merchantId: string,
  now = new Date(),
): Promise<ReconciliationReport> {
  const dayAgo = new Date(now.getTime() - 24 * 3600 * 1000);

  const [payouts, stuckPayments, undelivered, rejected] = await Promise.all([
    prisma.payout.findMany({
      where: { merchantId, status: 'UNKNOWN' },
      include: { attempts: { orderBy: { attemptNumber: 'desc' }, take: 1 } },
      orderBy: { createdAt: 'asc' },
      take: 100,
    }),
    prisma.payment.count({
      where: { merchantId, status: 'PROCESSING', createdAt: { lt: dayAgo } },
    }),
    prisma.outboundDelivery.count({ where: { merchantId, status: 'PENDING' } }),
    prisma.inboundWebhook.count({
      where: { merchantId, outcome: 'REJECTED', createdAt: { gte: dayAgo } },
    }),
  ]);

  return {
    indeterminate_payouts: payouts.map((p) => ({
      id: p.id,
      reference: p.reference,
      amount: p.amount,
      currency: p.currency,
      provider: p.attempts[0]?.providerId ?? null,
      since: p.updatedAt.toISOString(),
    })),
    stuck_payments: stuckPayments,
    undelivered_events: undelivered,
    rejected_webhooks_24h: rejected,
  };
}
