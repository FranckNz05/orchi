import type { MerchantSettlement, Prisma } from '@prisma/client';
import { AppError, errors } from '../core/errors.js';
import { env } from '../core/env.js';
import { ID_PREFIX, newId } from '../core/ids.js';
import { prisma } from '../db/client.js';
import { accounts, postJournal } from './ledger.js';

/**
 * Reversement aux marchands.
 *
 * Quand un encaissement passe par un compte agregateur d'Afripaie
 * (PLATFORM_MERCHANT_ID), l'argent arrive chez Afripaie, qui retient sa
 * commission et doit le net au marchand : c'est le solde de
 * `merchant:{id}:held`. Ce module dit combien est du, ou se trouve l'argent, et
 * constate chaque reversement.
 *
 * Deux facons de reverser :
 *   - MANUELLE (ici) : l'administrateur vire chez la banque ou l'operateur,
 *     puis constate le virement avec sa reference. Seule possibilite pour
 *     GeniusPay, qui n'expose aucune API de decaissement.
 *   - AUTOMATIQUE (settlements-auto.ts) : Afripaie decaisse elle-meme en
 *     mobile money depuis son compte agregateur, la ou il le permet (Yabetoo
 *     au Congo).
 *
 * Le solde est decoupe par AGREGATEUR : les francs encaisses par Yabetoo sont
 * sur le compte Yabetoo d'Afripaie, ceux de GeniusPay sur le compte GeniusPay.
 * Un reversement sort d'un compte precis ; il ne peut pas depasser ce que ce
 * compte detient pour ce marchand.
 */

export const SETTLEMENT_METHODS = ['BANK_TRANSFER', 'MOBILE_MONEY', 'OTHER'] as const;
export type SettlementMethod = (typeof SETTLEMENT_METHODS)[number];

export interface HeldBalance {
  environment: 'test' | 'live';
  currency: string;
  /** Agregateur sur lequel les fonds se trouvent. */
  provider: string;
  /** Total du au marchand. */
  held: number;
  /** Encaisse depuis moins de MERCHANT_SETTLEMENT_DELAY_MS : pas encore regle par l'agregateur. */
  maturing: number;
  /** Reversable maintenant. */
  available: number;
  /** Des que le plus ancien encaissement en cours de reglement devient reversable. */
  availableAt?: Date | null;
}

export const settlementErrors = {
  insufficient: (b: { available: number; held: number; currency: string; provider: string }) =>
    new AppError({
      type: 'invalid_request_error',
      code: 'settlement_exceeds_available',
      message:
        `Montant supérieur au disponible : ${b.available} ${b.currency} reversables sur ${b.provider}` +
        (b.held > b.available ? ` (${b.held - b.available} encore en attente de règlement par l’agrégateur).` : '.'),
      httpStatus: 400,
      retriable: false,
      param: 'amount',
      details: { available: b.available, held: b.held },
    }),
  notCancellable: (status: string) =>
    new AppError({
      type: 'invalid_request_error',
      code: 'settlement_not_cancellable',
      message: `Reversement déjà ${status === 'CANCELLED' ? 'annulé' : status}.`,
      httpStatus: 409,
      retriable: false,
    }),
} as const;

const CLEARING = /^provider:(.+):clearing$/;

/**
 * Solde du au marchand, par environnement, devise et agregateur.
 *
 * Calcule depuis le grand livre, et non depuis les paiements : c'est la seule
 * source qui tienne compte a la fois des encaissements, des reversements et de
 * leurs annulations. L'agregateur d'un mouvement est celui dont le compte de
 * transit est mouvemente dans le meme journal.
 */
