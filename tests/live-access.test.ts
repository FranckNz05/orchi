import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { generateApiKey } from '../src/core/crypto.js';
import { ID_PREFIX, newId } from '../src/core/ids.js';
import { prisma } from '../src/db/client.js';
import { SESSION_COOKIE } from '../src/modules/auth.js';
import { serializeLiveState } from '../src/modules/live-access.js';
import { buildServer } from '../src/server.js';

/**
 * Passage a l'environnement reel.
 *
 * Ces tests ne verifient pas qu'une fonctionnalite « marche » : ils verifient
 * qu'une porte reste FERMEE. C'est le seul controle qui separe la plateforme
 * d'un encaisseur anonyme, et sa particularite est qu'une regression ne se
 * manifeste par aucun symptome — tout continue de fonctionner, simplement pour
 * des gens qui n'auraient pas du passer.
 */

let app: FastifyInstance;
const merchants: string[] = [];
let counter = 0;
const email = () => `t${Date.now()}-${(counter += 1)}@live.test`;

beforeAll(async () => {
  app = await buildServer();
  await app.ready();
});

afterAll(async () => {
  for (const id of merchants) {
    await prisma.apiKey.deleteMany({ where: { merchantId: id } });
    await prisma.merchant.deleteMany({ where: { id } });
  }
  await prisma.user.deleteMany({ where: { email: { contains: '@live.test' } } });
  await app.close();
  await prisma.$disconnect();
});

/* -------------------------------------------------------------------------- */

interface Account {
  merchantId: string;
  cookie: string;
}

async function newMerchant(): Promise<Account> {
  const res = await app.inject({
    method: 'POST',
    url: '/auth/register',
    payload: {
      name: 'Testeur Live',
      email: email(),
      password: 'une phrase de passe solide',
      company_name: 'Boutique Live',
      country: 'BJ',
    },
  });
  const merchantId = res.json().merchant.id as string;
  merchants.push(merchantId);
  return { merchantId, cookie: res.cookies.find((c) => c.name === SESSION_COOKIE)!.value };
}

/** Promeut un compte au rang d'administrateur, comme le fait le script dedie. */
async function makeAdmin(account: Account): Promise<void> {
  await prisma.user.updateMany({
    where: { merchantId: account.merchantId },
    data: { platformAdmin: true },
  });
}

function as(account: Account, method: 'GET' | 'POST', url: string, payload?: unknown) {
  return app.inject({
    method,
    url,
    cookies: { [SESSION_COOKIE]: account.cookie },
    // La verification d'origine du plugin d'authentification exige cet en-tete
    // sur les requetes de session.
    headers: { 'sec-fetch-site': 'same-origin' },
    ...(payload ? { payload: payload as Record<string, unknown> } : {}),
  });
}

const DOSSIER = {
  activity: 'Billetterie de concerts au Benin, vente de billets nominatifs en ligne.',
  website: 'https://exemple.test',
  monthly_volume_minor: 4_000_000,
};

async function verify(admin: Account, merchantId: string) {
  return as(admin, 'POST', `/v1/admin/merchants/${merchantId}/review`, {
    decision: 'approve',
    note: 'Dossier conforme.',
  });
}

/* -------------------------------------------------------------------------- */

describe('la porte du reel est fermee par defaut', () => {
  it('refuse de creer une cle live a un marchand non verifie', async () => {
    const account = await newMerchant();
    const res = await as(account, 'POST', '/v1/api-keys', { label: 'prod', environment: 'live' });

    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('live_access_denied');
    expect(res.json().error.details.kyb_status).toBe('UNVERIFIED');
  });

  it('refuse de basculer le tableau de bord en live', async () => {
    const account = await newMerchant();
    const res = await as(account, 'POST', '/auth/environment', { environment: 'live' });

    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('live_access_denied');
  });

  it('laisse le test entierement ouvert', async () => {
    const account = await newMerchant();
    // Le controle ne doit gener personne tant qu'aucun argent reel n'est en jeu :
    // c'est ce qui permet a un integrateur de tout finir avant de deposer un
    // dossier.
    const key = await as(account, 'POST', '/v1/api-keys', { label: 'test', environment: 'test' });
    const env = await as(account, 'POST', '/auth/environment', { environment: 'test' });

    expect(key.statusCode).toBe(201);
    expect(env.statusCode).toBe(200);
  });

  it('refuse aussi apres coup : une suspension s’applique immediatement', async () => {
    const account = await newMerchant();
    const admin = await newMerchant();
    await makeAdmin(admin);
    await as(account, 'POST', '/v1/live-access', DOSSIER);
    await verify(admin, account.merchantId);

    // L'etat est relu en base a chaque appel. S'il etait fige dans la session,
    // le marchand suspendu continuerait d'emettre des cles jusqu'a expiration.
    await prisma.merchant.update({
      where: { id: account.merchantId },
      data: { kybStatus: 'REJECTED' },
    });

    const res = await as(account, 'POST', '/v1/api-keys', { label: 'prod', environment: 'live' });
    expect(res.statusCode).toBe(403);
  });
});

