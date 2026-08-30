import { beforeEach, describe, expect, it } from 'vitest';
import { inspect, onFailure, onSuccess, resetBreakers, snapshot } from '../src/routing/circuit-breaker.js';
import {
  classifyFailure,
  healthKey,
  recordFailure,
  recordSuccess,
  resetHealth,
  stats,
} from '../src/routing/health.js';
import { WEIGHTS, scoreCandidates, type ScoreInput } from '../src/routing/scoring.js';

const KEY = healthKey('cinetpay', 'CI', 'mobile_money');

beforeEach(() => {
  resetHealth();
  resetBreakers();
});

/* -------------------------------------------------------------------------- */

describe('classification des echecs', () => {
  it('compte les pannes reseau comme techniques', () => {
    expect(classifyFailure('timeout')).toBe('technical');
    expect(classifyFailure('unavailable')).toBe('technical');
    expect(classifyFailure('indeterminate')).toBe('technical');
    expect(classifyFailure('rate_limited')).toBe('technical');
  });

  it('ne compte JAMAIS un refus client comme une panne agregateur', () => {
    // Une veille de paie, beaucoup de clients n'ont pas de solde. Traiter ces
    // refus comme des pannes couperait un agregateur en parfait etat.
    expect(classifyFailure('declined')).toBe('business');
  });

  it('ne reproche pas a l’agregateur nos propres erreurs', () => {
    expect(classifyFailure('invalid_request')).toBe('ours');
    expect(classifyFailure('authentication')).toBe('ours');
  });
});

describe('sante sur fenetre glissante', () => {
  it('donne 0,5 a un agregateur sans historique', () => {
    // Ni condamne au premier echec, ni systematiquement prefere parce que neuf.
    expect(stats(KEY).successRate).toBe(0.5);
    expect(stats(KEY).observations).toBe(0);
  });

  it('monte avec les succes', () => {
    for (let i = 0; i < 20; i += 1) recordSuccess(KEY, 100);
    expect(stats(KEY).successRate).toBeGreaterThan(0.85);
  });

  it('exclut les refus clients du calcul de sante', () => {
    for (let i = 0; i < 10; i += 1) recordFailure(KEY, 'business', 50);
    const s = stats(KEY);
    expect(s.declines).toBe(10);
    expect(s.observations).toBe(0);
    expect(s.successRate).toBe(0.5);
  });

  it('ignore nos propres erreurs', () => {
    for (let i = 0; i < 10; i += 1) recordFailure(KEY, 'ours', 50);
    expect(stats(KEY).observations).toBe(0);
  });

  it('oublie les evenements sortis de la fenetre', () => {
    const old = Date.now() - 10 * 60 * 1000;
    for (let i = 0; i < 10; i += 1) recordFailure(KEY, 'technical', 50, old);
    expect(stats(KEY).technicalFailures).toBe(0);
  });

  it('calcule un p95 sur les appels aboutis', () => {
    for (let i = 1; i <= 100; i += 1) recordSuccess(KEY, i);
    expect(stats(KEY).latencyP95Ms).toBe(95);
  });

  it('ne mesure JAMAIS la latence sur les echecs', () => {
    // Un agregateur qui refuse la connexion en 1 ms paraitrait plus rapide
    // qu'un agregateur sain qui repond en 300 ms : le score le recompenserait
    // de tomber vite, et le prefererait a un agregateur qui marche.
    for (let i = 0; i < 20; i += 1) recordFailure(KEY, 'technical', 1);
    expect(stats(KEY).latencyP95Ms).toBeNull();
  });

  it('ignore les echecs rapides dans le p95 des succes', () => {
    for (let i = 0; i < 10; i += 1) recordSuccess(KEY, 300);
    for (let i = 0; i < 10; i += 1) recordFailure(KEY, 'technical', 1);
    expect(stats(KEY).latencyP95Ms).toBe(300);
  });
});

/* -------------------------------------------------------------------------- */

