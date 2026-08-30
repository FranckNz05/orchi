import { ID_PREFIX, newId } from '../core/ids.js';
import { prisma } from '../db/client.js';
import type { Prisma } from '@prisma/client';

/**
 * Ledger miroir, en partie double.
 *
 * Orchi ne detient pas les fonds : ces ecritures REFLETENT les flux constates
 * chez les agregateurs. Pourquoi maintenir une partie double si l'on ne garde
 * pas d'argent ? Parce que c'est le seul dispositif qui rend un ecart visible :
 * si le settlement de l'agregateur ne correspond pas a la somme de nos
 * ecritures, le desequilibre saute aux yeux au lieu de se diluer.
 *
 * Plan de comptes :
 *   provider:{id}:clearing     fonds en transit chez l'agregateur
 *   provider:{id}:fees         frais preleves par l'agregateur
 *   merchant:{id}:receivable   du au marchand sur un encaissement
 *   merchant:{id}:payable      du par le marchand sur un decaissement
 *   merchant:{id}:billing      commissions Orchi a facturer
 *   orchi:revenue              produit d'Orchi
 */

export type Side = 'DEBIT' | 'CREDIT';

export interface EntryInput {
  account: string;
  side: Side;
  amount: number;
}

export interface JournalInput {
  merchantId: string;
  /** payin.succeeded | payout.succeeded | fee.accrued */
  type: string;
  refType: 'payment' | 'payout';
  refId: string;
  currency: string;
  description?: string;
  entries: EntryInput[];
}

export const accounts = {
  providerClearing: (providerId: string) => `provider:${providerId}:clearing`,
  providerFees: (providerId: string) => `provider:${providerId}:fees`,
  merchantReceivable: (merchantId: string) => `merchant:${merchantId}:receivable`,
  merchantPayable: (merchantId: string) => `merchant:${merchantId}:payable`,
  merchantBilling: (merchantId: string) => `merchant:${merchantId}:billing`,
  orchiRevenue: () => 'orchi:revenue',
} as const;

export class UnbalancedJournalError extends Error {
  constructor(type: string, debit: number, credit: number) {
    super(`Journal ${type} desequilibre : debit ${debit} != credit ${credit}.`);
    this.name = 'UnbalancedJournalError';
  }
}

/**
 * Ecrit un journal. Refuse tout desequilibre : une ecriture fausse doit
 * echouer bruyamment au moment ou elle est produite, pas etre decouverte des
 * mois plus tard lors d'un rapprochement.
 */
export async function postJournal(
  input: JournalInput,
  tx: Prisma.TransactionClient = prisma,
): Promise<string> {
  if (input.entries.length === 0) throw new Error('Journal sans ecriture.');

  let debit = 0;
  let credit = 0;
  for (const entry of input.entries) {
    if (!Number.isInteger(entry.amount) || entry.amount < 0) {
      throw new Error(`Montant d'ecriture invalide sur ${entry.account} : ${entry.amount}.`);
    }
    if (entry.side === 'DEBIT') debit += entry.amount;
    else credit += entry.amount;
  }
  if (debit !== credit) throw new UnbalancedJournalError(input.type, debit, credit);

  const journalId = newId(ID_PREFIX.ledgerJournal);

  await tx.ledgerJournal.create({
    data: {
      id: journalId,
      merchantId: input.merchantId,
      type: input.type,
      refType: input.refType,
      refId: input.refId,
      currency: input.currency,
      description: input.description ?? null,
      entries: {
        create: input.entries.map((entry) => ({
          id: newId(ID_PREFIX.ledgerJournal),
          account: entry.account,
          side: entry.side,
          amount: entry.amount,
          currency: input.currency,
        })),
      },
    },
  });

  return journalId;
}

/* -------------------------------------------------------------------------- */
/* Ecritures metier                                                           */
/* -------------------------------------------------------------------------- */

export interface PayinPostingInput {
  merchantId: string;
  paymentId: string;
  providerId: string;
  currency: string;
  amount: number;
  providerFee: number;
  platformFee: number;
}

/**
 * Encaissement reussi.
 *
 * La commission Orchi est prelevee SUR LE FLUX : le marchand recoit
 * `montant − frais agregateur − commission Orchi`. Un seul journal suffit donc,
 * et c'est plus sur qu'en deux : un unique journal ne peut pas etre a moitie
 * ecrit.
 *
 * (Une version anterieure separait la commission dans un journal
 * `fee.accrued`, parce qu'elle etait facturee hors flux. Ce n'est plus le
 * modele : la retenue est immediate.)
 */
