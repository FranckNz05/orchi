import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  confirmCheckout,
  createCheckoutSession,
  getSessionForMerchant,
  pollCheckout,
  publicView,
  serializeSession,
} from '../../modules/checkout.js';
import { prisma } from '../../db/client.js';

const CHANNELS = ['mobile_money', 'card', 'bank_transfer'] as const;

const createBody = z.object({
  reference: z.string().min(1).max(120),
  amount: z.number().int().positive(),
  currency: z.string().length(3),
  country: z.string().length(2),
  description: z.string().max(500).optional(),
  customer: z
    .object({
      name: z.string().max(120).optional(),
      email: z.string().email().optional(),
      phone: z.string().min(6).max(20).optional(),
    })
    .optional(),
  success_url: z.string().url().optional(),
  cancel_url: z.string().url().optional(),
  metadata: z.record(z.string()).optional(),
  expires_in_minutes: z.number().int().min(5).max(1440).optional(),
});

const confirmBody = z.object({
  channel: z.enum(CHANNELS),
  network: z.string().max(60).optional(),
  phone: z.string().min(6).max(20).optional(),
  name: z.string().max(120).optional(),
  email: z.string().email().optional(),
});

export async function checkoutRoutes(app: FastifyInstance) {
  /* ---------------------------------------------------------------------- */
  /* Cote marchand — authentifie                                            */
  /* ---------------------------------------------------------------------- */

  /**
   * Cree une session et renvoie l'URL vers laquelle rediriger le client.
   *
   * C'est l'integration la plus courte possible : deux appels, aucun tunnel de
   * paiement a ecrire, aucun numero de telephone a manipuler cote marchand.
   */
  app.post(
    '/v1/checkout-sessions',
    { preHandler: [app.authenticate, app.requireScope('payments:write')] },
    async (request, reply) => {
      const body = createBody.parse(request.body);
      const auth = request.auth!;

      const session = await createCheckoutSession({
        merchantId: auth.merchantId,
        environment: auth.environment,
        reference: body.reference,
        amount: body.amount,
        currency: body.currency,
        country: body.country,
        ...(body.description ? { description: body.description } : {}),
        ...(body.customer ? { customer: body.customer } : {}),
        ...(body.success_url ? { successUrl: body.success_url } : {}),
        ...(body.cancel_url ? { cancelUrl: body.cancel_url } : {}),
        ...(body.metadata ? { metadata: body.metadata } : {}),
        ...(body.expires_in_minutes ? { ttlMinutes: body.expires_in_minutes } : {}),
      });

      return reply.status(201).send(serializeSession(session));
    },
  );

  app.get('/v1/checkout-sessions', { preHandler: app.authenticate }, async (request) => {
    const query = z
      .object({ limit: z.coerce.number().int().min(1).max(100).default(25) })
      .parse(request.query);

    const rows = await prisma.checkoutSession.findMany({
      where: { merchantId: request.auth!.merchantId },
      orderBy: { createdAt: 'desc' },
      take: query.limit,
    });

    return { object: 'list', count: rows.length, data: rows.map(serializeSession) };
  });

  app.get('/v1/checkout-sessions/:id', { preHandler: app.authenticate }, async (request) => {
    const { id } = z.object({ id: z.string() }).parse(request.params);
    return getSessionForMerchant(request.auth!.merchantId, id);
  });

  /* ---------------------------------------------------------------------- */
  /* Cote client final — public                                             */
  /* ---------------------------------------------------------------------- */

  /**
   * Ces trois routes sont PUBLIQUES : le client final n'a pas de compte.
   *
   * Le jeton d'URL est leur seule authentification. Il ne donne acces qu'a une
   * session, en lecture sur des informations que le client connait deja
   * (montant, commercant), et en ecriture uniquement pour choisir son moyen de
   * paiement. Aucune donnee du marchand n'y transite.
   */
  const token = z.object({ token: z.string().min(20).max(120) });

  app.get('/v1/public/checkout/:token', async (request) => {
    return publicView(token.parse(request.params).token);
  });

  app.post('/v1/public/checkout/:token/pay', async (request) => {
    const body = confirmBody.parse(request.body);
    return confirmCheckout({
      token: token.parse(request.params).token,
      channel: body.channel,
      ...(body.network ? { network: body.network } : {}),
      ...(body.phone ? { phone: body.phone } : {}),
      ...(body.name ? { name: body.name } : {}),
      ...(body.email ? { email: body.email } : {}),
    });
  });

  /** Interrogation pendant que le client valide sur son telephone. */
  app.get('/v1/public/checkout/:token/status', async (request) => {
    return pollCheckout(token.parse(request.params).token);
  });
}
