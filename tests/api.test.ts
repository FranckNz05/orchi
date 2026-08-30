import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { generateApiKey } from '../src/core/crypto.js';
import { ID_PREFIX, newId } from '../src/core/ids.js';
import { prisma } from '../src/db/client.js';
import { buildServer } from '../src/server.js';

let app: FastifyInstance;
let merchantId: string;
let secret: string;
let revokedSecret: string;

beforeAll(async () => {
  app = await buildServer();
  await app.ready();

  merchantId = newId(ID_PREFIX.merchant);
  await prisma.merchant.create({
    data: {
      id: merchantId,
      name: 'Marchand de test',
      legalType: 'COMPANY',
      country: 'CI',
      contactEmail: `${merchantId}@test.local`,
    },
  });

  const active = generateApiKey('test');
  secret = active.secret;
  await prisma.apiKey.create({
    data: {
      id: newId(ID_PREFIX.apiKey),
      merchantId,
      label: 'active',
      prefix: active.prefix,
      hash: active.hash,
      scopes: 'payments:read',
    },
  });

  const revoked = generateApiKey('test');
  revokedSecret = revoked.secret;
  await prisma.apiKey.create({
    data: {
      id: newId(ID_PREFIX.apiKey),
      merchantId,
      label: 'revoquee',
      prefix: revoked.prefix,
      hash: revoked.hash,
      revokedAt: new Date(),
    },
  });
});

afterAll(async () => {
  await prisma.merchant.deleteMany({ where: { id: merchantId } });
  await app.close();
  await prisma.$disconnect();
});

describe('index du service', () => {
  it('repond a la racine plutot que par une 404', async () => {
    // C'est le premier geste de quiconque decouvre l'API : y repondre par une
    // 404 est techniquement correct et pratiquement inutile.
    const res = await app.inject({ method: 'GET', url: '/' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.service).toBe('orchi');
    expect(body.endpoints.payments).toContain('/v1/payments');
  });

  it('n’expose aucun secret sur une route publique', async () => {
    const res = await app.inject({ method: 'GET', url: '/' });
    const raw = res.body;
    expect(raw).not.toMatch(/sk_(test|live)_[A-Za-z0-9]{10}/);
    expect(raw).not.toContain('whsec_');
  });
});

describe('sante', () => {
  it('repond sur /health sans authentification', async () => {
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: 'ok', service: 'orchi' });
  });

  it('verifie la base sur /health/ready', async () => {
    const res = await app.inject({ method: 'GET', url: '/health/ready' });
    expect(res.statusCode).toBe(200);
    expect(res.json().checks.database).toBe('up');
  });
});

describe('authentification', () => {
  it('refuse une requete sans cle', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/me' });
    expect(res.statusCode).toBe(401);
    const body = res.json();
    expect(body.error.type).toBe('authentication_error');
    expect(body.error.retriable).toBe(false);
    expect(body.error.request_id).toMatch(/^req_/);
  });

  it('refuse une cle inconnue', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/v1/me',
      headers: { authorization: 'Bearer sk_test_inexistante' },
    });
    expect(res.statusCode).toBe(401);
  });

  it('refuse une cle revoquee', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/v1/me',
      headers: { authorization: `Bearer ${revokedSecret}` },
    });
    expect(res.statusCode).toBe(401);
  });

  it('refuse un schema non Bearer', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/v1/me',
      headers: { authorization: `Basic ${secret}` },
    });
    expect(res.statusCode).toBe(401);
  });

  it('accepte une cle valide et renvoie le contexte marchand', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/v1/me',
      headers: { authorization: `Bearer ${secret}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      merchant: { id: merchantId, country: 'CI' },
      api_key: { environment: 'test', scopes: ['payments:read'] },
    });
  });

  it('refuse un marchand suspendu', async () => {
    await prisma.merchant.update({ where: { id: merchantId }, data: { status: 'SUSPENDED' } });
    const res = await app.inject({
      method: 'GET',
      url: '/v1/me',
      headers: { authorization: `Bearer ${secret}` },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('merchant_inactive');
    await prisma.merchant.update({ where: { id: merchantId }, data: { status: 'ACTIVE' } });
  });
});

describe('erreurs', () => {
  it('renvoie une 404 typee sur une route inconnue', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/inexistant' });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('resource_not_found');
  });
});
