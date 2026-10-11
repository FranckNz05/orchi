import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { generateApiKey } from '../src/core/crypto.js';
import { env } from '../src/core/env.js';
import { ID_PREFIX, newId } from '../src/core/ids.js';
import { prisma } from '../src/db/client.js';
import { assertLedgerBalanced } from '../src/modules/ledger.js';
import { connectProviderAccount } from '../src/modules/provider-accounts.js';
import { getProviderAdapter } from '../src/providers/registry.js';
import { inferNetwork, pollSettlements, runAutoSettlements } from '../src/modules/settlements-auto.js';
import { buildServer } from '../src/server.js';

/**
 * Reversement automatique en mobile money depuis un compte d'Afripaie.
 *
 * Le simulateur joue chaque issue d'apres les 4 derniers chiffres du numero :
 * 0000 succes, 0001 succes lent, 0002 refus, 0003 delai depasse.
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
const initial = {
  platform: env.PLATFORM_MERCHANT_ID,
  delay: env.MERCHANT_SETTLEMENT_DELAY_MS,
  every: env.MERCHANT_AUTO_SETTLEMENT_EVERY_MS,
};
const SAME_ORIGIN = { 'sec-fetch-site': 'same-origin' };

async function register(label: string) {
  const res = await app.inject({
    method: 'POST',
    url: '/auth/register',
    payload: {
      name: `Testeur ${label}`,
      email: `${label}-${Date.now()}-${(counter += 1)}@autosettle.test`,
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
  env.MERCHANT_AUTO_SETTLEMENT_EVERY_MS = initial.every;
});

afterAll(async () => {
  env.PLATFORM_MERCHANT_ID = initial.platform;
  env.MERCHANT_SETTLEMENT_DELAY_MS = initial.delay;
  env.MERCHANT_AUTO_SETTLEMENT_EVERY_MS = initial.every;
  await prisma.ledgerEntry.deleteMany({ where: { journal: { merchantId } } });
  await prisma.ledgerJournal.deleteMany({ where: { merchantId } });
  await prisma.idempotencyRecord.deleteMany({ where: { merchantId } });
  await prisma.merchant.deleteMany({ where: { id: merchantId } });
  await prisma.merchant.deleteMany({ where: { id: platformId } });
  await prisma.user.deleteMany({ where: { email: { contains: '@autosettle.test' } } });
  await prisma.merchant.deleteMany({ where: { contactEmail: { contains: '@autosettle.test' } } });
  await app.close();
  await prisma.$disconnect();
});

async function payin(amount: number): Promise<void> {
  const created = await app.inject({
    method: 'POST',
    url: '/v1/payments',
    headers: { authorization: `Bearer ${apiKey}`, 'idempotency-key': ref('idem') },
    payload: { reference: ref('pay'), amount, currency: 'XOF', channel: 'mobile_money', customer: { phone: '+229 0000000000' } },
  });
  await app.inject({
    method: 'GET',
    url: `/v1/payments/${created.json().id}`,
    headers: { authorization: `Bearer ${apiKey}` },
  });
}

function admin(method: 'POST' | 'PUT', url: string, payload: Record<string, unknown>, cookie = adminCookie) {
  return app.inject({ method, url, cookies: { afripaie_session: cookie }, headers: SAME_ORIGIN, payload });
}

/** Destination de reversement ; le suffixe du numero choisit l'issue simulee. */
function target(suffix: string, over: Record<string, unknown> = {}) {
  return admin('PUT', `/v1/admin/merchants/${merchantId}/settlement-targets`, {
    environment: 'test',
    provider: 'sandbox',
    phone: `+229 97 00 ${suffix.slice(0, 2)} ${suffix.slice(2)}`,
    network: 'MTN_BENIN',
    beneficiary_name: 'Marchand Test',
    ...over,
  });
}

const send = () =>
  admin('POST', `/v1/admin/merchants/${merchantId}/settlements/send`, { environment: 'test', provider: 'sandbox' });

async function held(): Promise<number> {
  const res = await app.inject({ method: 'GET', url: '/v1/settlements', headers: { authorization: `Bearer ${apiKey}` } });
  return (res.json().balances as { held: number }[])[0]?.held ?? 0;
}

describe('reseau d’apres le numero congolais', () => {
  it('reconnait MTN et Airtel', () => {
    expect(inferNetwork('CG', '+242 06 123 45 67')).toBe('MTN_CG');
    expect(inferNetwork('CG', '+242 05 123 45 67')).toBe('AIRTEL_CG');
    expect(inferNetwork('CG', '00242041234567')).toBe('AIRTEL_CG');
    expect(inferNetwork('CG', '+225 07 00 00 00 00')).toBeUndefined();
  });
});

