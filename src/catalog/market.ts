import { errors } from '../core/errors.js';
import { COUNTRIES, getCountry, type CountryDef } from './countries.js';

/**
 * Determination du pays et de la devise d'un encaissement.
 *
 * Le marchand n'a pas a connaitre la geographie des agregateurs : il envoie le
 * numero du client, et c'est l'indicatif qui designe le pays — +242 le Congo,
 * +225 la Cote d'Ivoire, +237 le Cameroun. Le routage part ensuite de ce pays
 * pour choisir l'agregateur. Un `country` explicite reste prioritaire : c'est
 * le marchand qui sait, par exemple, qu'une carte etrangere paie un evenement
 * local.
 */

/** Indicatifs tries du plus long au plus court : la correspondance la plus precise gagne. */
const BY_CALLING_CODE = [...COUNTRIES]
  .filter((c) => c.sovereign)
  .sort((a, b) => b.callingCode.length - a.callingCode.length);

/**
 * Pays designe par un numero au format international (+242…, 00242…).
 *
 * Un numero local (06 123 45 67) ne designe aucun pays : l'indicatif est la
 * seule information fiable, et deviner a partir d'un numero local enverrait le
 * client vers un operateur qui ne le connait pas.
 */
export function countryFromPhone(phone: string | undefined | null): CountryDef | undefined {
  if (!phone) return undefined;
  const compact = phone.trim().replace(/[\s.\-()]/g, '');

  let digits: string;
  if (compact.startsWith('+')) digits = compact.slice(1);
  else if (compact.startsWith('00')) digits = compact.slice(2);
  else return undefined;

  if (!/^\d{6,15}$/.test(digits)) return undefined;
  return BY_CALLING_CODE.find((c) => digits.startsWith(c.callingCode));
}

/**
 * XAF (CEMAC) et XOF (UEMOA) sont deux monnaies distinctes, mais arrimees a
 * l'euro au meme taux fixe (655,957) : 1 XAF vaut exactement 1 XOF. Un montant
 * en francs CFA reste donc juste d'une zone a l'autre, et seul le code change.
 *
 * C'est ce qui permet a un marchand qui affiche ses prix « en FCFA » de vendre
 * au Congo comme en Cote d'Ivoire sans convertir. Toute autre paire de devises
 * reste refusee : la convertir supposerait un taux, donc un risque de change.
 */
const FCFA: ReadonlySet<string> = new Set(['XAF', 'XOF']);

export interface Market {
  country: string;
  currency: string;
  /** Comment le pays a ete determine, conserve pour expliquer la decision. */
  countrySource: 'explicit' | 'phone';
}

export function resolveMarket(input: {
  country?: string | undefined;
  currency: string;
  phone?: string | undefined;
}): Market {
  let def: CountryDef | undefined;
  let countrySource: Market['countrySource'];

  if (input.country) {
    def = getCountry(input.country);
    if (!def) throw errors.invalidRequest(`Pays hors catalogue : ${input.country}.`, 'country');
    countrySource = 'explicit';
  } else {
    def = countryFromPhone(input.phone);
    if (!def) {
      throw errors.invalidRequest(
        'Pays introuvable : indiquez `country`, ou le numéro du client au format international (+242…, +225…).',
        'country',
      );
    }
    countrySource = 'phone';
  }

  const requested = input.currency.toUpperCase();
  if (requested === def.currency) return { country: def.iso2, currency: def.currency, countrySource };
  if (FCFA.has(requested) && FCFA.has(def.currency)) {
    return { country: def.iso2, currency: def.currency, countrySource };
  }

  // Erreur frequente et couteuse : envoyer XOF sur un pays en NGN passe les
  // validations naives et produit un montant faux chez l'agregateur.
  throw errors.invalidRequest(
    `La devise de ${def.name} est ${def.currency}, pas ${requested}.`,
    'currency',
    { expected: def.currency },
  );
}
