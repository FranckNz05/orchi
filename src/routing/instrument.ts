import { ID_PREFIX, newId } from '../core/ids.js';
import { logger } from '../core/logger.js';
import { prisma } from '../db/client.js';
import { isProviderError } from '../providers/errors.js';
import { onFailure, onSuccess, snapshot } from './circuit-breaker.js';
import { activeKeys, classifyFailure, healthKey, parseHealthKey, recordFailure, recordSuccess, stats } from './health.js';
import type { RoutingCandidate, RejectedCandidate } from './select.js';

/**
 * Instrumentation des appels agregateur.
 *
 * Tout appel sortant passe par ici : c'est le seul endroit qui alimente la
 * sante et le disjoncteur. Un adaptateur appele directement resterait invisible
 * du routage, qui continuerait a lui envoyer du trafic apres sa panne.
 */

export interface CallContext {
  providerId: string;
  country: string;
  channel: string;
}

export async function runInstrumented<T>(ctx: CallContext, fn: () => Promise<T>): Promise<T> {
  const key = healthKey(ctx.providerId, ctx.country, ctx.channel);
  const startedAt = Date.now();

  try {
    const result = await fn();
    recordSuccess(key, Date.now() - startedAt);
    onSuccess(key);
    return result;
  } catch (e) {
    const elapsed = Date.now() - startedAt;

    if (isProviderError(e)) {
      recordFailure(key, classifyFailure(e.code), elapsed);
      onFailure(key, e.code);
    } else {
      // Erreur inattendue dans notre code : elle ne dit rien de l'agregateur.
      recordFailure(key, 'ours', elapsed);
    }
    throw e;
  }
}

/* -------------------------------------------------------------------------- */
/* Trace de decision                                                          */
/* -------------------------------------------------------------------------- */

export interface DecisionInput {
  merchantId: string;
  refType: 'payment' | 'payout';
  refId: string;
  attemptId: string;
  country: string;
  channel: string;
  direction: string;
  chosen: RoutingCandidate;
  candidates: RoutingCandidate[];
  rejected: RejectedCandidate[];
}

/**
 * Enregistre pourquoi cette tentative est partie chez cet agregateur.
 *
 * L'ecriture est attendue — une insertion locale coute infiniment moins qu'un
 * appel agregateur — mais son echec est absorbe : perdre une trace d'audit est
 * regrettable, faire echouer un paiement pour cette raison serait absurde.
 */
export async function recordDecision(input: DecisionInput): Promise<void> {
  const payload = {
    chosen: input.chosen.providerId,
    considered: input.candidates.map((c) => ({
      provider: c.providerId,
      rank: c.rank,
      score: c.score,
      breakdown: c.breakdown,
      fee_bps: c.feeBps,
      breaker: c.breakerState,
      probe: c.probe,
    })),
    rejected: input.rejected,
  };

  await prisma.routingDecision
    .create({
      data: {
        id: newId(ID_PREFIX.routingDecision),
        merchantId: input.merchantId,
        refType: input.refType,
        refId: input.refId,
        attemptId: input.attemptId,
        countryIso2: input.country,
        channel: input.channel,
        direction: input.direction,
        chosenProviderId: input.chosen.providerId,
        candidates: JSON.stringify(payload),
        reason: input.chosen.reason,
      },
    })
    .catch((e: unknown) => logger.warn({ err: e }, 'Decision de routage non tracee'));
}

export async function routingDecisionFor(attemptId: string) {
  return prisma.routingDecision.findUnique({ where: { attemptId } });
}

/* -------------------------------------------------------------------------- */
/* Persistance de la sante                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Recopie l'etat en memoire vers la base, pour l'exploitation et le
 * redemarrage a chaud. Appelee periodiquement ; jamais sur le chemin critique.
 */
export async function persistHealthSnapshot(now = Date.now()): Promise<number> {
  const states = new Map(snapshot(now).map((s) => [s.key, s]));
  const keys = new Set([...states.keys(), ...activeKeys(now)]);
  let written = 0;

  for (const key of keys) {
    const { providerId, country, channel } = parseHealthKey(key);
    const s = stats(key, now);
    const breaker = states.get(key);

    const data = {
      providerId,
      countryIso2: country,
      channel,
      state: breaker?.state ?? 'CLOSED',
      successes: s.successes,
      technicalFailures: s.technicalFailures,
      declines: s.declines,
      latencyP95Ms: s.latencyP95Ms,
      openedAt: breaker?.openedAt ? new Date(breaker.openedAt) : null,
      nextProbeAt: breaker?.nextProbeAt ? new Date(breaker.nextProbeAt) : null,
      lastFailureCode: breaker?.lastFailureCode ?? null,
    };

    await prisma.providerHealth.upsert({ where: { id: key }, create: { id: key, ...data }, update: data });
    written += 1;
  }

  return written;
}

/**
 * Restaure les disjoncteurs ouverts au demarrage.
 *
 * Sans cela, un redemarrage — ou un deploiement — relancerait immediatement du
 * trafic vers un agregateur que l'on venait de couper, exactement au pire
 * moment.
 */
export async function warmStartBreakers(now = Date.now()): Promise<number> {
  const { forceOpen } = await import('./circuit-breaker.js');
  const open = await prisma.providerHealth.findMany({
    where: { state: 'OPEN', nextProbeAt: { gt: new Date(now) } },
  });

  for (const row of open) {
    forceOpen(
      row.providerId,
      row.countryIso2,
      row.channel,
      row.nextProbeAt!.getTime(),
      row.lastFailureCode,
    );
  }

  if (open.length > 0) {
    logger.info({ count: open.length }, 'Disjoncteurs restaures au demarrage');
  }
  return open.length;
}