describe('destination de reversement', () => {
  it('n’est modifiable que par un administrateur', async () => {
    if (!seeded) return;
    // Sinon, une session volee suffirait a detourner les reversements.
    const res = await admin('PUT', `/v1/admin/merchants/${merchantId}/settlement-targets`, {
      environment: 'test', provider: 'sandbox', phone: '+22997000000', network: 'MTN_BENIN', beneficiary_name: 'Pirate',
    }, merchantCookie);
    expect(res.statusCode).toBe(403);
  });

  it('refuse un agregateur qui ne sait pas decaisser', async () => {
    if (!seeded) return;
    const res = await target('0000', { provider: 'geniuspay' });
    expect(res.statusCode).toBe(400);
  });

  it('exige un numero international', async () => {
    if (!seeded) return;
    const res = await target('0000', { phone: '97000000' });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.param).toBe('phone');
  });
});

describe('envoi d’un reversement', () => {
  it('verse le disponible et le debite du solde du', async () => {
    if (!seeded) return;
    await payin(20000);
    expect((await target('0000')).statusCode).toBe(200);

    const res = await send();
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ status: 'PAID', amount: 19000, mode: 'AUTOMATIC', network: 'MTN_BENIN' });
    expect(res.json().provider_reference).toBeTruthy();
    expect(await held()).toBe(0);
    await expect(assertLedgerBalanced(merchantId)).resolves.toBeUndefined();
  });

  it('rend le montant au marchand sur un refus explicite', async () => {
    if (!seeded) return;
    await payin(10000);
    await target('0002');
    const res = await send();
    expect(res.json()).toMatchObject({ status: 'FAILED', amount: 9500 });
    expect(await held()).toBe(9500);
    await expect(assertLedgerBalanced(merchantId)).resolves.toBeUndefined();
  });

  it('ne conclut rien d’un delai depasse, et bloque tout nouvel envoi', async () => {
    if (!seeded) return;
    await target('0003');
    const res = await send();
    expect(res.json().status).toBe('UNKNOWN');
    // L'argent est peut-etre parti : le montant reste reserve.
    expect(await held()).toBe(0);

    await target('0000');
    const again = await send();
    expect(again.statusCode).toBe(409);
    expect(again.json().error.code).toBe('settlement_unresolved');

    // « Verse » exige la preuve constatee chez l'agregateur.
    const noProof = await admin('POST', `/v1/admin/settlements/${res.json().id}/resolve`, {
      outcome: 'paid', reason: 'Vu dans le tableau de bord',
    });
    expect(noProof.statusCode).toBe(400);

    const resolved = await admin('POST', `/v1/admin/settlements/${res.json().id}/resolve`, {
      outcome: 'failed', reason: 'Absent du tableau de bord de l’agregateur',
    });
    expect(resolved.json().status).toBe('FAILED');
    expect(await held()).toBe(9500);
  });

  it('suit un reversement en cours jusqu’a son aboutissement', async () => {
    if (!seeded) return;
    await target('0001');
    const res = await send();
    expect(res.json().status).toBe('PROCESSING');

    await pollSettlements();
    await pollSettlements();
    const after = await prisma.merchantSettlement.findUniqueOrThrow({ where: { id: res.json().id } });
    expect(after.status).toBe('PAID');
    expect(await held()).toBe(0);
    await expect(assertLedgerBalanced(merchantId)).resolves.toBeUndefined();
  });

  it('ajoute les frais du beneficiaire, a la charge d’Afripaie', async () => {
    if (!seeded) return;
    // Le simulateur ne retient rien : on lui prete le comportement de Yabetoo.
    const adapter = getProviderAdapter('sandbox') as { payoutBeneficiaryFeeBps?: number };
    adapter.payoutBeneficiaryFeeBps = 150;
    try {
      await payin(20000);
      await target('0000');
      const res = await send();
      // 19 000 dus : 19 290 envoyes, 290 de frais payes par Afripaie.
      expect(res.json()).toMatchObject({ status: 'PAID', amount: 19000, sent_amount: 19290, fee_absorbed: 290 });
      expect(await held()).toBe(0);

      const entries = await prisma.ledgerEntry.findMany({ where: { journal: { refId: res.json().id } } });
      const by = Object.fromEntries(entries.map((e) => [e.account, { side: e.side, amount: e.amount }]));
      expect(by[`merchant:${merchantId}:held`]).toEqual({ side: 'DEBIT', amount: 19000 });
      expect(by['afripaie:revenue']).toEqual({ side: 'DEBIT', amount: 290 });
      expect(by['provider:sandbox:clearing']).toEqual({ side: 'CREDIT', amount: 19290 });
      await expect(assertLedgerBalanced(merchantId)).resolves.toBeUndefined();
    } finally {
      delete adapter.payoutBeneficiaryFeeBps;
    }
  });

  it('refuse d’annuler un reversement automatique abouti', async () => {
    if (!seeded) return;
    const paid = await prisma.merchantSettlement.findFirstOrThrow({
      where: { merchantId, mode: 'AUTOMATIC', status: 'PAID' },
    });
    const res = await admin('POST', `/v1/admin/settlements/${paid.id}/cancel`, { reason: 'Tentative d’annulation' });
    expect(res.statusCode).toBe(409);
  });
});

