import { logger } from '../core/logger.js';
import { classifyFailure, healthKey, parseHealthKey, stats, type HealthKey } from './health.js';
import type { ProviderErrorCode } from '../providers/errors.js';

/**
 * Disjoncteur par (agregateur, pays, canal).
 *
 * Objectif : cesser d'envoyer du trafic a un agregateur en panne, et le
 * reessayer prudemment quand il revient — sans jamais couper pour de mauvaises
 * raisons.
 *
 * Ce qui ouvre le disjoncteur : timeouts, indisponibilites, quotas, reponses
 * illisibles. Ce qui ne l'ouvre JAMAIS : les refus clients (solde insuffisant)
 * et nos propres requetes invalides. Confondre les deux ferait couper un
 * agregateur parfaitement sain le jour ou beaucoup de clients n'ont pas de
 * solde — typiquement une veille de paie.
 *
 * Etats :
 *   CLOSED     trafic normal
 *   OPEN       agregateur ecarte du routage jusqu'a `nextProbeAt`
 *   HALF_OPEN  une seule transaction laissee passer, en sonde
 */

export type BreakerState = 'CLOSED' | 'OPEN' | 'HALF_OPEN';

/** Nombre minimal d'echecs techniques avant d'envisager l'ouverture. */
const FAILURE_THRESHOLD = 5;
/** Taux d'echec technique declenchant l'ouverture. */
const FAILURE_RATE_THRESHOLD = 0.5;
/** Attente initiale avant la premiere sonde. */
const BASE_COOLDOWN_MS = 30 * 1000;
/** Plafond de l'attente, malgre le doublement a chaque rechute. */
const MAX_COOLDOWN_MS = 5 * 60 * 1000;
/**
 * Duree de validite du jeton de sonde.
 *
 * Le jeton est pris a la SELECTION, avant de savoir si l'agregateur sera
 * reellement appele : un candidat evalue puis non retenu — ou un processus qui
 * meurt entre les deux — le retiendrait sinon indefiniment, et l'agregateur ne
 * se retablirait jamais. Passe ce delai, le jeton est rendu.
 */
const PROBE_TOKEN_TTL_MS = 60 * 1000;

interface BreakerRecord {
  state: BreakerState;
  openedAt: number | null;
  nextProbeAt: number | null;
  /** Ouvertures consecutives, pilote le doublement de l'attente. */
  consecutiveOpens: number;
  lastFailureCode: string | null;
  /** Horodatage du jeton de sonde en cours, null si aucun. */
  probeStartedAt: number | null;
}

const breakers = new Map<HealthKey, BreakerRecord>();

function record(key: HealthKey): BreakerRecord {
  let entry = breakers.get(key);
  if (!entry) {
    entry = {
      state: 'CLOSED',
      openedAt: null,
      nextProbeAt: null,
      consecutiveOpens: 0,
      lastFailureCode: null,
      probeStartedAt: null,
    };
    breakers.set(key, entry);
  }
  return entry;
}

export interface BreakerVerdict {
  state: BreakerState;
  /** L'agregateur peut-il recevoir cette transaction ? */
  allowed: boolean;
  /** true si ce passage est une sonde de reprise. */
  probe: boolean;
  nextProbeAt: number | null;
}

/**
 * Consulte le disjoncteur. Ne modifie l'etat que pour la transition
 * OPEN -> HALF_OPEN, qui depend du temps ecoule.
 */
export function inspect(key: HealthKey, now = Date.now()): BreakerVerdict {
  const entry = record(key);

  if (entry.state === 'OPEN') {
    if (entry.nextProbeAt !== null && now >= entry.nextProbeAt) {
      entry.state = 'HALF_OPEN';
      entry.probeStartedAt = null;
      logger.info({ key, ...parseHealthKey(key) }, 'Disjoncteur en sonde');
    } else {
      return { state: 'OPEN', allowed: false, probe: false, nextProbeAt: entry.nextProbeAt };
    }
  }

  if (entry.state === 'HALF_OPEN') {
    // Une seule transaction a la fois : sonder avec dix paiements ferait dix
    // victimes au lieu d'une si l'agregateur est toujours en panne.
    const held = entry.probeStartedAt !== null && now - entry.probeStartedAt < PROBE_TOKEN_TTL_MS;
    if (held) {
      return { state: 'HALF_OPEN', allowed: false, probe: false, nextProbeAt: entry.nextProbeAt };
    }
    entry.probeStartedAt = now;
    return { state: 'HALF_OPEN', allowed: true, probe: true, nextProbeAt: entry.nextProbeAt };
  }

  return { state: 'CLOSED', allowed: true, probe: false, nextProbeAt: null };
}

