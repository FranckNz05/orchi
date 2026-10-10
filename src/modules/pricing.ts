import { env } from '../core/env.js';
import { applyBps } from '../core/money.js';

/**
 * Tarification Afripaie : le marchand paie TOUJOURS le meme taux total.
 *
 *   commission Afripaie = taux total − commission de l'agregateur
 *
 * Si l'agregateur prend 2 %, Afripaie prend 3 %. S'il prend 4 %, Afripaie prend 1 %.
 * Le marchand connait donc son cout a l'avance, quel que soit le pays et quel
 * que soit l'agregateur choisi par le routage — ce qui est aussi ce qui rend le
 * routage acceptable pour lui : basculer vers un agregateur plus cher ne lui
 * coute rien de plus.
 *
 * ┌─ CONSEQUENCE STRUCTURELLE ───────────────────────────────────────────────┐
 * │ Prelever une commission SUR CHAQUE TRANSACTION suppose d'etre dans le    │
 * │ flux des fonds. C'est le modele COLLECTEUR, pas la passerelle technique  │
 * │ decrite ailleurs dans ce depot : Afripaie encaisse, retient sa part, et     │
 * │ reverse le solde au marchand.                                            │
 * │                                                                          │
 * │ Cela reactive la trajectoire reglementaire (statut d'agent ou d'EME,     │
 * │ comptes cantonnes, AML/CFT) et exige un accord sub-merchant explicite    │
 * │ avec chaque agregateur. `PLATFORM_FEE_COLLECTION` documente la maniere   │
 * │ dont la part Afripaie est effectivement prelevee.                           │
 * └──────────────────────────────────────────────────────────────────────────┘
 *
 * LE MARCHAND PAIE LE TAUX TOTAL, JAMAIS PLUS — decision du 10/10/2026 :
 *   - agregateur a plus de 5 % (Yabetoo sous ~1 667 XAF, ou 3,5 % + 25 XAF
 *     depasse 5 % ; Erythree, RCA, Soudan) : la part Afripaie devient NEGATIVE.
 *     Afripaie absorbe l'ecart plutot que de le reporter sur le marchand. Le
 *     grand livre le constate (debit de afripaie:revenue, ou avoir).
 *   - frais preleves au BENEFICIAIRE par l'agregateur (Yabetoo retient 1,5 % sur
 *     chaque decaissement) : ils font partie des frais, donc du taux total. Ils
 *     ne touchent pas le portefeuille, mais reduisent la part Afripaie.
 *   - agregateur inconnu au moment du calcul : la part Afripaie vaudrait alors le
 *     taux total entier, ce qui surfacturerait le marchand. Le taux de
 *     l'agregateur est donc fige sur la tentative au moment du routage.
 */

export interface PlatformFee {
  /** Part Afripaie, en unites mineures. NEGATIVE quand Afripaie absorbe un ecart. */
  amount: number;
  /** Part Afripaie, en points de base. */
  bps: number;
  /** Commission de l'agregateur retenue dans le calcul, en unites mineures. */
  providerAmount: number;
  /** Taux total supporte par le marchand, en points de base. */
  totalBps: number;
  /** Frais preleves au beneficiaire, compris dans le taux total. */
  beneficiaryAmount: number;
  /** Ce qu'Afripaie paie de sa poche pour tenir le taux total (0 sinon). */
  absorbed: number;
  /** true si les frais de l'agregateur depassent le taux total. */
  capped: boolean;
}

export interface FeeInput {
  amountMinor: number;
  /**
   * Commission de l'agregateur en unites mineures, quand elle est connue.
   * Les vrais adaptateurs la communiquent ; a defaut on la deduit de
   * `providerFeeBps`.
   */
  providerFeeAmount?: number | null;
  /** Taux de l'agregateur fige au routage, en points de base. */
  providerFeeBps?: number | null;
  /**
   * Frais que l'agregateur retient au BENEFICIAIRE d'un decaissement (Yabetoo :
   * 1,5 %). Absents du portefeuille, presents dans le cout pour le client.
   */
  beneficiaryFeeAmount?: number | null;
}

function compute(input: FeeInput, totalBps: number): PlatformFee {
  const total = applyBps(input.amountMinor, totalBps);

  const providerAmount =
    input.providerFeeAmount ?? applyBps(input.amountMinor, input.providerFeeBps ?? 0);

  const beneficiaryAmount = input.beneficiaryFeeAmount ?? 0;

  // Peut etre negatif : au-dela du taux total, c'est Afripaie qui paie l'ecart,
  // jamais le marchand.
  const amount = total - providerAmount - beneficiaryAmount;

  return {
    amount,
    bps: input.amountMinor > 0 ? Math.round((amount / input.amountMinor) * 10000) : 0,
    providerAmount,
    beneficiaryAmount,
    totalBps,
    absorbed: Math.max(0, -amount),
    capped: amount < 0,
  };
}

export function platformPayinFee(_merchantId: string, input: FeeInput): PlatformFee {
  return compute(input, env.PLATFORM_TOTAL_PAYIN_BPS);
}

export function platformPayoutFee(_merchantId: string, input: FeeInput): PlatformFee {
  return compute(input, env.PLATFORM_TOTAL_PAYOUT_BPS);
}

/**
 * Simulation, pour le site et le tableau de bord.
 *
 * Montre au marchand ce qu'il recevra reellement avant qu'il n'integre quoi que
 * ce soit : c'est la question qu'il se pose en premier.
 */
export function quote(amountMinor: number, providerFeeBps: number, direction: 'payin' | 'payout') {
  const totalBps =
    direction === 'payin' ? env.PLATFORM_TOTAL_PAYIN_BPS : env.PLATFORM_TOTAL_PAYOUT_BPS;
  const fee = compute({ amountMinor, providerFeeBps }, totalBps);

  return {
    amount: amountMinor,
    total_bps: totalBps,
    provider_fee: fee.providerAmount,
    provider_bps: providerFeeBps,
    platform_fee: fee.amount,
    platform_bps: fee.bps,
    /** Ce que le marchand recoit effectivement : toujours montant − taux total. */
    net: amountMinor - fee.providerAmount - fee.amount,
    capped: fee.capped,
    absorbed: fee.absorbed,
  };
}
