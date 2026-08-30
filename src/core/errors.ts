/**
 * Taxonomie d'erreurs de l'orchestrateur.
 *
 * Toute erreur renvoyee au marchand porte un champ `retriable`. Sur une API de
 * paiement c'est l'information la plus importante du corps de reponse : elle
 * indique si rejouer la requete est sur. Une erreur non retriable rejouee peut
 * produire un double decaissement.
 */

export type ErrorType =
  | 'authentication_error'
  | 'permission_error'
  | 'invalid_request_error'
  | 'idempotency_error'
  | 'routing_error'
  | 'provider_error'
  | 'rate_limit_error'
  | 'api_error';

export interface AppErrorOptions {
  type: ErrorType;
  code: string;
  message: string;
  httpStatus: number;
  /** Rejouer la requete a l'identique est-il sur ? */
  retriable: boolean;
  /** Champ de la requete en cause, le cas echeant. */
  param?: string;
  /** Contexte additionnel expose au marchand (jamais de secret). */
  details?: Record<string, unknown>;
  /** Erreur d'origine, conservee pour les logs uniquement. */
  cause?: unknown;
}

export class AppError extends Error {
  readonly type: ErrorType;
  readonly code: string;
  readonly httpStatus: number;
  readonly retriable: boolean;
  readonly param?: string;
  readonly details?: Record<string, unknown>;

  constructor(opts: AppErrorOptions) {
    super(opts.message, opts.cause !== undefined ? { cause: opts.cause } : undefined);
    this.name = 'AppError';
    this.type = opts.type;
    this.code = opts.code;
    this.httpStatus = opts.httpStatus;
    this.retriable = opts.retriable;
    if (opts.param !== undefined) this.param = opts.param;
    if (opts.details !== undefined) this.details = opts.details;
  }

  toResponse(requestId: string) {
    return {
      error: {
        type: this.type,
        code: this.code,
        message: this.message,
        retriable: this.retriable,
        ...(this.param ? { param: this.param } : {}),
        ...(this.details ? { details: this.details } : {}),
        request_id: requestId,
      },
    };
  }
}

/* -------------------------------------------------------------------------- */
/* Constructeurs                                                              */
/* -------------------------------------------------------------------------- */

export const errors = {
  unauthenticated: (message = "Cle API absente ou invalide.") =>
    new AppError({
      type: 'authentication_error',
      code: 'invalid_api_key',
      message,
      httpStatus: 401,
      retriable: false,
    }),

  forbidden: (scope: string) =>
    new AppError({
      type: 'permission_error',
      code: 'insufficient_scope',
      message: `Cette cle API n'a pas le scope requis : ${scope}.`,
      httpStatus: 403,
      retriable: false,
      details: { required_scope: scope },
    }),

  /**
   * Refus d'acces a l'administration de la plateforme.
   *
   * Distinct de `forbidden` : ce n'est pas un scope manquant sur une cle, c'est
   * une autorite que ce compte n'a pas. Reutiliser le message des scopes
   * parlerait de « cette cle API » a quelqu'un connecte dans son navigateur.
   */
  notAdmin: () =>
    new AppError({
      type: 'permission_error',
      code: 'admin_required',
      message: "Cette page est reservee aux administrateurs de la plateforme.",
      httpStatus: 403,
      retriable: false,
    }),

  merchantInactive: (status: string) =>
    new AppError({
      type: 'permission_error',
      code: 'merchant_inactive',
      message: `Le compte marchand est ${status.toLowerCase()}.`,
      httpStatus: 403,
      retriable: false,
    }),

  invalidRequest: (message: string, param?: string, details?: Record<string, unknown>) =>
    new AppError({
      type: 'invalid_request_error',
      code: 'invalid_request',
      message,
      httpStatus: 400,
      retriable: false,
      ...(param !== undefined ? { param } : {}),
      ...(details !== undefined ? { details } : {}),
    }),

  notFound: (resource: string, id?: string) =>
    new AppError({
      type: 'invalid_request_error',
      code: 'resource_not_found',
      message: id ? `${resource} introuvable : ${id}.` : `${resource} introuvable.`,
      httpStatus: 404,
      retriable: false,
    }),

  rateLimited: (retryAfterSeconds: number) =>
    new AppError({
      type: 'rate_limit_error',
      code: 'too_many_requests',
      message: 'Trop de requetes. Reessayez apres le delai indique.',
      httpStatus: 429,
      retriable: true,
      details: { retry_after: retryAfterSeconds },
    }),

  internal: (cause?: unknown) =>
    new AppError({
      type: 'api_error',
      code: 'internal_error',
      message: "Erreur interne de l'orchestrateur.",
      httpStatus: 500,
      // Retriable seulement avec la meme cle d'idempotence : la requete a pu
      // etre partiellement traitee.
      retriable: true,
      cause,
    }),
} as const;

export function isAppError(e: unknown): e is AppError {
  return e instanceof AppError;
}
