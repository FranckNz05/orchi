import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { logger } from '../../core/logger.js';
import { handleInboundWebhook } from '../../modules/webhooks/inbound.js';

/**
 * Reception des notifications agregateur.
 *
 * Deux particularites par rapport au reste de l'API :
 *
 * 1. AUCUNE AUTHENTIFICATION par cle API. L'appelant est un agregateur, pas un
 *    marchand. L'authenticite vient du jeton d'URL (qui identifie le compte) et
 *    de la signature du corps (qui prouve l'origine).
 *
 * 2. LE CORPS EST LU BRUT. La signature porte sur les octets recus : un JSON
 *    reparse puis reserialise ne se verifie plus. Le parseur est donc redefini
 *    dans un contexte encapsule, sans affecter le reste de l'API.
 */
const params = z.object({
  provider: z.string().min(1).max(60),
  token: z.string().min(10).max(200),
});

export async function hookRoutes(app: FastifyInstance) {
  await app.register(async (instance) => {
    // Contexte encapsule : ces parseurs ne s'appliquent qu'aux routes declarees
    // ci-dessous. Les autres routes continuent de recevoir du JSON parse.
    const keepRaw = (_req: unknown, body: string, done: (err: Error | null, result?: unknown) => void) =>
      done(null, body);

    instance.addContentTypeParser('application/json', { parseAs: 'string' }, keepRaw);
    instance.addContentTypeParser(
      'application/x-www-form-urlencoded',
      { parseAs: 'string' },
      keepRaw,
    );
    instance.addContentTypeParser('text/plain', { parseAs: 'string' }, keepRaw);
    // Certains agregateurs n'envoient aucun Content-Type exploitable.
    instance.addContentTypeParser('*', { parseAs: 'string' }, keepRaw);

    instance.post('/v1/hooks/:provider/:token', async (request, reply) => {
      const { provider, token } = params.parse(request.params);
      const rawBody = typeof request.body === 'string' ? request.body : '';

      const result = await handleInboundWebhook({
        providerId: provider,
        token,
        rawBody,
        headers: request.headers,
      });

      logger.info(
        { provider, outcome: result.outcome, attempt_id: result.attemptId },
        'Webhook entrant traite',
      );

      /**
       * Toujours 200 des lors que la requete est bien formee, MEME sur rejet.
       *
       * Un agregateur qui recoit une erreur reessaie, souvent longtemps. Rejouer
       * un evenement que nous savons deja ne pas pouvoir traiter n'aide
       * personne et masque les vraies pannes. Le detail est dans le corps, et la
       * trace est en base.
       */
      return reply.status(200).send({ received: true, outcome: result.outcome, note: result.note });
    });
  });
}