export async function postPayinSucceeded(
  input: PayinPostingInput,
  tx: Prisma.TransactionClient = prisma,
): Promise<void> {
  const net = input.amount - input.providerFee - input.platformFee;
  if (net < 0) {
    throw new Error(
      `Commissions (${input.providerFee} + ${input.platformFee}) superieures au montant encaisse (${input.amount}).`,
    );
  }

  await postJournal(
    {
      merchantId: input.merchantId,
      type: 'payin.succeeded',
      refType: 'payment',
      refId: input.paymentId,
      currency: input.currency,
      description: `Encaissement via ${input.providerId}`,
      entries: [
        { account: accounts.providerClearing(input.providerId), side: 'DEBIT', amount: input.amount },
        { account: accounts.merchantReceivable(input.merchantId), side: 'CREDIT', amount: net },
        ...(input.providerFee > 0
          ? [
              {
                account: accounts.providerFees(input.providerId),
                side: 'CREDIT' as Side,
                amount: input.providerFee,
              },
            ]
          : []),
        ...(input.platformFee > 0
          ? [{ account: accounts.orchiRevenue(), side: 'CREDIT' as Side, amount: input.platformFee }]
          : []),
      ],
    },
    tx,
  );
}

export interface PayoutPostingInput {
  merchantId: string;
  payoutId: string;
  providerId: string;
  currency: string;
  amount: number;
  providerFee: number;
  platformFee: number;
}

export async function postPayoutSucceeded(
  input: PayoutPostingInput,
  tx: Prisma.TransactionClient = prisma,
): Promise<void> {
  // Le marchand est debite du montant verse ET de toutes les commissions : un
  // decaissement de 50 000 a 5 % lui coute 52 500 au total.
  await postJournal(
    {
      merchantId: input.merchantId,
      type: 'payout.succeeded',
      refType: 'payout',
      refId: input.payoutId,
      currency: input.currency,
      description: `Decaissement via ${input.providerId}`,
      entries: [
        {
          account: accounts.merchantPayable(input.merchantId),
          side: 'DEBIT',
          amount: input.amount + input.providerFee + input.platformFee,
        },
        { account: accounts.providerClearing(input.providerId), side: 'CREDIT', amount: input.amount },
        ...(input.providerFee > 0
          ? [
              {
                account: accounts.providerFees(input.providerId),
                side: 'CREDIT' as Side,
                amount: input.providerFee,
              },
            ]
          : []),
        ...(input.platformFee > 0
          ? [{ account: accounts.orchiRevenue(), side: 'CREDIT' as Side, amount: input.platformFee }]
          : []),
      ],
    },
    tx,
  );
}

/* -------------------------------------------------------------------------- */
/* Lecture                                                                    */
/* -------------------------------------------------------------------------- */

export interface AccountBalance {
  account: string;
  currency: string;
  debit: number;
  credit: number;
  /** Solde en convention debit : positif = le compte doit.  */
  balance: number;
}

export async function accountBalances(merchantId: string): Promise<AccountBalance[]> {
  const entries = await prisma.ledgerEntry.findMany({
    where: { journal: { merchantId } },
    select: { account: true, side: true, amount: true, currency: true },
  });

  const map = new Map<string, AccountBalance>();
  for (const entry of entries) {
    const key = `${entry.account}|${entry.currency}`;
    const current =
      map.get(key) ?? { account: entry.account, currency: entry.currency, debit: 0, credit: 0, balance: 0 };
    if (entry.side === 'DEBIT') current.debit += entry.amount;
    else current.credit += entry.amount;
    current.balance = current.debit - current.credit;
    map.set(key, current);
  }

  return [...map.values()].sort((a, b) => a.account.localeCompare(b.account));
}

/** Verifie que l'ensemble des journaux d'un marchand s'equilibre par devise. */
export async function assertLedgerBalanced(merchantId: string): Promise<void> {
  const balances = await accountBalances(merchantId);
  const byCurrency = new Map<string, number>();
  for (const b of balances) {
    byCurrency.set(b.currency, (byCurrency.get(b.currency) ?? 0) + b.balance);
  }
  for (const [currency, total] of byCurrency) {
    if (total !== 0) {
      throw new Error(`Ledger desequilibre pour ${merchantId} en ${currency} : ${total}.`);
    }
  }
}
