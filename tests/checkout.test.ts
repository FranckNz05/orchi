import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { generateApiKey } from '../src/core/crypto.js';
import { ID_PREFIX, newId } from '../src/core/ids.js';
import { prisma } from '../src/db/client.js';
import { connectProviderAccount } from '../src/modules/provider-accounts.js';
import { buildServer } from '../src/server.js';

/**
 * Page de paiement hebergee.
 *
 * L'enjeu de ces tests n'est pas seulement « ca marche » : les trois routes
 * publiques sont accessibles sans aucune authentification, avec pour seule cle
 * un jeton visible dans la barre d'adresse du client. Ce qu'elles NE doivent
 * PAS faire compte donc autant que ce qu'elles font.
 */
let app: FastifyInstance;
let merchantId: string;
let key: string;
let seeded = false;
let counter = 0;
const ref = (p: string) => `${p}-${Date.now()}-${(counter += 1)}`;

beforeAll(async () => {
  app = await buildServer();
  await app.ready();
  seeded = (await prisma.country.count()) > 0;

  merchantId = newId(ID_PREFIX.merchant);
  await prisma.merchant.create({
    data: {
      id: merchantId,
      name: 'Boutique Checkout',
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

  await connectProviderAccount({
    merchantId,
    providerId: 'sandbox',
    environment: 'test',
    credentials: { webhook_secret: 'secret-checkout' },
    priority: 1,
  });
});

afterAll(async () => {
  await prisma.checkoutSession.deleteMany({ where: { merchantId } });
  await prisma.idempotencyRecord.deleteMany({ where: { merchantId } });
  await prisma.ledgerEntry.deleteMany({ where: { journal: { merchantId } } });
  await prisma.ledgerJournal.deleteMany({ where: { merchantId } });
  await prisma.merchant.deleteMany({ where: { id: merchantId } });
  await app.close();
  await prisma.$disconnect();
});

function auth(method: 'GET' | 'POST', url: string, payload?: unknown) {
  return app.inject({
    method,
    url,
    headers: { authorization: `Bearer ${key}` },
    ...(payload ? { payload: payload as Record<string, unknown> } : {}),
  });
}

function open(url: string, payload?: unknown) {
  return app.inject({
    method: payload ? 'POST' : 'GET',
    url,
    ...(payload ? { payload: payload as Record<string, unknown> } : {}),
  });
}

async function newSession(over: Record<string, unknown> = {}) {
  const res = await auth('POST', '/v1/checkout-sessions', {
    reference: ref('cs'),
    amount: 25000,
    currency: 'XOF',
    country: 'BJ',
    description: 'Commande de test',
    success_url: 'https://boutique.test/merci',
    ...over,
  });
  return res;
}

function tokenOf(res: { json: () => { url: string } }) {
  return res.json().url.split('/').pop()!;
}

/* -------------------------------------------------------------------------- */

describe('creation de session', () => {
  it('renvoie une URL de paiement', async () => {
    const res = await newSession();
    expect(res.statusCode).toBe(201);
    expect(res.json().url).toMatch(/\/pay\/[\w-]{20,}/);
    expect(res.json().status).toBe('OPEN');
  });

  it('exige une cle API', async () => {
    const res = await open('/v1/checkout-sessions', { reference: 'x', amount: 1000, currency: 'XOF', country: 'BJ' });
    expect(res.statusCode).toBe(401);
  });

  it('refuse une devise incoherente avec le pays', async () => {
    const res = await newSession({ currency: 'XAF' });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.details.expected).toBe('XOF');
  });

  it('ne cree pas deux sessions pour une meme reference', async () => {
    const reference = ref('cs');
    const first = await newSession({ reference });
    const second = await newSession({ reference });
    expect(second.json().id).toBe(first.json().id);
  });

  it('refuse une reference reutilisee avec un montant different', async () => {
    const reference = ref('cs');
    await newSession({ reference });
    const res = await newSession({ reference, amount: 999 });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('duplicate_reference');
  });

  it('produit un jeton long et non devinable', async () => {
    const a = tokenOf(await newSession());
    const b = tokenOf(await newSession());
    // Il est expose dans la barre d'adresse du client : il ne doit ni etre
    // court, ni suivre une suite previsible.
    expect(a.length).toBeGreaterThanOrEqual(40);
    expect(a).not.toBe(b);
  });
});

/* -------------------------------------------------------------------------- */

describe('vue publique', () => {
  it("s'ouvre sans aucune authentification", async () => {
    if (!seeded) return;
    const token = tokenOf(await newSession());
    const res = await open(`/v1/public/checkout/${token}`);

    expect(res.statusCode).toBe(200);
    expect(res.json().merchant).toBe('Boutique Checkout');
    expect(res.json().amount).toBe(25000);
  });

  it('ne divulgue rien du marchand au-dela de son nom commercial', async () => {
    if (!seeded) return;
    const token = tokenOf(await newSession());
    const body = (await open(`/v1/public/checkout/${token}`)).body;

    // Le client final n'a aucune raison de connaitre l'identifiant du marchand,
    // ses references internes ou ses metadonnees.
    expect(body).not.toContain(merchantId);
    expect(body).not.toContain('merchant_id');
    expect(body).not.toContain('metadata');
  });

  it('propose les operateurs reels du pays', async () => {
    if (!seeded) return;
    const token = tokenOf(await newSession());
    const options = (await open(`/v1/public/checkout/${token}`)).json().options as Array<{
      label: string;
      network: string | null;
    }>;

    expect(options.length).toBeGreaterThan(0);
    expect(options.map((o) => o.network)).toContain('MTN_BENIN');
    // Libelles lisibles par un client, pas des codes techniques.
    expect(options.map((o) => o.label)).toContain('MTN MoMo');
  });

  it('renvoie 404 sur un jeton inconnu', async () => {
    const res = await open('/v1/public/checkout/jeton-totalement-invente-mais-assez-long');
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('checkout_not_found');
  });

  it('refuse une session expiree et la marque comme telle', async () => {
    if (!seeded) return;
    const created = await newSession();
    const token = tokenOf(created);

    await prisma.checkoutSession.update({
      where: { id: created.json().id },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });

    const res = await open(`/v1/public/checkout/${token}`);
    expect(res.statusCode).toBe(410);
    expect(res.json().error.code).toBe('checkout_expired');

    const after = await prisma.checkoutSession.findUnique({ where: { id: created.json().id } });
    expect(after!.status).toBe('EXPIRED');
  });
});

/* -------------------------------------------------------------------------- */

describe('paiement depuis la page', () => {
  it('cree le paiement et renvoie l’action a executer', async () => {
    if (!seeded) return;
    const token = tokenOf(await newSession());

    const res = await open(`/v1/public/checkout/${token}/pay`, {
      channel: 'mobile_money',
      network: 'MTN_BENIN',
      phone: '+22997000000',
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().payment.status).toBe('PROCESSING');
    expect(res.json().payment.action).toBe('ussd_push');
  });

  it('aboutit a la lecture suivante et cloture la session', async () => {
    if (!seeded) return;
    const token = tokenOf(await newSession());
    await open(`/v1/public/checkout/${token}/pay`, {
      channel: 'mobile_money',
      network: 'MTN_BENIN',
      phone: '+22997000000',
    });

    const res = await open(`/v1/public/checkout/${token}/status`);
    expect(res.json().payment.status).toBe('SUCCEEDED');
    expect(res.json().status).toBe('COMPLETED');
    expect(res.json().return_url).toBe('https://boutique.test/merci');
  });

  it('refuse un moyen de paiement non propose', async () => {
    if (!seeded) return;
    const token = tokenOf(await newSession());

    // Sans cette verification, un client pourrait forcer un canal que le pays
    // ne dessert pas — ou un reseau d'un autre pays.
    const res = await open(`/v1/public/checkout/${token}/pay`, {
      channel: 'mobile_money',
      network: 'MPESA_KE',
      phone: '+254700000000',
    });
    expect(res.statusCode).toBe(400);
  });

  it('exige un telephone en mobile money', async () => {
    if (!seeded) return;
    const token = tokenOf(await newSession());
    const res = await open(`/v1/public/checkout/${token}/pay`, {
      channel: 'mobile_money',
      network: 'MTN_BENIN',
    });
    expect(res.statusCode).toBe(400);
  });

  it('ne relance pas de transaction si la page est rechargee apres paiement', async () => {
    if (!seeded) return;
    const created = await newSession();
    const token = tokenOf(created);

    const body = { channel: 'mobile_money', network: 'MTN_BENIN', phone: '+22997000000' };
    await open(`/v1/public/checkout/${token}/pay`, body);
    await open(`/v1/public/checkout/${token}/status`);
    // Rechargement apres paiement : le second envoi doit etre inoffensif.
    await open(`/v1/public/checkout/${token}/pay`, body);

    const session = await prisma.checkoutSession.findUnique({ where: { id: created.json().id } });
    const payments = await prisma.payment.count({ where: { merchantId, reference: session!.reference } });
    expect(payments).toBe(1);
  });

  it('reste consultable par le marchand avec le detail du paiement', async () => {
    if (!seeded) return;
    const created = await newSession();
    const token = tokenOf(created);
    await open(`/v1/public/checkout/${token}/pay`, {
      channel: 'mobile_money',
      network: 'MTN_BENIN',
      phone: '+22997000000',
    });

    const res = await auth('GET', `/v1/checkout-sessions/${created.json().id}`);
    expect(res.statusCode).toBe(200);
    expect(res.json().payment.object).toBe('payment');
  });

  it('n’expose pas la session d’un autre marchand', async () => {
    if (!seeded) return;
    const other = newId(ID_PREFIX.merchant);
    await prisma.merchant.create({
      data: {
        id: other,
        name: 'Autre',
        legalType: 'COMPANY',
        country: 'BJ',
        contactEmail: `${other}@test.local`,
      },
    });
    const session = await prisma.checkoutSession.create({
      data: {
        id: newId(ID_PREFIX.payment).replace('pay_', 'cs_'),
        token: `tok-${other}`,
        merchantId: other,
        reference: ref('autre'),
        amount: 1000,
        currency: 'XOF',
        country: 'BJ',
        expiresAt: new Date(Date.now() + 3_600_000),
      },
    });

    const res = await auth('GET', `/v1/checkout-sessions/${session.id}`);
    expect(res.statusCode).toBe(404);

    await prisma.merchant.deleteMany({ where: { id: other } });
  });
});

/* -------------------------------------------------------------------------- */

describe('page servie', () => {
  it('est accessible sans authentification et interdit l’indexation', async () => {
    if (!seeded) return;
    const token = tokenOf(await newSession());
    const res = await app.inject({
      method: 'GET',
      url: `/pay/${token}`,
      headers: { accept: 'text/html' },
    });

    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/html');
    // Un lien de paiement n'a rien a faire dans un moteur de recherche.
    expect(res.body).toContain('name="robots" content="noindex"');
  });
});