/* -------------------------------------------------------------------------- */

describe('depot d’un dossier', () => {
  it('place le marchand en attente d’examen', async () => {
    const account = await newMerchant();
    const res = await as(account, 'POST', '/v1/live-access', DOSSIER);

    expect(res.statusCode).toBe(202);
    expect(res.json().status).toBe('PENDING');
    expect(res.json().can_go_live).toBe(false);
    expect(res.json().requested_at).toBeTruthy();
  });

  it('exige une description reelle de l’activite', async () => {
    const account = await newMerchant();
    const res = await as(account, 'POST', '/v1/live-access', { activity: 'je vends' });
    expect(res.statusCode).toBe(400);
  });

  it('ne double pas la file quand le marchand redepose', async () => {
    const account = await newMerchant();
    const first = await as(account, 'POST', '/v1/live-access', DOSSIER);
    const second = await as(account, 'POST', '/v1/live-access', DOSSIER);

    // Recliquer n'est pas une faute : le marchand attend. On renvoie l'etat
    // courant sans redemarrer le compteur d'anciennete du dossier.
    expect(second.statusCode).toBe(202);
    expect(second.json().status).toBe('PENDING');
    expect(second.json().requested_at).toBe(first.json().requested_at);
  });

  it('refuse une demande d’un marchand deja verifie', async () => {
    const account = await newMerchant();
    const admin = await newMerchant();
    await makeAdmin(admin);
    await as(account, 'POST', '/v1/live-access', DOSSIER);
    await verify(admin, account.merchantId);

    const res = await as(account, 'POST', '/v1/live-access', DOSSIER);
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('already_verified');
  });

  it('n’est pas declenchable avec une cle API', async () => {
    const account = await newMerchant();
    const generated = generateApiKey('test');
    await prisma.apiKey.create({
      data: {
        id: newId(ID_PREFIX.apiKey),
        merchantId: account.merchantId,
        label: 'clé',
        prefix: generated.prefix,
        hash: generated.hash,
        environment: 'test',
        scopes: 'payments:read,payments:write',
      },
    });

    // Deposer un dossier engage le marchand sur son activite reelle. Un secret
    // copie dans un script ne doit pas pouvoir signer cet engagement.
    const res = await app.inject({
      method: 'POST',
      url: '/v1/live-access',
      headers: { authorization: `Bearer ${generated.secret}` },
      payload: DOSSIER,
    });
    expect(res.statusCode).toBe(403);
  });
});

/* -------------------------------------------------------------------------- */

describe('acces a l’administration', () => {
  it('est refuse a un marchand ordinaire', async () => {
    const account = await newMerchant();
    const res = await as(account, 'GET', '/v1/admin/merchants');

    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('admin_required');
  });

  it('est refuse a une cle API, meme celle d’un administrateur', async () => {
    const admin = await newMerchant();
    await makeAdmin(admin);

    const generated = generateApiKey('test');
    await prisma.apiKey.create({
      data: {
        id: newId(ID_PREFIX.apiKey),
        merchantId: admin.merchantId,
        label: 'clé admin',
        prefix: generated.prefix,
        hash: generated.hash,
        environment: 'test',
        scopes: 'payments:read,payments:write,payouts:read,payouts:write,accounts:write',
      },
    });

    // Une cle se copie, se colle dans un script et finit dans un depot.
    // Verifier un marchand doit rester un geste qu'une personne pose.
    const res = await app.inject({
      method: 'GET',
      url: '/v1/admin/merchants',
      headers: { authorization: `Bearer ${generated.secret}` },
    });
    expect(res.statusCode).toBe(403);
  });

  it('n’est jamais accorde par une route', async () => {
    const account = await newMerchant();
    // Aucun endpoint ne doit permettre de se declarer administrateur : le
    // drapeau ne s'accorde qu'en base. On verifie qu'une inscription ordinaire
    // ne le porte pas, quoi qu'on envoie.
    await app.inject({
      method: 'POST',
      url: '/auth/register',
      payload: {
        name: 'Malin', email: email(), password: 'une phrase de passe solide',
        company_name: 'Escalade SARL', country: 'BJ',
        platform_admin: true, platformAdmin: true, role: 'ADMIN',
      },
    });

    const users = await prisma.user.findMany({ where: { email: { contains: '@live.test' } } });
    expect(users.every((u) => u.platformAdmin === false || u.merchantId !== account.merchantId)).toBe(true);
    const escalated = users.find((u) => u.name === 'Malin');
    expect(escalated?.platformAdmin).toBe(false);
  });
});

/* -------------------------------------------------------------------------- */

