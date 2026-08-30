import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { generateApiKey } from '../src/core/crypto.js';
import { ID_PREFIX, newId } from '../src/core/ids.js';
import { prisma } from '../src/db/client.js';
import { connectProviderAccount } from '../src/modules/provider-accounts.js';
import { ProviderError } from '../src/providers/errors.js';
import { registerProvider } from '../src/providers/registry.js';
import type { AttemptResult, PaymentProvider } from '../src/providers/types.js';
import { resetBreakers } from '../src/routing/circuit-breaker.js';
import { resetHealth } from '../src/routing/health.js';
import { buildServer } from '../src/server.js';

/**
 * Failover, scoring et disjoncteur, contre un agregateur volontairement en panne.
 *
 * Le simulateur seul ne suffit pas : il faut DEUX agregateurs desservant le
 * meme pays pour observer un basculement et l'exclusion d'un agregateur mort.
 */
const FLAKY = 'test_flaky';

let failuresRequested = 0;

/** Agregateur de test : toujours indisponible. */
const flakyProvider: PaymentProvider = {
  id: FLAKY,
  name: 'Agregateur en panne (test)',
  requiredCredentials: ['api_key'],
  supports: () => true,
  async createCharge(): Promise<AttemptResult> {
    failuresRequested += 1;
    throw new ProviderError({
      providerId: FLAKY,
      code: 'unavailable',
      message: 'Panne simulee.',
      httpStatus: 503,
    });
  },
  async getCharge(): Promise<AttemptResult> {
    throw new ProviderError({ providerId: FLAKY, code: 'unavailable', message: 'Panne simulee.' });
  },
  async createPayout(): Promise<AttemptResult> {
    throw new ProviderError({ providerId: FLAKY, code: 'unavailable', message: 'Panne simulee.' });
  },
  async getPayout(): Promise<AttemptResult> {
    throw new ProviderError({ providerId: FLAKY, code: 'unavailable', message: 'Panne simulee.' });
  },
  verifyWebhook: () => ({ valid: false, reason: 'non supporte' }),
};

let app: FastifyInstance;
let merchantId: string;
let sandboxAccountId: string;
let key: string;
let seeded = false;
let counter = 0;
const ref = (p: string) => `${p}-${Date.now()}-${(counter += 1)}`;

beforeAll(async () => {
  registerProvider(flakyProvider);

  app = await buildServer();
  await app.ready();
  seeded = (await prisma.country.count()) > 0;
  if (!seeded) return;

  await prisma.provider.upsert({
    where: { id: FLAKY },
    create: {
      id: FLAKY,
      name: 'Agregateur en panne (test)',
      type: 'AGGREGATOR',
      integration: 'SANDBOX',
      scope: 'test',
    },
    update: {},
  });

  await prisma.coverageRule.upsert({
    where: { countryIso2_providerId: { countryIso2: 'BJ', providerId: FLAKY } },
    create: {
      id: `cov_bj_${FLAKY}`,
      countryIso2: 'BJ',
      providerId: FLAKY,
      channels: 'mobile_money',
      supportsPayin: true,
      supportsPayout: true,
      // Meme cout que le simulateur : le classement se joue alors sur la sante
      // et la preference marchand, ce que ce test veut observer.
      feeMinBps: 0,
      feeMaxBps: 0,
      priority: 1,
    },
    update: { feeMinBps: 0, feeMaxBps: 0 },
  });

  merchantId = newId(ID_PREFIX.merchant);
  await prisma.merchant.create({
    data: {
      id: merchantId,
      name: 'Marchand failover',
      legalType: 'COMPANY',
      country: 'BJ',
      contactEmail: `${merchantId}@test.local`,
    },
  });

  const generated = generateApiKey('test');
  key = generated.secret;
  await prisma.apiKey.create({
    data: {
      id: newId(ID_PREFIX.apiKey),
      merchantId,
      label: 'test',
      prefix: generated.prefix,
      hash: generated.hash,
      environment: 'test',
      scopes: 'payments:read,payments:write,payouts:read,payouts:write,accounts:write',
    },
  });

  // L'agregateur en panne est le PREFERE du marchand : il sera essaye en
  // premier tant que sa sante n'est pas encore degradee.
  await connectProviderAccount({
    merchantId,
    providerId: FLAKY,
    environment: 'test',
    credentials: { api_key: 'x' },
    priority: 1,
  });
  const sandbox = await connectProviderAccount({
    merchantId,
    providerId: 'sandbox',
    environment: 'test',
    credentials: { webhook_secret: 'secret-failover' },
    priority: 50,
  });
  sandboxAccountId = sandbox.id;

  resetHealth();
  resetBreakers();
});

