import type { CountryDef } from './countries.js';

/**
 * Matrice de couverture : pour chaque pays, quels agregateurs desservent quels
 * canaux, dans quel sens, vers quels reseaux.
 *
 * L'ORDRE DES REGLES FAIT LA PRIORITE : la premiere entree d'un pays est
 * l'agregateur maitre, celui vers lequel le routage penche a sante et cout
 * egaux. C'est la seule information de ce fichier qui n'est pas descriptive
 * mais decisionnelle.
 *
 * `payout: false` ne veut pas dire "impossible" mais "pas via API standard" :
 * un accord direct avec l'operateur ou la banque est requis. Le detail est
 * dans `note`, et le pays porte le libelle complet dans `payoutNote`.
 *
 * Le provider `sandbox` n'apparait pas ici : il couvre tous les pays et tous
 * les canaux, mais uniquement en environnement de test. Cette regle est
 * appliquee dans le service (src/catalog/index.ts), pas dupliquee 55 fois.
 */
export type Channel = 'mobile_money' | 'card' | 'bank_transfer';

const MM: Channel[] = ['mobile_money'];
const CARD: Channel[] = ['card'];
const BANK: Channel[] = ['bank_transfer'];
const MM_CARD: Channel[] = ['mobile_money', 'card'];
const CARD_BANK: Channel[] = ['card', 'bank_transfer'];
const MM_CARD_BANK: Channel[] = ['mobile_money', 'card', 'bank_transfer'];

export interface CoverageSeed {
  provider: string;
  channels: Channel[];
  /** Encaissement possible. Defaut : true. */
  payin?: boolean;
  /** Decaissement possible via API. Defaut : true. */
  payout?: boolean;
  /** Reseaux mobile money / rails bancaires joignables. */
  networks?: string[];
  /** Surcharge de la fourchette pays quand un taux specifique est connu. */
  feeMinBps?: number;
  feeMaxBps?: number;
  note?: string;
}

