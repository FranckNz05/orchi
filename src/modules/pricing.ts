import { env } from '../core/env.js';
import { applyBps } from '../core/money.js';

/**
 * Tarification Orchi : le marchand paie TOUJOURS le meme taux total.
 *
 *   commission Orchi = taux total − commission de l'agregateur
 *
 * Si l'agregateur prend 2 %, Orchi prend 3 %. S'il prend 4 %, Orchi prend 1 %.
 * Le marchand connait donc son cout a l'avance, quel que soit le pays et quel
 * que soit l'agregateur choisi par le routage — ce qui est aussi ce qui rend le
 * routage acceptable pour lui : basculer vers un agregateur plus cher ne lui
 * coute rien de plus.
 *
 * ┌─ CONSEQUENCE STRUCTURELLE ───────────────────────────────────────────────┐
 * │ Prelever une commission SUR CHAQUE TRANSACTION suppose d'etre dans le    │
 * │ flux des fonds. C'est le modele COLLECTEUR, pas la passerelle technique  │
 * │ decrite ailleurs dans ce depot : Orchi encaisse, retient sa part, et     │
 * │ reverse le solde au marchand.                                            │
 * │                                                                          │
 * │ Cela reactive la trajectoire reglementaire (statut d'agent ou d'EME,     │
 * │ comptes cantonnes, AML/CFT) et exige un accord sub-merchant explicite    │
 * │ avec chaque agregateur. `PLATFORM_FEE_COLLECTION` documente la maniere   │
 * │ dont la part Orchi est effectivement prelevee.                           │
 * └──────────────────────────────────────────────────────────────────────────┘
 *
 * DEUX BORNES, toutes deux atteintes par de vrais pays du catalogue :
 *   - agregateur a 5 % ou plus (Erythree, RCA, Soudan) : la part Orchi tombe a
 *     ZERO. Elle ne devient jamais negative — on ne paie pas pour transporter.
 *   - agregateur inconnu au moment du calcul : la part Orchi vaudrait alors le
 *     taux total entier, ce qui surfacturerait le marchand. Le taux de
 *     l'agregateur est donc fige sur la tentative au moment du routage.
 */

export interface PlatformFee {
  /** Part Orchi, en unites mineures. */
  amount: number;
  /** Part Orchi, en points de base. */
  bps: number;
  /** Commission de l'agregateur retenue dans le calcul, en unites mineures. */
  providerAmount: number;
  /** Taux total supporte par le marchand, en points de base. */
  totalBps: number;
  /** true si l'agregateur consomme deja tout le taux total. */
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
}

function compute(input: FeeInput, totalBps: number): PlatformFee {
  const total = applyBps(input.amountMinor, totalBps);

  const providerAmount =
    input.providerFeeAmount ?? applyBps(input.amountMinor, input.providerFeeBps ?? 0);

  // Jamais negatif : si l'agregateur coute plus cher que le taux total, Orchi
  // ne prend rien. La transaction reste possible, elle ne rapporte simplement
  // plus rien — c'est une information de pilotage, pas un blocage.
  const amount = Math.max(0, total - providerAmount);

  return {
    amount,
    bps: input.amountMinor > 0 ? Math.round((amount / input.amountMinor) * 10000) : 0,
    providerAmount,
    totalBps,
    capped: amount === 0 && providerAmount >= total,
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
    /** Ce que le marchand recoit effectivement. */
    net: amountMinor - fee.providerAmount - fee.amount,
    capped: fee.capped,
  };
}