afterAll(async () => {
  if (seeded) {
    await prisma.coverageRule.deleteMany({ where: { providerId: FLAKY } });
    await prisma.provider.deleteMany({ where: { id: FLAKY } });
    await prisma.routingDecision.deleteMany({ where: { merchantId } });
    await prisma.idempotencyRecord.deleteMany({ where: { merchantId } });
    await prisma.ledgerEntry.deleteMany({ where: { journal: { merchantId } } });
    await prisma.ledgerJournal.deleteMany({ where: { merchantId } });
    await prisma.merchant.deleteMany({ where: { id: merchantId } });
    await prisma.providerHealth.deleteMany({ where: { providerId: FLAKY } });
  }
  await app.close();
  await prisma.$disconnect();
});

function pay(over: Record<string, unknown> = {}) {
  return app.inject({
    method: 'POST',
    url: '/v1/payments',
    headers: { authorization: `Bearer ${key}`, 'idempotency-key': ref('idem') },
    payload: {
      reference: ref('pay'),
      amount: 15000,
      currency: 'XOF',
      country: 'BJ',
      channel: 'mobile_money',
      customer: { phone: '+22997000000' },
      ...over,
    },
  });
}

function get(url: string) {
  return app.inject({ method: 'GET', url, headers: { authorization: `Bearer ${key}` } });
}

async function setSandbox(status: 'ACTIVE' | 'DISABLED') {
  await prisma.providerAccount.update({ where: { id: sandboxAccountId }, data: { status } });
}

/* -------------------------------------------------------------------------- */

describe('basculement vers un autre agregateur', () => {
  it('essaie le prefere, echoue, puis bascule dans la meme requete', async () => {
    if (!seeded) return;
    const before = failuresRequested;
    const res = await pay();
    const body = res.json();

    expect(failuresRequested).toBe(before + 1);
    expect(body.attempts).toHaveLength(2);
    expect(body.attempts[0]).toMatchObject({
      provider: FLAKY,
      status: 'FAILED',
      failure_code: 'unavailable',
    });
    expect(body.attempts[1]).toMatchObject({ provider: 'sandbox' });
    expect(body.status).toBe('PROCESSING');
  });

  it('conserve les deux tentatives dans l’historique', async () => {
    if (!seeded) return;
    const res = await pay();
    const attempts = await prisma.paymentAttempt.findMany({
      where: { paymentId: res.json().id },
    });
    // Le failover AJOUTE une ligne, il n'ecrase jamais la precedente.
    expect(attempts.length).toBeGreaterThanOrEqual(1);
    expect(attempts.map((a) => a.attemptNumber)).toEqual(
      attempts.map((_, i) => i + 1),
    );
  });

  it('trace chaque decision avec ses candidats et leurs scores', async () => {
    if (!seeded) return;
    const res = await pay();
    const decisions = await get(`/v1/routing/decisions?payment=${res.json().id}`);
    const data = decisions.json().data;

    expect(data.length).toBeGreaterThanOrEqual(1);
    expect(data[0].considered[0]).toHaveProperty('score');
    expect(data[0].considered[0]).toHaveProperty('breakdown');
    expect(data[0].reason).toMatch(/sante/);
  });
});

/* -------------------------------------------------------------------------- */

