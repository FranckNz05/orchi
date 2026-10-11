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
  approval: env.WITHDRAWAL_APPROVAL,
  threshold: env.WITHDRAWAL_APPROVAL_THRESHOLD,
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
  env.WITHDRAWAL_APPROVAL = initial.approval;
  env.WITHDRAWAL_APPROVAL_THRESHOLD = initial.threshold;
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
  // Ces cas verifient le retrait lui-meme ; la validation a son propre bloc plus bas.
  beforeEach(() => { env.WITHDRAWAL_APPROVAL = 'never'; });
  const PASSWORD = 'une phrase de passe solide';
  /** Le simulateur lit le dernier bloc du numero : 0000 = succes. */
  const NUMERO = '+229 97 00 00 00';

  const withdraw = (payload: Record<string, unknown>, over: { cookie?: string; headers?: Record<string, string> } = {}) =>
    app.inject({
      method: 'POST',
      url: '/v1/withdrawals',
      cookies: { afripaie_session: over.cookie ?? merchantCookie },
      headers: over.headers ?? SAME_ORIGIN,
      payload: {
        provider: 'sandbox',
        phone: NUMERO,
        network: 'MTN_BENIN',
        beneficiary_name: 'Titulaire Test',
        password: PASSWORD,
        ...payload,
      },
    });

  it('envoie l’argent au numero SAISI pour ce retrait, mot de passe a l’appui', async () => {
    if (!seeded) return;
    await payin(20000);
    // Aucune destination enregistree par un administrateur : elle n'est plus requise.
    await prisma.merchantSettlementTarget.deleteMany({ where: { merchantId } });
    const avant = await held();

    const res = await withdraw({ amount: 10000 });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ status: 'PAID', amount: 10000, mode: 'AUTOMATIC', network: 'MTN_BENIN' });
    expect(res.json().destination).toBe('+22997000000');
    expect(await held()).toBe(avant - 10000);
    await expect(assertLedgerBalanced(merchantId)).resolves.toBeUndefined();

    // Un autre numero au retrait suivant, sans tout le disponible.
    const autre = await withdraw({ amount: 1000, phone: '+229 97 00 00 01' });
    expect(autre.json().destination).toBe('+22997000001');
  });

  it('retire tout le disponible quand aucun montant n’est donne', async () => {
    if (!seeded) return;
    await payin(20000);
    const avant = await held();
    const res = await withdraw({ phone: NUMERO });
    expect(res.json()).toMatchObject({ status: 'PAID', amount: avant });
    expect(await held()).toBe(0);
  });

  it('refuse un numero sans indicatif, ou d’un pays que l’agregateur ne sert pas', async () => {
    if (!seeded) return;
    await payin(20000);
    const local = await withdraw({ phone: '97000000' });
    expect(local.statusCode).toBe(400);
    expect(local.json().error.param).toBe('phone');

    // Yabetoo ne verse qu'au Congo : on le dit avant de reserver quoi que ce soit.
    const avant = await prisma.merchantSettlement.count({ where: { merchantId } });
    const ailleurs = await withdraw({ provider: 'yabetoo', phone: '+225 07 00 00 00 00', network: 'MTN_CI' });
    expect(ailleurs.statusCode).toBe(400);
    expect(ailleurs.json().error.param).toBe('phone');
    expect(await prisma.merchantSettlement.count({ where: { merchantId } })).toBe(avant);
  });

  it('refuse un mauvais mot de passe sans deconnecter ni rien envoyer', async () => {
    if (!seeded) return;
    await payin(20000);
    const avant = await prisma.merchantSettlement.count({ where: { merchantId } });
    const res = await withdraw({ amount: 1000, password: 'pas le bon du tout' });
    // 400 : un 401 renverrait le tableau de bord vers la page de connexion.
    expect(res.statusCode).toBe(400);
    expect(res.json().error.param).toBe('password');
    expect(await prisma.merchantSettlement.count({ where: { merchantId } })).toBe(avant);
  });

  it('refuse une cle API : elle se copie, elle ne doit pas vider un solde', async () => {
    if (!seeded) return;
    const res = await app.inject({
      method: 'POST',
      url: '/v1/withdrawals',
      headers: { authorization: `Bearer ${apiKey}` },
      payload: { provider: 'sandbox', amount: 1000, phone: NUMERO, beneficiary_name: 'X Y', password: PASSWORD },
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
    const solde = await held();
    expect(solde).toBeGreaterThan(1000);

    const peu = await withdraw({ amount: 499 });
    expect(peu.statusCode).toBe(400);
    expect(peu.json().error.param).toBe('amount');

    const trop = await withdraw({ amount: solde + 1 });
    expect(trop.statusCode).toBe(400);
    expect(trop.json().error.code).toBe('settlement_exceeds_available');
  });

  it('annonce quand les fonds en cours de reglement deviennent retirables', async () => {
    if (!seeded) return;
    env.MERCHANT_SETTLEMENT_DELAY_MS = 3_600_000;
    await payin(20000);
    const res = await app.inject({ method: 'GET', url: '/v1/settlements', headers: { authorization: `Bearer ${apiKey}` } });
    const b = (res.json().balances as { maturing: number; available: number; available_at: string | null }[])[0]!;
    expect(b.maturing).toBeGreaterThan(0);
    expect(b.available_at).toBeTruthy();
    const dans = new Date(b.available_at!).getTime() - Date.now();
    expect(dans).toBeGreaterThan(0);
    expect(dans).toBeLessThanOrEqual(3_600_000);

    // Rien n'est retirable tant que ce delai court.
    const refus = await withdraw({ amount: 1000 });
    expect(refus.statusCode).toBe(400);
    expect(refus.json().error.code).toBe('settlement_exceeds_available');
  });
});

