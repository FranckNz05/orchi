import { getCurrency } from '../catalog/currencies.js';
import { errors } from './errors.js';

/**
 * Tous les montants circulent dans l'orchestrateur en UNITES MINEURES, en
 * entiers. Aucun flottant ne touche un montant : 0.1 + 0.2 !== 0.3 est une
 * curiosite en general, une perte seche sur un decaissement.
 *
 * L'unite mineure depend de la devise :
 *   15000 XOF -> 15 000 F CFA        (exposant 0)
 *   15000 KES -> 150,00 shillings    (exposant 2)
 *   15000 TND -> 15,000 dinars       (exposant 3)
 *
 * Le champ `currency` accompagne donc TOUJOURS un montant. Un entier seul n'a
 * pas de sens.
 */
export interface Money {
  /** Montant en unites mineures. Entier, toujours positif pour un paiement. */
  amount: number;
  /** Code ISO 4217. */
  currency: string;
}

export function exponentOf(currency: string): number {
  const def = getCurrency(currency);
  if (!def) throw errors.invalidRequest(`Devise inconnue ou non couverte : ${currency}.`, 'currency');
  return def.exponent;
}

/**
 * Valide un montant recu du marchand. Refuse explicitement les decimales : si
 * un integrateur envoie 1500.5 XOF, c'est une erreur de sa part sur l'unite,
 * pas une valeur a arrondir silencieusement.
 */
export function assertValidAmount(amount: number, currency: string): Money {
  if (!Number.isFinite(amount) || !Number.isInteger(amount)) {
    throw errors.invalidRequest(
      `Le montant doit etre un entier en unites mineures (${currency}, ${exponentOf(currency)} decimale(s)).`,
      'amount',
    );
  }
  if (amount <= 0) throw errors.invalidRequest('Le montant doit etre strictement positif.', 'amount');
  if (amount > Number.MAX_SAFE_INTEGER) throw errors.invalidRequest('Montant hors limites.', 'amount');
  return { amount, currency: currency.toUpperCase() };
}

/**
 * Applique un taux en points de base (250 bps = 2,50 %).
 * Arrondi au demi-superieur : la commission n'est jamais sous-facturee, et le
 * resultat est deterministe (pas de Math.round sur .5 negatif).
 */
export function applyBps(amountMinor: number, bps: number): number {
  if (!Number.isInteger(amountMinor) || amountMinor < 0) {
    throw new Error('applyBps attend un montant entier positif en unites mineures.');
  }
  return Math.floor((amountMinor * bps + 5000) / 10000);
}

/** Rend un montant lisible : 15000 XOF -> "15 000 XOF", 15000 KES -> "150,00 KES". */
export function formatMoney(amountMinor: number, currency: string): string {
  const exponent = exponentOf(currency);
  const sign = amountMinor < 0 ? '-' : '';
  const abs = Math.abs(amountMinor).toString().padStart(exponent + 1, '0');
  const whole = abs.slice(0, abs.length - exponent) || '0';
  // Separateur ecrit en echappement : une espace fine insecable copiee par
  // inadvertance dans un litteral est invisible en relecture et casse toute
  // comparaison de chaine cote integrateur.
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
  const fraction = exponent > 0 ? `,${abs.slice(abs.length - exponent)}` : '';
  return `${sign}${grouped}${fraction} ${currency.toUpperCase()}`;
}
