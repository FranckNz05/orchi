import { randomBytes } from 'node:crypto';

/**
 * Identifiants prefixes, lisibles dans les logs et le support :
 *   mch_0k3f2p1x8q7w   pay_...   po_...   atmp_...
 *
 * Composition : prefixe + timestamp base36 (tri chronologique naturel en base)
 * + 8 caracteres aleatoires. Pas de dependance externe, pas de collision
 * realiste (48 bits d'entropie par milliseconde).
 */
const ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyz';

export const ID_PREFIX = {
  merchant: 'mch',
  apiKey: 'ak',
  payment: 'pay',
  paymentAttempt: 'patt',
  payout: 'po',
  payoutAttempt: 'poatt',
  providerAccount: 'pacc',
  routingDecision: 'rtd',
  webhookEvent: 'evt',
  ledgerJournal: 'jrn',
} as const;

export type IdPrefix = (typeof ID_PREFIX)[keyof typeof ID_PREFIX];

function randomSuffix(length = 8): string {
  const bytes = randomBytes(length);
  let out = '';
  for (let i = 0; i < length; i += 1) {
    out += ALPHABET[bytes[i]! % ALPHABET.length];
  }
  return out;
}

export function newId(prefix: IdPrefix, now: number = Date.now()): string {
  return `${prefix}_${now.toString(36)}${randomSuffix()}`;
}