describe('validation des retraits par un administrateur (PIN)', () => {
  const PASSWORD = 'une phrase de passe solide';
  const PIN = '4829';
  // Un numero NEUF a chaque appel (le simulateur reussit quand il finit par 0000),
  // pour que « jamais utilise » le reste d'un test a l'autre.
  let compteur = 0;
  const fresh = () => `+229 97 ${10 + (compteur += 1)} 00 00`;
  /** Un numero vers lequel un retrait a deja abouti (rempli par le test d'approbation). */
  let servi = '';

  beforeEach(() => {
    env.WITHDRAWAL_APPROVAL = 'risk';
    env.WITHDRAWAL_APPROVAL_THRESHOLD = 100_000;
  });

  const withdraw = (payload: Record<string, unknown>) =>
    app.inject({
      method: 'POST',
      url: '/v1/withdrawals',
      cookies: { afripaie_session: merchantCookie },
      headers: SAME_ORIGIN,
      payload: {
        provider: 'sandbox', phone: fresh(), network: 'MTN_BENIN', beneficiary_name: 'Titulaire Test',
        password: PASSWORD, ...payload,
      },
    });

  const setPin = (pin: string, password = PASSWORD) =>
    admin('PUT', '/v1/admin/pin', { password, pin });
  const approve = (id: string, pin: string, cookie = adminCookie) =>
    admin('POST', `/v1/admin/settlements/${id}/approve`, { pin }, cookie);
  const reject = (id: string, reason = 'Numéro non reconnu') =>
    admin('POST', `/v1/admin/settlements/${id}/reject`, { reason });

  const adminUser = () =>
    prisma.user.findFirstOrThrow({ where: { platformAdmin: true, email: { contains: '@autosettle.test' } } });
  const resetPinCounters = async () => {
    const u = await adminUser();
    await prisma.user.update({ where: { id: u.id }, data: { pinFailedCount: 0, pinLockedUntil: null } });
  };

  it('le PIN se definit avec le mot de passe du compte, et refuse un PIN trop simple', async () => {
    if (!seeded) return;
    expect((await setPin(PIN, 'pas le bon mot de passe')).statusCode).toBe(400);
    for (const faible of ['1234', '1111', '12', 'abcd', '9876']) {
      expect((await setPin(faible)).statusCode).toBe(400);
    }
    const ok = await setPin(PIN);
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({ is_set: true, locked_until: null });
    // La valeur du PIN n'est jamais renvoyee, ni stockee en clair.
    expect(JSON.stringify(ok.json())).not.toContain(PIN);
    expect((await adminUser()).withdrawalPinHash).not.toContain(PIN);
  });

  it('un marchand ne peut ni definir de PIN, ni approuver, ni lister les retraits a valider', async () => {
    if (!seeded) return;
    expect((await admin('PUT', '/v1/admin/pin', { password: PASSWORD, pin: '5731' }, merchantCookie)).statusCode).toBe(403);
    expect((await approve('rvs_x', PIN, merchantCookie)).statusCode).toBe(403);
    const liste = await app.inject({ method: 'GET', url: '/v1/admin/withdrawals', cookies: { afripaie_session: merchantCookie } });
    expect(liste.statusCode).toBe(403);
  });

  it('un numero jamais utilise attend l’approbation : montant reserve, rien n’est envoye', async () => {
    if (!seeded) return;
    await payin(20000);
    const avant = await held();

    const res = await withdraw({ amount: 10000 });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ status: 'PENDING_APPROVAL', amount: 10000, approval_reason: 'Premier retrait vers ce numéro.' });
    expect(res.json().provider_reference).toBeNull();
    // Reserve des la demande : le marchand ne peut pas le depenser deux fois.
    expect(await held()).toBe(avant - 10000);
    await expect(assertLedgerBalanced(merchantId)).resolves.toBeUndefined();

    const liste = await app.inject({ method: 'GET', url: '/v1/admin/withdrawals', cookies: { afripaie_session: adminCookie } });
    const lui = (liste.json().data as { id: string; merchant: { id: string } }[]).find((r) => r.id === res.json().id);
    expect(lui?.merchant.id).toBe(merchantId);
  });

  it('refuse un PIN faux, compte les essais et verrouille apres cinq echecs', async () => {
    if (!seeded) return;
    await payin(20000);
    const en_attente = (await withdraw({ amount: 6000 })).json();
    expect(en_attente.status).toBe('PENDING_APPROVAL');

    const un = await approve(en_attente.id, '0000');
    expect(un.statusCode).toBe(403);
    expect(un.json().error.code).toBe('pin_invalid');
    expect(un.json().error.message).toContain('4 essais');

    for (let i = 0; i < 3; i += 1) await approve(en_attente.id, '0000');
    const dernier = await approve(en_attente.id, '0000');
    expect(dernier.statusCode).toBe(429);
    expect(dernier.json().error.code).toBe('pin_locked');

    // Verrouille : meme le BON PIN est refuse, et rien n'est parti.
    const bon = await approve(en_attente.id, PIN);
    expect(bon.statusCode).toBe(429);
    const encore = await prisma.merchantSettlement.findUniqueOrThrow({ where: { id: en_attente.id } });
    expect(encore.status).toBe('PENDING_APPROVAL');

    await resetPinCounters();
    await reject(en_attente.id);
  });

  it('approuve avec le bon PIN : l’argent part, une seule fois', async () => {
    if (!seeded) return;
    await payin(20000);
    const demande = (await withdraw({ amount: 7000 })).json();
    expect(demande.status).toBe('PENDING_APPROVAL');
    const avant = await held();

    const ok = await approve(demande.id, PIN);
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({ status: 'PAID', amount: 7000, destination: demande.destination });
    expect(ok.json().decided_by).toContain('@autosettle.test');
    servi = demande.destination;
    // Rien n'est reservé une seconde fois.
    expect(await held()).toBe(avant);
    await expect(assertLedgerBalanced(merchantId)).resolves.toBeUndefined();

    // Deuxieme approbation : refusee, aucun double envoi.
    const deux = await approve(demande.id, PIN);
    expect(deux.statusCode).toBe(409);
    expect(await prisma.merchantSettlement.count({ where: { id: demande.id, status: 'PAID' } })).toBe(1);
  });

  it('un numero deja servi a ce marchand part tout de suite, sous le seuil', async () => {
    if (!seeded) return;
    await payin(20000);
    expect(servi).not.toBe('');
    const res = await withdraw({ amount: 1000, phone: servi });
    expect(res.json()).toMatchObject({ status: 'PAID', approval_reason: null });
  });

  it('au-dela du seuil, meme un numero connu attend un administrateur', async () => {
    if (!seeded) return;
    env.WITHDRAWAL_APPROVAL_THRESHOLD = 5000;
    await payin(20000);
    const res = await withdraw({ amount: 6000, phone: servi });
    expect(res.json().status).toBe('PENDING_APPROVAL');
    expect(res.json().approval_reason).toContain('5000');
    await reject(res.json().id);
  });

  it('le mode « always » valide tous les retraits', async () => {
    if (!seeded) return;
    env.WITHDRAWAL_APPROVAL = 'always';
    await payin(20000);
    const res = await withdraw({ amount: 1000, phone: servi });
    expect(res.json().status).toBe('PENDING_APPROVAL');
    await reject(res.json().id);
  });

  it('un refus rend le montant au marchand et garde le motif', async () => {
    if (!seeded) return;
    await payin(20000);
    const demande = (await withdraw({ amount: 6000 })).json();
    const reserve = await held();

    const res = await reject(demande.id, 'Numéro non reconnu par le marchand');
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: 'REJECTED', decision_note: 'Numéro non reconnu par le marchand' });
    expect(await held()).toBe(reserve + 6000);
    await expect(assertLedgerBalanced(merchantId)).resolves.toBeUndefined();
    // Un retrait deja decide ne se refuse pas une seconde fois.
    expect((await reject(demande.id)).statusCode).toBe(409);
  });

  it('le marchand annule sa propre demande tant qu’elle attend, pas apres', async () => {
    if (!seeded) return;
    await payin(20000);
    const demande = (await withdraw({ amount: 6000 })).json();
    const reserve = await held();

    const annule = await app.inject({
      method: 'POST', url: `/v1/withdrawals/${demande.id}/cancel`,
      cookies: { afripaie_session: merchantCookie }, headers: SAME_ORIGIN, payload: {},
    });
    expect(annule.statusCode).toBe(200);
    expect(annule.json().status).toBe('CANCELLED');
    expect(await held()).toBe(reserve + 6000);

    // Plus en attente : ni annulable, ni approuvable.
    const encore = await app.inject({
      method: 'POST', url: `/v1/withdrawals/${demande.id}/cancel`,
      cookies: { afripaie_session: merchantCookie }, headers: SAME_ORIGIN, payload: {},
    });
    expect(encore.statusCode).toBe(409);
    expect((await approve(demande.id, PIN)).statusCode).toBe(409);
  });

  it('sans PIN defini, un administrateur ne peut pas approuver', async () => {
    if (!seeded) return;
    await payin(20000);
    const demande = (await withdraw({ amount: 6000 })).json();
    const u = await adminUser();
    const hash = u.withdrawalPinHash;
    await prisma.user.update({ where: { id: u.id }, data: { withdrawalPinHash: null } });

    const res = await approve(demande.id, PIN);
    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe('pin_not_set');

    await prisma.user.update({ where: { id: u.id }, data: { withdrawalPinHash: hash } });
    await reject(demande.id);
  });
});

