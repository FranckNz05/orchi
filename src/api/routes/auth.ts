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

const registerBody = z.object({
  name: z.string().min(2).max(120),
  email: z.string().email().max(200),
  password: z.string().min(1).max(200),
  company_name: z.string().min(2).max(160),
  country: z.string().length(2),
  legal_type: z.enum(['COMPANY', 'INDIVIDUAL']).default('COMPANY'),
  registration_number: z.string().max(80).optional(),
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

export async function authRoutes(app: FastifyInstance) {
  /**
   * Inscription. Cree l'entreprise et son premier utilisateur, puis ouvre la
   * session : demander a l'utilisateur de se reconnecter juste apres s'etre
   * inscrit n'apporte rien.
   */
  app.post('/auth/register', async (request, reply) => {
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
      ...(body.registration_number ? { registrationNumber: body.registration_number } : {}),
    });

    setSessionCookie(reply, session.token, new Date(Date.now() + 7 * 24 * 3600 * 1000));

    return reply.status(201).send({
      user: { name: session.userName, email: session.userEmail },
      merchant: { id: session.merchantId, name: session.merchantName, country: session.merchantCountry },
      environment: session.environment,
      next: '/app',
    });
  });

  app.post('/auth/login', async (request, reply) => {
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
      user: { name: ctx.userName, email: ctx.userEmail },
      merchant: { id: ctx.merchantId, name: ctx.merchantName, country: ctx.merchantCountry },
      environment: ctx.environment,
      counts: { payments, payouts },
      public_base_url: env.PUBLIC_BASE_URL,
    };
  });

  /** Bascule test / live du tableau de bord. */
  app.post('/auth/environment', { preHandler: app.authenticate }, async (request) => {
    const ctx = request.auth!;
    if (ctx.via !== 'session') throw errors.unauthenticated('Session de navigateur requise.');

    const { environment } = z
      .object({ environment: z.enum(['test', 'live']) })
      .parse(request.body);

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