export async function heldBalances(
  merchantId: string,
  now = new Date(),
  db: Prisma.TransactionClient = prisma,
): Promise<HeldBalance[]> {
  const heldAccount = accounts.merchantHeld(merchantId);
  const journals = await db.ledgerJournal.findMany({
    where: { merchantId, entries: { some: { account: heldAccount } } },
    include: { entries: true },
  });
  if (journals.length === 0) return [];

  const ids = (type: string) => journals.filter((j) => j.refType === type).map((j) => j.refId);
  const [payments, settlements] = await Promise.all([
    db.payment.findMany({
      where: { id: { in: ids('payment') } },
      select: { id: true, environment: true, succeededAt: true },
    }),
    db.merchantSettlement.findMany({
      where: { id: { in: ids('settlement') } },
      select: { id: true, environment: true },
    }),
  ]);
  const paymentById = new Map(payments.map((p) => [p.id, p]));
  const settlementEnv = new Map(settlements.map((s) => [s.id, s.environment]));
  const matureBefore = now.getTime() - env.MERCHANT_SETTLEMENT_DELAY_MS;

  const map = new Map<string, HeldBalance>();
  for (const journal of journals) {
    const provider = journal.entries.map((e) => CLEARING.exec(e.account)?.[1]).find(Boolean);
    const payment = journal.refType === 'payment' ? paymentById.get(journal.refId) : undefined;
    const environment = (payment?.environment ?? settlementEnv.get(journal.refId)) === 'live' ? 'live' : 'test';
    if (!provider) continue;

    const key = `${environment}|${journal.currency}|${provider}`;
    const balance =
      map.get(key) ??
      { environment, currency: journal.currency, provider, held: 0, maturing: 0, available: 0 };

    for (const entry of journal.entries) {
      if (entry.account !== heldAccount) continue;
      const signed = entry.side === 'CREDIT' ? entry.amount : -entry.amount;
      balance.held += signed;
      const succeeded = payment?.succeededAt ?? journal.createdAt;
      if (payment && signed > 0 && succeeded.getTime() > matureBefore) {
        balance.maturing += signed;
        const at = new Date(succeeded.getTime() + env.MERCHANT_SETTLEMENT_DELAY_MS);
        if (!balance.availableAt || at < balance.availableAt) balance.availableAt = at;
      }
    }
    map.set(key, balance);
  }

  return [...map.values()]
    .map((b) => {
      // Le non-regle ne peut pas exceder le du : ce qui a deja ete reverse sort
      // d'abord des fonds les plus anciens.
      const maturing = Math.min(b.maturing, Math.max(0, b.held));
      return {
        ...b,
        maturing,
        available: Math.max(0, b.held - maturing),
        availableAt: maturing > 0 ? (b.availableAt ?? null) : null,
      };
    })
    .filter((b) => b.held !== 0)
    .sort((a, b) => `${a.environment}${a.currency}${a.provider}`.localeCompare(`${b.environment}${b.currency}${b.provider}`));
}

export interface RecordSettlementInput {
  merchantId: string;
  environment: 'test' | 'live';
  currency: string;
  amount: number;
  sourceProviderId: string;
  method: SettlementMethod;
  destination: string;
  externalReference: string;
  note?: string;
  actorId: string;
  actorEmail: string;
}

/**
 * Constate un reversement deja effectue.
 *
 * Le montant est plafonne au DISPONIBLE de l'agregateur source : reverser des
 * fonds que l'agregateur n'a pas encore regles, ou qui se trouvent sur un
 * autre compte, revient a avancer l'argent des autres marchands.
 */
export async function recordSettlement(input: RecordSettlementInput): Promise<MerchantSettlement> {
  if (!Number.isInteger(input.amount) || input.amount <= 0) {
    throw errors.invalidRequest('Le montant doit être un entier positif, en unités mineures.', 'amount');
  }
  const currency = input.currency.toUpperCase();

  const merchant = await prisma.merchant.findUnique({ where: { id: input.merchantId } });
  if (!merchant) throw errors.notFound('Marchand', input.merchantId);

  return prisma.$transaction(async (tx) => {
    // Verrou sur le marchand : deux reversements simultanes liraient sinon le
    // meme disponible, et le depasseraient a eux deux. Une ecriture sur la
    // ligne suffit a serialiser, en PostgreSQL comme en SQLite.
    await tx.merchant.update({ where: { id: input.merchantId }, data: { updatedAt: new Date() } });

    const balance = (await heldBalances(input.merchantId, new Date(), tx)).find(
      (b) =>
        b.environment === input.environment && b.currency === currency && b.provider === input.sourceProviderId,
    ) ?? { environment: input.environment, currency, provider: input.sourceProviderId, held: 0, maturing: 0, available: 0 };

    if (input.amount > balance.available) throw settlementErrors.insufficient(balance);

    const settlement = await tx.merchantSettlement.create({
      data: {
        id: newId(ID_PREFIX.merchantSettlement),
        merchantId: input.merchantId,
        environment: input.environment,
        currency,
        amount: input.amount,
        sourceProviderId: input.sourceProviderId,
        method: input.method,
        destination: input.destination.trim(),
        externalReference: input.externalReference.trim(),
        note: input.note?.trim() || null,
        actorId: input.actorId,
        actorEmail: input.actorEmail,
      },
    });

    await postSettlementJournal(tx, settlement, 'settlement.paid');
    return settlement;
  });
}

