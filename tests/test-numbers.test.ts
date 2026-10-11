import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { testScenarioOf } from '../src/catalog/test-numbers.js';
import { generateApiKey } from '../src/core/crypto.js';
import { env } from '../src/core/env.js';
import { ID_PREFIX, newId } from '../src/core/ids.js';
import { prisma } from '../src/db/client.js';
import { connectProviderAccount } from '../src/modules/provider-accounts.js';
import { buildServer } from '../src/server.js';

/**
 * Numeros de test : partie nationale nulle sauf le dernier chiffre, qui choisit
 * l'issue. Ils forcent le simulateur, en test seulement.
 */

let app: FastifyInstance;
let seeded = false;
let platformId: string;
let merchantId: string;
let testKey: string;
let liveKey: string;
let counter = 0;
const ref = (p: string) => `${p}-${Date.now()}-${(counter += 1)}`;
const initialPlatform = env.PLATFORM_MERCHANT_ID;

async function key(environment: 'test' | 'live') {
  const k = generateApiKey(environment);
  await prisma.apiKey.create({
    data: {
      id: newId(ID_PREFIX.apiKey), merchantId, label: environment, prefix: k.prefix, hash: k.hash, environment,
      scopes: 'payments:read,payments:write,payouts:read,payouts:write,accounts:write',
    },
  });
  return k.secret;
}

beforeAll(async () => {
  app = await buildServer();
  await app.ready();
  seeded = (await prisma.country.count()) > 0;

  platformId = newId(ID_PREFIX.merchant);
  merchantId = newId(ID_PREFIX.merchant);
  for (const [id, name] of [[platformId, 'Plateforme'], [merchantId, 'Marchand sans compte']] as const) {
    await prisma.merchant.create({
      data: { id, name, legalType: 'COMPANY', country: 'CI', contactEmail: `${id}@test.local`, kybStatus: 'VERIFIED' },
    });
  }
  // Afripaie a GeniusPay ET le simulateur : sans numero de test, le routage
  // pourrait choisir l'un ou l'autre.
  await connectProviderAccount({
    merchantId: platformId, providerId: 'sandbox', environment: 'test', credentials: { webhook_secret: 's' },
  });
  await connectProviderAccount({
    merchantId: platformId, providerId: 'geniuspay', environment: 'test',
    credentials: { api_key: 'pk_sandbox_test', api_secret: 'sk_sandbox_test', webhook_secret: 'whsec_test' },
  });
  testKey = await key('test');
  liveKey = await key('live');
});

beforeEach(() => {
  env.PLATFORM_MERCHANT_ID = platformId;
});

afterAll(async () => {
  env.PLATFORM_MERCHANT_ID = initialPlatform;
  await prisma.ledgerEntry.deleteMany({ where: { journal: { merchantId } } });
  await prisma.ledgerJournal.deleteMany({ where: { merchantId } });
  await prisma.idempotencyRecord.deleteMany({ where: { merchantId } });
  await prisma.merchant.deleteMany({ where: { id: merchantId } });
  await prisma.merchant.deleteMany({ where: { id: platformId } });
  await app.close();
  await prisma.$disconnect();
});

function post(url: string, payload: Record<string, unknown>, apiKey = testKey) {
  return app.inject({
    method: 'POST',
    url,
    headers: { authorization: `Bearer ${apiKey}`, 'idempotency-key': ref('idem') },
    payload,
  });
}

const payin = (phone: string) => ({
  reference: ref('tn'), amount: 5000, currency: 'XOF', channel: 'mobile_money', customer: { phone },
});

describe('reconnaissance', () => {
  it('lit l’issue dans le dernier chiffre, quel que soit le format', () => {
    expect(testScenarioOf('+225 00 00 00 00 00')).toBe('success');
    expect(testScenarioOf('+2250000000002')).toBe('declined');
    expect(testScenarioOf('00242 000 00 00 03')).toBe('timeout');
    expect(testScenarioOf('+221 000 00 00 07')).toBe('expired');
  });

  it('ne confond jamais un vrai numero avec un numero de test', () => {
    expect(testScenarioOf('+225 07 00 00 00 00')).toBeUndefined();
    expect(testScenarioOf('+229 97 00 00 00')).toBeUndefined();
    expect(testScenarioOf('+225 00 00 00 00 08')).toBeUndefined();
    expect(testScenarioOf('0000000000')).toBeUndefined();
  });
});

describe('encaissement avec un numero de test', () => {
  it('passe toujours par le simulateur, jamais par l’agregateur reel', async () => {
    if (!seeded) return;
    for (let i = 0; i < 6; i += 1) {
      const res = await post('/v1/payments', payin('+225 00 00 00 00 00'));
      expect(res.statusCode).toBe(201);
      expect(res.json().provider.id).toBe('sandbox');
    }
  });

  it('produit l’issue annoncee', async () => {
    if (!seeded) return;
    const ok = await post('/v1/payments', payin('+2250000000000'));
    const read = await app.inject({
      method: 'GET', url: `/v1/payments/${ok.json().id}`, headers: { authorization: `Bearer ${testKey}` },
    });
    expect(read.json().status).toBe('SUCCEEDED');

    const refus = await post('/v1/payments', payin('+2250000000002'));
    expect(refus.json().status).toBe('FAILED');
  });

  it('deduit le pays de l’indicatif, comme un vrai numero', async () => {
    if (!seeded) return;
    const res = await post('/v1/payments', { ...payin('+242 000 00 00 00'), currency: 'XAF' });
    expect(res.json()).toMatchObject({ country: 'CG', currency: 'XAF' });
  });

  it('est refuse avec une cle live, sans rien creer', async () => {
    if (!seeded) return;
    const reference = ref('live');
    const res = await post('/v1/payments', { ...payin('+2250000000000'), reference }, liveKey);
    expect(res.statusCode).toBe(400);
    expect(res.json().error.param).toBe('customer.phone');
    expect(await prisma.payment.count({ where: { merchantId, reference } })).toBe(0);
  });
});

describe('decaissement avec un numero de test', () => {
  const payout = (phone: string) => ({
    reference: ref('po'), amount: 5000, currency: 'XOF', country: 'CI', channel: 'mobile_money',
    recipient: { phone, network: 'ORANGE_CI', name: 'Beneficiaire Test' },
  });

  it('utilise le simulateur d’Afripaie : aucun argent reel n’existe', async () => {
    if (!seeded) return;
    const res = await post('/v1/payouts', payout('+2250000000000'));
    expect(res.statusCode).toBe(201);
    expect(res.json().provider.id).toBe('sandbox');
  });

  it('reste interdit sur les comptes reels d’Afripaie avec un vrai numero', async () => {
    if (!seeded) return;
    const res = await post('/v1/payouts', payout('+2250700000000'));
    expect(res.statusCode).toBe(422);
  });
});

describe('liste publique', () => {
  it('donne les huit numeros d’un pays, tous reconnus', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/test-numbers?country=CG' });
    expect(res.statusCode).toBe(200);
    const numbers = res.json().data[0].numbers as { phone: string; scenario: string }[];
    expect(numbers).toHaveLength(8);
    expect(numbers[0]!.phone).toBe('+242000000000');
    for (const n of numbers) expect(testScenarioOf(n.phone)).toBe(n.scenario);
  });
});
