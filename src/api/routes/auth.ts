import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import { getCountry } from '../../catalog/countries.js';
import { errors } from '../../core/errors.js';
import { env, isProduction } from '../../core/env.js';
import { prisma } from '../../db/client.js';
import {
  SESSION_COOKIE,
  login,
  register,
  revokeSession,
  switchEnvironment,
} from '../../modules/auth.js';
import { assertLiveAllowed } from '../../modules/live-access.js';

const registerBody = z.object({
  name: z.string().min(2).max(120),
  email: z.string().email().max(200),
  password: z.string().min(1).max(200),
  company_name: z.string().min(2).max(160),
  country: z.string().length(2),
  legal_type: z.enum(['COMPANY', 'INDIVIDUAL']).default('COMPANY'),
});

const loginBody = z.object({
  email: z.string().email().max(200),
  password: z.string().min(1).max(200),
});

/**
 * Le cookie de session.
 *
 *   httpOnly   inaccessible au JavaScript : un script injecte ne peut pas
 *              l'exfiltrer, contrairement a une cle rangee dans localStorage.
 *   sameSite   `lax` bloque l'envoi automatique depuis un site tiers, ce qui
 *              neutralise l'essentiel du CSRF. La verification d'origine du
 *              plugin d'authentification est la seconde barriere.
 *   secure     en production uniquement : en local le serveur est en HTTP et
 *              le cookie serait sinon ignore par le navigateur.
 */
function setSessionCookie(reply: FastifyReply, token: string, expiresAt: Date) {
  reply.setCookie(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: isProduction,
    path: '/',
    expires: expiresAt,
  });
}

/**
 * Limites strictes sur les routes qui manipulent un mot de passe.
 *
 * Le quota global (300/minute) est dimensionne pour du trafic de paiement : il
 * laisserait 300 essais de mot de passe par minute et par IP, ce qui ne freine
 * aucune attaque par dictionnaire. Ces routes-ci meritent un ordre de grandeur
 * different.
 *
 * La limite porte sur l'IP, pas sur le compte vise. C'est un choix : verrouiller
 * un compte apres N echecs offrirait a n'importe qui le moyen d'enfermer
 * dehors le titulaire d'une adresse connue. Un attaquant disposant de
 * nombreuses IP reste donc possible — la vraie reponse a ce cas est une
 * seconde authentification, qui n'existe pas encore.
 */
const LIMITE_CONNEXION = {
  rateLimit: { max: env.AUTH_RATE_LIMIT_MAX, timeWindow: env.AUTH_RATE_LIMIT_WINDOW },
};
const LIMITE_INSCRIPTION = {
  rateLimit: { max: env.REGISTER_RATE_LIMIT_MAX, timeWindow: env.REGISTER_RATE_LIMIT_WINDOW },
};

