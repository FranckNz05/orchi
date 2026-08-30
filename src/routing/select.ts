import type { Channel } from '../catalog/coverage.js';
import { AppError } from '../core/errors.js';
import { prisma } from '../db/client.js';
import { getProviderAdapter } from '../providers/registry.js';
import type { Direction } from '../providers/types.js';
import { inspect, type BreakerState } from './circuit-breaker.js';
import { healthKey, stats } from './health.js';
import { scoreCandidates, type ScoreInput } from './scoring.js';

/**
 * Selection de l'agregateur pour UNE tentative.
 *
 * Quatre conditions doivent etre reunies pour qu'un agregateur soit candidat :
 *   1. le catalogue le declare present sur (pays, canal, sens) ;
 *   2. Orchi possede un adaptateur pour lui ;
 *   3. le marchand a un compte actif chez lui, dans le bon environnement ;
 *   4. son disjoncteur n'est pas ouvert.
 *
 * La condition 3 est la contrainte structurante du modele A : router vers
 * quatre agregateurs suppose que le marchand est onboarde chez les quatre.
 *
 * Les candidats retenus sont ensuite ORDONNES par score (src/routing/scoring.ts).
 * Les agregateurs ecartes par leur disjoncteur sont conserves dans
 * `rejected` : la decision doit rester explicable, y compris sur ce qu'elle
 * n'a pas retenu.
 */

export interface RoutingCandidate {
  providerId: string;
  providerAccountId: string;
  /** Rang dans l'ordre d'essai, 1 = premier. */
  rank: number;
  /** Motif lisible, conserve dans la decision de routage. */
  reason: string;
  score: number;
  breakdown: { health: number; cost: number; latency: number; preference: number };
  breakerState: BreakerState;
  probe: boolean;
  feeBps: number;
  catalogPriority: number;
  merchantPriority: number;
}

export interface RejectedCandidate {
  providerId: string;
  reason: string;
  breakerState?: BreakerState;
  nextProbeAt?: string;
}

export interface RoutingPlan {
  candidates: RoutingCandidate[];
  rejected: RejectedCandidate[];
}

export interface RoutingRequest {
  merchantId: string;
  environment: 'test' | 'live';
  country: string;
  channel: Channel;
  direction: Direction;
  /** Reference de l'intention : sert de graine au departage deterministe. */
  seed: string;
  /** Force un agregateur precis (debogage, contrat marchand specifique). */
  preferredProviderId?: string;
  /** Agregateurs deja essayes sans succes pour cette intention. */
  excludeProviderIds?: string[];
}

export function noRouteError(
  request: RoutingRequest,
  detail: string,
  rejected: RejectedCandidate[] = [],
): AppError {
  return new AppError({
    type: 'routing_error',
    code: 'no_route_available',
    message: detail,
    httpStatus: 422,
    retriable: rejected.some((r) => r.breakerState === 'OPEN'),
    details: {
      country: request.country,
      channel: request.channel,
      direction: request.direction,
      ...(request.excludeProviderIds?.length ? { already_tried: request.excludeProviderIds } : {}),
      ...(rejected.length ? { rejected } : {}),
    },
  });
}

