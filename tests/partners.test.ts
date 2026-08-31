import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { generateApiKey } from '../src/core/crypto.js';
import { ID_PREFIX, newId } from '../src/core/ids.js';
import { prisma } from '../src/db/client.js';
import { runPartnerSettlements } from '../src/modules/partners.js';
import { connectProviderAccount } from '../src/modules/provider-accounts.js';
import { buildServer } from '../src/server.js';

/**
 * Repartition differee aux partenaires.
 *
 * Les cas qui comptent ne sont pas le calcul de la part — c'est une
 * multiplication — mais ce qui se passe quand un versement ne se deroule PAS
 * comme prevu : echec explicite, issue indeterminee, montant sous le seuil.
 */
let app: FastifyInstance;
let merchantId: string;
let key: string;
let seeded = false;

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
      name: 'Marchand partenaires',
      legalType: 'COMPANY',
      country: 'BJ',
      contactEmail: `${merchantId}@test.local`,
    },
  });

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
      scopes: 'payments:read,payments:write,payouts:read,payouts:write,accounts:write',
    },
  });

  await connectProviderAccount({
    merchantId,
    providerId: 'sandbox',
    environment: 'test',
    credentials: { webhook_secret: 'secret-partenaires' },
    priority: 1,
  });
});

afterAll(async () => {
  await prisma.partnerAccrual.deleteMany({ where: { merchantId } });
  await prisma.partnerSettlement.deleteMany({ where: { merchantId } });
  await prisma.partner.deleteMany({ where: { merchantId } });
  await prisma.idempotencyRecord.deleteMany({ where: { merchantId } });
  await prisma.ledgerEntry.deleteMany({ where: { journal: { merchantId } } });
  await prisma.ledgerJournal.deleteMany({ where: { merchantId } });
  await prisma.merchant.deleteMany({ where: { id: merchantId } });
  await app.close();
  await prisma.$disconnect();
});

afterEach(async () => {
  // Systematique, et non en fin de chaque test : une assertion qui echoue
  // sauterait un nettoyage en ligne et ferait cascader la panne sur le suivant.
  await prisma.partnerAccrual.deleteMany({ where: { merchantId } });
  await prisma.partnerSettlement.deleteMany({ where: { merchantId } });
  await prisma.partner.deleteMany({ where: { merchantId } });
});

function post(url: string, body: unknown, idem?: string) {
  return app.inject({
    method: 'POST',
    url,
    headers: { authorization: `Bearer ${key}`, ...(idem ? { 'idempotency-key': idem } : {}) },
    payload: body as Record<string, unknown>,
  });
}

function get(url: string) {
  return app.inject({ method: 'GET', url, headers: { authorization: `Bearer ${key}` } });
}

function partenaire(over: Record<string, unknown> = {}) {
  return {
    reference: ref('ptn'),
    name: 'Partenaire logistique',
    country: 'BJ',
    currency: 'XOF',
    channel: 'mobile_money',
    share_bps: 1000,
    recipient: { phone: '+22997000000', network: 'MTN_BENIN', name: 'Partenaire SARL' },
    ...over,
  };
}

async function encaisser(amount = 15000) {
  const res = await post(
    '/v1/payments',
    {
      reference: ref('pay'),
      amount,
      currency: 'XOF',
      country: 'BJ',
      channel: 'mobile_money',
      customer: { phone: '+22997000000' },
    },
    ref('idem'),
  );
  const id = res.json().id;
  await get(`/v1/payments/${id}`); // resout le paiement chez le simulateur
  return id;
}

/* -------------------------------------------------------------------------- */

