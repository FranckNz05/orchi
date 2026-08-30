import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';
import { env } from './env.js';

/* -------------------------------------------------------------------------- */
/* Cles API                                                                   */
/* -------------------------------------------------------------------------- */

const SECRET_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
const SECRET_LENGTH = 32;

export interface GeneratedApiKey {
  /** Valeur complete, montree une seule fois au marchand. */
  secret: string;
  /** Partie affichable et stockee en clair. */
  prefix: string;
  /** HMAC stocke en base. */
  hash: string;
}

/**
 * Le secret n'est jamais stocke. On conserve un HMAC-SHA256 avec un pepper
 * garde hors base : une fuite de la base seule ne permet pas de rejouer les
 * cles. HMAC et non bcrypt/argon2 volontairement : une cle API est un secret a
 * haute entropie (190 bits ici), pas un mot de passe, et l'authentification
 * doit rester a cout constant sur le chemin critique d'un paiement.
 */
export function hashApiKey(secret: string): string {
  return createHmac('sha256', Buffer.from(env.API_KEY_PEPPER, 'base64')).update(secret).digest('hex');
}

export function generateApiKey(environment: 'test' | 'live'): GeneratedApiKey {
  const bytes = randomBytes(SECRET_LENGTH);
  let body = '';
  for (let i = 0; i < SECRET_LENGTH; i += 1) {
    body += SECRET_ALPHABET[bytes[i]! % SECRET_ALPHABET.length];
  }
  const secret = `sk_${environment}_${body}`;
  return {
    secret,
    prefix: secret.slice(0, `sk_${environment}_`.length + 8),
    hash: hashApiKey(secret),
  };
}

/** Comparaison a temps constant de deux chaines hexadecimales de meme longueur. */
export function safeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));
}

/* -------------------------------------------------------------------------- */
/* Coffre de cles (credentials agregateurs des marchands)                     */
/* -------------------------------------------------------------------------- */

const VAULT_VERSION = 'v1';
const IV_LENGTH = 12; // GCM : 96 bits recommandes
const TAG_LENGTH = 16;

/**
 * Chiffre une chaine avec AES-256-GCM.
 * Format : v1.<iv base64url>.<tag base64url>.<ciphertext base64url>
 *
 * Le prefixe de version permet une rotation de cle ulterieure sans migration
 * destructrice : on ajoutera un v2 et on dechiffrera les deux.
 */
export function encryptSecret(plaintext: string): string {
  const key = Buffer.from(env.ENCRYPTION_KEY, 'base64');
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [
    VAULT_VERSION,
    iv.toString('base64url'),
    tag.toString('base64url'),
    ciphertext.toString('base64url'),
  ].join('.');
}

export function decryptSecret(payload: string): string {
  const parts = payload.split('.');
  if (parts.length !== 4 || parts[0] !== VAULT_VERSION) {
    throw new Error('Charge chiffree illisible ou version inconnue.');
  }
  const key = Buffer.from(env.ENCRYPTION_KEY, 'base64');
  const iv = Buffer.from(parts[1]!, 'base64url');
  const tag = Buffer.from(parts[2]!, 'base64url');
  const ciphertext = Buffer.from(parts[3]!, 'base64url');
  if (tag.length !== TAG_LENGTH) throw new Error('Tag d’authentification invalide.');

  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
}
