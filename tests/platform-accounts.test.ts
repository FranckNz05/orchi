import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { countryFromPhone, resolveMarket } from '../src/catalog/market.js';
import { generateApiKey } from '../src/core/crypto.js';
import { env } from '../src/core/env.js';
import { ID_PREFIX, newId } from '../src/core/ids.js';
import { prisma } from '../src/db/client.js';
import { assertLedgerBalanced } from '../src/modules/ledger.js';
import { connectProviderAccount } from '../src/modules/provider-accounts.js';
import { selectCandidates } from '../src/routing/select.js';
import { buildServer } from '../src/server.js';

/**
 * Afripaie en orchestrateur : un marchand sans aucun compte agregateur encaisse
 * par ceux d'Afripaie, et le pays se deduit de l'indicatif du client.
 */

/* -------------------------------------------------------------------------- */
/* Pays d'apres l'indicatif                                                   */
/* -------------------------------------------------------------------------- */

describe('pays d’apres l’indicatif', () => {
  it('reconnait le pays quel que soit le format international', () => {
    expect(countryFromPhone('+242 06 123 45 67')?.iso2).toBe('CG');
    expect(countryFromPhone('00225 07 00 00 00 00')?.iso2).toBe('CI');
    expect(countryFromPhone('+237-6-99-00-00-00')?.iso2).toBe('CM');
    expect(countryFromPhone('+229 97 00 00 00')?.iso2).toBe('BJ');
  });

  it('ne devine rien d’un numero local ou inconnu', () => {
    // Sans indicatif, le meme numero existe dans plusieurs pays : deviner
    // enverrait le client vers un operateur qui ne le connait pas.
    expect(countryFromPhone('06 123 45 67')).toBeUndefined();
    expect(countryFromPhone('+1 555 000 0000')).toBeUndefined();
    expect(countryFromPhone('+242abc')).toBeUndefined();
    expect(countryFromPhone(undefined)).toBeUndefined();
  });

  it('laisse un pays explicite prevaloir sur l’indicatif', () => {
    const m = resolveMarket({ country: 'CI', currency: 'XOF', phone: '+242061234567' });
    expect(m).toEqual({ country: 'CI', currency: 'XOF', countrySource: 'explicit' });
  });

  it('passe d’une zone CFA a l’autre sans changer le montant', () => {
    // XAF et XOF ont la meme parite fixe avec l'euro : 1 XAF = 1 XOF.
    expect(resolveMarket({ currency: 'XAF', phone: '+2250700000000' })).toEqual({
      country: 'CI',
      currency: 'XOF',
      countrySource: 'phone',
    });
    expect(resolveMarket({ currency: 'XAF', phone: '+242061234567' }).currency).toBe('XAF');
  });

  it('refuse toute autre conversion de devise', () => {
    expect(() => resolveMarket({ currency: 'XAF', phone: '+2348000000000' })).toThrow(/NGN/);
  });

  it('exige le pays quand l’indicatif manque', () => {
    expect(() => resolveMarket({ currency: 'XAF', phone: '061234567' })).toThrow(/format international/);
  });
});

/* -------------------------------------------------------------------------- */
/* Comptes d'Afripaie                                                         */
/* -------------------------------------------------------------------------- */

let app: FastifyInstance;
let seeded = false;
let platformId: string;
let clientId: string;
let ownId: string;
let clientKey: string;
let ownKey: string;
let counter = 0;
const ref = (p: string) => `${p}-${Date.now()}-${(counter += 1)}`;
const SCOPES = 'payments:read,payments:write,payouts:read,payouts:write,accounts:write';
const initialPlatform = env.PLATFORM_MERCHANT_ID;

async function merchant(name: string): Promise<string> {
  const id = newId(ID_PREFIX.merchant);
  await prisma.merchant.create({
    data: { id, name, legalType: 'COMPANY', country: 'BJ', contactEmail: `${id}@test.local` },
  });
  return id;
}

async function keyFor(merchantId: string): Promise<string> {
  const k = generateApiKey('test');
  await prisma.apiKey.create({
    data: {
      id: newId(ID_PREFIX.apiKey),
      merchantId,
      label: 'test',
      prefix: k.prefix,
      hash: k.hash,
      environment: 'test',
      scopes: SCOPES,
    },
  });
  return k.secret;
}

