import { createHash, randomBytes, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { AppError, errors } from '../core/errors.js';
import { ID_PREFIX, newId } from '../core/ids.js';
import { prisma } from '../db/client.js';

const scrypt = promisify(scryptCb) as (
  password: string,
  salt: Buffer,
  keylen: number,
  options: { N: number; r: number; p: number },
) => Promise<Buffer>;

/**
 * Authentification des utilisateurs du tableau de bord.
 *
 * A distinguer nettement des cles API :
 *   - une CLE API identifie un SYSTEME (le backend du marchand). Elle est a
 *     haute entropie, comparee par HMAC a cout constant.
 *   - un MOT DE PASSE identifie une PERSONNE. Il est faible par nature, et doit
 *     donc etre derive avec une fonction volontairement lente.
 *
 * D'ou scrypt ici et HMAC la-bas. Utiliser HMAC pour un mot de passe rendrait
 * une fuite de base immediatement exploitable par force brute.
 */

/** Cout de derivation. ~100 ms sur une machine courante en 2026. */
const SCRYPT = { N: 16384, r: 8, p: 1 } as const;
const KEYLEN = 64;

const SESSION_TTL_MS = 7 * 24 * 3600 * 1000;
/** Au-dela, la session est prolongee a l'usage plutot que reecrite a chaque appel. */
const SESSION_SLIDE_MS = 12 * 3600 * 1000;

export const SESSION_COOKIE = 'orchi_session';

/* -------------------------------------------------------------------------- */
/* Mots de passe                                                              */
/* -------------------------------------------------------------------------- */

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const derived = await scrypt(password, salt, KEYLEN, SCRYPT);
  // Les parametres voyagent avec l'empreinte : on pourra relever le cout plus
  // tard sans invalider les comptes deja crees.
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString('base64')}$${derived.toString('base64')}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;

  const [, n, r, p, salt, expected] = parts;
  const derived = await scrypt(password, Buffer.from(salt!, 'base64'), KEYLEN, {
    N: Number(n),
    r: Number(r),
    p: Number(p),
  });
  const a = Buffer.from(expected!, 'base64');
  return a.length === derived.length && timingSafeEqual(a, derived);
}

/* -------------------------------------------------------------------------- */
/* Sessions                                                                   */
/* -------------------------------------------------------------------------- */

function hashToken(token: string): string {
  // Meme principe que les cles API : le jeton n'est pas stocke, seule son
  // empreinte l'est. Une fuite de la base ne permet pas d'usurper une session.
  return createHash('sha256').update(token).digest('hex');
}

export interface SessionContext {
  sessionId: string;
  userId: string;
  userName: string;
  userEmail: string;
  merchantId: string;
  merchantName: string;
  merchantCountry: string;
  environment: 'test' | 'live';
}

export async function createSession(
  userId: string,
  meta: { userAgent?: string; ip?: string } = {},
): Promise<{ token: string; expiresAt: Date }> {
  const token = randomBytes(32).toString('base64url');
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);

  await prisma.session.create({
    data: {
      id: newId(ID_PREFIX.webhookEvent),
      tokenHash: hashToken(token),
      userId,
      expiresAt,
      userAgent: meta.userAgent?.slice(0, 300) ?? null,
      ip: meta.ip ?? null,
    },
  });

  return { token, expiresAt };
}

export async function resolveSession(token: string | undefined): Promise<SessionContext | null> {
  if (!token) return null;

  const session = await prisma.session.findUnique({
    where: { tokenHash: hashToken(token) },
    include: { user: { include: { merchant: true } } },
  });

  if (!session || session.revokedAt) return null;
  if (session.expiresAt.getTime() < Date.now()) return null;
  if (session.user.status !== 'ACTIVE') return null;
  if (session.user.merchant.status !== 'ACTIVE') return null;

  // Prolongation glissante, mais pas a chaque requete : un tableau de bord
  // ouvert declenche des dizaines d'appels par minute.
  if (Date.now() - session.lastSeenAt.getTime() > SESSION_SLIDE_MS) {
    void prisma.session
      .update({
        where: { id: session.id },
        data: { lastSeenAt: new Date(), expiresAt: new Date(Date.now() + SESSION_TTL_MS) },
      })
      .catch(() => undefined);
  }

  return {
    sessionId: session.id,
    userId: session.userId,
    userName: session.user.name,
    userEmail: session.user.email,
    merchantId: session.user.merchantId,
    merchantName: session.user.merchant.name,
    merchantCountry: session.user.merchant.country,
    environment: session.environment === 'live' ? 'live' : 'test',
  };
}

export async function revokeSession(token: string | undefined): Promise<void> {
  if (!token) return;
  await prisma.session
    .updateMany({ where: { tokenHash: hashToken(token) }, data: { revokedAt: new Date() } })
    .catch(() => undefined);
}

export async function switchEnvironment(
  sessionId: string,
  environment: 'test' | 'live',
): Promise<void> {
  await prisma.session.update({ where: { id: sessionId }, data: { environment } });
}

export async function purgeExpiredSessions(now = new Date()): Promise<number> {
  const { count } = await prisma.session.deleteMany({ where: { expiresAt: { lt: now } } });
  return count;
}