/**
 * Annule un reversement enregistre par erreur (mauvais montant, virement
 * rejete par la banque).
 *
 * L'enregistrement n'est pas supprime : un contre-journal remet le solde du au
 * marchand, et la ligne garde qui l'a annule et pourquoi.
 */
export async function cancelSettlement(input: {
  settlementId: string;
  reason: string;
  actorEmail: string;
}): Promise<MerchantSettlement> {
  const current = await prisma.merchantSettlement.findUnique({ where: { id: input.settlementId } });
  if (!current) throw errors.notFound('Reversement', input.settlementId);
  if (current.status !== 'PAID') throw settlementErrors.notCancellable(current.status);
  if (current.mode !== 'MANUAL') {
    // Un decaissement automatique reussi a reellement quitte le compte : le
    // declarer annule rendrait au marchand de l'argent qu'il a deja recu.
    throw new AppError({
      type: 'invalid_request_error',
      code: 'settlement_not_cancellable',
      message: 'Un reversement automatique abouti ne s’annule pas : l’argent est parti.',
      httpStatus: 409,
      retriable: false,
    });
  }

  return prisma.$transaction(async (tx) => {
    // Garde contre une double annulation concurrente : seule la premiere
    // trouve encore la ligne a PAID.
    const { count } = await tx.merchantSettlement.updateMany({
      where: { id: current.id, status: 'PAID' },
      data: {
        status: 'CANCELLED',
        cancelledAt: new Date(),
        cancelledBy: input.actorEmail,
        cancelReason: input.reason.trim(),
      },
    });
    if (count === 0) throw settlementErrors.notCancellable('CANCELLED');

    await postSettlementJournal(tx, current, 'settlement.cancelled');
    return tx.merchantSettlement.findUniqueOrThrow({ where: { id: current.id } });
  });
}

/**
 * paid, sent          : la dette envers le marchand diminue (debit held), les
 *                       fonds quittent le compte de l'agregateur (credit
 *                       clearing). `sent` reserve le montant DES l'envoi d'un
 *                       reversement automatique, avant toute reponse.
 * cancelled, reversed : l'inverse exact (annulation manuelle, decaissement
 *                       refuse).
 */
export async function postSettlementJournal(
  tx: Prisma.TransactionClient,
  s: MerchantSettlement,
  type: 'settlement.paid' | 'settlement.cancelled' | 'settlement.sent' | 'settlement.reversed',
): Promise<void> {
  const paid = type === 'settlement.paid' || type === 'settlement.sent';
  await postJournal(
    {
      merchantId: s.merchantId,
      type,
      refType: 'settlement',
      refId: s.id,
      currency: s.currency,
      description: {
        'settlement.paid': `Reversement depuis ${s.sourceProviderId} (${s.method}, ref. ${s.externalReference})`,
        'settlement.sent': `Reversement automatique vers ${s.destination} via ${s.sourceProviderId}`,
        'settlement.cancelled': `Annulation du reversement ${s.id}`,
        'settlement.reversed': `Decaissement refuse : reversement ${s.id} de nouveau du`,
      }[type],
      // Les frais de decaissement sont a la charge d'Afripaie (taux total de 5 %
      // tout compris) : ils sortent de son revenu, pas de la creance du marchand.
      entries: [
        { account: accounts.merchantHeld(s.merchantId), side: paid ? 'DEBIT' : 'CREDIT', amount: s.amount },
        ...(s.providerFeeAmount > 0
          ? [{ account: accounts.afripaieRevenue(), side: (paid ? 'DEBIT' : 'CREDIT') as 'DEBIT' | 'CREDIT', amount: s.providerFeeAmount }]
          : []),
        {
          account: accounts.providerClearing(s.sourceProviderId),
          side: paid ? 'CREDIT' : 'DEBIT',
          amount: s.amount + s.providerFeeAmount,
        },
      ],
    },
    tx,
  );
}

export async function listSettlements(merchantId: string, environment?: 'test' | 'live') {
  return prisma.merchantSettlement.findMany({
    where: { merchantId, ...(environment ? { environment } : {}) },
    orderBy: { createdAt: 'desc' },
    take: 200,
  });
}