beforeAll(async () => {
  app = await buildServer();
  await app.ready();
  seeded = (await prisma.country.count()) > 0;

  platformId = await merchant('Afripaie (plateforme)');
  clientId = await merchant('Marchand sans compte');
  ownId = await merchant('Marchand avec son compte');
  clientKey = await keyFor(clientId);
  ownKey = await keyFor(ownId);

  for (const merchantId of [platformId, ownId]) {
    await connectProviderAccount({
      merchantId,
      providerId: 'sandbox',
      environment: 'test',
      credentials: { webhook_secret: `secret-${merchantId}` },
      priority: 1,
    });
  }
  // Un vrai agregateur chez Afripaie : jamais appele ici (aucun paiement avec un
  // vrai numero), mais il doit apparaitre sur la page et dans le routage.
  await connectProviderAccount({
    merchantId: platformId,
    providerId: 'geniuspay',
    environment: 'test',
    credentials: { api_key: 'pk_sandbox_test', api_secret: 'sk_sandbox_test', webhook_secret: 'whsec_test' },
  });
});

afterEach(() => {
  env.PLATFORM_MERCHANT_ID = initialPlatform;
});

afterAll(async () => {
  const ids = [platformId, clientId, ownId];
  await prisma.idempotencyRecord.deleteMany({ where: { merchantId: { in: ids } } });
  await prisma.ledgerEntry.deleteMany({ where: { journal: { merchantId: { in: ids } } } });
  await prisma.ledgerJournal.deleteMany({ where: { merchantId: { in: ids } } });
  // La plateforme en dernier : les tentatives des autres marchands referencent
  // son compte agregateur.
  for (const id of [clientId, ownId, platformId]) await prisma.merchant.deleteMany({ where: { id } });
  await app.close();
  await prisma.$disconnect();
});

function post(url: string, body: Record<string, unknown>, key = clientKey) {
  return app.inject({
    method: 'POST',
    url,
    headers: { authorization: `Bearer ${key}`, 'idempotency-key': ref('idem') },
    payload: body,
  });
}

function get(url: string, key = clientKey) {
  return app.inject({ method: 'GET', url, headers: { authorization: `Bearer ${key}` } });
}

/**
 * Paiement sans `country` : seul l'indicatif du client designe le Benin. Numero
 * de test : c'est le simulateur d'Afripaie qui l'execute, seul agregateur
 * joignable hors ligne.
 */
const payin = (over: Record<string, unknown> = {}) => ({
  reference: ref('pf'),
  amount: 15000,
  currency: 'XOF',
  channel: 'mobile_money',
  customer: { phone: '+229 0000000000' },
  ...over,
});

