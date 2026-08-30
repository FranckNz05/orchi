import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { prisma } from '../src/db/client.js';
import {
  checkPasswordStrength,
  hashPassword,
  resolveSession,
  revokeSession,
  verifyPassword,
} from '../src/modules/auth.js';
import { buildServer } from '../src/server.js';

let app: FastifyInstance;
const created: string[] = [];
let counter = 0;
const email = () => `t${Date.now()}-${(counter += 1)}@auth.test`;

beforeAll(async () => {
  app = await buildServer();
  await app.ready();
});

afterAll(async () => {
  for (const id of created) await prisma.merchant.deleteMany({ where: { id } });
  await prisma.user.deleteMany({ where: { email: { contains: '@auth.test' } } });
  await app.close();
  await prisma.$disconnect();
});

async function register(over: Record<string, unknown> = {}) {
  const res = await app.inject({
    method: 'POST',
    url: '/auth/register',
    payload: {
      name: 'Testeur Auth',
      email: email(),
      password: 'une phrase de passe solide',
      company_name: 'Société de test',
      country: 'BJ',
      ...over,
    },
  });
  if (res.statusCode === 201) created.push(res.json().merchant.id);
  return res;
}

function cookieFrom(res: { cookies: Array<{ name: string; value: string }> }) {
  return res.cookies.find((c) => c.name === 'orchi_session')?.value;
}

/* -------------------------------------------------------------------------- */

describe('derivation des mots de passe', () => {
  it('ne stocke jamais le mot de passe en clair', async () => {
    const hash = await hashPassword('mon mot de passe secret');
    expect(hash).not.toContain('mon mot de passe');
    expect(hash.startsWith('scrypt$')).toBe(true);
  });

  it('produit une empreinte differente pour le meme mot de passe', async () => {
    // Sel aleatoire : deux comptes avec le meme mot de passe ne doivent pas
    // etre reconnaissables dans un vidage de base.
    const a = await hashPassword('identique');
    const b = await hashPassword('identique');
    expect(a).not.toBe(b);
  });

  it('verifie correctement', async () => {
    const hash = await hashPassword('la bonne phrase de passe');
    expect(await verifyPassword('la bonne phrase de passe', hash)).toBe(true);
    expect(await verifyPassword('la mauvaise phrase', hash)).toBe(false);
  });

  it('inscrit le cout dans l’empreinte pour pouvoir le relever plus tard', async () => {
    const hash = await hashPassword('peu importe');
    const [algo, n] = hash.split('$');
    expect(algo).toBe('scrypt');
    expect(Number(n)).toBeGreaterThanOrEqual(16384);
  });

  it('refuse une empreinte malformee au lieu de lever', async () => {
    expect(await verifyPassword('x', 'nimporte quoi')).toBe(false);
    expect(await verifyPassword('x', 'bcrypt$1$2$3$4$5')).toBe(false);
  });
});

describe('exigences de mot de passe', () => {
  it('impose douze caracteres', () => {
    expect(() => checkPasswordStrength('court', 'a@b.c')).toThrow(/12 caractères/);
  });

  it('refuse un mot de passe contenant l’adresse', () => {
    expect(() => checkPasswordStrength('francknzoutani99', 'francknzoutani@x.fr')).toThrow(/adresse/);
  });

  it('refuse les mots de passe les plus courants', () => {
    expect(() => checkPasswordStrength('motdepasse123456', 'a@b.c')).toThrow(/trop courant/);
  });

  it('accepte une phrase longue et banale', () => {
    // La longueur prime sur la complexite : `Passw0rd!` est plus faible que
    // douze mots ordinaires.
    expect(() => checkPasswordStrength('le chat dort sur le tapis', 'a@b.c')).not.toThrow();
  });
});

/* -------------------------------------------------------------------------- */

describe('inscription', () => {
  it('cree l’entreprise et l’utilisateur, et ouvre la session', async () => {
    const res = await register();
    expect(res.statusCode).toBe(201);
    expect(res.json().merchant.name).toBe('Société de test');
    expect(cookieFrom(res)).toBeTruthy();
  });

  it('connecte le simulateur d’office, sinon rien ne peut etre encaisse', async () => {
    const res = await register();
    const accounts = await prisma.providerAccount.findMany({
      where: { merchantId: res.json().merchant.id },
    });
    expect(accounts.map((a) => a.providerId)).toContain('sandbox');
  });

  it('pose un cookie httpOnly, invisible au JavaScript', async () => {
    const res = await register();
    const cookie = res.cookies.find((c) => c.name === 'orchi_session');
    // Une cle rangee dans localStorage serait exfiltrable par un script injecte.
    expect(cookie?.httpOnly).toBe(true);
    expect(cookie?.sameSite?.toLowerCase()).toBe('lax');
  });

  it('refuse une adresse deja enregistree', async () => {
    const address = email();
    await register({ email: address });
    const second = await register({ email: address });
    expect(second.statusCode).toBe(409);
    expect(second.json().error.code).toBe('email_already_registered');
  });

  it('refuse un pays hors catalogue', async () => {
    const res = await register({ country: 'FR' });
    expect(res.statusCode).toBe(400);
  });
});