export async function authRoutes(app: FastifyInstance) {
  /**
   * Inscription. Cree l'entreprise et son premier utilisateur, puis ouvre la
   * session : demander a l'utilisateur de se reconnecter juste apres s'etre
   * inscrit n'apporte rien.
   */
  app.post('/auth/register', { config: LIMITE_INSCRIPTION }, async (request, reply) => {
    const body = registerBody.parse(request.body);

    const country = getCountry(body.country);
    if (!country) {
      throw errors.invalidRequest(`Pays hors catalogue : ${body.country}.`, 'country');
    }

    const session = await register({
      email: body.email,
      password: body.password,
      name: body.name,
      companyName: body.company_name,
      country: body.country,
      legalType: body.legal_type,
    });

    setSessionCookie(reply, session.token, new Date(Date.now() + 7 * 24 * 3600 * 1000));

    return reply.status(201).send({
      user: { name: session.userName, email: session.userEmail },
      merchant: { id: session.merchantId, name: session.merchantName, country: session.merchantCountry },
      environment: session.environment,
      next: '/app',
    });
  });

  app.post('/auth/login', { config: LIMITE_CONNEXION }, async (request, reply) => {
    const body = loginBody.parse(request.body);

    const { token, context } = await login(body.email, body.password, {
      ...(request.headers['user-agent'] ? { userAgent: request.headers['user-agent'] } : {}),
      ip: request.ip,
    });

    setSessionCookie(reply, token, new Date(Date.now() + 7 * 24 * 3600 * 1000));

    return {
      user: { name: context.userName, email: context.userEmail },
      merchant: { id: context.merchantId, name: context.merchantName, country: context.merchantCountry },
      environment: context.environment,
      next: '/app',
    };
  });

  app.post('/auth/logout', async (request, reply) => {
    await revokeSession(request.cookies?.[SESSION_COOKIE]);
    reply.clearCookie(SESSION_COOKIE, { path: '/' });
    return { ok: true };
  });

  /** Identite de la session courante. Sert au tableau de bord au chargement. */
  app.get('/auth/session', { preHandler: app.authenticate }, async (request) => {
    const ctx = request.auth!;
    if (ctx.via !== 'session') throw errors.unauthenticated('Session de navigateur requise.');

    const [payments, payouts] = await Promise.all([
      prisma.payment.count({ where: { merchantId: ctx.merchantId, environment: ctx.environment } }),
      prisma.payout.count({ where: { merchantId: ctx.merchantId, environment: ctx.environment } }),
    ]);

    return {
      user: {
        name: ctx.userName,
        email: ctx.userEmail,
        // Le tableau de bord affiche le lien vers /admin a partir de ce champ.
        // Il ne conditionne AUCUN droit : l'autorite est verifiee a chaque appel
        // de /v1/admin/*. Un champ cote client ne protege rien, il n'informe.
        platform_admin: ctx.platformAdmin,
      },
      merchant: {
        id: ctx.merchantId,
        name: ctx.merchantName,
        country: ctx.merchantCountry,
        kyb_status: ctx.merchantKybStatus,
        can_go_live: ctx.merchantKybStatus === 'VERIFIED',
      },
      environment: ctx.environment,
      counts: { payments, payouts },
      public_base_url: env.PUBLIC_BASE_URL,
    };
  });

  /**
   * Bascule test / live du tableau de bord.
   *
   * Le passage en `live` est refuse tant que le marchand n'est pas verifie.
   * L'etat est relu en base a cet instant plutot que lu dans la session : une
   * suspension prononcee il y a une minute doit deja s'appliquer.
   */
  app.post('/auth/environment', { preHandler: app.authenticate }, async (request) => {
    const ctx = request.auth!;
    if (ctx.via !== 'session') throw errors.unauthenticated('Session de navigateur requise.');

    const { environment } = z
      .object({ environment: z.enum(['test', 'live']) })
      .parse(request.body);

    if (environment === 'live') await assertLiveAllowed(ctx.merchantId);

    await switchEnvironment(ctx.sessionId!, environment);
    return { environment };
  });

  /* ---------------------------------------------------------------------- */
  /* Cles API                                                               */
  /* ---------------------------------------------------------------------- */

  /**
   * Creation d'une cle API depuis le tableau de bord.
   *
   * Reservee a une session : une cle API ne doit pas pouvoir en engendrer
   * d'autres, sinon une cle compromise se perpetuerait toute seule.
   */
  app.post('/v1/api-keys', { preHandler: app.authenticate }, async (request, reply) => {
    const ctx = request.auth!;
    if (ctx.via !== 'session') {
      throw errors.forbidden('session (une cle API ne peut pas en creer une autre)');
    }

    const body = z
      .object({
        label: z.string().min(1).max(80).default('Clé'),
        environment: z.enum(['test', 'live']).optional(),
      })
      .parse(request.body ?? {});

    const { generateApiKey } = await import('../../core/crypto.js');
    const { ID_PREFIX, newId } = await import('../../core/ids.js');

    const environment = body.environment ?? ctx.environment;
    // Seconde et derniere porte vers l'environnement reel. Une cle `live`
    // emise ici serait utilisable sans limite de duree : la verifier au moment
    // de l'emission est ce qui rend le controle effectif.
    if (environment === 'live') await assertLiveAllowed(ctx.merchantId);
    const key = generateApiKey(environment);

    await prisma.apiKey.create({
      data: {
        id: newId(ID_PREFIX.apiKey),
        merchantId: ctx.merchantId,
        label: body.label,
        prefix: key.prefix,
        hash: key.hash,
        environment,
        scopes: 'payments:read,payments:write,payouts:read,payouts:write,accounts:write',
      },
    });

    // Le secret n'apparait qu'ici, comme chez tout fournisseur serieux.
    return reply.status(201).send({ label: body.label, environment, secret: key.secret });
  });

  app.get('/v1/api-keys', { preHandler: app.authenticate }, async (request) => {
    const ctx = request.auth!;
    const keys = await prisma.apiKey.findMany({
      where: { merchantId: ctx.merchantId },
      orderBy: { createdAt: 'desc' },
    });

    return {
      object: 'list',
      count: keys.length,
      data: keys.map((k) => ({
        id: k.id,
        label: k.label,
        prefix: k.prefix,
        environment: k.environment,
        revoked: k.revokedAt !== null,
        last_used_at: k.lastUsedAt?.toISOString() ?? null,
        created_at: k.createdAt.toISOString(),
      })),
    };
  });

  app.delete('/v1/api-keys/:id', { preHandler: app.authenticate }, async (request, reply) => {
    const ctx = request.auth!;
    if (ctx.via !== 'session') throw errors.forbidden('session');

    const { id } = z.object({ id: z.string() }).parse(request.params);
    const key = await prisma.apiKey.findFirst({ where: { id, merchantId: ctx.merchantId } });
    if (!key) throw errors.notFound('Clé API', id);

    await prisma.apiKey.update({ where: { id }, data: { revokedAt: new Date() } });
    return reply.status(204).send();
  });
}