describe('encaissement par les comptes d’Afripaie', () => {
  it('refuse un marchand sans compte tant qu’aucun compte plateforme n’est designe', async () => {
    if (!seeded) return;
    env.PLATFORM_MERCHANT_ID = undefined;
    const res = await post('/v1/payments', payin());
    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe('no_route_available');
  });

  it('route un marchand sans compte vers le compte d’Afripaie, pays deduit du numero', async () => {
    if (!seeded) return;
    env.PLATFORM_MERCHANT_ID = platformId;

    const res = await post('/v1/payments', payin());
    expect(res.statusCode).toBe(201);
    expect(res.json().country).toBe('BJ');
    const id = res.json().id as string;

    const attempt = await prisma.paymentAttempt.findFirstOrThrow({
      where: { paymentId: id },
      include: { providerAccount: true },
    });
    expect(attempt.providerAccount.merchantId).toBe(platformId);

    expect((await get(`/v1/payments/${id}`)).json().status).toBe('SUCCEEDED');
  });

  it('retient la commission et inscrit le net comme du au marchand', async () => {
    if (!seeded) return;
    env.PLATFORM_MERCHANT_ID = platformId;

    const id = (await post('/v1/payments', payin({ amount: 20000 }))).json().id as string;
    await get(`/v1/payments/${id}`);

    // Afripaie detient les fonds : rien a facturer, donc pas de `fee.accrued`.
    const journals = await prisma.ledgerJournal.findMany({ where: { refId: id } });
    expect(journals.map((j) => j.type)).toEqual(['payin.succeeded']);

    const entries = await prisma.ledgerEntry.findMany({ where: { journal: { refId: id } } });
    const by = Object.fromEntries(entries.map((e) => [e.account, { side: e.side, amount: e.amount }]));
    expect(by['provider:sandbox:clearing']).toEqual({ side: 'DEBIT', amount: 20000 });
    // 5 % de 20 000 retenus, le simulateur ne prenant rien.
    expect(by['afripaie:revenue']).toEqual({ side: 'CREDIT', amount: 1000 });
    expect(by[`merchant:${clientId}:held`]).toEqual({ side: 'CREDIT', amount: 19000 });
    expect(by[`merchant:${clientId}:receivable`]).toBeUndefined();
    await expect(assertLedgerBalanced(clientId)).resolves.toBeUndefined();
  });

  it('ne confie jamais un vrai numero au simulateur d’Afripaie', async () => {
    if (!seeded) return;
    env.PLATFORM_MERCHANT_ID = platformId;
    // Le simulateur validerait un paiement que personne n'a fait.
    for (const seed of ['a', 'b', 'c', 'd', 'e']) {
      const plan = await selectCandidates({
        merchantId: clientId, environment: 'test', country: 'BJ', channel: 'mobile_money', direction: 'payin', seed,
      });
      expect(plan.candidates.map((c) => c.providerId)).toEqual(['geniuspay']);
    }
  });

  it('prefere le compte du marchand quand il en a un', async () => {
    if (!seeded) return;
    env.PLATFORM_MERCHANT_ID = platformId;

    const id = (await post('/v1/payments', payin(), ownKey)).json().id as string;
    const attempt = await prisma.paymentAttempt.findFirstOrThrow({
      where: { paymentId: id },
      include: { providerAccount: true },
    });
    expect(attempt.providerAccount.merchantId).toBe(ownId);
  });

  it('ne decaisse JAMAIS depuis un compte d’Afripaie', async () => {
    if (!seeded) return;
    env.PLATFORM_MERCHANT_ID = platformId;
    // Le solde d'Afripaie contient l'argent des autres marchands.
    const res = await post('/v1/payouts', {
      reference: ref('po'),
      amount: 5000,
      currency: 'XOF',
      country: 'BJ',
      channel: 'mobile_money',
      recipient: { phone: '+22997000000', network: 'MTN_BENIN', name: 'Jean Dupont' },
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe('no_route_available');
  });

  it('ouvre une session de paiement sans pays, d’apres l’indicatif', async () => {
    if (!seeded) return;
    env.PLATFORM_MERCHANT_ID = platformId;
    const res = await post('/v1/checkout-sessions', {
      reference: ref('cs'),
      amount: 1000,
      currency: 'XAF',
      customer: { phone: '+229 97 00 00 00' },
    });
    expect(res.statusCode).toBe(201);
    // Prix en XAF, client beninois : meme montant, en XOF.
    expect(res.json()).toMatchObject({ country: 'BJ', currency: 'XOF', amount: 1000 });
  });

  it('ne propose sur la page que les moyens reellement routables', async () => {
    if (!seeded) return;
    const optionsFor = async () => {
      const created = await post('/v1/checkout-sessions', {
        reference: ref('cs'),
        amount: 1000,
        currency: 'XOF',
        customer: { phone: '+229 97 00 00 00' },
      });
      const token = (created.json().url as string).split('/').pop();
      const view = await app.inject({ method: 'GET', url: `/v1/public/checkout/${token}` });
      return view.json().options as unknown[];
    };

    // Aucun compte, ni a lui ni a Afripaie : proposer un moyen ferait echouer
    // le client apres son choix.
    env.PLATFORM_MERCHANT_ID = undefined;
    expect(await optionsFor()).toEqual([]);

    env.PLATFORM_MERCHANT_ID = platformId;
    expect((await optionsFor()).length).toBeGreaterThan(0);
  });

  it('demande le pays quand le numero n’a pas d’indicatif', async () => {
    if (!seeded) return;
    const res = await post('/v1/payments', payin({ customer: { phone: '97000000' } }));
    expect(res.statusCode).toBe(400);
    expect(res.json().error.param).toBe('country');
  });
});
