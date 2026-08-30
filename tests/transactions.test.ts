import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { generateApiKey } from '../src/core/crypto.js';
import { ID_PREFIX, newId } from '../src/core/ids.js';
import { prisma } from '../src/db/client.js';
import { accountBalances, assertLedgerBalanced } from '../src/modules/ledger.js';
import { connectProviderAccount } from '../src/modules/provider-accounts.js';
import { buildServer } from '../src/server.js';

/**
 * Cycle transactionnel complet contre le simulateur.
 * Necessite le catalogue seede (`npm run seed:catalog`).
 */
let app: FastifyInstance;
let merchantId: string;
let key: string;
let liveKey: string;
let seeded = false;

/** Reference unique par appel : le simulateur est idempotent par reference. */
let refCounter = 0;
const ref = (prefix: string) => `${prefix}-${Date.now()}-${(refCounter += 1)}`;

beforeAll(async () => {
  app = await buildServer();
  await app.ready();
  seeded = (await prisma.country.count()) > 0;

  merchantId = newId(ID_PREFIX.merchant);
  await prisma.merchant.create({
    data: {
      id: merchantId,
      name: 'Marchand transactions',
      legalType: 'COMPANY',
      country: 'BJ',
      contactEmail: `${merchantId}@test.local`,
    },
  });

  const scopes = 'payments:read,payments:write,payouts:read,payouts:write,accounts:write';

  const test = generateApiKey('test');
  key = test.secret;
  await prisma.apiKey.create({
    data: {
      id: newId(ID_PREFIX.apiKey),
      merchantId,
      label: 'test',
      prefix: test.prefix,
      hash: test.hash,
      environment: 'test',
      scopes,
    },
  });

  const live = generateApiKey('live');
  liveKey = live.secret;
  await prisma.apiKey.create({
    data: {
      id: newId(ID_PREFIX.apiKey),
      merchantId,
      label: 'live',
      prefix: live.prefix,
      hash: live.hash,
      environment: 'live',
      scopes,
    },
  });

  await connectProviderAccount({
    merchantId,
    providerId: 'sandbox',
    environment: 'test',
    credentials: { webhook_secret: 'secret-transactions' },
    priority: 1,
  });
});

afterAll(async () => {
  await prisma.idempotencyRecord.deleteMany({ where: { merchantId } });
  await prisma.ledgerEntry.deleteMany({ where: { journal: { merchantId } } });
  await prisma.ledgerJournal.deleteMany({ where: { merchantId } });
  await prisma.merchant.deleteMany({ where: { id: merchantId } });
  await app.close();
  await prisma.$disconnect();
});

function post(url: string, body: unknown, idem?: string, apiKey = key) {
  return app.inject({
    method: 'POST',
    url,
    headers: {
      authorization: `Bearer ${apiKey}`,
      ...(idem ? { 'idempotency-key': idem } : {}),
    },
    payload: body as Record<string, unknown>,
  });
}

function get(url: string, apiKey = key) {
  return app.inject({ method: 'GET', url, headers: { authorization: `Bearer ${apiKey}` } });
}

function payinBody(over: Record<string, unknown> = {}) {
  return {
    reference: ref('pay'),
    amount: 15000,
    currency: 'XOF',
    country: 'BJ',
    channel: 'mobile_money',
    customer: { phone: '+22997000000' },
    ...over,
  };
}

function payoutBody(over: Record<string, unknown> = {}) {
  return {
    reference: ref('po'),
    amount: 50000,
    currency: 'XOF',
    country: 'BJ',
    channel: 'mobile_money',
    recipient: { phone: '+22997000000', network: 'MTN_BENIN', name: 'Jean Dupont' },
    ...over,
  };
}

/* -------------------------------------------------------------------------- */

