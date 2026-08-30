/**
 * Devises africaines utilisees par le catalogue.
 *
 * `exponent` = nombre de decimales ISO 4217. C'est la donnee la plus sensible du
 * fichier : tous les montants circulent en unites mineures dans l'orchestrateur.
 *   - XOF / XAF / GNF / KMF / RWF / BIF / DJF / UGX : exposant 0
 *     -> 15000 XOF = 15 000 francs, PAS 150,00
 *   - TND / LYD : exposant 3
 *     -> 15000 TND = 15,000 dinars
 * Une erreur ici est un facteur 100 ou 1000 sur un virement reel.
 */
export interface CurrencyDef {
  code: string;
  exponent: 0 | 2 | 3;
  name: string;
}

export const CURRENCIES: readonly CurrencyDef[] = [
  { code: 'XOF', exponent: 0, name: 'Franc CFA BCEAO' },
  { code: 'XAF', exponent: 0, name: 'Franc CFA BEAC' },
  { code: 'GNF', exponent: 0, name: 'Franc guinéen' },
  { code: 'KMF', exponent: 0, name: 'Franc comorien' },
  { code: 'RWF', exponent: 0, name: 'Franc rwandais' },
  { code: 'BIF', exponent: 0, name: 'Franc burundais' },
  { code: 'DJF', exponent: 0, name: 'Franc de Djibouti' },
  { code: 'UGX', exponent: 0, name: 'Shilling ougandais' },

  { code: 'TND', exponent: 3, name: 'Dinar tunisien' },
  { code: 'LYD', exponent: 3, name: 'Dinar libyen' },

  { code: 'GHS', exponent: 2, name: 'Cedi ghanéen' },
  { code: 'NGN', exponent: 2, name: 'Naira nigérian' },
  { code: 'GMD', exponent: 2, name: 'Dalasi gambien' },
  { code: 'SLE', exponent: 2, name: 'Leone sierra-léonais' },
  { code: 'LRD', exponent: 2, name: 'Dollar libérien' },
  { code: 'CVE', exponent: 2, name: 'Escudo cap-verdien' },
  { code: 'CDF', exponent: 2, name: 'Franc congolais' },
  { code: 'STN', exponent: 2, name: 'Dobra santoméen' },
  { code: 'KES', exponent: 2, name: 'Shilling kényan' },
  { code: 'TZS', exponent: 2, name: 'Shilling tanzanien' },
  { code: 'ETB', exponent: 2, name: 'Birr éthiopien' },
  { code: 'SOS', exponent: 2, name: 'Shilling somalien' },
  { code: 'SSP', exponent: 2, name: 'Livre sud-soudanaise' },
  { code: 'SDG', exponent: 2, name: 'Livre soudanaise' },
  { code: 'ERN', exponent: 2, name: 'Nakfa érythréen' },
  { code: 'EGP', exponent: 2, name: 'Livre égyptienne' },
  { code: 'MAD', exponent: 2, name: 'Dirham marocain' },
  { code: 'DZD', exponent: 2, name: 'Dinar algérien' },
  { code: 'MRU', exponent: 2, name: 'Ouguiya mauritanienne' },
  { code: 'ZAR', exponent: 2, name: 'Rand sud-africain' },
  { code: 'AOA', exponent: 2, name: 'Kwanza angolais' },
  { code: 'MZN', exponent: 2, name: 'Metical mozambicain' },
  { code: 'ZMW', exponent: 2, name: 'Kwacha zambien' },
  { code: 'ZWG', exponent: 2, name: 'Zimbabwe Gold' },
  { code: 'NAD', exponent: 2, name: 'Dollar namibien' },
  { code: 'BWP', exponent: 2, name: 'Pula botswanais' },
  { code: 'MWK', exponent: 2, name: 'Kwacha malawite' },
  { code: 'SZL', exponent: 2, name: 'Lilangeni swazi' },
  { code: 'LSL', exponent: 2, name: 'Loti lesothan' },
  { code: 'MGA', exponent: 2, name: 'Ariary malgache' },
  { code: 'MUR', exponent: 2, name: 'Roupie mauricienne' },
  { code: 'SCR', exponent: 2, name: 'Roupie seychelloise' },
  { code: 'SHP', exponent: 2, name: 'Livre de Sainte-Hélène' },
] as const;

const BY_CODE = new Map(CURRENCIES.map((c) => [c.code, c]));

export function getCurrency(code: string): CurrencyDef | undefined {
  return BY_CODE.get(code.toUpperCase());
}
