/**
 * Les 54 Etats africains, plus Sainte-Helene signalee comme territoire non
 * souverain (elle figure dans le document source mais n'est pas un Etat : le
 * compte de 54 reste exact grace au drapeau `sovereign`).
 *
 * Les fourchettes de commission sont INDICATIVES, reprises du document de
 * cadrage. Elles servent au scoring de routage et a l'affichage commercial ;
 * elles doivent etre remplacees par les taux contractuels reels agregateur par
 * agregateur avant toute facturation.
 */
export type Region = 'WEST' | 'CENTRAL' | 'EAST' | 'NORTH' | 'SOUTHERN' | 'ISLANDS';

/** Capacite de decaissement constatee sur le pays, toutes voies confondues. */
export type PayoutMode = 'FULL' | 'PARTIAL' | 'LIMITED' | 'NONE';

export type KycRequirement =
  | 'RCCM_REQUIRED'
  | 'LOCAL_REGISTRATION'
  | 'STATE_AUTHORIZATION'
  | 'LIGHT_KYC';

export interface CountryDef {
  iso2: string;
  name: string;
  region: Region;
  currency: string;
  callingCode: string;
  /** Zones economiques / monetaires, utiles au routage et au settlement. */
  zones: string[];
  sovereign: boolean;

  kycRequirement: KycRequirement;
  /** Libelle exact de l'exigence locale, tel qu'affiche au marchand. */
  kycLabel: string;
  /** Un particulier / micro-entrepreneur peut-il encaisser sans RCCM ? */
  allowsIndividual: boolean;

  /** Fourchette indicative, en points de base (250 = 2,50 %). */
  feeMinBps: number;
  feeMaxBps: number;

  payoutMode: PayoutMode;
  payoutNote: string;
}

