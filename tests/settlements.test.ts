import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { generateApiKey } from '../src/core/crypto.js';
import { env } from '../src/core/env.js';
import { ID_PREFIX, newId } from '../src/core/ids.js';
import { prisma } from '../src/db/client.js';
import { assertLedgerBalanced } from '../src/modules/ledger.js';
import { connectProviderAccount } from '../src/modules/provider-accounts.js';
import { buildServer } from '../src/server.js';

/**
 * Reversement au marchand de ce qu'Afripaie a encaisse pour lui sur ses propres
 * comptes agregateurs.
 */

let app: FastifyInstance;
let seeded = false;
let platformId: string;
let merchantId: string;
let apiKey: string;
let merchantCookie: string;
let adminCookie: string;
let counter = 0;
const ref = (p: string) => `${p}-${Date.now()}-${(counter += 1)}`;
const initial = { platform: env.PLATFORM_MERCHANT_ID, delay: env.MERCHANT_SETTLEMENT_DELAY_MS };
const SAME_ORIGIN = { 'sec-fetch-site': 'same-origin' };

async function register(label: string) {
  const res = await app.inject({
    method: 'POST',
    url: '/auth/register',
    payload: {
      name: `Testeur ${label}`,
      email: `${label}-${Date.now()}-${(counter += 1)}@settle.test`,
      password: 'une phrase de passe solide',
      company_name: `Societe ${label}`,
      country: 'BJ',
    },
  });
  return {
    merchantId: res.json().merchant.id as string,
    cookie: res.cookies.find((c) => c.name === 'afripaie_session')!.value,
  };
}

beforeAll(async () => {
  app = await buildServer();
  await app.ready();
  seeded = (await prisma.country.count()) > 0;

  platformId = newId(ID_PREFIX.merchant);
  await prisma.merchant.create({
    data: { id: platformId, name: 'Plateforme', legalType: 'COMPANY', country: 'BJ', contactEmail: `${platformId}@test.local` },
  });
  await connectProviderAccount({
    merchantId: platformId,
    providerId: 'sandbox',
    environment: 'test',
    credentials: { webhook_secret: 'secret-plateforme' },
  });

  const merchant = await register('marchand');
  merchantId = merchant.merchantId;
  merchantCookie = merchant.cookie;
  // Le simulateur connecte a l'inscription est retire : le marchand doit
  // encaisser par le compte d'Afripaie.
  await prisma.providerAccount.updateMany({ where: { merchantId }, data: { status: 'DISABLED' } });

  const k = generateApiKey('test');
  apiKey = k.secret;
  await prisma.apiKey.create({
    data: {
      id: newId(ID_PREFIX.apiKey), merchantId, label: 'test', prefix: k.prefix, hash: k.hash,
      environment: 'test', scopes: 'payments:read,payments:write,payouts:read,payouts:write,accounts:write',
    },
  });

  const admin = await register('admin');
  adminCookie = admin.cookie;
  await prisma.user.updateMany({ where: { merchantId: admin.merchantId }, data: { platformAdmin: true } });
});

beforeEach(() => {
  env.PLATFORM_MERCHANT_ID = platformId;
  env.MERCHANT_SETTLEMENT_DELAY_MS = 0;
});

afterAll(async () => {
  env.PLATFORM_MERCHANT_ID = initial.platform;
  env.MERCHANT_SETTLEMENT_DELAY_MS = initial.delay;
  await prisma.ledgerEntry.deleteMany({ where: { journal: { merchantId } } });
  await prisma.ledgerJournal.deleteMany({ where: { merchantId } });
  await prisma.idempotencyRecord.deleteMany({ where: { merchantId } });
  await prisma.merchant.deleteMany({ where: { id: merchantId } });
  await prisma.merchant.deleteMany({ where: { id: platformId } });
  await prisma.user.deleteMany({ where: { email: { contains: '@settle.test' } } });
  await prisma.merchant.deleteMany({ where: { contactEmail: { contains: '@settle.test' } } });
  await app.close();
  await prisma.$disconnect();
});

/** Encaissement par le simulateur d'Afripaie (numero de test), conclu a la lecture. */
async function payin(amount: number): Promise<void> {
  const created = await app.inject({
    method: 'POST',
    url: '/v1/payments',
    headers: { authorization: `Bearer ${apiKey}`, 'idempotency-key': ref('idem') },
    payload: { reference: ref('pay'), amount, currency: 'XOF', channel: 'mobile_money', customer: { phone: '+229 0000000000' } },
  });
  expect(created.statusCode).toBe(201);
  const read = await app.inject({
    method: 'GET',
    url: `/v1/payments/${created.json().id}`,
    headers: { authorization: `Bearer ${apiKey}` },
  });
  expect(read.json().status).toBe('SUCCEEDED');
}

