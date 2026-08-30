import type { FastifyInstance, FastifyRequest, preHandlerHookHandler } from 'fastify';
import fp from 'fastify-plugin';
import { hashApiKey } from '../../core/crypto.js';
import { AppError, errors } from '../../core/errors.js';
import { prisma } from '../../db/client.js';
import { SESSION_COOKIE, resolveSession } from '../../modules/auth.js';

/**
 * Deux facons de s'authentifier, pour deux appelants differents :
 *
 *   - CLE API en jeton porteur : le backend du marchand. C'est le chemin
 *     normal de l'API.
 *   - SESSION en cookie : une personne dans le tableau de bord. Le navigateur
 *     ne detient alors aucun secret durable, contrairement a une cle API
 *     rangee dans le `localStorage`.
 *
 * Les deux aboutissent au meme `request.auth`, ce qui evite de dupliquer chaque
 * endpoint en une version « API » et une version « tableau de bord ».
 */

export interface AuthContext {
  merchantId: string;
  merchantName: string;
  merchantCountry: string;
  /** UNVERIFIED | PENDING | VERIFIED | REJECTED. Voir modules/live-access.ts. */
  merchantKybStatus: string;
  /** Autorite sur la plateforme, jamais accordee a une cle API. */
  platformAdmin: boolean;
  /** Present uniquement pour une authentification par cle API. */
  apiKeyId?: string;
  /** Present uniquement pour une session de navigateur. */
  sessionId?: string;
  userName?: string;
  userEmail?: string;
  environment: 'test' | 'live';
  scopes: string[];
  via: 'api_key' | 'session';
}

declare module 'fastify' {
  interface FastifyRequest {
    auth?: AuthContext;
  }
}

/** Scopes accordes a une personne connectee au tableau de bord. */
const SESSION_SCOPES = [
  'payments:read',
  'payments:write',
  'payouts:read',
  'payouts:write',
  'accounts:write',
];

function extractBearer(request: FastifyRequest): string | null {
  const header = request.headers.authorization;
  if (!header) return null;
  const [scheme, ...rest] = header.split(' ');
  if (!scheme || scheme.toLowerCase() !== 'bearer') return null;
  const token = rest.join(' ').trim();
  return token.length > 0 ? token : null;
}

/**
 * Protection CSRF des requetes authentifiees par cookie.
 *
 * Un cookie est envoye automatiquement par le navigateur, y compris depuis un
 * site tiers : sans cette verification, une page malveillante pourrait declencher
 * un decaissement au nom de l'utilisateur connecte. Le cookie est deja en
 * `SameSite=Lax`, ce qui bloque l'essentiel ; ceci est la seconde barriere.
 *
 * Les cles API ne sont pas concernees : elles ne sont jamais envoyees
 * automatiquement.
 */
function assertSameOrigin(request: FastifyRequest): void {
  const method = request.method.toUpperCase();
  if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') return;

  const fetchSite = request.headers['sec-fetch-site'];
  if (fetchSite === 'same-origin' || fetchSite === 'none') return;

  const origin = request.headers.origin;
  if (origin) {
    try {
      if (new URL(origin).host === request.headers.host) return;
    } catch {
      // Origin malforme : on refuse.
    }
  }

  throw new AppError({
    type: 'permission_error',
    code: 'cross_origin_denied',
    message: "Requete inter-origine refusee sur une session de navigateur.",
    httpStatus: 403,
    retriable: false,
  });
}

export const auth = fp(async (app: FastifyInstance) => {
  const authenticate: preHandlerHookHandler = async (request) => {
    const token = extractBearer(request);

    if (token) {
      // La recherche se fait sur le HMAC, jamais sur le secret : une seule
      // lecture indexee, pas de comparaison en boucle.
      const record = await prisma.apiKey.findUnique({
        where: { hash: hashApiKey(token) },
        include: { merchant: true },
      });

      if (!record || record.revokedAt) throw errors.unauthenticated();
      if (record.merchant.status !== 'ACTIVE') throw errors.merchantInactive(record.merchant.status);

      request.auth = {
        merchantId: record.merchantId,
        merchantName: record.merchant.name,
        merchantCountry: record.merchant.country,
        merchantKybStatus: record.merchant.kybStatus,
        // Une cle API n'est jamais administratrice, meme si elle appartient au
        // marchand de la plateforme : l'administration se fait avec une
        // session de navigateur, jamais avec un secret copiable.
        platformAdmin: false,
        apiKeyId: record.id,
        environment: record.environment === 'live' ? 'live' : 'test',
        scopes: record.scopes.split(',').map((s) => s.trim()).filter(Boolean),
        via: 'api_key',
      };

      // Horodatage d'usage : utile au support et a la detection de cles
      // orphelines. Une erreur ici ne doit pas faire echouer un paiement.
      void prisma.apiKey
        .update({ where: { id: record.id }, data: { lastUsedAt: new Date() } })
        .catch((e: unknown) => request.log.warn({ err: e }, 'lastUsedAt non mis a jour'));
      return;
    }

    const session = await resolveSession(request.cookies?.[SESSION_COOKIE]);
    if (!session) {
      throw errors.unauthenticated('Cle API ou session valide requise.');
    }

    assertSameOrigin(request);

    request.auth = {
      merchantId: session.merchantId,
      merchantName: session.merchantName,
      merchantCountry: session.merchantCountry,
      merchantKybStatus: session.merchantKybStatus,
      platformAdmin: session.platformAdmin,
      sessionId: session.sessionId,
      userName: session.userName,
      userEmail: session.userEmail,
      environment: session.environment,
      scopes: SESSION_SCOPES,
      via: 'session',
    };
  };

  app.decorate('authenticate', authenticate);

  app.decorate('requireScope', (scope: string): preHandlerHookHandler => {
    return async (request) => {
      const ctx = request.auth;
      if (!ctx) throw errors.unauthenticated();
      if (!ctx.scopes.includes(scope) && !ctx.scopes.includes('*')) throw errors.forbidden(scope);
    };
  });

  /**
   * Acces a l'administration de la plateforme.
   *
   * Exige une SESSION de navigateur : une cle API, meme celle du marchand de la
   * plateforme, ne donne jamais ce droit. Une cle se copie, se colle dans un
   * script et finit dans un depot ; verifier un marchand doit rester un geste
   * qu'une personne identifiee pose derriere son ecran.
   */
  app.decorate('requireAdmin', (async (request) => {
    const ctx = request.auth;
    if (!ctx) throw errors.unauthenticated();
    if (ctx.via !== 'session' || !ctx.platformAdmin) throw errors.notAdmin();
  }) as preHandlerHookHandler);
});

declare module 'fastify' {
  interface FastifyInstance {
    authenticate: preHandlerHookHandler;
    requireScope: (scope: string) => preHandlerHookHandler;
    requireAdmin: preHandlerHookHandler;
  }
}