describe('connexion', () => {
  it('accepte les bons identifiants', async () => {
    const address = email();
    await register({ email: address });

    const res = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { email: address, password: 'une phrase de passe solide' },
    });
    expect(res.statusCode).toBe(200);
    expect(cookieFrom(res)).toBeTruthy();
  });

  it('donne le meme message pour un compte inexistant et un mauvais mot de passe', async () => {
    const address = email();
    await register({ email: address });

    const wrongPassword = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { email: address, password: 'une mauvaise phrase de passe' },
    });
    const noAccount = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { email: 'inconnu@auth.test', password: 'une phrase de passe solide' },
    });

    // Distinguer les deux permettrait d'enumerer les comptes enregistres.
    expect(wrongPassword.statusCode).toBe(401);
    expect(noAccount.statusCode).toBe(401);
    expect(noAccount.json().error.message).toBe(wrongPassword.json().error.message);
  });

  it('accepte l’adresse quelle qu’en soit la casse', async () => {
    const address = email();
    await register({ email: address });
    const res = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { email: address.toUpperCase(), password: 'une phrase de passe solide' },
    });
    expect(res.statusCode).toBe(200);
  });
});

/* -------------------------------------------------------------------------- */

describe('sessions', () => {
  it('ne reconnait pas un jeton inconnu', async () => {
    expect(await resolveSession('jeton-invente')).toBeNull();
    expect(await resolveSession(undefined)).toBeNull();
  });

  it('ne reconnait plus un jeton revoque', async () => {
    const res = await register();
    const token = cookieFrom(res)!;
    expect(await resolveSession(token)).not.toBeNull();

    await revokeSession(token);
    expect(await resolveSession(token)).toBeNull();
  });

  it('ne stocke pas le jeton en base, seulement son empreinte', async () => {
    const res = await register();
    const token = cookieFrom(res)!;
    const stored = await prisma.session.findMany({ select: { tokenHash: true } });
    // Une fuite de la base ne doit pas permettre d'usurper une session.
    expect(stored.every((s) => s.tokenHash !== token)).toBe(true);
  });
});

describe('authentification par session sur l’API', () => {
  it('donne acces aux memes endpoints qu’une cle API', async () => {
    const res = await register();
    const token = cookieFrom(res)!;

    const list = await app.inject({
      method: 'GET',
      url: '/v1/payments',
      cookies: { orchi_session: token },
    });
    expect(list.statusCode).toBe(200);
  });

  it('refuse une ecriture inter-origine, meme avec un cookie valide', async () => {
    const res = await register();
    const token = cookieFrom(res)!;

    const attack = await app.inject({
      method: 'POST',
      url: '/v1/api-keys',
      cookies: { orchi_session: token },
      headers: { origin: 'https://site-malveillant.example' },
      payload: { label: 'vol' },
    });

    // Un cookie est envoye automatiquement par le navigateur, y compris depuis
    // un site tiers : sans cette barriere, une page piegee pourrait agir au nom
    // de l'utilisateur connecte.
    expect(attack.statusCode).toBe(403);
    expect(attack.json().error.code).toBe('cross_origin_denied');
  });

  it('autorise l’ecriture depuis la meme origine', async () => {
    const res = await register();
    const token = cookieFrom(res)!;

    const ok = await app.inject({
      method: 'POST',
      url: '/v1/api-keys',
      cookies: { orchi_session: token },
      headers: { 'sec-fetch-site': 'same-origin' },
      payload: { label: 'Backend' },
    });
    expect(ok.statusCode).toBe(201);
    expect(ok.json().secret).toMatch(/^sk_test_/);
  });

  it('interdit a une cle API d’en creer une autre', async () => {
    const res = await register();
    const token = cookieFrom(res)!;

    const created = await app.inject({
      method: 'POST',
      url: '/v1/api-keys',
      cookies: { orchi_session: token },
      headers: { 'sec-fetch-site': 'same-origin' },
      payload: { label: 'Premiere' },
    });
    const secret = created.json().secret;

    const chained = await app.inject({
      method: 'POST',
      url: '/v1/api-keys',
      headers: { authorization: `Bearer ${secret}` },
      payload: { label: 'Seconde' },
    });

    // Sinon une cle compromise se perpetuerait toute seule.
    expect(chained.statusCode).toBe(403);
  });
});

describe('pages publiques', () => {
  it('sert le site vitrine a un navigateur et l’index de service a curl', async () => {
    const browser = await app.inject({ method: 'GET', url: '/', headers: { accept: 'text/html' } });
    const client = await app.inject({ method: 'GET', url: '/' });

    expect(browser.headers['content-type']).toContain('text/html');
    expect(client.json().service).toBe('orchi');
  });

  it('expose le catalogue sans authentification', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/public/catalog' });
    expect(res.statusCode).toBe(200);
    expect(res.json().totals.countries).toBe(54);
  });

  it('ne laisse pas sortir du dossier public', async () => {
    for (const path of ['/assets/..%2f.env', '/assets/../.env', '/assets/theme.txt']) {
      const res = await app.inject({ method: 'GET', url: path });
      expect(res.statusCode).toBe(404);
    }
  });

  it('sert les ressources partagees', async () => {
    const css = await app.inject({ method: 'GET', url: '/assets/theme.css' });
    expect(css.statusCode).toBe(200);
    expect(css.headers['content-type']).toContain('text/css');
  });
});
