import type { FastifyInstance } from 'fastify';

/**
 * Renvoie l'identite associee a la cle API presentee. Sert de verification
 * d'integration cote marchand : si cette route repond, les cles sont bonnes.
 */
export async function meRoutes(app: FastifyInstance) {
  app.get('/v1/me', { preHandler: app.authenticate }, async (request) => {
    const ctx = request.auth!;
    return {
      merchant: {
        id: ctx.merchantId,
        name: ctx.merchantName,
        country: ctx.merchantCountry,
      },
      api_key: {
        id: ctx.apiKeyId,
        environment: ctx.environment,
        scopes: ctx.scopes,
      },
    };
  });
}
