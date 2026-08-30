/**
 * Registre des agregateurs, operateurs et banques cites dans le cadrage.
 *
 * `integration` decrit l'etat REEL de l'integration cote Orchi, pas la maturite
 * du produit du partenaire. Un agregateur peut etre excellent et rester
 * `PLANNED` tant qu'aucun adaptateur n'existe dans `src/providers/`.
 *
 * `DIRECT_AGREEMENT` signale les cas ou aucune API publique n'existe : il faut
 * un accord commercial signe avec l'operateur ou la banque avant tout
 * developpement. C'est une information de vente autant que de technique.
 */
export type ProviderType = 'AGGREGATOR' | 'OPERATOR' | 'BANK' | 'SCHEME';

export type IntegrationStatus = 'LIVE' | 'SANDBOX' | 'PLANNED' | 'DIRECT_AGREEMENT';

export interface ProviderDef {
  id: string;
  name: string;
  type: ProviderType;
  integration: IntegrationStatus;
  /** Regions ou zones d'intervention principales, a titre documentaire. */
  scope: string;
}

export const PROVIDERS: readonly ProviderDef[] = [
  /* ------------------------------------------------ Agregateurs zone franc -- */
  { id: 'fedapay', name: 'FedaPay', type: 'AGGREGATOR', integration: 'PLANNED', scope: 'UEMOA (BJ, TG, CI, SN, NE)' },
  { id: 'cinetpay', name: 'CinetPay', type: 'AGGREGATOR', integration: 'PLANNED', scope: 'UEMOA + CEMAC' },
  {
    id: 'geniuspay',
    name: 'GeniusPay',
    type: 'AGGREGATOR',
    integration: 'PLANNED',
    scope: '21 pays — UEMOA, CEMAC, Afrique de l’Est et australe (cf. src/providers/geniuspay.ts)',
  },
  { id: 'bizao', name: 'Bizao', type: 'AGGREGATOR', integration: 'PLANNED', scope: 'Afrique de l’Ouest et Centrale' },
  { id: 'touchpay', name: 'TouchPay', type: 'AGGREGATOR', integration: 'PLANNED', scope: 'UEMOA + CEMAC' },
  { id: 'paytech', name: 'PayTech', type: 'AGGREGATOR', integration: 'PLANNED', scope: 'Sénégal' },
  { id: 'semoa', name: 'Semoa', type: 'AGGREGATOR', integration: 'PLANNED', scope: 'Togo' },
  { id: 'paygate_togo', name: 'PayGate Togo', type: 'AGGREGATOR', integration: 'PLANNED', scope: 'Togo' },
  { id: 'ligdicash', name: 'LigdiCash', type: 'AGGREGATOR', integration: 'PLANNED', scope: 'Burkina Faso' },
  { id: 'nita', name: 'Nita', type: 'AGGREGATOR', integration: 'PLANNED', scope: 'Niger' },
  { id: 'paycard', name: 'PayCard', type: 'AGGREGATOR', integration: 'PLANNED', scope: 'Guinée' },
  { id: 'mycoolpay', name: 'MyCoolPay', type: 'AGGREGATOR', integration: 'PLANNED', scope: 'Cameroun' },
  { id: 'singpay', name: 'SingPay', type: 'AGGREGATOR', integration: 'PLANNED', scope: 'Gabon' },

  /* ------------------------------------------- Agregateurs panafricains -- */
  { id: 'flutterwave', name: 'Flutterwave', type: 'AGGREGATOR', integration: 'PLANNED', scope: 'Panafricain' },
  { id: 'paystack', name: 'Paystack', type: 'AGGREGATOR', integration: 'PLANNED', scope: 'NG, GH, ZA, KE' },
  { id: 'dpo', name: 'DPO Group', type: 'AGGREGATOR', integration: 'PLANNED', scope: 'Afrique de l’Est et Australe' },
  { id: 'monnify', name: 'Monnify', type: 'AGGREGATOR', integration: 'PLANNED', scope: 'Nigeria' },
  { id: 'interswitch', name: 'Interswitch', type: 'AGGREGATOR', integration: 'PLANNED', scope: 'Nigeria' },
  { id: 'hubtel', name: 'Hubtel', type: 'AGGREGATOR', integration: 'PLANNED', scope: 'Ghana' },
  { id: 'aps_international', name: 'APS International', type: 'AGGREGATOR', integration: 'PLANNED', scope: 'Gambie' },
  { id: 'moneta', name: 'Moneta', type: 'AGGREGATOR', integration: 'PLANNED', scope: 'Sierra Leone' },
  { id: 'tipme', name: 'TipMe Liberia', type: 'AGGREGATOR', integration: 'PLANNED', scope: 'Libéria' },
  { id: 'sisp', name: 'SISP (Vinti4)', type: 'SCHEME', integration: 'PLANNED', scope: 'Cap-Vert' },

  /* --------------------------------------------------- Afrique centrale -- */
  { id: 'maxicash', name: 'MaxiCash', type: 'AGGREGATOR', integration: 'PLANNED', scope: 'RDC' },
  { id: 'flashkm', name: 'FlashKM', type: 'AGGREGATOR', integration: 'PLANNED', scope: 'RDC' },
  { id: 'ilicocash', name: 'IlicoCash', type: 'AGGREGATOR', integration: 'PLANNED', scope: 'RDC' },
  { id: 'bange', name: 'BANGE Mobile', type: 'BANK', integration: 'DIRECT_AGREEMENT', scope: 'Guinée équatoriale' },
  { id: 'cst_movel', name: 'CST Movel', type: 'OPERATOR', integration: 'DIRECT_AGREEMENT', scope: 'Sao Tomé-et-Principe' },

  /* ------------------------------------------------------ Afrique de l'Est -- */
  { id: 'mpesa_daraja', name: 'Safaricom M-Pesa (Daraja)', type: 'OPERATOR', integration: 'PLANNED', scope: 'Kenya' },
  { id: 'yo_payments', name: 'Yo! Payments', type: 'AGGREGATOR', integration: 'PLANNED', scope: 'Ouganda' },
  { id: 'pegasus', name: 'Pegasus', type: 'AGGREGATOR', integration: 'PLANNED', scope: 'Ouganda' },
  { id: 'selcom', name: 'Selcom', type: 'AGGREGATOR', integration: 'PLANNED', scope: 'Tanzanie' },
  { id: 'paypack', name: 'PayPack Rwanda', type: 'AGGREGATOR', integration: 'PLANNED', scope: 'Rwanda' },
  { id: 'chapa', name: 'Chapa', type: 'AGGREGATOR', integration: 'PLANNED', scope: 'Éthiopie' },
  { id: 'telebirr', name: 'Telebirr (Ethio Telecom)', type: 'OPERATOR', integration: 'PLANNED', scope: 'Éthiopie' },
  { id: 'cbe_birr', name: 'CBE Birr', type: 'BANK', integration: 'DIRECT_AGREEMENT', scope: 'Éthiopie' },
  { id: 'iclick', name: 'iClick', type: 'AGGREGATOR', integration: 'PLANNED', scope: 'Burundi' },
  { id: 'lumicash', name: 'Lumicash', type: 'OPERATOR', integration: 'PLANNED', scope: 'Burundi' },
  { id: 'ecocash', name: 'EcoCash', type: 'OPERATOR', integration: 'PLANNED', scope: 'BI, ZW, LS' },
  { id: 'waafi', name: 'WaafiPay', type: 'AGGREGATOR', integration: 'PLANNED', scope: 'DJ, SO' },
  { id: 'mgurush', name: 'm-GURUSH', type: 'OPERATOR', integration: 'PLANNED', scope: 'Soudan du Sud' },
  { id: 'zain_cash', name: 'Zain Cash', type: 'OPERATOR', integration: 'PLANNED', scope: 'Soudan du Sud' },
  { id: 'syberpay', name: 'SyberPay', type: 'AGGREGATOR', integration: 'DIRECT_AGREEMENT', scope: 'Soudan' },
  { id: 'solus', name: 'Solus', type: 'AGGREGATOR', integration: 'DIRECT_AGREEMENT', scope: 'Soudan' },
  { id: 'eritel', name: 'Eritrean Postal & Telecom', type: 'OPERATOR', integration: 'DIRECT_AGREEMENT', scope: 'Érythrée' },

  /* ----------------------------------------------------- Afrique du Nord -- */
  { id: 'paymob', name: 'Paymob', type: 'AGGREGATOR', integration: 'PLANNED', scope: 'Égypte, Maghreb' },
  { id: 'fawry', name: 'Fawry', type: 'AGGREGATOR', integration: 'PLANNED', scope: 'Égypte' },
  { id: 'paytabs', name: 'PayTabs Egypt', type: 'AGGREGATOR', integration: 'PLANNED', scope: 'Égypte' },
  { id: 'kashier', name: 'Kashier', type: 'AGGREGATOR', integration: 'PLANNED', scope: 'Égypte' },
  { id: 'cmi', name: 'CMI', type: 'SCHEME', integration: 'DIRECT_AGREEMENT', scope: 'Maroc' },
  { id: 'payzone', name: 'PayZone', type: 'AGGREGATOR', integration: 'PLANNED', scope: 'Maroc' },
  { id: 'amanpay', name: 'AmanPay', type: 'AGGREGATOR', integration: 'PLANNED', scope: 'Maroc' },
  { id: 'satim', name: 'SATIM', type: 'SCHEME', integration: 'DIRECT_AGREEMENT', scope: 'Algérie' },
  { id: 'clicktopay', name: 'ClickToPay (Monétique Tunisie)', type: 'SCHEME', integration: 'DIRECT_AGREEMENT', scope: 'Tunisie' },
  { id: 'sobflous', name: 'Sobflous', type: 'AGGREGATOR', integration: 'PLANNED', scope: 'Tunisie' },
  { id: 'sadad', name: 'Sadad', type: 'AGGREGATOR', integration: 'PLANNED', scope: 'Libye' },
  { id: 'moamalat', name: 'Moamalat', type: 'SCHEME', integration: 'DIRECT_AGREEMENT', scope: 'Libye' },
  { id: 'bankily', name: 'Bankily (BIM)', type: 'BANK', integration: 'PLANNED', scope: 'Mauritanie' },
  { id: 'masrifi', name: 'Masrifi', type: 'BANK', integration: 'PLANNED', scope: 'Mauritanie' },

  /* --------------------------------------------------- Afrique australe -- */
  { id: 'stitch', name: 'Stitch', type: 'AGGREGATOR', integration: 'PLANNED', scope: 'Afrique du Sud' },
  { id: 'ozow', name: 'Ozow', type: 'AGGREGATOR', integration: 'PLANNED', scope: 'Afrique du Sud' },
  { id: 'payfast', name: 'PayFast', type: 'AGGREGATOR', integration: 'PLANNED', scope: 'Afrique du Sud' },
  { id: 'yoco', name: 'Yoco', type: 'AGGREGATOR', integration: 'PLANNED', scope: 'Afrique du Sud' },
  { id: 'peach', name: 'Peach Payments', type: 'AGGREGATOR', integration: 'PLANNED', scope: 'ZA, MU' },
  { id: 'emis_multicaixa', name: 'Multicaixa Express (EMIS)', type: 'SCHEME', integration: 'DIRECT_AGREEMENT', scope: 'Angola' },
  { id: 'proxypay', name: 'Proxypay', type: 'AGGREGATOR', integration: 'PLANNED', scope: 'Angola' },
  { id: 'mpesa_mz', name: 'M-Pesa Moçambique', type: 'OPERATOR', integration: 'PLANNED', scope: 'Mozambique' },
  { id: 'emola', name: 'E-Mola', type: 'OPERATOR', integration: 'PLANNED', scope: 'Mozambique' },
  { id: 'kazang', name: 'Kazang', type: 'AGGREGATOR', integration: 'PLANNED', scope: 'Zambie' },
  { id: 'paynow_zw', name: 'Paynow Zimbabwe', type: 'AGGREGATOR', integration: 'PLANNED', scope: 'Zimbabwe' },
  { id: 'paytoday', name: 'PayToday', type: 'AGGREGATOR', integration: 'PLANNED', scope: 'Namibie' },
  { id: 'virtual_pay', name: 'Virtual Pay', type: 'AGGREGATOR', integration: 'PLANNED', scope: 'Botswana' },
  { id: 'fdh_bank', name: 'FDH Bank', type: 'BANK', integration: 'DIRECT_AGREEMENT', scope: 'Malawi' },

  /* -------------------------------------------------------------- Iles -- */
  { id: 'mvola', name: 'MVola (Telma)', type: 'OPERATOR', integration: 'PLANNED', scope: 'Madagascar' },
  { id: 'mcb_juice', name: 'MCB Juice', type: 'BANK', integration: 'DIRECT_AGREEMENT', scope: 'Maurice' },
  { id: 'blink', name: 'Blink', type: 'AGGREGATOR', integration: 'PLANNED', scope: 'Maurice' },
  { id: 'merchantpay', name: 'MerchantPay', type: 'AGGREGATOR', integration: 'PLANNED', scope: 'Seychelles' },
  { id: 'huri_money', name: 'Huri Money (Comores Telecom)', type: 'OPERATOR', integration: 'PLANNED', scope: 'Comores' },
  { id: 'holo_safe', name: 'Holo Safe', type: 'AGGREGATOR', integration: 'PLANNED', scope: 'Comores' },
  { id: 'bank_st_helena', name: 'Bank of St Helena', type: 'BANK', integration: 'DIRECT_AGREEMENT', scope: 'Sainte-Hélène' },

  /* --------------------------------- Operateurs mobile money transverses -- */
  { id: 'orange_money', name: 'Orange Money', type: 'OPERATOR', integration: 'PLANNED', scope: 'Multi-pays' },
  { id: 'mtn_momo', name: 'MTN MoMo', type: 'OPERATOR', integration: 'PLANNED', scope: 'Multi-pays' },
  { id: 'airtel_money', name: 'Airtel Money', type: 'OPERATOR', integration: 'PLANNED', scope: 'Multi-pays' },
  { id: 'moov_money', name: 'Moov Money', type: 'OPERATOR', integration: 'PLANNED', scope: 'Multi-pays' },
  { id: 'wave', name: 'Wave', type: 'OPERATOR', integration: 'PLANNED', scope: 'SN, CI' },

  /* ------------------------------------------------------------ Interne -- */
  {
    id: 'sandbox',
    name: 'Orchi Sandbox',
    type: 'AGGREGATOR',
    integration: 'LIVE',
    scope: 'Simulateur interne — tous pays, environnement de test uniquement',
  },
] as const;

const BY_ID = new Map(PROVIDERS.map((p) => [p.id, p]));

export function getProvider(id: string): ProviderDef | undefined {
  return BY_ID.get(id);
}