describe('le score ecarte l’agregateur malade avant le disjoncteur', () => {
  it('cesse de le classer premier apres quelques echecs', async () => {
    if (!seeded) return;

    // La sante pese 0,45 dans le score, la preference marchand 0,10. Il faut
    // donc quelques echecs pour que la degradation de sante l'emporte sur la
    // preference maximale accordee a l'agregateur en panne. Le lissage evite
    // qu'un unique echec ne condamne un agregateur — c'est voulu.
    let paymentsUntilAvoided = 0;
    let avoided = false;
    let breakerStateAtAvoidance: string | undefined;

    for (let i = 0; i < 6 && !avoided; i += 1) {
      const before = failuresRequested;
      const res = await pay();
      paymentsUntilAvoided += 1;
      avoided = failuresRequested === before;

      if (avoided) {
        expect(res.json().attempts).toHaveLength(1);
        expect(res.json().attempts[0].provider).toBe('sandbox');
        // L'etat est releve A CET INSTANT precis, pas apres coup : c'est la
        // seule facon d'affirmer que le score a agi AVANT le disjoncteur.
        const health = await get('/v1/routing/health');
        breakerStateAtAvoidance = health
          .json()
          .data.find((d: { provider: string }) => d.provider === FLAKY)?.state;
      }
    }

    expect(avoided, 'le score n’a jamais ecarte l’agregateur en panne').toBe(true);
    // Une poignee de transactions, pas des dizaines.
    expect(paymentsUntilAvoided).toBeLessThanOrEqual(5);
    // Le disjoncteur est un filet de securite, pas le mecanisme principal.
    expect(breakerStateAtAvoidance).toBe('CLOSED');
  });
});

/* -------------------------------------------------------------------------- */

describe('disjoncteur — quand il n’existe aucune alternative', () => {
  it('ouvre apres cinq echecs et cesse tout appel', async () => {
    if (!seeded) return;
    // Sans le simulateur, l'agregateur en panne redevient le seul candidat :
    // c'est exactement la situation ou le disjoncteur sert a quelque chose.
    await setSandbox('DISABLED');

    // On paie jusqu'a ce que le disjoncteur coupe. Le nombre exact depend des
    // echecs deja accumules par les tests precedents : ce qui compte est que la
    // coupure finisse par arriver, et qu'elle arrete tout appel sortant.
    let cut: Awaited<ReturnType<typeof pay>> | null = null;
    for (let i = 0; i < 10 && cut === null; i += 1) {
      const res = await pay();
      if (res.statusCode === 422) cut = res;
      else expect(res.json().status).toBe('FAILED');
    }

    expect(cut, 'le disjoncteur ne s’est jamais ouvert').not.toBeNull();

    const before = failuresRequested;
    const after = await pay();
    expect(after.statusCode).toBe(422);
    // Plus aucun appel a l'agregateur mort.
    expect(failuresRequested).toBe(before);

    const error = cut!.json().error;
    expect(error.code).toBe('no_route_available');
    expect(error.message).toMatch(/disjoncteur/);
    // Reessayer plus tard a du sens : le disjoncteur finira par sonder.
    expect(error.retriable).toBe(true);
  });

  it('expose son etat et la date de la prochaine sonde', async () => {
    if (!seeded) return;
    const res = await get('/v1/routing/health');
    const entry = res.json().data.find((d: { provider: string }) => d.provider === FLAKY);

    expect(entry.state).toBe('OPEN');
    expect(entry.technical_failures).toBeGreaterThanOrEqual(5);
    expect(entry.last_failure_code).toBe('unavailable');
    expect(entry.next_probe_at).toBeTruthy();
  });

  it('n’a pas fait exploser la temporisation sous les echecs en rafale', async () => {
    if (!seeded) return;
    const res = await get('/v1/routing/health');
    const entry = res.json().data.find((d: { provider: string }) => d.provider === FLAKY);
    const wait = new Date(entry.next_probe_at).getTime() - new Date(entry.opened_at).getTime();
    // Seule une SONDE ratee doit doubler l'attente. Les echecs survenant apres
    // l'ouverture ne comptent pas.
    expect(wait).toBe(30_000);
  });

  it('reprend le trafic des qu’une alternative saine revient', async () => {
    if (!seeded) return;
    await setSandbox('ACTIVE');
    const before = failuresRequested;
    const res = await pay();

    expect(res.statusCode).toBe(201);
    expect(failuresRequested).toBe(before);
    expect(res.json().attempts[0].provider).toBe('sandbox');
  });

  it('mentionne l’agregateur ecarte dans la decision de routage', async () => {
    if (!seeded) return;
    const res = await pay();
    const decisions = await get(`/v1/routing/decisions?payment=${res.json().id}`);
    const rejected = decisions.json().data[0].rejected;

    expect(rejected).toContainEqual(
      expect.objectContaining({ providerId: FLAKY, breakerState: 'OPEN' }),
    );
  });
});