export async function selectCandidates(request: RoutingRequest): Promise<RoutingPlan> {
  const country = request.country.toUpperCase();
  const excluded = new Set(request.excludeProviderIds ?? []);
  const rejected: RejectedCandidate[] = [];

  const [rules, countryRow, accounts] = await Promise.all([
    prisma.coverageRule.findMany({
      where: {
        countryIso2: country,
        enabled: true,
        provider: { enabled: true },
        country: { enabled: true },
        ...(request.direction === 'payin' ? { supportsPayin: true } : { supportsPayout: true }),
      },
      include: { provider: true },
      orderBy: { priority: 'asc' },
    }),
    prisma.country.findUnique({ where: { iso2: country } }),
    prisma.providerAccount.findMany({
      where: { merchantId: request.merchantId, environment: request.environment, status: 'ACTIVE' },
    }),
  ]);

  if (rules.length === 0) {
    throw noRouteError(request, `Aucun agregateur au catalogue pour ${country}.`);
  }

  const accountByProvider = new Map(accounts.map((a) => [a.providerId, a]));
  const inputs: ScoreInput[] = [];

  const consider = (
    providerId: string,
    providerAccountId: string,
    feeBps: number,
    catalogPriority: number,
    merchantPriority: number,
  ): void => {
    const key = healthKey(providerId, country, request.channel);
    const verdict = inspect(key);

    if (!verdict.allowed) {
      rejected.push({
        providerId,
        reason:
          verdict.state === 'OPEN'
            ? 'disjoncteur ouvert : agregateur ecarte'
            : 'sonde de reprise deja en cours',
        breakerState: verdict.state,
        ...(verdict.nextProbeAt ? { nextProbeAt: new Date(verdict.nextProbeAt).toISOString() } : {}),
      });
      return;
    }

    inputs.push({
      providerId,
      providerAccountId,
      feeBps,
      merchantPriority,
      catalogPriority,
      health: stats(key),
      breakerState: verdict.state,
      probe: verdict.probe,
    });
  };

  for (const rule of rules) {
    if (excluded.has(rule.providerId)) continue;
    if (request.preferredProviderId && rule.providerId !== request.preferredProviderId) continue;
    if (!rule.channels.split(',').map((c) => c.trim()).includes(request.channel)) continue;

    const adapter = getProviderAdapter(rule.providerId);
    if (!adapter) continue;

    const account = accountByProvider.get(rule.providerId);
    if (!account) continue;

    if (!adapter.supports(country, request.channel, request.direction)) continue;

    // Le cout retenu est le bas de la fourchette : c'est la seule valeur
    // comparable entre agregateurs, la borne haute dependant du reseau.
    const feeBps = rule.feeMinBps ?? countryRow?.feeMinBps ?? 0;
    consider(rule.providerId, account.id, feeBps, rule.priority, account.priority);
  }

  if (inputs.length === 0) {
    throw noRouteError(
      request,
      diagnose(request, country, rules.length, accounts.length, excluded.size, rejected.length),
      rejected,
    );
  }

  const scored = scoreCandidates(inputs, request.seed);

  return {
    candidates: scored.map((c) => ({
      providerId: c.providerId,
      providerAccountId: c.providerAccountId,
      rank: c.rank,
      reason: c.reason,
      score: Number(c.score.toFixed(4)),
      breakdown: {
        health: Number(c.breakdown.health.toFixed(4)),
        cost: Number(c.breakdown.cost.toFixed(4)),
        latency: Number(c.breakdown.latency.toFixed(4)),
        preference: Number(c.breakdown.preference.toFixed(4)),
      },
      breakerState: c.breakerState,
      probe: c.probe,
      feeBps: c.feeBps,
      catalogPriority: c.catalogPriority,
      merchantPriority: c.merchantPriority,
    })),
    rejected,
  };
}

/**
 * Message d'echec exploitable : sans cela, le marchand recoit "aucune route"
 * sans savoir s'il lui manque un compte, un canal, si tout est deja essaye, ou
 * si un disjoncteur a tout coupe.
 */
function diagnose(
  request: RoutingRequest,
  country: string,
  ruleCount: number,
  accountCount: number,
  excludedCount: number,
  rejectedCount: number,
): string {
  if (accountCount === 0) {
    return (
      `Aucun compte agregateur actif en environnement ${request.environment}. ` +
      'Connectez-en un via POST /v1/provider-accounts.'
    );
  }
  if (rejectedCount > 0) {
    return (
      `Tous les agregateurs desservant ${country} sont actuellement ecartes par leur ` +
      'disjoncteur. Reessayez apres la prochaine sonde.'
    );
  }
  if (excludedCount > 0) {
    return `Tous les agregateurs disponibles pour ${country} ont deja ete essayes.`;
  }
  return (
    `Aucun agregateur branche ne dessert ${country} en ${request.channel} (${request.direction}) ` +
    `parmi vos comptes. ${ruleCount} agregateur(s) au catalogue, ${accountCount} compte(s) connecte(s).`
  );
}
