import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  connectProviderAccount,
  disableProviderAccount,
  listProviderAccounts,
} from '../../modules/provider-accounts.js';

const connectBody = z.object({
  provider: z.string().min(1),
  /**
   * Cles du marchand chez l'agregateur. Chiffrees a la reception, jamais
   * renvoyees par l'API.
   */
  credentials: z.record(z.string().min(1)),
  priority: z.number().int().min(0).max(1000).optional(),
});

export async function providerAccountRoutes(app: FastifyInstance) {
  app.post(
    '/v1/provider-accounts',
    { preHandler: [app.authenticate, app.requireScope('accounts:write')] },
    async (request, reply) => {
      const body = connectBody.parse(request.body);
      const account = await connectProviderAccount({
        merchantId: request.auth!.merchantId,
        providerId: body.provider,
        environment: request.auth!.environment,
        credentials: body.credentials,
        ...(body.priority !== undefined ? { priority: body.priority } : {}),
      });
      return reply.status(201).send(account);
    },
  );

  app.get('/v1/provider-accounts', { preHandler: app.authenticate }, async (request) => {
    const accounts = await listProviderAccounts(
      request.auth!.merchantId,
      request.auth!.environment,
    );
    return { object: 'list', count: accounts.length, data: accounts };
  });

  app.delete(
    '/v1/provider-accounts/:id',
    { preHandler: [app.authenticate, app.requireScope('accounts:write')] },
    async (request, reply) => {
      const { id } = z.object({ id: z.string() }).parse(request.params);
      await disableProviderAccount(request.auth!.merchantId, id);
      return reply.status(204).send();
    },
  );
}
