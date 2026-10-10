import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { prisma } from '../src/db/client.js';
import { resolveSession } from '../src/modules/auth.js';
import { buildServer } from '../src/server.js';

let app: FastifyInstance;
const created: string[] = [];
let counter = 0;
const email = () => `p${Date.now()}-${(counter += 1)}@pwchange.test`;

const INITIAL = 'une phrase de passe solide';
const NOUVEAU = 'un tout autre secret durable';
const SAME_ORIGIN = { 'sec-fetch-site': 'same-origin' };

beforeAll(async () => {
  app = await buildServer();
  await app.ready();
});

afterAll(async () => {
  for (const id of created) await prisma.merchant.deleteMany({ where: { id } });
  await prisma.user.deleteMany({ where: { email: { contains: '@pwchange.test' } } });
  await app.close();
  await prisma.$disconnect();
});

function cookieFrom(res: { cookies: Array<{ name: string; value: string }> }) {
  return res.cookies.find((c) => c.name === 'afripaie_session')?.value;
}

async function newAccount() {
  const address = email();
  const res = await app.inject({
    method: 'POST',
    url: '/auth/register',
    payload: {
      name: 'Testeur Mot de passe',
      email: address,
      password: INITIAL,
      company_name: 'Société de test',
      country: 'CI',
    },
  });
  expect(res.statusCode).toBe(201);
  created.push(res.json().merchant.id);
  return { email: address, token: cookieFrom(res)! };
}

function loginAs(address: string, password: string) {
  return app.inject({ method: 'POST', url: '/auth/login', payload: { email: address, password } });
}

function change(token: string, payload: Record<string, unknown>, headers: Record<string, string> = SAME_ORIGIN) {
  return app.inject({
    method: 'POST',
    url: '/auth/password',
    cookies: { afripaie_session: token },
    headers,
    payload,
  });
}

describe('changement de mot de passe', () => {
  it('remplace le mot de passe : le nouveau ouvre une session, l’ancien non', async () => {
    const { email: address, token } = await newAccount();

    const res = await change(token, { current_password: INITIAL, new_password: NOUVEAU });
    expect(res.statusCode).toBe(200);
    expect(res.json().ok).toBe(true);

    expect((await loginAs(address, INITIAL)).statusCode).toBe(401);
    expect((await loginAs(address, NOUVEAU)).statusCode).toBe(200);
  });

  it('deconnecte les autres sessions et garde celle qui agit', async () => {
    const { email: address, token } = await newAccount();
    const autre = cookieFrom(await loginAs(address, INITIAL))!;
    const troisieme = cookieFrom(await loginAs(address, INITIAL))!;

    const res = await change(token, { current_password: INITIAL, new_password: NOUVEAU });
    expect(res.json().other_sessions_revoked).toBe(2);

    expect(await resolveSession(token)).not.toBeNull();
    expect(await resolveSession(autre)).toBeNull();
    expect(await resolveSession(troisieme)).toBeNull();
  });

  it('exige le mot de passe actuel, sans deconnecter sur une faute de frappe', async () => {
    const { email: address, token } = await newAccount();

    const res = await change(token, { current_password: 'pas le bon du tout', new_password: NOUVEAU });
    // 400, pas 401 : le tableau de bord interprete 401 comme une session perdue.
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('invalid_current_password');

    expect(await resolveSession(token)).not.toBeNull();
    expect((await loginAs(address, INITIAL)).statusCode).toBe(200);
  });

  it('applique les memes exigences qu’a l’inscription', async () => {
    const { token } = await newAccount();

    const court = await change(token, { current_password: INITIAL, new_password: 'court' });
    expect(court.statusCode).toBe(400);
    expect(court.json().error.code).toBe('weak_password');
    expect(court.json().error.param).toBe('new_password');

    const courant = await change(token, { current_password: INITIAL, new_password: 'monpassword2026!' });
    expect(courant.json().error.code).toBe('weak_password');
  });

  it('refuse un nouveau mot de passe identique a l’ancien', async () => {
    const { token } = await newAccount();
    const res = await change(token, { current_password: INITIAL, new_password: INITIAL });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('password_unchanged');
  });

  it('refuse une requete inter-origine (CSRF)', async () => {
    const { email: address, token } = await newAccount();
    const res = await change(
      token,
      { current_password: INITIAL, new_password: NOUVEAU },
      { origin: 'https://site-malveillant.example' },
    );
    expect(res.statusCode).toBe(403);
    expect((await loginAs(address, INITIAL)).statusCode).toBe(200);
  });

  it('refuse une cle API : elle identifie un systeme, pas une personne', async () => {
    const { token } = await newAccount();
    const key = await app.inject({
      method: 'POST',
      url: '/v1/api-keys',
      cookies: { afripaie_session: token },
      headers: SAME_ORIGIN,
      payload: { label: 'Backend' },
    });
    const secret = key.json().secret as string;

    const res = await app.inject({
      method: 'POST',
      url: '/auth/password',
      headers: { authorization: `Bearer ${secret}` },
      payload: { current_password: INITIAL, new_password: NOUVEAU },
    });
    expect(res.statusCode).toBe(403);
  });

  it('refuse sans session', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/auth/password',
      payload: { current_password: INITIAL, new_password: NOUVEAU },
    });
    expect(res.statusCode).toBe(401);
  });
});