describe('configuration des partenaires', () => {
  it('refuse une part qui depasserait le plafond', async () => {
    if (!seeded) return;
    const a = await post('/v1/partners', partenaire({ share_bps: 8000 }));
    expect(a.statusCode).toBe(201);

    const b = await post('/v1/partners', partenaire({ share_bps: 2000 }));
    expect(b.statusCode).toBe(400);
    expect(b.json().error.details.max_bps).toBe(9000);

  });

  it('refuse un pays sans voie de decaissement', async () => {
    if (!seeded) return;
    // Erythree : aucun decaissement possible. Le refuser a la configuration
    // vaut mieux que de le decouvrir le jour du versement.
    const res = await post(
      '/v1/partners',
      partenaire({ country: 'ER', currency: 'ERN', share_bps: 500 }),
    );
    expect(res.statusCode).toBe(400);
    expect(res.json().error.message).toContain('decaissement');
  });

  it('rejouer la meme reference met a jour sans dupliquer', async () => {
    if (!seeded) return;
    const corps = partenaire({ share_bps: 500 });
    const a = await post('/v1/partners', corps);
    const b = await post('/v1/partners', { ...corps, share_bps: 700 });

    expect(a.json().id).toBe(b.json().id);
    expect(b.json().share_bps).toBe(700);

  });
});

/* -------------------------------------------------------------------------- */

describe('accumulation', () => {
  it('ecrit la part sur le net, pas sur le brut', async () => {
    if (!seeded) return;
    const created = await post('/v1/partners', partenaire({ share_bps: 1000 }));
    const partnerId = created.json().id;

    // 15 000 XOF chez le simulateur : commission agregateur 0, commission
    // Orchi 750 (5 %). Net = 14 250. Part de 10 % = 1 425.
    const paymentId = await encaisser(15000);

    const accrual = await prisma.partnerAccrual.findFirst({
      where: { partnerId, paymentId },
    });

    expect(accrual).not.toBeNull();
    expect(accrual!.baseAmount).toBe(14250);
    expect(accrual!.amount).toBe(1425);
    expect(accrual!.status).toBe('PENDING');

  });

  it('arrondit a l inferieur : le reste demeure au marchand', async () => {
    if (!seeded) return;
    const created = await post('/v1/partners', partenaire({ share_bps: 333 }));
    const partnerId = created.json().id;

    // 1 000 XOF : Orchi prend 50, net = 950. 950 * 3,33 % = 31,635 -> 31.
    const paymentId = await encaisser(1000);
    const accrual = await prisma.partnerAccrual.findFirst({ where: { partnerId, paymentId } });

    expect(accrual!.amount).toBe(31);

  });

  it('n accumule rien pour un partenaire desactive', async () => {
    if (!seeded) return;
    const created = await post('/v1/partners', partenaire({ share_bps: 1000 }));
    const partnerId = created.json().id;
    await app.inject({
      method: 'DELETE',
      url: `/v1/partners/${partnerId}`,
      headers: { authorization: `Bearer ${key}` },
    });

    const paymentId = await encaisser(15000);
    const accrual = await prisma.partnerAccrual.findFirst({ where: { partnerId, paymentId } });

    expect(accrual).toBeNull();

  });
});

/* -------------------------------------------------------------------------- */

