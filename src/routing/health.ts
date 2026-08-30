import type { ProviderErrorCode } from '../providers/errors.js';

/**
 * Sante des agregateurs, sur fenetre glissante en memoire.
 *
 * Aucun acces base sur le chemin critique d'un paiement : la decision de
 * routage doit couter quelques microsecondes, pas une requete SQL. La
 * persistance (table provider_health) sert a l'exploitation et au redemarrage
 * a chaud, pas a la decision.
 *
 * La granularite est (agregateur, PAYS, canal) et jamais l'agregateur seul :
 * CinetPay peut etre parfaitement sain en Cote d'Ivoire et injoignable au Mali.
 * Un disjoncteur global couperait le trafic sain avec le trafic malade.
 */

export type HealthKey = string;

export function healthKey(providerId: string, country: string, channel: string): HealthKey {
  return `${providerId}|${country.toUpperCase()}|${channel}`;
}

export function parseHealthKey(key: HealthKey): {
  providerId: string;
  country: string;
  channel: string;
} {
  const [providerId = '', country = '', channel = ''] = key.split('|');
  return { providerId, country, channel };
}

/**
 * Classification d'un echec.
 *
 * `technical` : l'agregateur ou le reseau a failli. Compte pour le disjoncteur.
 * `business`  : l'agregateur a fonctionne et a transmis un refus (solde
 *               insuffisant, plafond). Ne doit JAMAIS ouvrir un disjoncteur —
 *               sinon une vague de clients sans solde couperait un agregateur
 *               en parfait etat.
 * `ours`      : notre requete etait invalide. Ne dit rien de l'agregateur.
 */
export type FailureKind = 'technical' | 'business' | 'ours';

const KIND_BY_CODE: Record<ProviderErrorCode, FailureKind> = {
  declined: 'business',
  invalid_request: 'ours',
  authentication: 'ours',
  rate_limited: 'technical',
  unavailable: 'technical',
  timeout: 'technical',
  malformed_response: 'technical',
  indeterminate: 'technical',
};

export function classifyFailure(code: ProviderErrorCode): FailureKind {
  return KIND_BY_CODE[code] ?? 'technical';
}

/* -------------------------------------------------------------------------- */

interface Sample {
  at: number;
  outcome: 'success' | FailureKind;
  latencyMs: number;
}

export interface HealthStats {
  successes: number;
  technicalFailures: number;
  declines: number;
  /** Appels retenus pour la sante technique : succes + echecs techniques. */
  observations: number;
  /**
   * Taux de succes lisse. Un agregateur sans historique obtient 0,5 et non 0
   * ou 1 : sans cela, le premier echec d'un agregateur neuf le condamnerait, et
   * un agregateur jamais essaye serait toujours prefere.
   */
  successRate: number;
  /**
   * p95 mesuree sur les seuls appels REUSSIS.
   *
   * Inclure les echecs serait pervers : un agregateur qui refuse la connexion
   * en 1 ms paraitrait plus rapide qu'un agregateur sain qui repond en 300 ms,
   * et le score le recompenserait de tomber vite. `null` tant qu'aucun succes
   * n'a ete observe — le scoring traite alors la latence comme neutre.
   */
  latencyP95Ms: number | null;
}

/** Duree de la fenetre glissante. */
const WINDOW_MS = 5 * 60 * 1000;
/** Plafond d'echantillons par cle, pour borner la memoire. */
const MAX_SAMPLES = 500;
/** Force du prior bayesien : equivaut a 2 succes et 2 echecs observes. */
const PRIOR = 2;

const samples = new Map<HealthKey, Sample[]>();

export function recordSuccess(key: HealthKey, latencyMs: number, now = Date.now()): void {
  push(key, { at: now, outcome: 'success', latencyMs });
}

export function recordFailure(
  key: HealthKey,
  kind: FailureKind,
  latencyMs: number,
  now = Date.now(),
): void {
  push(key, { at: now, outcome: kind, latencyMs });
}

function push(key: HealthKey, sample: Sample): void {
  const list = samples.get(key) ?? [];
  list.push(sample);
  if (list.length > MAX_SAMPLES) list.splice(0, list.length - MAX_SAMPLES);
  samples.set(key, list);
}

function windowed(key: HealthKey, now: number): Sample[] {
  const list = samples.get(key);
  if (!list) return [];
  const cutoff = now - WINDOW_MS;
  const kept = list.filter((s) => s.at >= cutoff);
  if (kept.length !== list.length) samples.set(key, kept);
  return kept;
}

export function stats(key: HealthKey, now = Date.now()): HealthStats {
  const list = windowed(key, now);

  let successes = 0;
  let technicalFailures = 0;
  let declines = 0;
  const latencies: number[] = [];

  for (const sample of list) {
    if (sample.outcome === 'success') {
      successes += 1;
      // Seuls les succes alimentent la latence : voir HealthStats.latencyP95Ms.
      latencies.push(sample.latencyMs);
    } else if (sample.outcome === 'technical') {
      technicalFailures += 1;
    } else if (sample.outcome === 'business') {
      declines += 1;
    }
    // 'ours' est volontairement ignore : nos propres erreurs ne disent rien de
    // la sante de l'agregateur.
  }

  const observations = successes + technicalFailures;

  return {
    successes,
    technicalFailures,
    declines,
    observations,
    successRate: (successes + PRIOR) / (observations + 2 * PRIOR),
    latencyP95Ms: percentile(latencies, 0.95),
  };
}

function percentile(values: number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1);
  return sorted[Math.max(0, index)] ?? null;
}

/** Cles ayant recu au moins un echantillon dans la fenetre. */
export function activeKeys(now = Date.now()): HealthKey[] {
  const result: HealthKey[] = [];
  for (const key of samples.keys()) {
    if (windowed(key, now).length > 0) result.push(key);
  }
  return result;
}

/** Reserve aux tests. */
export function resetHealth(): void {
  samples.clear();
}