/* -------------------------------------------------------------------------- */
/* Inscription et connexion                                                   */
/* -------------------------------------------------------------------------- */

export interface RegisterInput {
  email: string;
  password: string;
  name: string;
  companyName: string;
  country: string;
  legalType?: 'COMPANY' | 'INDIVIDUAL';
  registrationNumber?: string;
}

export const authErrors = {
  emailTaken: () =>
    new AppError({
      type: 'invalid_request_error',
      code: 'email_already_registered',
      message: 'Un compte existe déjà avec cette adresse.',
      httpStatus: 409,
      retriable: false,
      param: 'email',
    }),

  badCredentials: () =>
    new AppError({
      type: 'authentication_error',
      code: 'invalid_credentials',
      // Volontairement identique que l'email existe ou non : distinguer les
      // deux permettrait d'enumerer les comptes.
      message: 'Adresse ou mot de passe incorrect.',
      httpStatus: 401,
      retriable: false,
    }),

  weakPassword: (reason: string) =>
    new AppError({
      type: 'invalid_request_error',
      code: 'weak_password',
      message: reason,
      httpStatus: 400,
      retriable: false,
      param: 'password',
    }),
} as const;

/**
 * Exigences de mot de passe.
 *
 * Longueur d'abord, complexite ensuite : imposer un caractere special sur huit
 * caracteres produit `Passw0rd!`, que tout dictionnaire connait. Douze
 * caracteres sans contrainte de forme resistent mieux.
 */
export function checkPasswordStrength(password: string, email: string): void {
  if (password.length < 12) {
    throw authErrors.weakPassword('Le mot de passe doit faire au moins 12 caractères.');
  }
  if (password.length > 200) {
    throw authErrors.weakPassword('Le mot de passe ne peut pas dépasser 200 caractères.');
  }
  const local = email.split('@')[0]?.toLowerCase() ?? '';
  if (local.length >= 4 && password.toLowerCase().includes(local)) {
    throw authErrors.weakPassword('Le mot de passe ne doit pas contenir votre adresse e-mail.');
  }
  const trivial = ['motdepasse', 'password', '123456789', 'azertyuiop', 'qwertyuiop'];
  if (trivial.some((t) => password.toLowerCase().includes(t))) {
    throw authErrors.weakPassword('Ce mot de passe est trop courant.');
  }
}

export async function register(input: RegisterInput): Promise<SessionContext & { token: string }> {
  const email = input.email.trim().toLowerCase();
  checkPasswordStrength(input.password, email);

  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) throw authErrors.emailTaken();

  const passwordHash = await hashPassword(input.password);

  // L'inscription cree l'entreprise ET son premier utilisateur : un marchand
  // sans utilisateur serait inaccessible, un utilisateur sans marchand n'aurait
  // rien a administrer.
  const merchant = await prisma.merchant.create({
    data: {
      id: newId(ID_PREFIX.merchant),
      name: input.companyName.trim(),
      legalType: input.legalType ?? 'COMPANY',
      country: input.country.toUpperCase(),
      registrationNumber: input.registrationNumber?.trim() || null,
      contactEmail: email,
    },
  });

  const user = await prisma.user.create({
    data: {
      id: newId(ID_PREFIX.merchant).replace('mch_', 'usr_'),
      email,
      passwordHash,
      name: input.name.trim(),
      merchantId: merchant.id,
      role: 'OWNER',
    },
  });

  // Le simulateur est connecte d'office en environnement de test.
  //
  // Sans cela, un compte fraichement cree ne possede AUCUN compte agregateur
  // et ne peut donc rien encaisser : la promesse d'un essai immediat serait
  // fausse. L'operation est volontairement non bloquante — un echec ici ne doit
  // pas empecher l'inscription d'aboutir.
  try {
    const { connectProviderAccount } = await import('./provider-accounts.js');
    await connectProviderAccount({
      merchantId: merchant.id,
      providerId: 'sandbox',
      environment: 'test',
      credentials: { webhook_secret: `whsec_${randomBytes(24).toString('base64url')}` },
      priority: 1,
    });
  } catch {
    // Le simulateur peut etre desactive (PROVIDERS_ENABLED) : ce n'est pas une
    // raison de refuser une inscription.
  }

  const { token } = await createSession(user.id);
  const context = await resolveSession(token);
  return { ...context!, token };
}

export async function login(
  email: string,
  password: string,
  meta: { userAgent?: string; ip?: string } = {},
): Promise<{ token: string; context: SessionContext }> {
  const user = await prisma.user.findUnique({
    where: { email: email.trim().toLowerCase() },
    include: { merchant: true },
  });

  if (!user) {
    // Derivation a vide pour que la reponse prenne le meme temps qu'avec un
    // compte existant : sans cela, la duree de reponse revele quels emails sont
    // enregistres.
    await hashPassword(password);
    throw authErrors.badCredentials();
  }

  const valid = await verifyPassword(password, user.passwordHash);
  if (!valid) throw authErrors.badCredentials();
  if (user.status !== 'ACTIVE') throw errors.merchantInactive('DISABLED');

  const { token } = await createSession(user.id, meta);
  await prisma.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } });

  const context = await resolveSession(token);
  return { token, context: context! };
}