export const COUNTRIES: readonly CountryDef[] = [
  /* ---------------------------------------------------------------- OUEST -- */
  {
    iso2: 'BJ', name: 'Bénin', region: 'WEST', currency: 'XOF', callingCode: '229',
    zones: ['UEMOA', 'CEDEAO'], sovereign: true,
    kycRequirement: 'RCCM_REQUIRED',
    kycLabel: 'RCCM requis (Pro) — option Starter/Particulier sous plafond',
    allowsIndividual: true,
    feeMinBps: 150, feeMaxBps: 300,
    payoutMode: 'FULL', payoutNote: 'Payout FedaPay / CinetPay vers MTN et Moov Bénin.',
  },
  {
    iso2: 'TG', name: 'Togo', region: 'WEST', currency: 'XOF', callingCode: '228',
    zones: ['UEMOA', 'CEDEAO'], sovereign: true,
    kycRequirement: 'RCCM_REQUIRED', kycLabel: 'RCCM requis', allowsIndividual: false,
    feeMinBps: 180, feeMaxBps: 280,
    payoutMode: 'FULL', payoutNote: 'Payout direct TMoney et Moov Togo via FedaPay / PayGate.',
  },
  {
    iso2: 'CI', name: "Côte d'Ivoire", region: 'WEST', currency: 'XOF', callingCode: '225',
    zones: ['UEMOA', 'CEDEAO'], sovereign: true,
    kycRequirement: 'RCCM_REQUIRED', kycLabel: 'RCCM requis', allowsIndividual: false,
    feeMinBps: 100, feeMaxBps: 250,
    payoutMode: 'FULL', payoutNote: 'Payout B2C vers Wave, Orange, MTN, Moov.',
  },
  {
    iso2: 'SN', name: 'Sénégal', region: 'WEST', currency: 'XOF', callingCode: '221',
    zones: ['UEMOA', 'CEDEAO'], sovereign: true,
    kycRequirement: 'RCCM_REQUIRED', kycLabel: 'NINEA / RCCM', allowsIndividual: true,
    feeMinBps: 100, feeMaxBps: 200,
    payoutMode: 'FULL', payoutNote: 'Payout instantané Wave et Orange Money Sénégal.',
  },
  {
    iso2: 'ML', name: 'Mali', region: 'WEST', currency: 'XOF', callingCode: '223',
    zones: ['UEMOA', 'CEDEAO'], sovereign: true,
    kycRequirement: 'RCCM_REQUIRED', kycLabel: 'RCCM requis', allowsIndividual: false,
    feeMinBps: 200, feeMaxBps: 300,
    payoutMode: 'FULL', payoutNote: 'Retrait Orange Money Mali et Malitel via Bizao / CinetPay.',
  },
  {
    iso2: 'BF', name: 'Burkina Faso', region: 'WEST', currency: 'XOF', callingCode: '226',
    zones: ['UEMOA', 'CEDEAO'], sovereign: true,
    kycRequirement: 'RCCM_REQUIRED', kycLabel: 'RCCM requis', allowsIndividual: false,
    feeMinBps: 200, feeMaxBps: 300,
    payoutMode: 'FULL', payoutNote: 'Payout vers Orange Money et Moov Africa BF.',
  },
  {
    iso2: 'NE', name: 'Niger', region: 'WEST', currency: 'XOF', callingCode: '227',
    zones: ['UEMOA', 'CEDEAO'], sovereign: true,
    kycRequirement: 'RCCM_REQUIRED', kycLabel: 'RCCM requis', allowsIndividual: false,
    feeMinBps: 220, feeMaxBps: 320,
    payoutMode: 'FULL', payoutNote: 'Payout Zamani / Airtel Niger.',
  },
  {
    iso2: 'GW', name: 'Guinée-Bissau', region: 'WEST', currency: 'XOF', callingCode: '245',
    zones: ['UEMOA', 'CEDEAO'], sovereign: true,
    kycRequirement: 'RCCM_REQUIRED', kycLabel: 'RCCM requis', allowsIndividual: false,
    feeMinBps: 250, feeMaxBps: 350,
    payoutMode: 'FULL', payoutNote: 'Retrait Orange Money Bissau.',
  },
  {
    iso2: 'GN', name: 'Guinée', region: 'WEST', currency: 'GNF', callingCode: '224',
    zones: ['CEDEAO'], sovereign: true,
    kycRequirement: 'RCCM_REQUIRED', kycLabel: 'RCCM requis', allowsIndividual: false,
    feeMinBps: 200, feeMaxBps: 300,
    payoutMode: 'FULL', payoutNote: 'Transfert vers Orange Money et MTN Guinée.',
  },
  {
    iso2: 'GH', name: 'Ghana', region: 'WEST', currency: 'GHS', callingCode: '233',
    zones: ['CEDEAO'], sovereign: true,
    kycRequirement: 'LOCAL_REGISTRATION', kycLabel: 'Ghanaian Registration / TIN',
    allowsIndividual: true,
    feeMinBps: 195, feeMaxBps: 195,
    payoutMode: 'FULL', payoutNote: 'Transfert instantané MTN MoMo, Telecel, AirtelTigo.',
  },
  {
    iso2: 'NG', name: 'Nigeria', region: 'WEST', currency: 'NGN', callingCode: '234',
    zones: ['CEDEAO'], sovereign: true,
    kycRequirement: 'LOCAL_REGISTRATION', kycLabel: 'CAC Registration (Nigeria)',
    allowsIndividual: true,
    feeMinBps: 150, feeMaxBps: 150,
    payoutMode: 'FULL',
    payoutNote: 'Virement bancaire NIBSS et payout wallet. Commission plafonnée à 2 000 NGN.',
  },
  {
    iso2: 'GM', name: 'Gambie', region: 'WEST', currency: 'GMD', callingCode: '220',
    zones: ['CEDEAO'], sovereign: true,
    kycRequirement: 'LOCAL_REGISTRATION', kycLabel: 'Business Registration', allowsIndividual: false,
    feeMinBps: 250, feeMaxBps: 350,
    payoutMode: 'FULL', payoutNote: 'Retrait AfriMoney / QMoney via Flutterwave.',
  },
  {
    iso2: 'SL', name: 'Sierra Leone', region: 'WEST', currency: 'SLE', callingCode: '232',
    zones: ['CEDEAO'], sovereign: true,
    kycRequirement: 'LOCAL_REGISTRATION', kycLabel: 'Business Registration', allowsIndividual: false,
    feeMinBps: 250, feeMaxBps: 350,
    payoutMode: 'FULL', payoutNote: 'Payout Orange et Africell Sierra Leone.',
  },
  {
    iso2: 'LR', name: 'Libéria', region: 'WEST', currency: 'LRD', callingCode: '231',
    zones: ['CEDEAO'], sovereign: true,
    kycRequirement: 'LOCAL_REGISTRATION', kycLabel: 'Business Registration', allowsIndividual: false,
    feeMinBps: 300, feeMaxBps: 400,
    payoutMode: 'FULL', payoutNote: 'Retrait Lonestar MTN / Orange Liberia.',
  },
  {
    iso2: 'CV', name: 'Cap-Vert', region: 'WEST', currency: 'CVE', callingCode: '238',
    zones: ['CEDEAO'], sovereign: true,
    kycRequirement: 'LOCAL_REGISTRATION', kycLabel: 'Registre du commerce', allowsIndividual: false,
    feeMinBps: 250, feeMaxBps: 350,
    payoutMode: 'FULL', payoutNote: 'Virement interbancaire local via SISP.',
  },

  /* ------------------------------------------------------------- CENTRALE -- */
  {
    iso2: 'CM', name: 'Cameroun', region: 'CENTRAL', currency: 'XAF', callingCode: '237',
    zones: ['CEMAC'], sovereign: true,
    kycRequirement: 'RCCM_REQUIRED',
    kycLabel: 'RCCM requis — compte sandbox ouvert sans RCCM', allowsIndividual: true,
    feeMinBps: 200, feeMaxBps: 300,
    payoutMode: 'FULL', payoutNote: 'Payout B2C rapide MTN MoMo et Orange Cameroun.',
  },
  {
    iso2: 'GA', name: 'Gabon', region: 'CENTRAL', currency: 'XAF', callingCode: '241',
    zones: ['CEMAC'], sovereign: true,
    kycRequirement: 'RCCM_REQUIRED', kycLabel: 'RCCM requis', allowsIndividual: false,
    feeMinBps: 250, feeMaxBps: 350,
    payoutMode: 'FULL', payoutNote: 'Payout Airtel Money et Moov Money Gabon.',
  },
  {
    iso2: 'CG', name: 'Congo-Brazzaville', region: 'CENTRAL', currency: 'XAF', callingCode: '242',
    zones: ['CEMAC'], sovereign: true,
    kycRequirement: 'RCCM_REQUIRED', kycLabel: 'RCCM requis', allowsIndividual: false,
    feeMinBps: 250, feeMaxBps: 350,
    payoutMode: 'FULL', payoutNote: 'Disbursement MTN MoMo et Airtel Money Congo.',
  },
  {
    iso2: 'CD', name: 'République démocratique du Congo', region: 'CENTRAL', currency: 'CDF',
    callingCode: '243', zones: ['SADC', 'COMESA'], sovereign: true,
    kycRequirement: 'RCCM_REQUIRED', kycLabel: 'RCCM RDC requis', allowsIndividual: false,
    feeMinBps: 250, feeMaxBps: 380,
    payoutMode: 'FULL', payoutNote: 'Payout M-Pesa, Orange Money, Airtel Money, Africell.',
  },
  {
    iso2: 'TD', name: 'Tchad', region: 'CENTRAL', currency: 'XAF', callingCode: '235',
    zones: ['CEMAC'], sovereign: true,
    kycRequirement: 'RCCM_REQUIRED', kycLabel: 'RCCM requis', allowsIndividual: false,
    feeMinBps: 300, feeMaxBps: 400,
    payoutMode: 'FULL', payoutNote: 'Payout Airtel Money Tchad et Moov.',
  },
  {
    iso2: 'CF', name: 'République centrafricaine', region: 'CENTRAL', currency: 'XAF',
    callingCode: '236', zones: ['CEMAC'], sovereign: true,
    kycRequirement: 'STATE_AUTHORIZATION', kycLabel: 'RCCM + licence spéciale',
    allowsIndividual: false,
    feeMinBps: 350, feeMaxBps: 500,
    payoutMode: 'PARTIAL', payoutNote: "Accord direct avec l'opérateur requis.",
  },
  {
    iso2: 'GQ', name: 'Guinée équatoriale', region: 'CENTRAL', currency: 'XAF', callingCode: '240',
    zones: ['CEMAC'], sovereign: true,
    kycRequirement: 'STATE_AUTHORIZATION', kycLabel: 'RCCM + accord bancaire',
    allowsIndividual: false,
    feeMinBps: 300, feeMaxBps: 450,
    payoutMode: 'PARTIAL', payoutNote: 'Virement bancaire / carte BANGE uniquement.',
  },
  {
    iso2: 'ST', name: 'Sao Tomé-et-Principe', region: 'CENTRAL', currency: 'STN', callingCode: '239',
    zones: ['CEEAC'], sovereign: true,
    kycRequirement: 'LOCAL_REGISTRATION', kycLabel: 'Business Registration', allowsIndividual: false,
    feeMinBps: 350, feeMaxBps: 450,
    payoutMode: 'LIMITED', payoutNote: 'Virement SWIFT ou retrait carte bancaire.',
  },

  /* ------------------------------------------------------------------ EST -- */
  {
    iso2: 'KE', name: 'Kenya', region: 'EAST', currency: 'KES', callingCode: '254',
    zones: ['EAC', 'COMESA'], sovereign: true,
    kycRequirement: 'LOCAL_REGISTRATION', kycLabel: 'CR12 / Registration Kenya',
    allowsIndividual: true,
    feeMinBps: 120, feeMaxBps: 200,
    payoutMode: 'FULL', payoutNote: 'M-Pesa B2C, disbursement instantané.',
  },
  {
    iso2: 'UG', name: 'Ouganda', region: 'EAST', currency: 'UGX', callingCode: '256',
    zones: ['EAC', 'COMESA'], sovereign: true,
    kycRequirement: 'LOCAL_REGISTRATION', kycLabel: 'URSB Registration', allowsIndividual: false,
    feeMinBps: 180, feeMaxBps: 250,
    payoutMode: 'FULL', payoutNote: 'Retrait Airtel Money et MTN Mobile Money Ouganda.',
  },
  {
    iso2: 'TZ', name: 'Tanzanie', region: 'EAST', currency: 'TZS', callingCode: '255',
    zones: ['EAC', 'SADC'], sovereign: true,
    kycRequirement: 'LOCAL_REGISTRATION', kycLabel: 'BRELA Registration', allowsIndividual: false,
    feeMinBps: 200, feeMaxBps: 300,
    payoutMode: 'FULL', payoutNote: 'Payout Tigo Pesa, M-Pesa, Airtel Money Tanzanie.',
  },
  {
    iso2: 'RW', name: 'Rwanda', region: 'EAST', currency: 'RWF', callingCode: '250',
    zones: ['EAC', 'COMESA'], sovereign: true,
    kycRequirement: 'LOCAL_REGISTRATION', kycLabel: 'RDB Certificate', allowsIndividual: false,
    feeMinBps: 150, feeMaxBps: 250,
    payoutMode: 'FULL', payoutNote: 'Payout instantané MTN MoMo et Airtel Rwanda.',
  },
  {
    iso2: 'ET', name: 'Éthiopie', region: 'EAST', currency: 'ETB', callingCode: '251',
    zones: ['COMESA'], sovereign: true,
    kycRequirement: 'LOCAL_REGISTRATION', kycLabel: 'Trade License Ethiopia',
    allowsIndividual: false,
    feeMinBps: 150, feeMaxBps: 250,
    payoutMode: 'FULL', payoutNote: 'Payout B2C Chapa et Telebirr.',
  },
  {
    iso2: 'BI', name: 'Burundi', region: 'EAST', currency: 'BIF', callingCode: '257',
    zones: ['EAC', 'COMESA'], sovereign: true,
    kycRequirement: 'LOCAL_REGISTRATION', kycLabel: 'Registre du commerce', allowsIndividual: false,
    feeMinBps: 250, feeMaxBps: 400,
    payoutMode: 'FULL', payoutNote: 'Payout Lumicash et EcoCash.',
  },
  {
    iso2: 'DJ', name: 'Djibouti', region: 'EAST', currency: 'DJF', callingCode: '253',
    zones: ['COMESA'], sovereign: true,
    kycRequirement: 'LOCAL_REGISTRATION', kycLabel: 'Patente / registre', allowsIndividual: false,
    feeMinBps: 200, feeMaxBps: 350,
    payoutMode: 'FULL', payoutNote: 'Transfert wallet Waafi Pay.',
  },
  {
    iso2: 'SO', name: 'Somalie', region: 'EAST', currency: 'SOS', callingCode: '252',
    zones: ['COMESA'], sovereign: true,
    kycRequirement: 'LIGHT_KYC', kycLabel: 'KYC de base (souple)', allowsIndividual: true,
    feeMinBps: 100, feeMaxBps: 200,
    payoutMode: 'FULL', payoutNote: 'Payout Zaad et EVC Plus instantané.',
  },
  {
    iso2: 'SS', name: 'Soudan du Sud', region: 'EAST', currency: 'SSP', callingCode: '211',
    zones: ['EAC'], sovereign: true,
    kycRequirement: 'LOCAL_REGISTRATION', kycLabel: 'Registration / Relief Org ID',
    allowsIndividual: false,
    feeMinBps: 300, feeMaxBps: 450,
    payoutMode: 'FULL', payoutNote: 'Disbursement m-GURUSH.',
  },
  {
    iso2: 'SD', name: 'Soudan', region: 'EAST', currency: 'SDG', callingCode: '249',
    zones: ['COMESA'], sovereign: true,
    kycRequirement: 'STATE_AUTHORIZATION', kycLabel: 'Registration locale stricte',
    allowsIndividual: false,
    feeMinBps: 300, feeMaxBps: 500,
    payoutMode: 'PARTIAL', payoutNote: 'Systèmes bancaires locaux uniquement.',
  },
  {
    iso2: 'ER', name: 'Érythrée', region: 'EAST', currency: 'ERN', callingCode: '291',
    zones: ['COMESA'], sovereign: true,
    kycRequirement: 'STATE_AUTHORIZATION', kycLabel: "Autorisation d'État", allowsIndividual: false,
    feeMinBps: 500, feeMaxBps: 500,
    payoutMode: 'NONE', payoutNote: 'Paiements numériques très restreints.',
  },

  /* ----------------------------------------------------------------- NORD -- */
  {
    iso2: 'EG', name: 'Égypte', region: 'NORTH', currency: 'EGP', callingCode: '20',
    zones: ['COMESA'], sovereign: true,
    kycRequirement: 'LOCAL_REGISTRATION', kycLabel: 'Commercial Registration / Tax Card',
    allowsIndividual: true,
    feeMinBps: 200, feeMaxBps: 275,
    payoutMode: 'FULL',
    payoutNote: 'Payout wallet Vodafone Cash, InstaPay, Orange. Frais fixes en sus.',
  },
  {
    iso2: 'MA', name: 'Maroc', region: 'NORTH', currency: 'MAD', callingCode: '212',
    zones: ['MAGHREB'], sovereign: true,
    kycRequirement: 'LOCAL_REGISTRATION', kycLabel: 'Registre du commerce (RC)',
    allowsIndividual: false,
    feeMinBps: 200, feeMaxBps: 300,
    payoutMode: 'FULL', payoutNote: 'Virement interbancaire Maroc.',
  },
  {
    iso2: 'DZ', name: 'Algérie', region: 'NORTH', currency: 'DZD', callingCode: '213',
    zones: ['MAGHREB'], sovereign: true,
    kycRequirement: 'LOCAL_REGISTRATION', kycLabel: 'Registre du commerce algérien',
    allowsIndividual: false,
    feeMinBps: 150, feeMaxBps: 250,
    payoutMode: 'LIMITED', payoutNote: 'Uniquement vers comptes bancaires algériens.',
  },
  {
    iso2: 'TN', name: 'Tunisie', region: 'NORTH', currency: 'TND', callingCode: '216',
    zones: ['MAGHREB'], sovereign: true,
    kycRequirement: 'LOCAL_REGISTRATION', kycLabel: 'Registre du commerce', allowsIndividual: false,
    feeMinBps: 200, feeMaxBps: 300,
    payoutMode: 'FULL', payoutNote: 'Retrait vers comptes en dinar et cartes e-Dinar.',
  },
  {
    iso2: 'LY', name: 'Libye', region: 'NORTH', currency: 'LYD', callingCode: '218',
    zones: ['MAGHREB'], sovereign: true,
    kycRequirement: 'LOCAL_REGISTRATION', kycLabel: 'Registre libyen', allowsIndividual: false,
    feeMinBps: 250, feeMaxBps: 400,
    payoutMode: 'PARTIAL', payoutNote: 'Portefeuilles électroniques locaux.',
  },
  {
    iso2: 'MR', name: 'Mauritanie', region: 'NORTH', currency: 'MRU', callingCode: '222',
    zones: ['MAGHREB'], sovereign: true,
    kycRequirement: 'LOCAL_REGISTRATION', kycLabel: 'Registre du commerce', allowsIndividual: false,
    feeMinBps: 150, feeMaxBps: 250,
    payoutMode: 'FULL', payoutNote: 'Payout Bankily et Masrifi.',
  },

  /* ------------------------------------------------------------- AUSTRALE -- */
  {
    iso2: 'ZA', name: 'Afrique du Sud', region: 'SOUTHERN', currency: 'ZAR', callingCode: '27',
    zones: ['SADC'], sovereign: true,
    kycRequirement: 'LOCAL_REGISTRATION', kycLabel: 'CIPC Registration', allowsIndividual: true,
    feeMinBps: 150, feeMaxBps: 250,
    payoutMode: 'FULL', payoutNote: 'Instant EFT payout vers toutes banques sud-africaines.',
  },
  {
    iso2: 'AO', name: 'Angola', region: 'SOUTHERN', currency: 'AOA', callingCode: '244',
    zones: ['SADC'], sovereign: true,
    kycRequirement: 'LOCAL_REGISTRATION', kycLabel: 'Diário da República', allowsIndividual: false,
    feeMinBps: 180, feeMaxBps: 280,
    payoutMode: 'FULL', payoutNote: 'Virement Multicaixa.',
  },
  {
    iso2: 'MZ', name: 'Mozambique', region: 'SOUTHERN', currency: 'MZN', callingCode: '258',
    zones: ['SADC'], sovereign: true,
    kycRequirement: 'LOCAL_REGISTRATION', kycLabel: 'NUIT / registre', allowsIndividual: false,
    feeMinBps: 200, feeMaxBps: 300,
    payoutMode: 'FULL', payoutNote: 'Payout B2C Vodacom M-Pesa et E-Mola.',
  },
  {
    iso2: 'ZM', name: 'Zambie', region: 'SOUTHERN', currency: 'ZMW', callingCode: '260',
    zones: ['SADC', 'COMESA'], sovereign: true,
    kycRequirement: 'LOCAL_REGISTRATION', kycLabel: 'PACRA Registration', allowsIndividual: false,
    feeMinBps: 200, feeMaxBps: 300,
    payoutMode: 'FULL', payoutNote: 'Payout MTN, Airtel et Zamtel Kwacha.',
  },
  {
    iso2: 'ZW', name: 'Zimbabwe', region: 'SOUTHERN', currency: 'ZWG', callingCode: '263',
    zones: ['SADC', 'COMESA'], sovereign: true,
    kycRequirement: 'LOCAL_REGISTRATION', kycLabel: 'CR14 / registre', allowsIndividual: false,
    feeMinBps: 250, feeMaxBps: 400,
    payoutMode: 'FULL', payoutNote: 'Payout wallet EcoCash (USD / ZiG).',
  },
  {
    iso2: 'NA', name: 'Namibie', region: 'SOUTHERN', currency: 'NAD', callingCode: '264',
    zones: ['SADC'], sovereign: true,
    kycRequirement: 'LOCAL_REGISTRATION', kycLabel: 'BIPA Registration', allowsIndividual: false,
    feeMinBps: 200, feeMaxBps: 300,
    payoutMode: 'FULL', payoutNote: 'Virement direct FNB / Bank Windhoek.',
  },
  {
    iso2: 'BW', name: 'Botswana', region: 'SOUTHERN', currency: 'BWP', callingCode: '267',
    zones: ['SADC'], sovereign: true,
    kycRequirement: 'LOCAL_REGISTRATION', kycLabel: 'CIPA Certificate', allowsIndividual: false,
    feeMinBps: 200, feeMaxBps: 320,
    payoutMode: 'FULL', payoutNote: 'Payout Orange Money Botswana.',
  },
  {
    iso2: 'MW', name: 'Malawi', region: 'SOUTHERN', currency: 'MWK', callingCode: '265',
    zones: ['SADC', 'COMESA'], sovereign: true,
    kycRequirement: 'LOCAL_REGISTRATION', kycLabel: 'Business Registration', allowsIndividual: false,
    feeMinBps: 220, feeMaxBps: 350,
    payoutMode: 'FULL', payoutNote: 'Retrait Airtel Money et TNM Mpamba.',
  },
  {
    iso2: 'SZ', name: 'Eswatini', region: 'SOUTHERN', currency: 'SZL', callingCode: '268',
    zones: ['SADC'], sovereign: true,
    kycRequirement: 'LOCAL_REGISTRATION', kycLabel: 'Company Registration', allowsIndividual: false,
    feeMinBps: 200, feeMaxBps: 300,
    payoutMode: 'FULL', payoutNote: 'Payout MTN MoMo Eswatini.',
  },
  {
    iso2: 'LS', name: 'Lesotho', region: 'SOUTHERN', currency: 'LSL', callingCode: '266',
    zones: ['SADC'], sovereign: true,
    kycRequirement: 'LOCAL_REGISTRATION', kycLabel: 'Company Registration', allowsIndividual: false,
    feeMinBps: 200, feeMaxBps: 300,
    payoutMode: 'FULL', payoutNote: 'Payout Vodacom M-Pesa Lesotho.',
  },

  /* ------------------------------------------------------------------ ILES -- */
  {
    iso2: 'MG', name: 'Madagascar', region: 'ISLANDS', currency: 'MGA', callingCode: '261',
    zones: ['SADC', 'COMESA'], sovereign: true,
    kycRequirement: 'LOCAL_REGISTRATION', kycLabel: 'RCS / carte statistique',
    allowsIndividual: false,
    feeMinBps: 200, feeMaxBps: 300,
    payoutMode: 'FULL', payoutNote: 'Payout B2C MVola et Orange Money Madagascar.',
  },
  {
    iso2: 'MU', name: 'Maurice', region: 'ISLANDS', currency: 'MUR', callingCode: '230',
    zones: ['SADC', 'COMESA'], sovereign: true,
    kycRequirement: 'LOCAL_REGISTRATION', kycLabel: 'BRN (Business Registration Number)',
    allowsIndividual: false,
    feeMinBps: 150, feeMaxBps: 250,
    payoutMode: 'FULL', payoutNote: 'Instant MauCAS et virement bancaire.',
  },
  {
    iso2: 'SC', name: 'Seychelles', region: 'ISLANDS', currency: 'SCR', callingCode: '248',
    zones: ['COMESA', 'SADC'], sovereign: true,
    kycRequirement: 'LOCAL_REGISTRATION', kycLabel: 'NISA Registration', allowsIndividual: false,
    feeMinBps: 200, feeMaxBps: 300,
    payoutMode: 'FULL', payoutNote: 'Virement bancaire local SWIFT / EFT.',
  },
  {
    iso2: 'KM', name: 'Comores', region: 'ISLANDS', currency: 'KMF', callingCode: '269',
    zones: ['COMESA'], sovereign: true,
    kycRequirement: 'LOCAL_REGISTRATION', kycLabel: 'Registre du commerce', allowsIndividual: false,
    feeMinBps: 250, feeMaxBps: 400,
    payoutMode: 'FULL', payoutNote: 'Retrait wallet Huri Money.',
  },

  /* Territoire non souverain : present dans le document source, exclu du compte des 54. */
  {
    iso2: 'SH', name: 'Sainte-Hélène', region: 'ISLANDS', currency: 'SHP', callingCode: '290',
    zones: [], sovereign: false,
    kycRequirement: 'STATE_AUTHORIZATION', kycLabel: 'Permis local', allowsIndividual: false,
    feeMinBps: 350, feeMaxBps: 500,
    payoutMode: 'LIMITED', payoutNote: 'Transferts bancaires manuels / ISO.',
  },
] as const;

const BY_ISO2 = new Map(COUNTRIES.map((c) => [c.iso2, c]));

export function getCountry(iso2: string): CountryDef | undefined {
  return BY_ISO2.get(iso2.toUpperCase());
}

/** Nombre d'Etats souverains couverts. Doit valoir 54. */
export const SOVEREIGN_COUNT = COUNTRIES.filter((c) => c.sovereign).length;