describe('comptes agregateurs', () => {
  it('refuse un compte aux credentials incomplets, en disant lesquels', async () => {
    const res = await post('/v1/provider-accounts', { provider: 'sandbox', credentials: { foo: 'bar' } }, undefined);
    expect(res.statusCode).toBe(400);
    expect(res.json().error.details.missing).toEqual(['webhook_secret']);
  });

  it("refuse un agregateur sans adaptateur", async () => {
    const res = await post('/v1/provider-accounts', {
      provider: 'fedapay',
      credentials: { api_key: 'x' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.message).toMatch(/Aucun adaptateur/);
  });

  it('ne renvoie jamais la valeur des credentials, seulement leurs noms', async () => {
    const res = await get('/v1/provider-accounts');
    const account = res.json().data[0];
    expect(account.credential_keys).toEqual(['webhook_secret']);
    expect(JSON.stringify(account)).not.toContain('secret-transactions');
  });
});

/* -------------------------------------------------------------------------- */

describe('encaissement — cycle nominal', () => {
  it("ne repond jamais 'paye' mais renvoie une action client", async () => {
    if (!seeded) return;
    const res = await post('/v1/payments', payinBody(), ref('idem'));
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.status).toBe('PROCESSING');
    expect(body.action.type).toBe('ussd_push');
    expect(body.action.instructions).toBeTruthy();
    expect(body.provider.id).toBe('sandbox');
  });

  it('aboutit a la lecture suivante et inscrit le ledger', async () => {
    if (!seeded) return;
    const created = await post('/v1/payments', payinBody(), ref('idem'));
    const id = created.json().id;

    const read = await get(`/v1/payments/${id}`);
    const body = read.json();
    expect(body.status).toBe('SUCCEEDED');
    expect(body.action.type).toBe('none');
    // Le simulateur ne prend aucune commission : la part Orchi vaut donc le
    // taux total, soit 5 % de 15 000.
    expect(body.fees.platform).toBe(750);
    expect(body.fees.provider).toBe(0);

    // En mode `invoice` (defaut), le flux et la commission sont deux journaux
    // distincts, ecrits dans la meme transaction.
    const journals = await prisma.ledgerJournal.findMany({ where: { refId: id } });
    expect(journals.map((j) => j.type).sort()).toEqual(['fee.accrued', 'payin.succeeded']);
    await expect(assertLedgerBalanced(merchantId)).resolves.toBeUndefined();
  });

  it('ne retient pas la commission sur le flux : elle devient une creance', async () => {
    if (!seeded) return;
    const created = await post('/v1/payments', payinBody({ amount: 20000 }), ref('idem'));
    const id = created.json().id;
    await get(`/v1/payments/${id}`);

    const flux = await prisma.ledgerEntry.findMany({
      where: { journal: { refId: id, type: 'payin.succeeded' } },
    });
    const byAccount = Object.fromEntries(flux.map((e) => [e.account, { side: e.side, amount: e.amount }]));

    expect(byAccount['provider:sandbox:clearing']).toEqual({ side: 'DEBIT', amount: 20000 });
    // Le simulateur ne prend rien : le marchand recoit L'INTEGRALITE de ce que
    // verse l'agregateur. C'est tout le principe du modele A.
    expect(byAccount[`merchant:${merchantId}:receivable`]).toEqual({ side: 'CREDIT', amount: 20000 });
    expect(byAccount['orchi:revenue']).toBeUndefined();

    // La part Orchi, 5 % de 20 000, vit dans le second journal.
    const creance = await prisma.ledgerEntry.findMany({
      where: { journal: { refId: id, type: 'fee.accrued' } },
    });
    const byBilling = Object.fromEntries(creance.map((e) => [e.account, { side: e.side, amount: e.amount }]));

    expect(byBilling[`merchant:${merchantId}:billing`]).toEqual({ side: 'DEBIT', amount: 1000 });
    expect(byBilling['orchi:revenue']).toEqual({ side: 'CREDIT', amount: 1000 });
  });

  it('conserve un ledger equilibre apres plusieurs transactions', async () => {
    if (!seeded) return;
    await assertLedgerBalanced(merchantId);
    const balances = await accountBalances(merchantId);
    expect(balances.length).toBeGreaterThan(0);
    expect(balances.reduce((sum, b) => sum + b.balance, 0)).toBe(0);
  });
});

/* -------------------------------------------------------------------------- */

describe('listes', () => {
  it('renvoie les encaissements du plus recent au plus ancien', async () => {
    if (!seeded) return;
    await post('/v1/payments', payinBody(), ref('idem'));
    const res = await get('/v1/payments?limit=5');

    expect(res.statusCode).toBe(200);
    const data = res.json().data as Array<{ created_at: string }>;
    expect(data.length).toBeGreaterThan(0);
    const dates = data.map((d) => new Date(d.created_at).getTime());
    expect([...dates].sort((a, b) => b - a)).toEqual(dates);
  });

  it('ne renvoie que les transactions du marchand authentifie', async () => {
    if (!seeded) return;
    const res = await get('/v1/payments?limit=100');
    const ids = (res.json().data as Array<{ id: string }>).map((d) => d.id);
    const foreign = await prisma.payment.count({
      where: { id: { in: ids }, merchantId: { not: merchantId } },
    });
    expect(foreign).toBe(0);
  });

  it('filtre par statut', async () => {
    if (!seeded) return;
    const res = await get('/v1/payments?status=SUCCEEDED&limit=50');
    for (const row of res.json().data as Array<{ status: string }>) {
      expect(row.status).toBe('SUCCEEDED');
    }
  });

  it('refuse un statut hors taxonomie', async () => {
    const res = await get('/v1/payments?status=PRESQUE_PAYE');
    expect(res.statusCode).toBe(400);
  });

  it('pagine par curseur sans repeter une ligne', async () => {
    if (!seeded) return;
    const first = await get('/v1/payments?limit=1');
    const cursor = first.json().next_cursor;
    if (!cursor) return;

    const second = await get(`/v1/payments?limit=1&starting_after=${cursor}`);
    expect(second.json().data[0]?.id).not.toBe(first.json().data[0].id);
  });

  it('expose les decaissements avec leur beneficiaire', async () => {
    if (!seeded) return;
    const res = await get('/v1/payouts?limit=5');
    expect(res.statusCode).toBe(200);
    const row = res.json().data[0];
    if (row) {
      expect(row.object).toBe('payout');
      expect(row).toHaveProperty('recipient_phone');
    }
  });

  it('omet l’historique complet des tentatives dans une liste', async () => {
    if (!seeded) return;
    const res = await get('/v1/payments?limit=1');
    const row = res.json().data[0];
    // Renvoyer l'historique de cent transactions produirait une reponse enorme :
    // la liste ne porte qu'un compteur, le detail s'obtient par GET /:id.
    expect(row.attempts).toBeUndefined();
    expect(typeof row.attempt_count).toBe('number');
  });
});

describe('idempotence', () => {
  it('exige une cle sur la creation de paiement', async () => {
    const res = await post('/v1/payments', payinBody());
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('idempotency_key_required');
  });

  it('rejoue la meme reponse pour une cle et un corps identiques', async () => {
    if (!seeded) return;
    const body = payinBody();
    const idem = ref('idem');

    const first = await post('/v1/payments', body, idem);
    const second = await post('/v1/payments', body, idem);

    expect(second.statusCode).toBe(first.statusCode);
    expect(second.json().id).toBe(first.json().id);
    expect(second.headers['idempotent-replayed']).toBe('true');
    expect(first.headers['idempotent-replayed']).toBe('false');
  });

  it('refuse la meme cle avec un corps different', async () => {
    if (!seeded) return;
    const idem = ref('idem');
    await post('/v1/payments', payinBody(), idem);
    const res = await post('/v1/payments', payinBody({ amount: 99000 }), idem);
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('idempotency_key_reused');
  });

  it('ne cree pas deux paiements pour une meme reference marchand', async () => {
    if (!seeded) return;
    const body = payinBody();
    await post('/v1/payments', body, ref('idem'));
    // Cle differente, reference identique : le second filet doit tenir.
    const second = await post('/v1/payments', body, ref('idem'));

    expect(second.statusCode).toBe(201);
    const count = await prisma.payment.count({ where: { merchantId, reference: body.reference } });
    expect(count).toBe(1);
  });

  it('refuse une reference reutilisee avec un montant different', async () => {
    if (!seeded) return;
    const body = payinBody();
    await post('/v1/payments', body, ref('idem'));
    const res = await post('/v1/payments', { ...body, amount: 1000 }, ref('idem'));
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('duplicate_reference');
  });
});

/* -------------------------------------------------------------------------- */

describe('validation metier', () => {
  it('refuse une devise incoherente avec le pays', async () => {
    const res = await post('/v1/payments', payinBody({ currency: 'XAF' }), ref('idem'));
    expect(res.statusCode).toBe(400);
    expect(res.json().error.details.expected).toBe('XOF');
  });

  it('refuse un montant decimal plutot que de l’arrondir', async () => {
    const res = await post('/v1/payments', payinBody({ amount: 1500.5 }), ref('idem'));
    expect(res.statusCode).toBe(400);
  });

  it('exige un telephone en mobile money', async () => {
    const res = await post('/v1/payments', payinBody({ customer: {} }), ref('idem'));
    expect(res.statusCode).toBe(400);
    expect(res.json().error.param).toBe('customer.phone');
  });

  it('refuse un pays hors catalogue', async () => {
    const res = await post('/v1/payments', payinBody({ country: 'FR', currency: 'XOF' }), ref('idem'));
    expect(res.statusCode).toBe(400);
  });

  it('explique l’absence de route quand aucun compte n’existe en live', async () => {
    if (!seeded) return;
    const res = await post('/v1/payments', payinBody(), ref('idem'), liveKey);
    expect(res.statusCode).toBe(422);
    const error = res.json().error;
    expect(error.code).toBe('no_route_available');
    expect(error.message).toMatch(/Aucun compte agregateur actif/);
  });
});

/* -------------------------------------------------------------------------- */

describe('encaissement — echecs', () => {
  it('marque le paiement en echec sur refus explicite', async () => {
    if (!seeded) return;
    const res = await post('/v1/payments', payinBody({ customer: { phone: '+22997000002' } }), ref('idem'));
    const body = res.json();
    expect(body.status).toBe('FAILED');
    expect(body.provider.code).toBe('insufficient_funds');
  });

  it('refuse la relance quand aucun autre agregateur n’est disponible', async () => {
    if (!seeded) return;
    const created = await post('/v1/payments', payinBody({ customer: { phone: '+22997000002' } }), ref('idem'));
    const res = await post(`/v1/payments/${created.json().id}/retry`, {});
    expect(res.statusCode).toBe(422);
    expect(res.json().error.message).toMatch(/deja ete essayes/);
  });

  it('laisse le paiement EN COURS sur timeout, jamais en echec', async () => {
    if (!seeded) return;
    const res = await post('/v1/payments', payinBody({ customer: { phone: '+22997000003' } }), ref('idem'));
    const body = res.json();
    // FAILED autoriserait une relance alors que le client a peut-etre valide.
    expect(body.status).toBe('PROCESSING');
    expect(body.attempts[0].status).toBe('UNKNOWN');
    expect(body.attempts[0].failure_code).toBe('timeout');
  });

  it('bloque la relance apres un timeout', async () => {
    if (!seeded) return;
    const created = await post('/v1/payments', payinBody({ customer: { phone: '+22997000003' } }), ref('idem'));
    const res = await post(`/v1/payments/${created.json().id}/retry`, {});
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('attempt_still_open');
    expect(res.json().error.retriable).toBe(false);
  });
});

/* -------------------------------------------------------------------------- */

describe('decaissement', () => {
  it('aboutit immediatement et inscrit le ledger', async () => {
    if (!seeded) return;
    const res = await post('/v1/payouts', payoutBody(), ref('idem'));
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.status).toBe('SUCCEEDED');
    expect(body.fees.platform).toBe(2500);

    const entries = await prisma.ledgerEntry.findMany({
      where: { journal: { refId: body.id, type: 'payout.succeeded' } },
    });
    const byAccount = Object.fromEntries(entries.map((e) => [e.account, { side: e.side, amount: e.amount }]));
    // Un decaissement de 50 000 a 5 % coute toujours 52 500 au marchand, mais en
    // mode `invoice` seuls 50 000 sortent de son compte agregateur : la part
    // Orchi ne transite pas, elle devient une creance.
    expect(byAccount[`merchant:${merchantId}:payable`]).toEqual({ side: 'DEBIT', amount: 50000 });
    expect(byAccount['provider:sandbox:clearing']).toEqual({ side: 'CREDIT', amount: 50000 });
    expect(byAccount['orchi:revenue']).toBeUndefined();

    const creance = await prisma.ledgerEntry.findMany({
      where: { journal: { refId: body.id, type: 'fee.accrued' } },
    });
    const byBilling = Object.fromEntries(creance.map((e) => [e.account, { side: e.side, amount: e.amount }]));
    expect(byBilling[`merchant:${merchantId}:billing`]).toEqual({ side: 'DEBIT', amount: 2500 });
    expect(byBilling['orchi:revenue']).toEqual({ side: 'CREDIT', amount: 2500 });

    await expect(assertLedgerBalanced(merchantId)).resolves.toBeUndefined();
  });

  it('exige une cle d’idempotence', async () => {
    const res = await post('/v1/payouts', payoutBody());
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('idempotency_key_required');
  });

  it('refuse un pays sans voie de decaissement', async () => {
    const res = await post(
      '/v1/payouts',
      payoutBody({ country: 'ER', currency: 'ERN', recipient: { phone: '+29112345678' } }),
      ref('idem'),
    );
    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe('payout_unavailable_in_country');
  });
});