export function onSuccess(key: HealthKey): void {
  const entry = record(key);
  entry.probeStartedAt = null;

  if (entry.state !== 'CLOSED') {
    logger.info({ key, ...parseHealthKey(key) }, 'Disjoncteur referme');
  }
  entry.state = 'CLOSED';
  entry.openedAt = null;
  entry.nextProbeAt = null;
  entry.consecutiveOpens = 0;
  entry.lastFailureCode = null;
}

export function onFailure(key: HealthKey, code: ProviderErrorCode, now = Date.now()): void {
  const entry = record(key);
  entry.probeStartedAt = null;
  entry.lastFailureCode = code;

  const kind = classifyFailure(code);
  if (kind !== 'technical') return;

  // Une sonde qui echoue rouvre immediatement, sans attendre le seuil : on
  // vient de verifier que l'agregateur est toujours en panne.
  if (entry.state === 'HALF_OPEN') {
    open(entry, key, code, now);
    return;
  }

  // Deja ouvert : les requetes encore en vol au moment de l'ouverture vont
  // echouer en rafale. Les compter comme autant de rechutes ferait bondir la
  // temporisation au plafond des la premiere panne. Seule une SONDE ratee
  // justifie d'attendre plus longtemps.
  if (entry.state === 'OPEN') return;

  const s = stats(key, now);
  const failureRate = s.observations === 0 ? 0 : s.technicalFailures / s.observations;

  if (s.technicalFailures >= FAILURE_THRESHOLD && failureRate >= FAILURE_RATE_THRESHOLD) {
    open(entry, key, code, now);
  }
}

function open(entry: BreakerRecord, key: HealthKey, code: string, now: number): void {
  entry.consecutiveOpens += 1;
  const cooldown = Math.min(
    BASE_COOLDOWN_MS * 2 ** (entry.consecutiveOpens - 1),
    MAX_COOLDOWN_MS,
  );

  entry.state = 'OPEN';
  entry.openedAt = now;
  entry.nextProbeAt = now + cooldown;

  logger.warn(
    { key, ...parseHealthKey(key), code, cooldown_ms: cooldown, opens: entry.consecutiveOpens },
    'Disjoncteur ouvert',
  );
}

export interface BreakerSnapshot {
  key: HealthKey;
  providerId: string;
  country: string;
  channel: string;
  state: BreakerState;
  openedAt: number | null;
  nextProbeAt: number | null;
  lastFailureCode: string | null;
}

export function snapshot(now = Date.now()): BreakerSnapshot[] {
  const out: BreakerSnapshot[] = [];
  for (const [key, entry] of breakers) {
    // Rafraichit les transitions temporelles avant l'instantane.
    if (entry.state === 'OPEN' && entry.nextProbeAt !== null && now >= entry.nextProbeAt) {
      entry.state = 'HALF_OPEN';
      entry.probeStartedAt = null;
    }
    out.push({ key, ...parseHealthKey(key), state: entry.state, openedAt: entry.openedAt, nextProbeAt: entry.nextProbeAt, lastFailureCode: entry.lastFailureCode });
  }
  return out;
}

/**
 * Force l'ouverture. Utilise au demarrage a chaud : un processus qui repart ne
 * doit pas relancer du trafic sur un agregateur qu'on venait de couper.
 */
export function forceOpen(
  providerId: string,
  country: string,
  channel: string,
  nextProbeAt: number,
  code: string | null,
): void {
  const key = healthKey(providerId, country, channel);
  const entry = record(key);
  entry.state = 'OPEN';
  entry.openedAt = Date.now();
  entry.nextProbeAt = nextProbeAt;
  entry.lastFailureCode = code;
  entry.probeStartedAt = null;
  entry.consecutiveOpens = Math.max(entry.consecutiveOpens, 1);
}

/** Reserve aux tests. */
export function resetBreakers(): void {
  breakers.clear();
}