describe('decision de la plateforme', () => {
  it('ouvre le reel apres approbation', async () => {
    const account = await newMerchant();
    const admin = await newMerchant();
    await makeAdmin(admin);

    await as(account, 'POST', '/v1/live-access', DOSSIER);
    const review = await verify(admin, account.merchantId);
    expect(review.statusCode).toBe(200);
    expect(review.json().kyb_status).toBe('VERIFIED');

    const key = await as(account, 'POST', '/v1/api-keys', { label: 'prod', environment: 'live' });
    const env = await as(account, 'POST', '/auth/environment', { environment: 'live' });

    expect(key.statusCode).toBe(201);
    expect(key.json().secret.startsWith('sk_live_')).toBe(true);
    expect(env.statusCode).toBe(200);
  });

  it('exige un motif pour un refus', async () => {
    const account = await newMerchant();
    const admin = await newMerchant();
    await makeAdmin(admin);
    await as(account, 'POST', '/v1/live-access', DOSSIER);

    // Un refus sans motif produit le meme dossier redepose la semaine suivante,
    // et un examen a refaire pour rien.
    const res = await as(admin, 'POST', `/v1/admin/merchants/${account.merchantId}/review`, {
      decision: 'reject',
    });
    expect(res.statusCode).toBe(400);
  });

  it('montre le motif du refus au marchand', async () => {
    const account = await newMerchant();
    const admin = await newMerchant();
    await makeAdmin(admin);
    await as(account, 'POST', '/v1/live-access', DOSSIER);
    await as(admin, 'POST', `/v1/admin/merchants/${account.merchantId}/review`, {
      decision: 'reject',
      note: 'Le numero RCCM fourni ne correspond a aucune inscription.',
    });

    const state = await as(account, 'GET', '/v1/live-access');
    expect(state.json().status).toBe('REJECTED');
    expect(state.json().note).toContain('RCCM');
  });

  it('permet de redeposer apres un refus, et efface la decision precedente', async () => {
    const account = await newMerchant();
    const admin = await newMerchant();
    await makeAdmin(admin);
    await as(account, 'POST', '/v1/live-access', DOSSIER);
    await as(admin, 'POST', `/v1/admin/merchants/${account.merchantId}/review`, {
      decision: 'reject', note: 'Dossier incomplet.',
    });

    const again = await as(account, 'POST', '/v1/live-access', DOSSIER);
    expect(again.json().status).toBe('PENDING');
    // Afficher « refuse » a cote de « en cours d'examen » n'aurait aucun sens.
    expect(again.json().note).toBeNull();
    expect(again.json().reviewed_at).toBeNull();
  });
});

/* -------------------------------------------------------------------------- */

describe('retrait de l’acces', () => {
  it('revoque les cles live sans toucher aux cles de test', async () => {
    const account = await newMerchant();
    const admin = await newMerchant();
    await makeAdmin(admin);
    await as(account, 'POST', '/v1/live-access', DOSSIER);
    await verify(admin, account.merchantId);
    await as(account, 'POST', '/v1/api-keys', { label: 'prod', environment: 'live' });
    await as(account, 'POST', '/v1/api-keys', { label: 'bac à sable', environment: 'test' });

    await as(admin, 'POST', `/v1/admin/merchants/${account.merchantId}/review`, {
      decision: 'revoke', note: 'Activite non conforme aux conditions.',
    });

    const keys = await prisma.apiKey.findMany({ where: { merchantId: account.merchantId } });
    const live = keys.filter((k) => k.environment === 'live');
    const test = keys.filter((k) => k.environment === 'test');

    // Sans cette revocation, le marchand suspendu continuerait d'encaisser avec
    // une cle distribuee la veille : la suspension ne serait qu'un affichage.
    expect(live.length).toBeGreaterThan(0);
    expect(live.every((k) => k.revokedAt !== null)).toBe(true);
    expect(test.every((k) => k.revokedAt === null)).toBe(true);
  });

  it('ramene les sessions ouvertes en test', async () => {
    const account = await newMerchant();
    const admin = await newMerchant();
    await makeAdmin(admin);
    await as(account, 'POST', '/v1/live-access', DOSSIER);
    await verify(admin, account.merchantId);
    await as(account, 'POST', '/auth/environment', { environment: 'live' });

    await as(admin, 'POST', `/v1/admin/merchants/${account.merchantId}/review`, {
      decision: 'revoke', note: 'Suspension.',
    });

    const session = await as(account, 'GET', '/auth/session');
    expect(session.json().environment).toBe('test');
    expect(session.json().merchant.can_go_live).toBe(false);
  });
});

/* -------------------------------------------------------------------------- */

describe('ce que le marchand voit du dossier', () => {
  it('n’expose pas l’identite de l’examinateur', () => {
    const state = serializeLiveState({
      kybStatus: 'REJECTED',
      liveRequestedAt: new Date(),
      liveReviewedAt: new Date(),
      liveReviewedBy: 'sess_123 (agent@orchi.africa)',
      liveReviewNote: 'Dossier incomplet.',
      liveActivity: 'Vente en ligne.',
      liveWebsite: null,
    } as never);

    // Le motif regarde le marchand ; le nom de la personne qui l'a redige
    // regarde la plateforme. Les melanger expose un agent a la pression du
    // marchand qu'il vient de refuser.
    expect(state.note).toBe('Dossier incomplet.');
    expect(JSON.stringify(state)).not.toContain('agent@orchi.africa');
  });
});