/* -------------------------------------------------------------------------- */

describe('decaissement — la regle anti-double-paiement', () => {
  it('passe en UNKNOWN sur timeout et avertit explicitement', async () => {
    if (!seeded) return;
    const res = await post(
      '/v1/payouts',
      payoutBody({ recipient: { phone: '+22997000003', network: 'MTN_BENIN' } }),
      ref('idem'),
    );
    const body = res.json();
    expect(body.status).toBe('UNKNOWN');
    expect(body.warning.code).toBe('indeterminate_state');
    expect(body.attempts[0].status).toBe('UNKNOWN');
  });

  it('n’essaie AUCUN autre agregateur apres un etat indetermine', async () => {
    if (!seeded) return;
    const res = await post(
      '/v1/payouts',
      payoutBody({ recipient: { phone: '+22997000003', network: 'MTN_BENIN' } }),
      ref('idem'),
    );
    // Une seule tentative, meme si d'autres agregateurs etaient disponibles.
    expect(res.json().attempts).toHaveLength(1);
  });

  it('bloque toute relance tant que la reconciliation n’a pas tranche', async () => {
    if (!seeded) return;
    const created = await post(
      '/v1/payouts',
      payoutBody({ recipient: { phone: '+22997000003', network: 'MTN_BENIN' } }),
      ref('idem'),
    );
    const res = await post(`/v1/payouts/${created.json().id}/retry`, {});
    expect(res.statusCode).toBe(409);
    const error = res.json().error;
    expect(error.code).toBe('payout_indeterminate');
    expect(error.retriable).toBe(false);
  });

  it('reste bloque apres une lecture qui ne resout rien', async () => {
    if (!seeded) return;
    const created = await post(
      '/v1/payouts',
      payoutBody({ recipient: { phone: '+22997000003', network: 'MTN_BENIN' } }),
      ref('idem'),
    );
    const read = await get(`/v1/payouts/${created.json().id}`);
    expect(read.json().status).toBe('UNKNOWN');
  });

  it('n’ecrit aucune ligne de ledger pour un decaissement indetermine', async () => {
    if (!seeded) return;
    const created = await post(
      '/v1/payouts',
      payoutBody({ recipient: { phone: '+22997000003', network: 'MTN_BENIN' } }),
      ref('idem'),
    );
    const journals = await prisma.ledgerJournal.findMany({ where: { refId: created.json().id } });
    expect(journals).toHaveLength(0);
  });
});