describe('reversement periodique', () => {
  it('verse seul le disponible, puis attend l’intervalle', async () => {
    if (!seeded) return;
    await payin(20000);
    await target('0000', { auto_enabled: true, min_amount: 1000 });
    env.MERCHANT_AUTO_SETTLEMENT_EVERY_MS = 0;

    // On compte les reversements DE CE marchand : la base de test est une copie
    // de la base de developpement, qui peut contenir d'autres destinations.
    const automatic = () => prisma.merchantSettlement.count({ where: { merchantId, mode: 'AUTOMATIC', status: 'PAID' } });
    const before = await automatic();

    await runAutoSettlements();
    expect(await automatic()).toBe(before + 1);
    expect(await held()).toBe(0);

    await payin(20000);
    env.MERCHANT_AUTO_SETTLEMENT_EVERY_MS = 3_600_000;
    await runAutoSettlements();
    expect(await automatic()).toBe(before + 1);
    expect(await held()).toBe(19000);
  });

  it('attend que le disponible atteigne le minimum', async () => {
    if (!seeded) return;
    env.MERCHANT_AUTO_SETTLEMENT_EVERY_MS = 0;
    await target('0000', { auto_enabled: true, min_amount: 50000 });
    const count = () => prisma.merchantSettlement.count({ where: { merchantId } });
    const before = await count();
    await runAutoSettlements();
    expect(await count()).toBe(before);
  });
});

describe('retrait demande par le marchand', () => {
  const PASSWORD = 'une phrase de passe solide';

  const withdraw = (payload: Record<string, unknown>, over: { cookie?: string; headers?: Record<string, string> } = {}) =>
    app.inject({
      method: 'POST',
      url: '/v1/withdrawals',
      cookies: { afripaie_session: over.cookie ?? merchantCookie },
      headers: over.headers ?? SAME_ORIGIN,
      payload: { provider: 'sandbox', password: PASSWORD, ...payload },
    });

  it('retire vers le numero enregistre par l’administrateur, mot de passe a l’appui', async () => {
    if (!seeded) return;
    await payin(20000);
    await target('0000');
    const avant = await held();

    const res = await withdraw({ amount: 10000 });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ status: 'PAID', amount: 10000, mode: 'AUTOMATIC' });
    // Le numero est celui de l'administrateur : le marchand n'en a fourni aucun.
    expect(res.json().destination).toBe('+22997000000');
    expect(await held()).toBe(avant - 10000);
    await expect(assertLedgerBalanced(merchantId)).resolves.toBeUndefined();

    // Sans montant : tout le disponible.
    const rest = await withdraw({});
    expect(rest.json()).toMatchObject({ status: 'PAID', amount: avant - 10000 });
    expect(await held()).toBe(0);
  });

  it('refuse un mauvais mot de passe sans deconnecter ni rien envoyer', async () => {
    if (!seeded) return;
    await payin(20000);
    await target('0000');
    const before = await prisma.merchantSettlement.count({ where: { merchantId } });

    const res = await withdraw({ amount: 1000, password: 'pas le bon du tout' });
    // 400 : un 401 renverrait le tableau de bord vers la page de connexion.
    expect(res.statusCode).toBe(400);
    expect(res.json().error.param).toBe('password');
    expect(await prisma.merchantSettlement.count({ where: { merchantId } })).toBe(before);
  });

  it('refuse une cle API : elle se copie, elle ne doit pas vider un solde', async () => {
    if (!seeded) return;
    const res = await app.inject({
      method: 'POST',
      url: '/v1/withdrawals',
      headers: { authorization: `Bearer ${apiKey}` },
      payload: { provider: 'sandbox', amount: 1000, password: PASSWORD },
    });
    expect(res.statusCode).toBe(403);
  });

  it('refuse une requete venue d’un autre site (CSRF)', async () => {
    if (!seeded) return;
    const res = await withdraw({ amount: 1000 }, { headers: { origin: 'https://site-malveillant.example' } });
    expect(res.statusCode).toBe(403);
  });

  it('refuse un retrait sous le minimum, ou au-dessus du disponible', async () => {
    if (!seeded) return;
    await payin(20000);
    await target('0000');
    const solde = await held();
    expect(solde).toBeGreaterThan(1000);

    const peu = await withdraw({ amount: 499 });
    expect(peu.statusCode).toBe(400);
    expect(peu.json().error.param).toBe('amount');

    const trop = await withdraw({ amount: solde + 1 });
    expect(trop.statusCode).toBe(400);
    expect(trop.json().error.code).toBe('settlement_exceeds_available');
  });

  it('refuse sans numero de retrait enregistre', async () => {
    if (!seeded) return;
    await payin(20000);
    await prisma.merchantSettlementTarget.deleteMany({ where: { merchantId } });
    const res = await withdraw({ amount: 1000 });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('settlement_target_missing');
  });
});