describe('reglement groupe', () => {
  it('ne verse rien tant que l echeance n est pas atteinte', async () => {
    if (!seeded) return;
    await post('/v1/partners', partenaire({ share_bps: 1000 }));
    await encaisser(15000);

    // `dueAt` vaut succes + 24 h : a l'instant present, rien n'est echu.
    const result = await runPartnerSettlements(new Date());
    expect(result.groupes).toBe(0);

  });

  it('regroupe plusieurs encaissements en UN SEUL versement', async () => {
    if (!seeded) return;
    const created = await post('/v1/partners', partenaire({ share_bps: 1000 }));
    const partnerId = created.json().id;

    await encaisser(15000);
    await encaisser(15000);
    await encaisser(15000);

    const accruals = await prisma.partnerAccrual.findMany({ where: { partnerId } });
    expect(accruals).toHaveLength(3);

    // On se place apres l'echeance plutot que d'attendre 24 h.
    const apres = new Date(Date.now() + 48 * 3600 * 1000);
    const result = await runPartnerSettlements(apres);

    expect(result.groupes).toBe(1);
    expect(result.verses).toBe(1);

    const settlements = await prisma.partnerSettlement.findMany({ where: { partnerId } });
    expect(settlements).toHaveLength(1);
    expect(settlements[0]!.status).toBe('PAID');
    // 3 x 1 425 : c'est tout l'interet du groupement.
    expect(settlements[0]!.amount).toBe(4275);
    expect(settlements[0]!.accrualCount).toBe(3);
    expect(settlements[0]!.payoutId).not.toBeNull();

    const apresReglement = await prisma.partnerAccrual.findMany({ where: { partnerId } });
    expect(apresReglement.every((a) => a.status === 'SETTLED')).toBe(true);

  });

  it('reporte un montant sous le seuil au lieu de l annuler', async () => {
    if (!seeded) return;
    const created = await post('/v1/partners', partenaire({ share_bps: 100 }));
    const partnerId = created.json().id;

    // 1 000 XOF, 1 % du net (950) = 9. Tres en dessous du seuil de 1 000.
    await encaisser(1000);

    const apres = new Date(Date.now() + 48 * 3600 * 1000);
    const result = await runPartnerSettlements(apres);

    expect(result.reportes).toBe(1);
    expect(result.verses).toBe(0);

    // La somme reste DUE : l'accumulation n'est ni consommee ni annulee.
    const accruals = await prisma.partnerAccrual.findMany({ where: { partnerId } });
    expect(accruals.every((a) => a.status === 'PENDING')).toBe(true);
    expect(await prisma.partnerSettlement.count({ where: { partnerId } })).toBe(0);

  });

  it('relache les accumulations quand le versement echoue explicitement', async () => {
    if (!seeded) return;
    // Le suffixe 0002 declenche un refus explicite du simulateur : l agregateur
    // garantit n avoir rien traite, donc on peut relacher sans risque.
    const created = await post(
      '/v1/partners',
      partenaire({
        share_bps: 2000,
        recipient: { phone: '+22997000002', network: 'MTN_BENIN', name: 'Refuse' },
      }),
    );
    const partnerId = created.json().id;

    await encaisser(100000);

    const apres = new Date(Date.now() + 48 * 3600 * 1000);
    const result = await runPartnerSettlements(apres);

    expect(result.echecs).toBe(1);

    const settlement = await prisma.partnerSettlement.findFirst({ where: { partnerId } });
    expect(settlement!.status).toBe('FAILED');

    // Relachees : elles repartiront au cycle suivant.
    const accruals = await prisma.partnerAccrual.findMany({ where: { partnerId } });
    expect(accruals.every((a) => a.status === 'PENDING' && a.settlementId === null)).toBe(true);

  });

  it('BLOQUE sans relacher quand l issue du versement est indeterminee', async () => {
    if (!seeded) return;
    // C'est LE cas qui justifie toute la structure : le suffixe 0003 laisse le
    // decaissement en etat inconnu. De l argent est peut-etre parti. Relacher
    // les accumulations enverrait un second versement.
    const created = await post(
      '/v1/partners',
      partenaire({
        share_bps: 2000,
        recipient: { phone: '+22997000003', network: 'MTN_BENIN', name: 'Indetermine' },
      }),
    );
    const partnerId = created.json().id;

    await encaisser(100000);

    const apres = new Date(Date.now() + 48 * 3600 * 1000);
    const result = await runPartnerSettlements(apres);

    expect(result.bloques).toBe(1);
    expect(result.echecs).toBe(0);

    const settlement = await prisma.partnerSettlement.findFirst({ where: { partnerId } });
    expect(settlement!.status).toBe('BLOCKED');

    // NON relachees. C'est la propriete a ne jamais casser.
    const accruals = await prisma.partnerAccrual.findMany({ where: { partnerId } });
    expect(accruals.every((a) => a.status === 'SETTLED')).toBe(true);
    expect(accruals.every((a) => a.settlementId === settlement!.id)).toBe(true);

    // Un second passage ne doit rien reverser.
    const encore = await runPartnerSettlements(new Date(Date.now() + 72 * 3600 * 1000));
    expect(encore.verses).toBe(0);
    expect(encore.groupes).toBe(0);

  });
});

/* -------------------------------------------------------------------------- */

describe('lecture', () => {
  it('expose ce qui est du et pas encore verse', async () => {
    if (!seeded) return;
    await post('/v1/partners', partenaire({ share_bps: 1000 }));
    await encaisser(15000);
    await encaisser(15000);

    const res = await get('/v1/partners/pending');
    expect(res.statusCode).toBe(200);

    const ligne = res.json().data[0];
    expect(ligne.pending_amount).toBe(2850);
    expect(ligne.accrual_count).toBe(2);

  });
});