describe('disjoncteur', () => {
  it('laisse passer tant que rien ne va mal', () => {
    expect(inspect(KEY)).toMatchObject({ state: 'CLOSED', allowed: true });
  });

  it('ouvre apres cinq echecs techniques consecutifs', () => {
    for (let i = 0; i < 5; i += 1) {
      recordFailure(KEY, 'technical', 100);
      onFailure(KEY, 'unavailable');
    }
    expect(inspect(KEY)).toMatchObject({ state: 'OPEN', allowed: false });
  });

  it('n’ouvre jamais sur des refus clients, meme nombreux', () => {
    for (let i = 0; i < 50; i += 1) {
      recordFailure(KEY, 'business', 100);
      onFailure(KEY, 'declined');
    }
    expect(inspect(KEY).state).toBe('CLOSED');
  });

  it('n’ouvre pas si le taux d’echec reste minoritaire', () => {
    for (let i = 0; i < 5; i += 1) {
      recordFailure(KEY, 'technical', 100);
      onFailure(KEY, 'timeout');
    }
    // Rejoue avec beaucoup de succes autour : 5 echecs sur 100 appels n'est pas
    // une panne, c'est du bruit.
    resetBreakers();
    resetHealth();
    for (let i = 0; i < 95; i += 1) recordSuccess(KEY, 100);
    for (let i = 0; i < 5; i += 1) {
      recordFailure(KEY, 'technical', 100);
      onFailure(KEY, 'timeout');
    }
    expect(inspect(KEY).state).toBe('CLOSED');
  });

  it('passe en sonde apres la temporisation', () => {
    const t0 = Date.now();
    for (let i = 0; i < 5; i += 1) {
      recordFailure(KEY, 'technical', 100, t0);
      onFailure(KEY, 'unavailable', t0);
    }
    expect(inspect(KEY, t0).state).toBe('OPEN');

    const verdict = inspect(KEY, t0 + 31_000);
    expect(verdict.state).toBe('HALF_OPEN');
    expect(verdict.allowed).toBe(true);
    expect(verdict.probe).toBe(true);
  });

  it('ne laisse passer qu’une seule sonde a la fois', () => {
    const t0 = Date.now();
    for (let i = 0; i < 5; i += 1) {
      recordFailure(KEY, 'technical', 100, t0);
      onFailure(KEY, 'unavailable', t0);
    }
    const t1 = t0 + 31_000;
    expect(inspect(KEY, t1).allowed).toBe(true);
    // Sonder avec dix paiements ferait dix victimes au lieu d'une.
    expect(inspect(KEY, t1 + 10).allowed).toBe(false);
  });

  it('rend le jeton de sonde non consomme apres expiration', () => {
    const t0 = Date.now();
    for (let i = 0; i < 5; i += 1) {
      recordFailure(KEY, 'technical', 100, t0);
      onFailure(KEY, 'unavailable', t0);
    }
    const t1 = t0 + 31_000;
    inspect(KEY, t1); // jeton pris par un candidat finalement non retenu
    // Sans expiration, l'agregateur ne se retablirait jamais.
    expect(inspect(KEY, t1 + 61_000).allowed).toBe(true);
  });

  it('referme sur une sonde reussie', () => {
    const t0 = Date.now();
    for (let i = 0; i < 5; i += 1) {
      recordFailure(KEY, 'technical', 100, t0);
      onFailure(KEY, 'unavailable', t0);
    }
    inspect(KEY, t0 + 31_000);
    onSuccess(KEY);
    expect(inspect(KEY, t0 + 32_000).state).toBe('CLOSED');
  });

  it('rouvre immediatement sur une sonde qui echoue, avec une attente doublee', () => {
    const t0 = Date.now();
    for (let i = 0; i < 5; i += 1) {
      recordFailure(KEY, 'technical', 100, t0);
      onFailure(KEY, 'unavailable', t0);
    }
    const first = snapshot(t0).find((s) => s.key === KEY)!;
    const firstCooldown = first.nextProbeAt! - t0;

    const t1 = t0 + 31_000;
    inspect(KEY, t1);
    onFailure(KEY, 'unavailable', t1);

    const second = snapshot(t1).find((s) => s.key === KEY)!;
    expect(second.state).toBe('OPEN');
    expect(second.nextProbeAt! - t1).toBe(firstCooldown * 2);
  });
});

