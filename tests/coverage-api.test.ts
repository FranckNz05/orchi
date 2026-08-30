import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { generateApiKey } from '../src/core/crypto.js';
import { ID_PREFIX, newId } from '../src/core/ids.js';
import { prisma } from '../src/db/client.js';
import { buildServer } from '../src/server.js';

/**
 * Ces tests supposent le catalogue seede : `npm run seed:catalog`.
 * Ils sont ignores sinon, plutot que d'echouer sur un environnement vierge.
 */
let app: FastifyInstance;
let merchantId: string;
let testKey: string;
let liveKey: string;
let catalogSeeded = false;

beforeAll(async () => {
  app = await buildServer();
  await app.ready();

  catalogSeeded = (await prisma.country.count()) > 0;

  merchantId = newId(ID_PREFIX.merchant);
  await prisma.merchant.create({
    data: {
      id: merchantId,
      name: 'Marchand couverture',
      legalType: 'COMPANY',
      country: 'BJ',
      contactEmail: `${merchantId}@test.local`,
    },
  });

  const test = generateApiKey('test');
  testKey = test.secret;
  await prisma.apiKey.create({
    data: {
      id: newId(ID_PREFIX.apiKey),
      merchantId,
      label: 'test',
      prefix: test.prefix,
      hash: test.hash,
      environment: 'test',
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
    },
  });
});

afterAll(async () => {
  await prisma.merchant.deleteMany({ where: { id: merchantId } });
  await app.close();
  await prisma.$disconnect();
});

function get(url: string, key: string) {
  return app.inject({ method: 'GET', url, headers: { authorization: `Bearer ${key}` } });
}

describe('GET /v1/countries', () => {
  it('exige une cle API', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/countries' });
    expect(res.statusCode).toBe(401);
  });

  it('renvoie les 54 Etats souverains', async () => {
    if (!catalogSeeded) return;
    const res = await get('/v1/countries', testKey);
    expect(res.statusCode).toBe(200);
    expect(res.json().count).toBe(54);
  });

  it('ajoute les territoires sur demande explicite', async () => {
    if (!catalogSeeded) return;
    const res = await get('/v1/countries?include_territories=true', testKey);
    expect(res.json().count).toBe(55);
  });

  it('filtre par region', async () => {
    if (!catalogSeeded) return;
    const res = await get('/v1/countries?region=NORTH', testKey);
    const data = res.json().data as Array<{ iso2: string; region: string }>;
    expect(data.map((c) => c.iso2).sort()).toEqual(['DZ', 'EG', 'LY', 'MA', 'MR', 'TN']);
  });

  it('refuse une region inconnue', async () => {
    const res = await get('/v1/countries?region=ATLANTIS', testKey);
    expect(res.statusCode).toBe(400);
    expect(res.json().error.type).toBe('invalid_request_error');
  });
});

describe('GET /v1/coverage', () => {
  it('decrit le Benin avec ses agregateurs et son exigence RCCM', async () => {
    if (!catalogSeeded) return;
    const res = await get('/v1/coverage?country=BJ', testKey);
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.country.currency).toMatchObject({ code: 'XOF', exponent: 0 });
    expect(body.kyc.allows_individual).toBe(true);
    expect(body.providers.map((p: { id: string }) => p.id)).toContain('fedapay');
  });

  it('accepte un code pays en minuscules', async () => {
    if (!catalogSeeded) return;
    const res = await get('/v1/coverage?country=ci', testKey);
    expect(res.statusCode).toBe(200);
    expect(res.json().country.iso2).toBe('CI');
  });

  it('filtre par canal', async () => {
    if (!catalogSeeded) return;
    const res = await get('/v1/coverage?country=NG&channel=bank_transfer', testKey);
    const providers = res.json().providers as Array<{ id: string; channels: string[] }>;
    expect(providers.length).toBeGreaterThan(0);
    for (const p of providers) expect(p.channels).toContain('bank_transfer');
  });

  it('exclut les agregateurs sans payout quand on demande le decaissement', async () => {
    if (!catalogSeeded) return;
    const res = await get('/v1/coverage?country=EG&direction=payout', testKey);
    const providers = res.json().providers as Array<{ id: string; payout: boolean }>;
    for (const p of providers) expect(p.payout).toBe(true);
    expect(providers.map((p) => p.id)).not.toContain('kashier');
  });

  it('propose le simulateur aux cles de test', async () => {
    if (!catalogSeeded) return;
    const res = await get('/v1/coverage?country=CM', testKey);
    const body = res.json();
    expect(body.providers[0].id).toBe('sandbox');
    expect(body.routable_now).toBe(true);
  });

  it('ne propose jamais le simulateur aux cles live', async () => {
    if (!catalogSeeded) return;
    const res = await get('/v1/coverage?country=CM', liveKey);
    const body = res.json();
    expect(body.providers.map((p: { id: string }) => p.id)).not.toContain('sandbox');
    // Aucun adaptateur reel n'est encore branche : la reponse doit le dire.
    expect(body.routable_now).toBe(false);
  });

  it('renvoie 404 sur un pays hors catalogue', async () => {
    const res = await get('/v1/coverage?country=FR', testKey);
    expect(res.statusCode).toBe(404);
  });

  it('refuse un code pays malforme', async () => {
    const res = await get('/v1/coverage?country=BEN', testKey);
    expect(res.statusCode).toBe(400);
  });
});