export const COVERAGE: Readonly<Record<string, readonly CoverageSeed[]>> = {
  /* ---------------------------------------------------------------- OUEST -- */
  BJ: [
    { provider: 'fedapay', channels: MM_CARD, networks: ['MTN_BENIN', 'MOOV_BENIN'] },
    { provider: 'cinetpay', channels: MM_CARD, networks: ['MTN_BENIN', 'MOOV_BENIN'] },
    { provider: 'geniuspay', channels: MM, networks: ['MTN_BENIN', 'MOOV_BENIN'], payout: false },
    { provider: 'bizao', channels: MM, networks: ['MTN_BENIN', 'MOOV_BENIN'] },
  ],
  TG: [
    { provider: 'fedapay', channels: MM_CARD, networks: ['TMONEY', 'MOOV_TOGO'] },
    { provider: 'cinetpay', channels: MM_CARD, networks: ['TMONEY', 'MOOV_TOGO'] },
    { provider: 'paygate_togo', channels: MM, networks: ['TMONEY', 'MOOV_TOGO'] },
    { provider: 'semoa', channels: MM, networks: ['TMONEY', 'MOOV_TOGO'] },
    { provider: 'geniuspay', channels: MM_CARD, networks: ['MOOV_TOGO'], payout: false },
  ],
  CI: [
    { provider: 'cinetpay', channels: MM_CARD, networks: ['ORANGE_CI', 'MTN_CI', 'MOOV_CI', 'WAVE_CI'] },
    { provider: 'wave', channels: MM, networks: ['WAVE_CI'], feeMinBps: 100, feeMaxBps: 100 },
    { provider: 'bizao', channels: MM, networks: ['ORANGE_CI', 'MTN_CI', 'MOOV_CI'] },
    { provider: 'geniuspay', channels: MM, networks: ['ORANGE_CI', 'MTN_CI'], payout: false },
    { provider: 'orange_money', channels: MM, networks: ['ORANGE_CI'] },
  ],
  SN: [
    { provider: 'paytech', channels: MM_CARD, networks: ['ORANGE_SN', 'FREE_SN', 'WAVE_SN'] },
    { provider: 'wave', channels: MM, networks: ['WAVE_SN'], feeMinBps: 100, feeMaxBps: 100 },
    { provider: 'cinetpay', channels: MM_CARD, networks: ['ORANGE_SN', 'FREE_SN', 'WAVE_SN'] },
    { provider: 'bizao', channels: MM, networks: ['ORANGE_SN', 'FREE_SN'] },
    { provider: 'touchpay', channels: MM, networks: ['ORANGE_SN'] },
    { provider: 'geniuspay', channels: MM_CARD, networks: ['ORANGE_SN', 'FREE_SN', 'WAVE_SN'], payout: false },
  ],
  ML: [
    { provider: 'cinetpay', channels: MM_CARD, networks: ['ORANGE_ML', 'MALITEL'] },
    { provider: 'bizao', channels: MM, networks: ['ORANGE_ML', 'MALITEL'] },
    { provider: 'geniuspay', channels: MM, networks: ['ORANGE_ML'], payout: false },
  ],
  BF: [
    { provider: 'cinetpay', channels: MM_CARD, networks: ['ORANGE_BF', 'MOOV_BF'] },
    { provider: 'ligdicash', channels: MM, networks: ['ORANGE_BF', 'MOOV_BF'] },
    { provider: 'bizao', channels: MM, networks: ['ORANGE_BF', 'MOOV_BF'] },
    { provider: 'geniuspay', channels: MM_CARD, networks: ['ORANGE_BF', 'MOOV_BF'], payout: false },
  ],
  NE: [
    { provider: 'cinetpay', channels: MM_CARD, networks: ['ZAMANI', 'AIRTEL_NE'] },
    { provider: 'geniuspay', channels: MM, networks: ['ZAMANI', 'AIRTEL_NE'], payout: false },
    { provider: 'nita', channels: MM, networks: ['ZAMANI'] },
  ],
  GW: [
    { provider: 'cinetpay', channels: MM, networks: ['ORANGE_GW'] },
    { provider: 'orange_money', channels: MM, networks: ['ORANGE_GW'] },
    { provider: 'geniuspay', channels: MM, networks: ['ORANGE_GW'], payout: false },
  ],
  GN: [
    { provider: 'bizao', channels: MM, networks: ['ORANGE_GN', 'MTN_GN'] },
    { provider: 'paycard', channels: MM_CARD, networks: ['ORANGE_GN'] },
    { provider: 'cinetpay', channels: MM, networks: ['ORANGE_GN', 'MTN_GN'] },
  ],
  GH: [
    { provider: 'paystack', channels: MM_CARD, networks: ['MTN_GH', 'TELECEL_GH', 'AIRTELTIGO_GH'], feeMinBps: 195, feeMaxBps: 195 },
    { provider: 'flutterwave', channels: MM_CARD, networks: ['MTN_GH', 'TELECEL_GH', 'AIRTELTIGO_GH'] },
    { provider: 'hubtel', channels: MM, networks: ['MTN_GH', 'TELECEL_GH'] },
    { provider: 'geniuspay', channels: MM_CARD, networks: ['MTN_GH', 'AIRTELTIGO_GH'], payout: false },
  ],
  NG: [
    { provider: 'paystack', channels: CARD_BANK, networks: ['NIBSS'], note: 'Commission plafonnée à 2 000 NGN.' },
    { provider: 'flutterwave', channels: MM_CARD_BANK, networks: ['NIBSS', 'OPAY', 'PALMPAY'] },
    { provider: 'monnify', channels: BANK, networks: ['NIBSS'] },
    { provider: 'interswitch', channels: CARD, networks: ['NIBSS'] },
    { provider: 'geniuspay', channels: CARD_BANK, networks: ['NIBSS'], payout: false },
  ],
  GM: [
    { provider: 'flutterwave', channels: MM_CARD, networks: ['AFRIMONEY', 'QMONEY'] },
    { provider: 'aps_international', channels: MM, networks: ['AFRIMONEY'] },
  ],
  SL: [
    { provider: 'flutterwave', channels: MM_CARD, networks: ['ORANGE_SL', 'AFRICELL_SL'] },
    { provider: 'moneta', channels: MM, networks: ['ORANGE_SL'] },
    { provider: 'geniuspay', channels: MM, networks: ['ORANGE_SL'], payout: false },
  ],
  LR: [
    { provider: 'flutterwave', channels: MM_CARD, networks: ['LONESTAR_MTN', 'ORANGE_LR'] },
    { provider: 'tipme', channels: MM, networks: ['LONESTAR_MTN'] },
  ],
  CV: [
    { provider: 'sisp', channels: CARD_BANK, networks: ['VINTI4'] },
    { provider: 'flutterwave', channels: CARD, payout: false, note: 'Encaissement carte uniquement.' },
  ],

  /* ------------------------------------------------------------- CENTRALE -- */
  CM: [
    { provider: 'geniuspay', channels: MM_CARD, networks: ['MTN_CM', 'ORANGE_CM'], payout: false },
    { provider: 'mycoolpay', channels: MM, networks: ['MTN_CM', 'ORANGE_CM'] },
    { provider: 'cinetpay', channels: MM_CARD, networks: ['MTN_CM', 'ORANGE_CM'] },
    { provider: 'touchpay', channels: MM, networks: ['MTN_CM', 'ORANGE_CM'] },
  ],
  GA: [
    { provider: 'geniuspay', channels: MM, networks: ['AIRTEL_GA', 'MOOV_GA'], payout: false },
    { provider: 'cinetpay', channels: MM_CARD, networks: ['AIRTEL_GA', 'MOOV_GA'] },
    { provider: 'singpay', channels: MM, networks: ['AIRTEL_GA', 'MOOV_GA'] },
  ],
  CG: [
    { provider: 'geniuspay', channels: MM, networks: ['MTN_CG', 'AIRTEL_CG'], payout: false },
    { provider: 'bizao', channels: MM, networks: ['MTN_CG', 'AIRTEL_CG'] },
    { provider: 'airtel_money', channels: MM, networks: ['AIRTEL_CG'] },
    { provider: 'mtn_momo', channels: MM, networks: ['MTN_CG'] },
  ],
  CD: [
    { provider: 'maxicash', channels: MM_CARD, networks: ['MPESA_CD', 'ORANGE_CD', 'AIRTEL_CD', 'AFRICELL_CD'] },
    { provider: 'flutterwave', channels: MM_CARD, networks: ['MPESA_CD', 'ORANGE_CD', 'AIRTEL_CD'] },
    { provider: 'flashkm', channels: MM, networks: ['MPESA_CD', 'ORANGE_CD'] },
    { provider: 'ilicocash', channels: MM, networks: ['ORANGE_CD', 'AIRTEL_CD'] },
    { provider: 'geniuspay', channels: MM_CARD, networks: ['AIRTEL_CD', 'ORANGE_CD', 'MPESA_CD'], payout: false },
  ],
  TD: [
    // Present dans le document de cadrage mais ABSENT de la documentation
    // publique de GeniusPay : l'adaptateur refuse ce pays. La regle reste ici
    // pour ne pas perdre l'information commerciale, et `connected` le dira.
    { provider: 'geniuspay', channels: MM, networks: ['AIRTEL_TD', 'MOOV_TD'], payout: false },
    { provider: 'touchpay', channels: MM, networks: ['AIRTEL_TD', 'MOOV_TD'] },
    { provider: 'airtel_money', channels: MM, networks: ['AIRTEL_TD'] },
  ],
  CF: [
    { provider: 'orange_money', channels: MM, payout: false, networks: ['ORANGE_CF'], note: "Accord direct opérateur requis pour le décaissement." },
    { provider: 'moov_money', channels: MM, payout: false, networks: ['TELECEL_CF'], note: 'Accord direct opérateur requis.' },
    { provider: 'geniuspay', channels: MM, networks: ['ORANGE_CF'], payout: false },
  ],
  GQ: [
    // Voir TD : issu du cadrage, hors documentation publique GeniusPay.
    { provider: 'geniuspay', channels: CARD, payout: false, note: 'Encaissement carte ; décaissement par virement bancaire hors API.' },
    { provider: 'bange', channels: CARD_BANK, payout: false, note: 'Accord bancaire BANGE requis.' },
  ],
  ST: [
    { provider: 'cst_movel', channels: MM, payout: false, networks: ['CST_MOVEL'], note: 'Accord opérateur requis.' },
    { provider: 'flutterwave', channels: CARD, payout: false, note: 'Retrait par SWIFT uniquement.' },
  ],

  /* ------------------------------------------------------------------ EST -- */
  KE: [
    { provider: 'mpesa_daraja', channels: MM, networks: ['MPESA_KE'], feeMinBps: 120, feeMaxBps: 150 },
    { provider: 'flutterwave', channels: MM_CARD, networks: ['MPESA_KE', 'AIRTEL_KE'] },
    { provider: 'dpo', channels: MM_CARD, networks: ['MPESA_KE', 'AIRTEL_KE'] },
    { provider: 'geniuspay', channels: MM_CARD, networks: ['MPESA_KE', 'AIRTEL_KE'], payout: false },
  ],
  UG: [
    { provider: 'flutterwave', channels: MM_CARD, networks: ['MTN_UG', 'AIRTEL_UG'] },
    { provider: 'yo_payments', channels: MM, networks: ['MTN_UG', 'AIRTEL_UG'] },
    { provider: 'pegasus', channels: MM, networks: ['MTN_UG', 'AIRTEL_UG'] },
    { provider: 'geniuspay', channels: MM, networks: ['MTN_UG', 'AIRTEL_UG'], payout: false },
  ],
  TZ: [
    { provider: 'selcom', channels: MM_CARD, networks: ['MPESA_TZ', 'TIGOPESA', 'AIRTEL_TZ'] },
    { provider: 'dpo', channels: MM_CARD, networks: ['MPESA_TZ', 'TIGOPESA'] },
    { provider: 'flutterwave', channels: MM_CARD, networks: ['MPESA_TZ', 'AIRTEL_TZ'] },
  ],
  RW: [
    { provider: 'flutterwave', channels: MM_CARD, networks: ['MTN_RW', 'AIRTEL_RW'] },
    { provider: 'paypack', channels: MM, networks: ['MTN_RW', 'AIRTEL_RW'] },
    { provider: 'dpo', channels: MM_CARD, networks: ['MTN_RW'] },
    { provider: 'geniuspay', channels: MM, networks: ['MTN_RW', 'AIRTEL_RW'], payout: false },
  ],
  ET: [
    { provider: 'telebirr', channels: MM, networks: ['TELEBIRR'] },
    { provider: 'chapa', channels: MM_CARD_BANK, networks: ['TELEBIRR', 'CBE_BIRR'] },
    { provider: 'cbe_birr', channels: MM, payout: false, networks: ['CBE_BIRR'], note: 'Accord bancaire CBE requis.' },
  ],
  BI: [
    { provider: 'lumicash', channels: MM, networks: ['LUMICASH'] },
    { provider: 'ecocash', channels: MM, networks: ['ECOCASH_BI'] },
    { provider: 'iclick', channels: MM, networks: ['LUMICASH', 'ECOCASH_BI'] },
  ],
  DJ: [{ provider: 'waafi', channels: MM, networks: ['WAAFI_DJ'] }],
  SO: [{ provider: 'waafi', channels: MM, networks: ['ZAAD', 'EVC_PLUS', 'SAHAL'], feeMinBps: 100, feeMaxBps: 200 }],
  SS: [
    { provider: 'mgurush', channels: MM, networks: ['MGURUSH'] },
    { provider: 'zain_cash', channels: MM, networks: ['ZAIN_CASH_SS'] },
  ],
  SD: [
    { provider: 'syberpay', channels: CARD_BANK, payout: false, note: 'Systèmes bancaires locaux uniquement.' },
    { provider: 'solus', channels: BANK, payout: false, note: 'Systèmes bancaires locaux uniquement.' },
  ],
  ER: [
    { provider: 'eritel', channels: MM, payin: false, payout: false, note: 'Paiements numériques très restreints ; autorisation d’État requise.' },
  ],

  /* ----------------------------------------------------------------- NORD -- */
  EG: [
    { provider: 'paymob', channels: MM_CARD_BANK, networks: ['VODAFONE_CASH', 'INSTAPAY', 'ORANGE_EG'] },
    { provider: 'fawry', channels: CARD_BANK, networks: ['FAWRY_NETWORK'] },
    { provider: 'paytabs', channels: CARD, payout: false },
    { provider: 'kashier', channels: CARD, payout: false },
  ],
  MA: [
    { provider: 'cmi', channels: CARD, payout: false, note: 'Acquéreur national ; décaissement par virement bancaire hors API.' },
    { provider: 'payzone', channels: CARD_BANK, networks: ['INTERBANK_MA'] },
    { provider: 'amanpay', channels: CARD_BANK, networks: ['INTERBANK_MA'] },
  ],
  DZ: [
    { provider: 'satim', channels: CARD, payout: false, networks: ['CIB', 'EDAHABIA'], note: 'Décaissement uniquement vers comptes bancaires algériens, hors API.' },
  ],
  TN: [
    { provider: 'clicktopay', channels: CARD, networks: ['E_DINAR'] },
    { provider: 'sobflous', channels: MM_CARD, networks: ['E_DINAR'] },
  ],
  LY: [
    { provider: 'sadad', channels: MM, payout: false, networks: ['SADAD'], note: 'Portefeuilles électroniques locaux.' },
    { provider: 'moamalat', channels: CARD, payout: false, note: 'Accord direct requis.' },
  ],
  MR: [
    { provider: 'bankily', channels: MM, networks: ['BANKILY'] },
    { provider: 'masrifi', channels: MM, networks: ['MASRIFI'] },
  ],

  /* ------------------------------------------------------------- AUSTRALE -- */
  ZA: [
    { provider: 'stitch', channels: BANK, networks: ['EFT_ZA'] },
    { provider: 'ozow', channels: BANK, networks: ['EFT_ZA'] },
    { provider: 'peach', channels: CARD_BANK, networks: ['EFT_ZA'] },
    { provider: 'payfast', channels: CARD_BANK, networks: ['EFT_ZA'] },
    { provider: 'yoco', channels: CARD, payout: false },
    { provider: 'geniuspay', channels: CARD_BANK, networks: ['EFT_ZA'], payout: false },
  ],
  AO: [
    { provider: 'emis_multicaixa', channels: CARD_BANK, networks: ['MULTICAIXA'] },
    { provider: 'proxypay', channels: BANK, networks: ['MULTICAIXA'] },
  ],
  MZ: [
    { provider: 'mpesa_mz', channels: MM, networks: ['MPESA_MZ'] },
    { provider: 'emola', channels: MM, networks: ['EMOLA'] },
  ],
  ZM: [
    { provider: 'kazang', channels: MM, networks: ['MTN_ZM', 'AIRTEL_ZM', 'ZAMTEL'] },
    { provider: 'flutterwave', channels: MM_CARD, networks: ['MTN_ZM', 'AIRTEL_ZM'] },
    { provider: 'geniuspay', channels: MM, networks: ['MTN_ZM', 'ZAMTEL'], payout: false },
  ],
  ZW: [
    { provider: 'ecocash', channels: MM, networks: ['ECOCASH_ZW'] },
    { provider: 'paynow_zw', channels: MM_CARD, networks: ['ECOCASH_ZW'] },
  ],
  NA: [
    { provider: 'paytoday', channels: MM, networks: ['PAYTODAY'] },
    { provider: 'dpo', channels: CARD_BANK, networks: ['FNB_NA', 'BANK_WINDHOEK'] },
  ],
  BW: [
    { provider: 'dpo', channels: CARD, networks: ['EFT_BW'] },
    { provider: 'orange_money', channels: MM, networks: ['ORANGE_BW'] },
    { provider: 'virtual_pay', channels: CARD, payout: false },
  ],
  MW: [
    { provider: 'airtel_money', channels: MM, networks: ['AIRTEL_MW', 'TNM_MPAMBA'] },
    { provider: 'fdh_bank', channels: BANK, payout: false, note: 'Accord bancaire FDH requis.' },
  ],
  SZ: [
    { provider: 'mtn_momo', channels: MM, networks: ['MTN_SZ'] },
    { provider: 'dpo', channels: CARD, payout: false },
  ],
  LS: [
    { provider: 'ecocash', channels: MM, networks: ['ECOCASH_LS'] },
    { provider: 'mtn_momo', channels: MM, payout: false, networks: ['MPESA_LS'], note: 'Vodacom M-Pesa Lesotho : accord direct opérateur requis.' },
  ],

  /* ------------------------------------------------------------------ ILES -- */
  MG: [
    { provider: 'mvola', channels: MM, networks: ['MVOLA'] },
    { provider: 'orange_money', channels: MM, networks: ['ORANGE_MG'] },
    { provider: 'airtel_money', channels: MM, networks: ['AIRTEL_MG'] },
  ],
  MU: [
    { provider: 'blink', channels: MM_CARD, networks: ['MAUCAS'] },
    { provider: 'peach', channels: CARD, payout: false },
    { provider: 'mcb_juice', channels: BANK, networks: ['MAUCAS'], note: 'Accord bancaire MCB requis.' },
  ],
  SC: [
    { provider: 'airtel_money', channels: MM, networks: ['AIRTEL_SC'] },
    { provider: 'merchantpay', channels: CARD_BANK, networks: ['SWIFT_SC'] },
  ],
  KM: [
    { provider: 'huri_money', channels: MM, networks: ['HURI_MONEY'] },
    { provider: 'holo_safe', channels: MM, networks: ['HURI_MONEY'] },
  ],

  SH: [
    { provider: 'bank_st_helena', channels: BANK, payout: false, note: 'Transferts bancaires manuels / ISO.' },
  ],
};

/** Verifie qu'aucun pays du catalogue n'est laisse sans regle de couverture. */
export function countriesWithoutCoverage(countries: readonly CountryDef[]): string[] {
  return countries.filter((c) => (COVERAGE[c.iso2] ?? []).length === 0).map((c) => c.iso2);
}
