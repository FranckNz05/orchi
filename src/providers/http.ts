import { ProviderError, type ProviderErrorCode } from './errors.js';

/**
 * Client HTTP commun aux adaptateurs.
 *
 * Son role n'est pas de simplifier `fetch` mais d'IMPOSER la traduction des
 * echecs reseau vers la taxonomie de `errors.ts`. Un adaptateur qui appellerait
 * `fetch` directement pourrait laisser remonter un timeout brut, que le moteur
 * interpreterait comme un echec — et rejouerait.
 */

const DEFAULT_TIMEOUT_MS = 15_000;

export interface ProviderHttpRequest {
  providerId: string;
  method: 'GET' | 'POST' | 'PUT' | 'PATCH';
  url: string;
  headers?: Record<string, string>;
  /** Corps deja serialise. */
  body?: string;
  timeoutMs?: number;
  /**
   * La requete cree-t-elle ou modifie-t-elle quelque chose chez l'agregateur ?
   *
   * Determine la lecture des 5xx : sur une lecture, un 500 signifie "reessayez
   * plus tard" ; sur une creation de paiement, il signifie "je ne sais pas si
   * j'ai traite". Se tromper ici, c'est autoriser un double decaissement.
   */
  mutating: boolean;
}

export interface ProviderHttpResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
}

/** Erreurs reseau survenues AVANT que la requete parte : rien n'a pu etre traite. */
const PRE_FLIGHT_ERRORS = new Set(['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'ERR_INVALID_URL']);

/**
 * `fetch` enveloppe la cause reelle, et quand un hote resout vers plusieurs
 * adresses il remonte une AggregateError dont seuls les membres portent le
 * code. Sans ce parcours, un simple "connexion refusee" serait classe en
 * timeout, donc en etat inconnu — et bloquerait inutilement un decaissement
 * qui n'est jamais parti.
 */
function walkErrors(error: unknown, depth = 0): Array<{ code?: string; message: string }> {
  if (!error || typeof error !== 'object' || depth > 3) return [];
  const e = error as { code?: unknown; message?: unknown; cause?: unknown; errors?: unknown };
  const found: Array<{ code?: string; message: string }> = [
    {
      ...(typeof e.code === 'string' ? { code: e.code } : {}),
      message: typeof e.message === 'string' ? e.message : '',
    },
  ];
  if (Array.isArray(e.errors)) {
    for (const inner of e.errors) found.push(...walkErrors(inner, depth + 1));
  }
  if (e.cause) found.push(...walkErrors(e.cause, depth + 1));
  return found;
}

/**
 * URL invalide, protocole non supporte, port interdit par la specification
 * fetch : la requete n'a jamais ete construite. C'est une erreur de
 * configuration de notre cote, pas une incertitude sur l'etat du paiement.
 */
const CONFIG_ERROR = /bad port|invalid url|unsupported protocol|protocol.*not supported/i;

function statusToCode(status: number, mutating: boolean): ProviderErrorCode {
  if (status === 429) return 'rate_limited';
  if (status === 401 || status === 403) return 'authentication';
  if (status === 400 || status === 404 || status === 422) return 'invalid_request';
  if (status === 503 || status === 504) return 'unavailable';
  // 500, 502 et autres : la requete a atteint l'agregateur. Sur une creation,
  // impossible d'affirmer qu'il n'a rien fait.
  return mutating ? 'indeterminate' : 'unavailable';
}

export async function providerFetch(req: ProviderHttpRequest): Promise<ProviderHttpResponse> {
  const controller = new AbortController();
  const timeoutMs = req.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let response: Response;
  try {
    response = await fetch(req.url, {
      method: req.method,
      headers: { 'content-type': 'application/json', accept: 'application/json', ...req.headers },
      ...(req.body !== undefined ? { body: req.body } : {}),
      signal: controller.signal,
    });
  } catch (e) {
    const chain = walkErrors(e);

    if (chain.some((entry) => CONFIG_ERROR.test(entry.message))) {
      throw new ProviderError({
        providerId: req.providerId,
        code: 'invalid_request',
        message: `URL d'appel invalide pour ${req.providerId} : ${req.url}`,
        cause: e,
      });
    }

    const preFlight = chain.map((entry) => entry.code).find((c) => c && PRE_FLIGHT_ERRORS.has(c));

    if (preFlight) {
      throw new ProviderError({
        providerId: req.providerId,
        code: 'unavailable',
        message: `Agregateur injoignable (${preFlight}).`,
        cause: e,
      });
    }

    // Abandon sur delai, coupure en cours de route : etat indetermine.
    throw new ProviderError({
      providerId: req.providerId,
      code: 'timeout',
      message:
        (e as Error)?.name === 'AbortError'
          ? `Aucune reponse en ${timeoutMs} ms.`
          : 'Connexion interrompue avant reponse complete.',
      cause: e,
    });
  } finally {
    clearTimeout(timer);
  }

  const body = await response.text().catch(() => '');

  if (!response.ok) {
    throw new ProviderError({
      providerId: req.providerId,
      code: statusToCode(response.status, req.mutating),
      message: `HTTP ${response.status} depuis ${req.providerId}.`,
      httpStatus: response.status,
      cause: body.slice(0, 500),
    });
  }

  return {
    status: response.status,
    headers: Object.fromEntries(response.headers.entries()),
    body,
  };
}

/** Parse une reponse JSON en signalant une charge illisible comme etat inconnu. */
export function parseJson<T>(providerId: string, body: string): T {
  try {
    return JSON.parse(body) as T;
  } catch (e) {
    throw new ProviderError({
      providerId,
      code: 'malformed_response',
      message: 'Reponse non JSON.',
      cause: e,
    });
  }
}