function balance() {
  return app
    .inject({ method: 'GET', url: '/v1/settlements', headers: { authorization: `Bearer ${apiKey}` } })
    .then((r) => r.json());
}

function record(over: Record<string, unknown> = {}, cookie = adminCookie) {
  return app.inject({
    method: 'POST',
    url: `/v1/admin/merchants/${merchantId}/settlements`,
    cookies: { afripaie_session: cookie },
    headers: SAME_ORIGIN,
    payload: {
      environment: 'test',
      currency: 'XOF',
      amount: 1000,
      source_provider: 'sandbox',
      method: 'BANK_TRANSFER',
      destination: 'SGBCI CI000 0000 0000',
      external_reference: ref('VIR'),
      ...over,
    },
  });
}

describe('reversement au marchand', () => {
  it('doit au marchand le net de chaque encaissement, agregateur par agregateur', async () => {
    if (!seeded) return;
    await payin(20000);
    const b = await balance();
    // 20 000 encaisses, 5 % retenus : 19 000 dus.
    expect(b.balances).toEqual([
      { environment: 'test', currency: 'XOF', provider: 'sandbox', held: 19000, maturing: 0, available: 19000, available_at: null },
    ]);
  });

  it('ne rend reversable que ce que l’agregateur a eu le temps de regler', async () => {
    if (!seeded) return;
    env.MERCHANT_SETTLEMENT_DELAY_MS = 3_600_000;
    const b = (await balance()).balances[0];
    expect(b.available).toBe(0);
    expect(b.maturing).toBe(b.held);

    const res = await record({ amount: 1000 });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('settlement_exceeds_available');
  });

  it('constate un reversement et diminue le solde du', async () => {
    if (!seeded) return;
    const res = await record({ amount: 15000, external_reference: 'VIR-2026-0001' });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ status: 'PAID', amount: 15000, external_reference: 'VIR-2026-0001' });

    const b = await balance();
    expect(b.balances[0].held).toBe(4000);
    expect(b.data[0].id).toBe(res.json().id);
    // L'adresse de l'administrateur ne sort pas de la plateforme.
    expect(b.data[0].recorded_by).toBeUndefined();

    const entries = await prisma.ledgerEntry.findMany({
      where: { journal: { refId: res.json().id, type: 'settlement.paid' } },
    });
    const by = Object.fromEntries(entries.map((e) => [e.account, { side: e.side, amount: e.amount }]));
    expect(by[`merchant:${merchantId}:held`]).toEqual({ side: 'DEBIT', amount: 15000 });
    expect(by['provider:sandbox:clearing']).toEqual({ side: 'CREDIT', amount: 15000 });
    await expect(assertLedgerBalanced(merchantId)).resolves.toBeUndefined();
  });

  it('refuse de reverser plus que le disponible', async () => {
    if (!seeded) return;
    const res = await record({ amount: 4001 });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.details.available).toBe(4000);
  });

  it('refuse de puiser sur un agregateur qui ne detient rien pour ce marchand', async () => {
    if (!seeded) return;
    const res = await record({ amount: 100, source_provider: 'yabetoo' });
    expect(res.statusCode).toBe(400);
  });

  it('n’autorise que l’administrateur a enregistrer un reversement', async () => {
    if (!seeded) return;
    // Le marchand qui recoit l'argent ne doit pas pouvoir s'en declarer paye.
    expect((await record({}, merchantCookie)).statusCode).toBe(403);
    const withKey = await app.inject({
      method: 'POST',
      url: `/v1/admin/merchants/${merchantId}/settlements`,
      headers: { authorization: `Bearer ${apiKey}` },
      payload: {},
    });
    expect(withKey.statusCode).toBe(403);
  });

  it('annule un reversement par contre-ecriture, une seule fois', async () => {
    if (!seeded) return;
    const id = (await balance()).data[0].id as string;
    const cancel = () =>
      app.inject({
        method: 'POST',
        url: `/v1/admin/settlements/${id}/cancel`,
        cookies: { afripaie_session: adminCookie },
        headers: SAME_ORIGIN,
        payload: { reason: 'Virement rejete par la banque' },
      });

    const res = await cancel();
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: 'CANCELLED', cancel_reason: 'Virement rejete par la banque' });
    expect((await balance()).balances[0].held).toBe(19000);
    expect((await cancel()).statusCode).toBe(409);
    await expect(assertLedgerBalanced(merchantId)).resolves.toBeUndefined();
  });
});
