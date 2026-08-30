import type { FastifyInstance } from 'fastify';
import { checkDatabase } from '../../db/client.js';
import { env } from '../../core/env.js';

/**
 * Index de service, renvoye a la racine aux clients d'API (curl, SDK). Un
 * navigateur recoit le site vitrine a la place — cf. src/api/routes/pages.ts.
 */
export function serviceIndex() {
  return ({
    service: 'orchi',
    description: "Orchestrateur de paiement pan-africain — API unifiee pay-in / payout",
    version: '0.1.0',
    environment: env.NODE_ENV,
    documentation: 'docs/INTEGRATION.md',
    console: 'GET /console',
    authentication: 'Authorization: Bearer sk_test_... ou sk_live_...',
    endpoints: {
      health: 'GET /health',
      readiness: 'GET /health/ready',
      identity: 'GET /v1/me',
      countries: 'GET /v1/countries',
      coverage: 'GET /v1/coverage?country=BJ',
      provider_accounts: 'GET|POST /v1/provider-accounts',
      payments: 'POST /v1/payments, GET /v1/payments/:id, POST /v1/payments/:id/retry',
      checkout: 'POST /v1/checkout-sessions -> page hebergee sur /pay/:token',
      payouts: 'POST /v1/payouts, GET /v1/payouts/:id, POST /v1/payouts/:id/retry',
      webhook_endpoints: 'GET|POST /v1/webhook-endpoints',
      webhook_deliveries: 'GET /v1/webhook-deliveries',
      reconciliation: 'GET /v1/reconciliation',
      routing: 'GET /v1/routing/health, GET /v1/routing/decisions?payment=...',
      inbound_hooks: 'POST /v1/hooks/:provider/:token (reserve aux agregateurs)',
    },
  });
}

export async function healthRoutes(app: FastifyInstance) {
  /** Liveness : le processus repond-il ? Aucune dependance externe. */
  app.get('/health', async () => ({
    status: 'ok',
    service: 'orchi',
    version: '0.1.0',
    environment: env.NODE_ENV,
    uptime_seconds: Math.round(process.uptime()),
  }));

  /** Readiness : peut-on servir du trafic ? Verifie la base. */
  app.get('/health/ready', async (_request, reply) => {
    const database = await checkDatabase();
    if (!database) {
      return reply.status(503).send({ status: 'degraded', checks: { database: 'down' } });
    }
    return { status: 'ok', checks: { database: 'up' } };
  });
}