/* -------------------------------------------------------------------------- */

function candidate(over: Partial<ScoreInput> = {}): ScoreInput {
  return {
    providerId: 'p',
    providerAccountId: 'acc',
    feeBps: 200,
    merchantPriority: 100,
    catalogPriority: 1,
    health: {
      successes: 0,
      technicalFailures: 0,
      declines: 0,
      observations: 0,
      successRate: 0.5,
      latencyP95Ms: null,
    },
    breakerState: 'CLOSED',
    probe: false,
    ...over,
  };
}

describe('scoring', () => {
  it('repartit exactement le poids total', () => {
    const total = Object.values(WEIGHTS).reduce((a, b) => a + b, 0);
    expect(total).toBeCloseTo(1, 10);
  });

  it('prefere la fiabilite au prix', () => {
    // Un agregateur deux fois moins cher mais qui echoue une fois sur trois
    // coute infiniment plus cher qu'un agregateur fiable a 0,5 % de plus.
    const cheapAndBroken = candidate({
      providerId: 'pas_cher',
      feeBps: 100,
      health: { successes: 6, technicalFailures: 14, declines: 0, observations: 20, successRate: 0.33, latencyP95Ms: 200 },
    });
    const dearAndSolid = candidate({
      providerId: 'fiable',
      feeBps: 300,
      health: { successes: 60, technicalFailures: 0, declines: 0, observations: 60, successRate: 0.97, latencyP95Ms: 200 },
    });

    const [first] = scoreCandidates([cheapAndBroken, dearAndSolid], 'ref');
    expect(first!.providerId).toBe('fiable');
  });

  it('prefere le moins cher a fiabilite egale', () => {
    const a = candidate({ providerId: 'cher', feeBps: 300 });
    const b = candidate({ providerId: 'economique', feeBps: 100 });
    const [first] = scoreCandidates([a, b], 'ref');
    expect(first!.providerId).toBe('economique');
  });

  it('respecte la preference du marchand a egalite par ailleurs', () => {
    const a = candidate({ providerId: 'secondaire', merchantPriority: 50 });
    const b = candidate({ providerId: 'principal', merchantPriority: 1 });
    const [first] = scoreCandidates([a, b], 'ref');
    expect(first!.providerId).toBe('principal');
  });

  it('ne penalise pas une latence inconnue', () => {
    const known = candidate({
      providerId: 'mesure',
      health: { ...candidate().health, latencyP95Ms: 800, observations: 10, successRate: 0.5 },
    });
    const unknown = candidate({ providerId: 'neuf' });
    const scored = scoreCandidates([known, unknown], 'ref');
    const neuf = scored.find((c) => c.providerId === 'neuf')!;
    expect(neuf.breakdown.latency).toBe(0.5);
  });

  it('departage de facon stable pour une meme intention', () => {
    const inputs = [candidate({ providerId: 'a' }), candidate({ providerId: 'b' })];
    const first = scoreCandidates(inputs, 'cmd-4821').map((c) => c.providerId);
    const second = scoreCandidates(inputs, 'cmd-4821').map((c) => c.providerId);
    // Une relance doit repartir dans le meme ordre.
    expect(second).toEqual(first);
  });

  it('repartit le trafic entre intentions differentes', () => {
    const inputs = [
      candidate({ providerId: 'a' }),
      candidate({ providerId: 'b' }),
      candidate({ providerId: 'c' }),
    ];
    const winners = new Set(
      Array.from({ length: 60 }, (_, i) => scoreCandidates(inputs, `cmd-${i}`)[0]!.providerId),
    );
    // A score strictement egal, le premier ne doit pas toujours etre le meme.
    expect(winners.size).toBeGreaterThan(1);
  });

  it('explique sa decision en clair', () => {
    const [only] = scoreCandidates([candidate({ providerId: 'x' })], 'ref');
    expect(only!.reason).toMatch(/sante \d+ %/);
    expect(only!.reason).toMatch(/cout \d/);
  });
});
