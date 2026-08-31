import Fastify, { type FastifyBaseLogger, type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import { env, isProduction } from './core/env.js';
import { logger } from './core/logger.js';
import { newId } from './core/ids.js';
import { auth } from './api/plugins/auth.js';
import { errorHandler } from './api/plugins/error-handler.js';
import { authRoutes } from './api/routes/auth.js';
import { catalogRoutes } from './api/routes/catalog.js';
import { checkoutRoutes } from './api/routes/checkout.js';

import { healthRoutes, serviceIndex } from './api/routes/health.js';
import { pageRoutes } from './api/routes/pages.js';
import { publicCatalogRoutes } from './api/routes/public-catalog.js';
import { hookRoutes } from './api/routes/hooks.js';
import { liveAccessRoutes } from './api/routes/live-access.js';
import { meRoutes } from './api/routes/me.js';
import { paymentRoutes } from './api/routes/payments.js';
import { payoutRoutes } from './api/routes/payouts.js';
import { partnerRoutes } from './api/routes/partners.js';
import { providerAccountRoutes } from './api/routes/provider-accounts.js';
import { routingRoutes } from './api/routes/routing.js';
import { webhookEndpointRoutes } from './api/routes/webhook-endpoints.js';

export async function buildServer(): Promise<FastifyInstance> {
  const app = Fastify({
    // Cast : le type pino concret est plus etroit que FastifyBaseLogger, ce qui
    // rendrait l'instance Fastify generique et contaminerait toutes les routes.
    loggerInstance: logger as unknown as FastifyBaseLogger,
    // Identifiant present dans chaque log et chaque corps d'erreur : c'est la
    // reference que le marchand communique au support.
    genReqId: () => `req_${newId('evt').split('_')[1]}`,
    trustProxy: isProduction,
    bodyLimit: 256 * 1024,
  });

  await app.register(helmet, { contentSecurityPolicy: false });
  await app.register(cookie);

  await app.register(rateLimit, {
    max: env.RATE_LIMIT_MAX,
    timeWindow: env.RATE_LIMIT_WINDOW,
    // Limite par cle API quand elle est connue, sinon par IP.
    keyGenerator: (request) => request.auth?.apiKeyId ?? request.ip,
  });

  await app.register(errorHandler);
  await app.register(auth);

  await app.register(healthRoutes);
  await app.register(publicCatalogRoutes);
  await app.register(async (instance) => pageRoutes(instance, serviceIndex));
  await app.register(meRoutes);
  await app.register(authRoutes);
  await app.register(liveAccessRoutes);
  await app.register(catalogRoutes);
  await app.register(providerAccountRoutes);
  await app.register(partnerRoutes);
  await app.register(paymentRoutes);
  await app.register(checkoutRoutes);
  await app.register(payoutRoutes);
  await app.register(routingRoutes);
  await app.register(webhookEndpointRoutes);
  await app.register(hookRoutes);

  return app;
}
