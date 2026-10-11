import { AppError, errors } from '../core/errors.js';
import { prisma } from '../db/client.js';
import { hashPassword, verifyPassword } from './auth.js';

/**
 * PIN de validation des retraits.
 *
 * RESERVE AUX ADMINISTRATEURS DE LA PLATEFORME. Un marchand n'en a pas et ne le
 * saisit jamais : il demande un retrait, c'est un administrateur d'Afripaie qui
 * l'approuve en tapant SON PIN. C'est le dernier garde-fou avant qu'un franc ne
 * parte, et il vaut depuis n'importe quel navigateur.
 *
 * Un PIN court (4 a 6 chiffres) se retrouve en quelques secondes si l'empreinte
 * fuit : il n'est donc jamais la seule barriere. Il faut d'abord une session
 * administrateur, puis le PIN ; et 5 essais ratés le verrouillent 15 minutes.
 */

export const PIN_PATTERN = /^\d{4,6}$/;
const MAX_FAILURES = 5;
const LOCK_MS = 15 * 60 * 1000;

const pinErrors = {
  notSet: () =>
    new AppError({
      type: 'permission_error',
      code: 'pin_not_set',
      message: 'Vous n’avez pas encore défini votre PIN de validation. Définissez-le dans « Mon PIN » avant d’approuver un retrait.',
      httpStatus: 422,
      retriable: false,
    }),
  wrong: (left: number) =>
    new AppError({
      type: 'permission_error',
      code: 'pin_invalid',
      message: left > 0 ? `PIN incorrect. Il vous reste ${left} essai${left > 1 ? 's' : ''}.` : 'PIN incorrect.',
      httpStatus: 403,
      retriable: false,
    }),
  locked: (until: Date) =>
    new AppError({
      type: 'permission_error',
      code: 'pin_locked',
      message: `PIN verrouillé après trop d’essais. Réessayez à ${until.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })}.`,
      httpStatus: 429,
      retriable: true,
    }),
} as const;

export async function pinStatus(userId: string): Promise<{ is_set: boolean; locked_until: string | null }> {
  const user = await prisma.user.findUnique({ where: { id: userId } });
  const locked = user?.pinLockedUntil && user.pinLockedUntil.getTime() > Date.now() ? user.pinLockedUntil : null;
  return { is_set: Boolean(user?.withdrawalPinHash), locked_until: locked?.toISOString() ?? null };
}

/**
 * Definit ou change le PIN. Exige le MOT DE PASSE du compte : une session
 * administrateur laissee ouverte ne doit pas suffire a fixer le PIN de quelqu'un
 * d'autre.
 */
export async function setAdminPin(input: { userId: string; password: string; pin: string }): Promise<void> {
  const user = await prisma.user.findUnique({ where: { id: input.userId } });
  if (!user || !user.platformAdmin) throw errors.forbidden('administrateur');

  // 400 et non 401 : la session est valide, seul le champ est faux.
  if (!(await verifyPassword(input.password, user.passwordHash))) {
    throw errors.invalidRequest('Mot de passe incorrect.', 'password');
  }
  if (!PIN_PATTERN.test(input.pin)) {
    throw errors.invalidRequest('Le PIN doit comporter 4 à 6 chiffres.', 'pin');
  }
  if (/^(\d)\1+$/.test(input.pin) || '0123456789'.includes(input.pin) || '9876543210'.includes(input.pin)) {
    throw errors.invalidRequest('PIN trop simple (chiffres identiques ou suite) : choisissez-en un autre.', 'pin');
  }

  await prisma.user.update({
    where: { id: user.id },
    data: { withdrawalPinHash: await hashPassword(input.pin), pinFailedCount: 0, pinLockedUntil: null },
  });
}

/**
 * Verifie le PIN d'un administrateur, ou leve. Compte les echecs et verrouille.
 *
 * Le compteur est incremente AVANT la comparaison de la reponse : deux requetes
 * simultanees ne peuvent pas tenter plus d'essais que la limite.
 */
export async function verifyAdminPin(userId: string, pin: string): Promise<void> {
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user || !user.platformAdmin) throw errors.forbidden('administrateur');
  if (!user.withdrawalPinHash) throw pinErrors.notSet();

  if (user.pinLockedUntil && user.pinLockedUntil.getTime() > Date.now()) {
    throw pinErrors.locked(user.pinLockedUntil);
  }

  const ok = PIN_PATTERN.test(pin) && (await verifyPassword(pin, user.withdrawalPinHash));
  if (ok) {
    if (user.pinFailedCount > 0 || user.pinLockedUntil) {
      await prisma.user.update({ where: { id: userId }, data: { pinFailedCount: 0, pinLockedUntil: null } });
    }
    return;
  }

  // Increment atomique : la valeur renvoyee est celle APRES notre ajout.
  const after = await prisma.user.update({
    where: { id: userId },
    data: { pinFailedCount: { increment: 1 } },
    select: { pinFailedCount: true },
  });
  if (after.pinFailedCount >= MAX_FAILURES) {
    const until = new Date(Date.now() + LOCK_MS);
    await prisma.user.update({ where: { id: userId }, data: { pinFailedCount: 0, pinLockedUntil: until } });
    throw pinErrors.locked(until);
  }
  throw pinErrors.wrong(MAX_FAILURES - after.pinFailedCount);
}