/**
 * Vue marchand. `actor_email` n'en fait PAS partie : l'adresse de
 * l'administrateur n'a pas a sortir de la plateforme.
 */
export function serializeSettlement(s: MerchantSettlement, forAdmin = false) {
  return {
    object: 'settlement',
    id: s.id,
    environment: s.environment,
    status: s.status,
    amount: s.amount,
    currency: s.currency,
    source_provider: s.sourceProviderId,
    method: s.method,
    destination: s.destination,
    external_reference: s.externalReference,
    note: s.note,
    mode: s.mode,
    beneficiary_name: s.beneficiaryName,
    approval_reason: s.approvalReason,
    decision_note: s.decisionNote,
    decided_at: s.decidedAt?.toISOString() ?? null,
    /** Somme reellement envoyee : le montant du, plus les frais pris en charge par Afripaie. */
    sent_amount: s.amount + s.providerFeeAmount,
    fee_absorbed: s.providerFeeAmount,
    network: s.network,
    provider_reference: s.providerReference,
    failure_reason: s.failureReason,
    checked_at: s.checkedAt?.toISOString() ?? null,
    created_at: s.createdAt.toISOString(),
    cancelled_at: s.cancelledAt?.toISOString() ?? null,
    cancel_reason: s.cancelReason,
    ...(forAdmin ? { recorded_by: s.actorEmail, cancelled_by: s.cancelledBy, decided_by: s.decidedBy } : {}),
  };
}

export function serializeBalance(b: HeldBalance) {
  return {
    environment: b.environment,
    currency: b.currency,
    provider: b.provider,
    held: b.held,
    maturing: b.maturing,
    available: b.available,
    available_at: b.availableAt?.toISOString() ?? null,
  };
}

/**
 * D'ou vient le solde, par agregateur et par devise : ce que les clients ont
 * paye, ce que l'agregateur et Afripaie ont retenu, ce qui revient au marchand,
 * ce qui en est deja sorti (retraits verses) ou reserve (retraits en cours ou en
 * attente de validation). `balance` = ce qui reste du.
 *
 * Seuls les paiements encaisses sur les comptes d'Afripaie comptent : sur ses
 * propres comptes, le marchand recoit l'argent directement de l'agregateur.
 */
export async function splitSummary(merchantId: string, environment: string) {
  const payments = await prisma.payment.findMany({
    where: {
      merchantId,
      environment,
      status: 'SUCCEEDED',
      attempts: { some: { status: 'SUCCEEDED', providerAccount: { merchantId: { not: merchantId } } } },
    },
    select: {
      amount: true,
      currency: true,
      providerFeeAmount: true,
      platformFeeAmount: true,
      attempts: { where: { status: 'SUCCEEDED' }, select: { providerId: true }, take: 1 },
    },
  });
  const settlements = await prisma.merchantSettlement.findMany({ where: { merchantId, environment } });

  type Row = {
    currency: string; provider: string; payments: number; customer_paid: number; aggregator_fees: number;
    afripaie_fees: number; merchant_net: number; withdrawn: number; withdrawing: number; balance: number;
  };
  const rows = new Map<string, Row>();
  const row = (currency: string, provider: string): Row => {
    const key = `${currency}:${provider}`;
    let r = rows.get(key);
    if (!r) {
      r = { currency, provider, payments: 0, customer_paid: 0, aggregator_fees: 0, afripaie_fees: 0, merchant_net: 0, withdrawn: 0, withdrawing: 0, balance: 0 };
      rows.set(key, r);
    }
    return r;
  };

  for (const p of payments) {
    const r = row(p.currency, p.attempts[0]?.providerId ?? 'inconnu');
    const agg = p.providerFeeAmount ?? 0;
    const afr = p.platformFeeAmount ?? 0;
    r.payments += 1;
    r.customer_paid += p.amount;
    r.aggregator_fees += agg;
    r.afripaie_fees += afr;
    r.merchant_net += p.amount - agg - afr;
  }
  for (const st of settlements) {
    const r = row(st.currency, st.sourceProviderId);
    if (st.status === 'PAID') r.withdrawn += st.amount;
    else if (['PENDING_APPROVAL', 'PROCESSING', 'UNKNOWN'].includes(st.status)) r.withdrawing += st.amount;
  }
  for (const r of rows.values()) r.balance = r.merchant_net - r.withdrawn - r.withdrawing;
  return [...rows.values()];
}

