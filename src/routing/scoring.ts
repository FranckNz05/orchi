import { createHash } from 'node:crypto';
import type { BreakerState } from './circuit-breaker.js';
import type { HealthStats } from './health.js';

/**
 * Score de routage.
 *
 *   score = 0,45 x sante + 0,25 x cout + 0,20 x latence + 0,10 x preference
 *
 * La sante domine volontairement : un agregateur moins cher mais qui echoue une
 * fois sur trois coute infiniment plus cher qu'un agregateur a 0,5 % de plus.
 * Le prix ne se compare qu'entre agregateurs qui marchent.
 *
 * Chaque terme est ramene a [0,1] PAR RAPPORT AUX AUTRES CANDIDATS du meme
 * appel. Une normalisation absolue n'aurait pas de sens : 2,5 % est cher au
 * Kenya et bon marche au Tchad.
 */

export const WEIGHTS = {
  health: 0.45,
  cost: 0.25,
  latency: 0.2,
  preference: 0.1,
} as const;

export interface ScoreInput {
  providerId: string;
  providerAccountId: string;
  /** Commission indicative de l'agregateur sur ce pays, en points de base. */
  feeBps: number;
  /** Preference du marchand : plus petit = prefere. */
  merchantPriority: number;
  catalogPriority: number;
  health: HealthStats;
  breakerState: BreakerState;
  /** Ce passage est-il une sonde de reprise ? */
  probe: boolean;
}

export interface ScoredCandidate extends ScoreInput {
  score: number;
  breakdown: {
    health: number;
    cost: number;
    latency: number;
    preference: number;
  };
  rank: number;
  reason: string;
}

/** Normalisation lineaire inversee : la plus petite valeur obtient 1. */
function lowerIsBetter(value: number, min: number, max: number): number {
  if (max === min) return 1;
  return 1 - (value - min) / (max - min);
}

/**
 * Departage stable : deux agregateurs a score identique ne doivent pas
 * dependre de l'ordre de la base. Le tirage est derive de la reference de
 * l'intention, donc reproductible pour une meme transaction (une relance
 * repart dans le meme ordre) tout en repartissant le trafic entre intentions.
 */
function tieBreak(seed: string, providerId: string): number {
  const digest = createHash('sha256').update(`${seed}:${providerId}`).digest();
  return digest.readUInt32BE(0) / 0xffffffff;
}

export function scoreCandidates(inputs: ScoreInput[], seed: string): ScoredCandidate[] {
  if (inputs.length === 0) return [];

  const fees = inputs.map((i) => i.feeBps);
  const minFee = Math.min(...fees);
  const maxFee = Math.max(...fees);

  const latencies = inputs
    .map((i) => i.health.latencyP95Ms)
    .filter((v): v is number => v !== null);
  const minLatency = latencies.length > 0 ? Math.min(...latencies) : 0;
  const maxLatency = latencies.length > 0 ? Math.max(...latencies) : 0;

  const priorities = inputs.map((i) => i.merchantPriority);
  const minPriority = Math.min(...priorities);
  const maxPriority = Math.max(...priorities);

  const scored = inputs.map((input) => {
    const health = input.health.successRate;
    const cost = lowerIsBetter(input.feeBps, minFee, maxFee);
    const latency =
      input.health.latencyP95Ms === null
        ? // Sans mesure, on ne penalise ni ne favorise : la latence inconnue
          // vaut le milieu, sinon un agregateur neuf serait systematiquement
          // avantage ou desavantage selon le sens de la normalisation.
          0.5
        : lowerIsBetter(input.health.latencyP95Ms, minLatency, maxLatency);
    const preference = lowerIsBetter(input.merchantPriority, minPriority, maxPriority);

    const score =
      WEIGHTS.health * health +
      WEIGHTS.cost * cost +
      WEIGHTS.latency * latency +
      WEIGHTS.preference * preference;

    return {
      ...input,
      score,
      breakdown: { health, cost, latency, preference },
      rank: 0,
      reason: buildReason(input, health),
    };
  });

  scored.sort((a, b) => {
    if (Math.abs(b.score - a.score) > 1e-9) return b.score - a.score;
    return tieBreak(seed, a.providerId) - tieBreak(seed, b.providerId);
  });

  scored.forEach((c, index) => {
    c.rank = index + 1;
  });

  return scored;
}

function buildReason(input: ScoreInput, health: number): string {
  const parts = [
    `sante ${(health * 100).toFixed(0)} %`,
    `${input.health.observations} appel(s) observes`,
    `cout ${(input.feeBps / 100).toFixed(2)} %`,
  ];
  if (input.health.latencyP95Ms !== null) parts.push(`p95 ${input.health.latencyP95Ms} ms`);
  if (input.probe) parts.push('sonde de reprise');
  if (input.health.declines > 0) parts.push(`${input.health.declines} refus client`);
  return parts.join(', ');
}
