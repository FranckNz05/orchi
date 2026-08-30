/**
 * Normalisation des echecs agregateur.
 *
 * C'est le fichier le plus important du dossier `providers/`. Chaque adaptateur
 * traduit ses erreurs propres vers cette taxonomie, et le moteur de routage ne
 * decide QUE d'apres elle.
 *
 * Deux proprietes portent toute la logique :
 *
 *   outcome  'failed'  -> l'agregateur affirme que rien n'a bouge.
 *            'unknown' -> nous ignorons si l'argent a bouge.
 *
 *   failoverAllowed  peut-on tenter un AUTRE agregateur pour cette intention ?
 *
 * Sur un decaissement, `outcome: 'unknown'` interdit toute nouvelle tentative,
 * chez le meme agregateur comme chez un autre, tant que la reconciliation n'a
 * pas tranche. C'est la seule protection contre le double paiement.
 */

export type ProviderErrorCode =
  /** Refus explicite : solde insuffisant, compte inexistant, plafond atteint. */
  | 'declined'
  /** Notre requete est mal formee ou incoherente. Ne jamais rejouer telle quelle. */
  | 'invalid_request'
  /** Credentials du marchand invalides ou revoques. Alerte, pas de failover utile. */
  | 'authentication'
  /** Quota agregateur atteint. Reessayer chez lui plus tard, ou basculer. */
  | 'rate_limited'
  /** Agregateur en panne ou canal ferme. Basculer. */
  | 'unavailable'
  /** Pas de reponse dans le delai imparti. Etat reel inconnu. */
  | 'timeout'
  /** Reponse recue mais illisible. Etat reel inconnu. */
  | 'malformed_response'
  /**
   * Erreur serveur sur une requete mutante (5xx sur un POST de creation) :
   * l'agregateur a pu traiter avant de tomber. Etat reel inconnu.
   */
  | 'indeterminate';

interface ProviderErrorInit {
  providerId: string;
  code: ProviderErrorCode;
  message: string;
  /** Code brut renvoye par l'agregateur, conserve pour le support. */
  providerCode?: string;
  /** Statut HTTP, quand il y en a un. */
  httpStatus?: number;
  cause?: unknown;
}

/** Codes pour lesquels l'agregateur garantit qu'aucun mouvement n'a eu lieu. */
const DEFINITELY_FAILED: readonly ProviderErrorCode[] = [
  'declined',
  'invalid_request',
  'authentication',
  'rate_limited',
  'unavailable',
];

/** Codes autorisant l'essai d'un autre agregateur pour la meme intention. */
const FAILOVER_ALLOWED: readonly ProviderErrorCode[] = ['unavailable', 'rate_limited', 'declined'];

export class ProviderError extends Error {
  readonly providerId: string;
  readonly code: ProviderErrorCode;
  readonly providerCode?: string;
  readonly httpStatus?: number;

  constructor(init: ProviderErrorInit) {
    super(init.message, init.cause !== undefined ? { cause: init.cause } : undefined);
    this.name = 'ProviderError';
    this.providerId = init.providerId;
    this.code = init.code;
    if (init.providerCode !== undefined) this.providerCode = init.providerCode;
    if (init.httpStatus !== undefined) this.httpStatus = init.httpStatus;
  }

  /**
   * 'failed'  : rien n'a bouge, on peut repartir proprement.
   * 'unknown' : etat reel indetermine, reconciliation obligatoire avant tout
   *             nouvel essai.
   */
  get outcome(): 'failed' | 'unknown' {
    return DEFINITELY_FAILED.includes(this.code) ? 'failed' : 'unknown';
  }

  /**
   * Un `declined` autorise le failover en encaissement (le client peut payer
   * autrement) mais le moteur de payout ajoute sa propre regle : un refus
   * explicite est rejouable ailleurs, un `unknown` ne l'est jamais.
   */
  get failoverAllowed(): boolean {
    return FAILOVER_ALLOWED.includes(this.code);
  }

  /** Reessayer le MEME agregateur a l'identique a-t-il un sens ? */
  get retriableSameProvider(): boolean {
    return this.code === 'rate_limited' || this.code === 'unavailable';
  }

  toLogContext() {
    return {
      provider: this.providerId,
      code: this.code,
      provider_code: this.providerCode,
      http_status: this.httpStatus,
      outcome: this.outcome,
      failover_allowed: this.failoverAllowed,
    };
  }
}

export function isProviderError(e: unknown): e is ProviderError {
  return e instanceof ProviderError;
}
