import type { Channel } from '../catalog/coverage.js';

/**
 * Port unique que doit implementer chaque agregateur.
 *
 * Tout ce qui est specifique a FedaPay, CinetPay ou M-Pesa vit derriere cette
 * interface. Le moteur ne connait que ces types : c'est ce qui permet de
 * rerouter une transaction d'un agregateur a l'autre sans que le code metier
 * sache lequel.
 */

export type Direction = 'payin' | 'payout';

/* -------------------------------------------------------------------------- */
/* Statuts                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Statut normalise d'une tentative chez un agregateur.
 *
 * `unknown` n'est PAS un statut d'erreur : c'est l'aveu que nous ignorons si
 * l'argent a bouge. Il ne peut etre resolu que par une interrogation ulterieure
 * de l'agregateur, jamais par une nouvelle tentative. Confondre `unknown` et
 * `failed` sur un decaissement, c'est payer deux fois.
 */
export type AttemptStatus =
  | 'pending'
  | 'awaiting_customer'
  | 'succeeded'
  | 'failed'
  | 'expired'
  | 'unknown';

export const TERMINAL_STATUSES: readonly AttemptStatus[] = ['succeeded', 'failed', 'expired'];

export function isTerminal(status: AttemptStatus): boolean {
  return TERMINAL_STATUSES.includes(status);
}

/* -------------------------------------------------------------------------- */
/* Action client                                                              */
/* -------------------------------------------------------------------------- */

/**
 * Un encaissement mobile money n'est pas synchrone : l'agregateur repond
 * "j'ai envoye un push USSD", pas "c'est paye". L'API doit donc renvoyer au
 * marchand l'action a faire executer par son client, jamais un booleen.
 */
export type CustomerAction =
  | { type: 'none' }
  | { type: 'redirect'; url: string; expiresAt?: string }
  | { type: 'ussd_push'; instructions: string; expiresAt?: string }
  | { type: 'otp_required'; instructions: string; expiresAt?: string };

/* -------------------------------------------------------------------------- */
/* Requetes                                                                   */
/* -------------------------------------------------------------------------- */

export interface CustomerInfo {
  phone?: string;
  email?: string;
  name?: string;
}

export interface ChargeRequest {
  /** Reference de LA TENTATIVE (pas du paiement) transmise a l'agregateur. */
  reference: string;
  /** Montant en unites mineures. */
  amount: number;
  currency: string;
  /** ISO 3166-1 alpha-2. */
  country: string;
  channel: Channel;
  /** Reseau vise : MTN_BENIN, WAVE_SN, ORANGE_CM... */
  network?: string;
  customer: CustomerInfo;
  /** URL de notre endpoint de webhooks pour cet agregateur. */
  callbackUrl: string;
  /** Retour navigateur apres paiement par carte / page hebergee. */
  returnUrl?: string;
  description?: string;
  metadata?: Record<string, string>;
}

export interface PayoutRecipient {
  phone?: string;
  /** Reseau ou rail bancaire de destination. */
  network?: string;
  accountNumber?: string;
  bankCode?: string;
  name?: string;
}

export interface PayoutRequest {
  reference: string;
  amount: number;
  currency: string;
  country: string;
  channel: Channel;
  recipient: PayoutRecipient;
  callbackUrl: string;
  description?: string;
  metadata?: Record<string, string>;
}

/* -------------------------------------------------------------------------- */
/* Resultats                                                                  */
/* -------------------------------------------------------------------------- */

export interface AttemptResult {
  /** Identifiant chez l'agregateur. Cle de toute reconciliation ulterieure. */
  providerReference: string;
  status: AttemptStatus;
  action: CustomerAction;
  /** Frais preleves par l'agregateur, en unites mineures, si communiques. */
  providerFeeAmount?: number;
  /** Code et libelle bruts de l'agregateur, conserves tels quels. */
  providerCode?: string;
  providerMessage?: string;
  /** Charge brute, stockee pour audit et reconciliation. */
  raw: unknown;
}

/* -------------------------------------------------------------------------- */
/* Webhooks                                                                   */
/* -------------------------------------------------------------------------- */

export interface WebhookInput {
  /** Corps brut, non parse : la signature porte sur les octets recus. */
  rawBody: string;
  headers: Record<string, string | string[] | undefined>;
}

export type WebhookVerdict =
  | { valid: false; reason: string }
  | {
      valid: true;
      /** Identifiant d'evenement de l'agregateur, pour la deduplication. */
      eventId: string;
      kind: Direction | 'unknown';
      providerReference: string;
      status: AttemptStatus;
      providerCode?: string;
      providerMessage?: string;
      raw: unknown;
    };

/* -------------------------------------------------------------------------- */
/* Contexte d'appel                                                           */
/* -------------------------------------------------------------------------- */

/**
 * Credentials dechiffres du marchand, en clair uniquement le temps de l'appel.
 * En modele A (passerelle technique), ce sont les cles du marchand chez
 * l'agregateur, pas les notres.
 */
export interface ProviderContext {
  merchantId: string;
  environment: 'test' | 'live';
  credentials: Readonly<Record<string, string>>;
  /** Delai maximal de l'appel sortant, en millisecondes. */
  timeoutMs?: number;
}

/* -------------------------------------------------------------------------- */
/* Le port                                                                    */
/* -------------------------------------------------------------------------- */

export interface PaymentProvider {
  readonly id: string;
  readonly name: string;

  /** Champs de credentials attendus, verifies a la connexion du compte. */
  readonly requiredCredentials: readonly string[];

  supports(country: string, channel: Channel, direction: Direction): boolean;

  createCharge(request: ChargeRequest, ctx: ProviderContext): Promise<AttemptResult>;
  getCharge(providerReference: string, ctx: ProviderContext): Promise<AttemptResult>;

  createPayout(request: PayoutRequest, ctx: ProviderContext): Promise<AttemptResult>;
  getPayout(providerReference: string, ctx: ProviderContext): Promise<AttemptResult>;

  /**
   * Verification synchrone et sans effet de bord d'un webhook entrant.
   * Ne doit jamais lever : un webhook invalide se signale par `valid: false`.
   */
  verifyWebhook(input: WebhookInput, ctx: ProviderContext): WebhookVerdict;
}
