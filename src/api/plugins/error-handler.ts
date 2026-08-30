import type { FastifyInstance } from 'fastify';
import fp from 'fastify-plugin';
import { ZodError } from 'zod';
import { AppError, errors, isAppError } from '../../core/errors.js';

/**
 * Point de sortie unique des erreurs. Aucune stack trace, aucun message de
 * driver ne doit fuir vers le marchand : on journalise le detail et on renvoie
 * une erreur typee.
 */
export const errorHandler = fp(async (app: FastifyInstance) => {
  app.setErrorHandler((error, request, reply) => {
    const requestId = String(request.id);

    if (isAppError(error)) {
      if (error.httpStatus >= 500) request.log.error({ err: error }, error.message);
      else request.log.warn({ code: error.code, path: request.url }, error.message);
      return reply.status(error.httpStatus).send(error.toResponse(requestId));
    }

    if (error instanceof ZodError) {
      const first = error.issues[0];
      const appError = errors.invalidRequest(
        first ? `${first.path.join('.') || 'corps'} : ${first.message}` : 'Requete invalide.',
        first?.path.join('.'),
        { issues: error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })) },
      );
      return reply.status(400).send(appError.toResponse(requestId));
    }

    // Erreurs levees par Fastify lui-meme (JSON malforme, 404, 429...).
    const raw = error as { statusCode?: number; code?: string; message?: string };
    const status = raw.statusCode;
    if (status && status < 500) {
      const appError = new AppError({
        type: status === 429 ? 'rate_limit_error' : 'invalid_request_error',
        code: raw.code ?? 'bad_request',
        message: raw.message ?? 'Requete invalide.',
        httpStatus: status,
        retriable: status === 429,
      });
      return reply.status(status).send(appError.toResponse(requestId));
    }

    request.log.error({ err: error }, 'Erreur non geree');
    return reply.status(500).send(errors.internal(error).toResponse(requestId));
  });

  app.setNotFoundHandler((request, reply) => {
    const err = errors.notFound(`Route ${request.method} ${request.url}`);
    reply.status(404).send(err.toResponse(String(request.id)));
  });
});
