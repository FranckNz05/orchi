import type { Partner, PartnerSettlement, Prisma } from '@prisma/client';
import type { Channel } from '../catalog/coverage.js';
import { getCountry } from '../catalog/countries.js';
import { env } from '../core/env.js';
import { errors } from '../core/errors.js';
import { ID_PREFIX, newId } from '../core/ids.js';
import { logger } from '../core/logger.js';
import { prisma } from '../db/client.js';
import { createPayout } from './payouts.js';

/**
 * Repartition differee aux partenaires.
 *
 * LE BESOIN : des qu'un marchand encaisse, une part doit revenir a des
 * partenaires configures a l'avance.
 *
 * POURQUOI DIFFERE, ET POURQUOI GROUPE
 *
 * Verser a l'instant du paiement est impossible, et pour deux raisons qui n'ont
 * rien de technique :
 *
 *  1. Les fonds ne sont pas la. Un encaissement « reussi » veut dire que le
 *     client a paye, pas que l'argent est disponible sur le compte agregateur
 *     du marchand — les agregateurs reglent a J+1 ou J+2. Un versement immediat
 *     echouerait pour solde insuffisant.
 *  2. Chaque versement coute. En modele A, un decaissement supporte le taux
 *     complet. Verser a trois partenaires a chaque transaction, c'est trois
 *     frais par transaction : la repartition couterait vite plus que ce qu'elle
 *     distribue.
 *
 * D'ou ce decoupage en deux temps :
 *
 *   ACCUMULATION  a chaque encaissement reussi, on ECRIT ce qui est du, sans
 *                 rien verser. Dans la meme transaction que le paiement.
 *   REGLEMENT     une fois par cycle, toutes les accumulations echues d'un
 *                 partenaire sont regroupees en UN SEUL decaissement.
 *
 * Trois cents encaissements produisent ainsi un versement par jour et par
 * partenaire, pas trois cents.
 */

/* -------------------------------------------------------------------------- */
/* Configuration                                                              */
/* -------------------------------------------------------------------------- */

export interface UpsertPartnerInput {
  merchantId: string;
  environment: 'test' | 'live';
  reference: string;
  name: string;
  country: string;
  currency: string;
  channel: Channel;
  shareBps: number;
  shareBase?: 'gross' | 'net';
  recipient: {
    phone?: string;
    network?: string;
    accountNumber?: string;
    bankCode?: string;
    name?: string;
  };
}

export interface PartnerView {
  id: string;
  reference: string;
  name: string;
  environment: string;
  country: string;
  currency: string;
  channel: string;
  share_bps: number;
  share_base: string;
  status: string;
  created_at: string;
}

function toView(p: Partner): PartnerView {
  return {
    id: p.id,
    reference: p.reference,
    name: p.name,
    environment: p.environment,
    country: p.country,
    currency: p.currency,
    channel: p.channel,
    share_bps: p.shareBps,
    share_base: p.shareBase,
    status: p.status,
    created_at: p.createdAt.toISOString(),
  };
}

/**
 * Somme maximale des parts actives d'un marchand.
 *
 * Volontairement strictement inferieure a 100 % : un marchand qui aurait
 * engage 100 % de son encaissement ne garderait rien pour payer la commission
 * Orchi, qui lui est facturee hors flux. Il se retrouverait debiteur a chaque
 * vente reussie — le genre de configuration qu'il vaut mieux refuser que
 * d'honorer.
 */
const MAX_TOTAL_SHARE_BPS = 9_000;

export async function upsertPartner(input: UpsertPartnerInput): Promise<PartnerView> {
  const country = getCountry(input.country);
  if (!country) throw errors.invalidRequest(`Pays hors catalogue : ${input.country}.`, 'country');

  if (country.currency !== input.currency.toUpperCase()) {
    throw errors.invalidRequest(
      `La devise de ${country.name} est ${country.currency}, pas ${input.currency.toUpperCase()}.`,
      'currency',
      { expected: country.currency },
    );
  }

  // Verifie A LA CONFIGURATION, pas au moment du versement : decouvrir qu'un
  // pays ne supporte pas le decaissement le jour ou l'on doit payer un
  // partenaire, c'est le decouvrir trop tard.
  if (country.payoutMode === 'NONE') {
    throw errors.invalidRequest(
      `Aucune voie de decaissement n'existe pour ${country.name} : ce partenaire ne pourrait jamais etre paye.`,
      'country',
      { note: country.payoutNote },
    );
  }

  if (!Number.isInteger(input.shareBps) || input.shareBps <= 0) {
    throw errors.invalidRequest('La part doit etre un entier positif en points de base.', 'share_bps');
  }

  if (input.channel === 'mobile_money' && !input.recipient.phone) {
    throw errors.invalidRequest(
      'Un numero de telephone est requis pour un partenaire paye par mobile money.',
      'recipient.phone',
    );
  }
  if (input.channel === 'bank_transfer' && !input.recipient.accountNumber) {
    throw errors.invalidRequest(
      'Un numero de compte est requis pour un partenaire paye par virement.',
      'recipient.account_number',
    );
  }

  const autres = await prisma.partner.findMany({
    where: {
      merchantId: input.merchantId,
      environment: input.environment,
      status: 'ACTIVE',
      reference: { not: input.reference },
    },
    select: { shareBps: true },
  });

  const total = autres.reduce((n, p) => n + p.shareBps, 0) + input.shareBps;
  if (total > MAX_TOTAL_SHARE_BPS) {
    throw errors.invalidRequest(
      `La somme des parts partenaires atteindrait ${(total / 100).toFixed(2)} %, au-dela du plafond de ${MAX_TOTAL_SHARE_BPS / 100} %.`,
      'share_bps',
      { total_bps: total, max_bps: MAX_TOTAL_SHARE_BPS },
    );
  }

  const data = {
    name: input.name,
    country: country.iso2,
    currency: country.currency,
    channel: input.channel,
    shareBps: input.shareBps,
    shareBase: input.shareBase ?? 'net',
    status: 'ACTIVE',
    recipientPhone: input.recipient.phone ?? null,
    recipientNetwork: input.recipient.network ?? null,
    recipientAccountNumber: input.recipient.accountNumber ?? null,
    recipientBankCode: input.recipient.bankCode ?? null,
    recipientName: input.recipient.name ?? null,
  };

  const partner = await prisma.partner.upsert({
    where: {
      merchantId_reference_environment: {
        merchantId: input.merchantId,
        reference: input.reference,
        environment: input.environment,
      },
    },
    create: {
      id: newId(ID_PREFIX.partner),
      merchantId: input.merchantId,
      reference: input.reference,
      environment: input.environment,
      ...data,
    },
    update: data,
  });

  return toView(partner);
}

export async function listPartners(
  merchantId: string,
  environment: 'test' | 'live',
): Promise<PartnerView[]> {
  const partners = await prisma.partner.findMany({
    where: { merchantId, environment },
    orderBy: [{ createdAt: 'asc' }],
  });
  return partners.map(toView);
}

/**
 * Desactive un partenaire.
 *
 * N'annule PAS ses accumulations en attente : ce qui lui est deja du reste du.
 * Couper la configuration et effacer une dette sont deux gestes differents, et
 * les confondre serait une facon discrete de ne pas payer.
 */
export async function disablePartner(merchantId: string, partnerId: string): Promise<void> {
  const partner = await prisma.partner.findFirst({ where: { id: partnerId, merchantId } });
  if (!partner) throw errors.notFound('Partenaire', partnerId);
  await prisma.partner.update({ where: { id: partnerId }, data: { status: 'DISABLED' } });
}

/* -------------------------------------------------------------------------- */
/* Accumulation                                                               */
/* -------------------------------------------------------------------------- */

export interface AccrualInput {
  merchantId: string;
  paymentId: string;
  environment: string;
  currency: string;
  amount: number;
  providerFee: number;
  platformFee: number;
  succeededAt: Date;
}

/**
 * Calcule et ecrit ce que cet encaissement doit a chaque partenaire actif.
 *
 * L'ARRONDI, ET QUI ABSORBE LE RESTE
 *
 * Des points de base appliques a des entiers ne tombent jamais juste. La regle
 * retenue, et elle doit figurer au contrat : chaque part est arrondie A
 * L'INFERIEUR, et le reste demeure au marchand. Deux consequences voulues :
 * la somme versee ne peut jamais depasser l'assiette, et un partenaire n'est
 * jamais paye au-dela de sa part. Arrondir au superieur ferait payer au
 * marchand des centimes qu'il n'a pas encaisses, a chaque transaction.
 *
 * Les parts nulles apres arrondi ne produisent PAS de ligne : accumuler zero
 * n'informe personne et encombre le rapprochement.
 */
export async function accruePartnerShares(
  input: AccrualInput,
  tx: Prisma.TransactionClient = prisma,
): Promise<number> {
  const partners = await tx.partner.findMany({
    where: { merchantId: input.merchantId, environment: input.environment, status: 'ACTIVE' },
    orderBy: { createdAt: 'asc' },
  });
  if (partners.length === 0) return 0;

  // L'assiette `net` retire TOUT ce que la transaction coute au marchand, y
  // compris la commission Orchi qui lui sera facturee hors flux. C'est la seule
  // definition qui ne l'engage pas au-dela de ce qu'il garde reellement.
  const gross = input.amount;
  const net = Math.max(0, input.amount - input.providerFee - input.platformFee);
  const dueAt = new Date(input.succeededAt.getTime() + env.PARTNER_SETTLEMENT_DELAY_MS);

  let ecrites = 0;
  for (const partner of partners) {
    const base = partner.shareBase === 'gross' ? gross : net;
    const amount = Math.floor((base * partner.shareBps) / 10_000);
    if (amount <= 0) continue;

    // La devise du partenaire doit etre celle de l'encaissement : Orchi ne
    // convertit pas. Un partenaire en XOF ne peut pas etre paye sur une vente
    // en KES, et l'inventer serait pire que de ne rien faire.
    if (partner.currency !== input.currency.toUpperCase()) {
      logger.warn(
        {
          partner_id: partner.id,
          payment_id: input.paymentId,
          partner_currency: partner.currency,
          payment_currency: input.currency,
        },
        'Part partenaire ignoree : devise differente de celle de l encaissement',
      );
      continue;
    }

    await tx.partnerAccrual.create({
      data: {
        id: newId(ID_PREFIX.partnerAccrual),
        partnerId: partner.id,
        merchantId: input.merchantId,
        paymentId: input.paymentId,
        currency: partner.currency,
        baseAmount: base,
        amount,
        shareBps: partner.shareBps,
        dueAt,
      },
    });
    ecrites += 1;
  }

  return ecrites;
}

/* -------------------------------------------------------------------------- */
/* Reglement                                                                  */
/* -------------------------------------------------------------------------- */

export interface SettlementRunResult {
  groupes: number;
  verses: number;
  reportes: number;
  echecs: number;
  bloques: number;
}

/**
 * Regroupe les accumulations echues et declenche un versement par partenaire.
 *
 * L'ETAT INDETERMINE COMMANDE TOUT
 *
 * Un decaissement peut finir dans trois etats, et le troisieme dicte la
 * structure de cette fonction :
 *
 *   SUCCEEDED  le partenaire est paye, les accumulations sont consommees.
 *   FAILED     echec EXPLICITE, l'agregateur garantit n'avoir rien traite. Les
 *              accumulations sont RELACHEES et repartiront au cycle suivant.
 *   UNKNOWN    on ignore si l'argent est parti. Les accumulations restent
 *              consommees et le reglement passe en BLOCKED. Les relacher
 *              enverrait un second versement sur des fonds peut-etre deja
 *              partis — exactement le double paiement que tout le reste du
 *              systeme s'emploie a rendre impossible.
 *
 * Les accumulations sont donc marquees SETTLED **avant** l'appel sortant. En
 * cas d'interruption entre les deux, elles restent rattachees a un reglement
 * PENDING : visible, rattrapable, et surtout jamais versee deux fois.
 */
export async function runPartnerSettlements(now: Date = new Date()): Promise<SettlementRunResult> {
  const result: SettlementRunResult = { groupes: 0, verses: 0, reportes: 0, echecs: 0, bloques: 0 };

  const echues = await prisma.partnerAccrual.findMany({
    where: { status: 'PENDING', dueAt: { lte: now } },
    select: { id: true, partnerId: true, currency: true, amount: true },
  });
  if (echues.length === 0) return result;

  const groupes = new Map<string, { partnerId: string; currency: string; ids: string[]; total: number }>();
  for (const a of echues) {
    const cle = `${a.partnerId}|${a.currency}`;
    const g = groupes.get(cle) ?? { partnerId: a.partnerId, currency: a.currency, ids: [], total: 0 };
    g.ids.push(a.id);
    g.total += a.amount;
    groupes.set(cle, g);
  }

  result.groupes = groupes.size;

  for (const groupe of groupes.values()) {
    const partner = await prisma.partner.findUnique({ where: { id: groupe.partnerId } });
    if (!partner) continue;

    // Sous le seuil, on REPORTE : les accumulations restent en attente et
    // grossiront. On n'annule rien — la somme reste due.
    if (groupe.total < env.PARTNER_SETTLEMENT_MIN_MINOR) {
      result.reportes += 1;
      continue;
    }

    const settlement = await prisma.$transaction(async (tx) => {
      const created = await tx.partnerSettlement.create({
        data: {
          id: newId(ID_PREFIX.partnerSettlement),
          partnerId: partner.id,
          merchantId: partner.merchantId,
          environment: partner.environment,
          currency: groupe.currency,
          amount: groupe.total,
          accrualCount: groupe.ids.length,
        },
      });

      // Consommation AVANT l'appel sortant : voir l'en-tete.
      await tx.partnerAccrual.updateMany({
        where: { id: { in: groupe.ids }, status: 'PENDING' },
        data: { status: 'SETTLED', settlementId: created.id },
      });

      return created;
    });

    await payerReglement(settlement, partner, result);
  }

  return result;
}

async function payerReglement(
  settlement: PartnerSettlement,
  partner: Partner,
  result: SettlementRunResult,
): Promise<void> {
  try {
    const { payout } = await createPayout({
      merchantId: partner.merchantId,
      environment: partner.environment === 'live' ? 'live' : 'test',
      // La reference porte l'identifiant du reglement : rejouer ce versement
      // retombe sur le meme decaissement plutot que d'en creer un second.
      reference: `partner-${settlement.id}`,
      amount: settlement.amount,
      currency: settlement.currency,
      country: partner.country,
      channel: partner.channel as Channel,
      recipient: {
        ...(partner.recipientPhone ? { phone: partner.recipientPhone } : {}),
        ...(partner.recipientNetwork ? { network: partner.recipientNetwork } : {}),
        ...(partner.recipientAccountNumber ? { accountNumber: partner.recipientAccountNumber } : {}),
        ...(partner.recipientBankCode ? { bankCode: partner.recipientBankCode } : {}),
        ...(partner.recipientName ? { name: partner.recipientName } : {}),
      },
      description: `Repartition ${partner.name} (${settlement.accrualCount} encaissements)`,
      metadata: { orchi_partner_settlement: settlement.id, orchi_partner: partner.reference },
    });

    if (payout.status === 'SUCCEEDED') {
      await prisma.partnerSettlement.update({
        where: { id: settlement.id },
        data: { status: 'PAID', payoutId: payout.id },
      });
      result.verses += 1;
      return;
    }

    if (payout.status === 'UNKNOWN') {
      await prisma.partnerSettlement.update({
        where: { id: settlement.id },
        data: { status: 'BLOCKED', payoutId: payout.id, failureReason: 'Decaissement d issue indeterminee' },
      });
      result.bloques += 1;
      logger.error(
        { settlement_id: settlement.id, payout_id: payout.id, partner_id: partner.id },
        'Reglement partenaire bloque : issue indeterminee, accumulations non relachees',
      );
      return;
    }

    if (payout.status === 'FAILED') {
      await relacher(settlement, `Decaissement en echec (${payout.id})`);
      result.echecs += 1;
      return;
    }

    // CREATED ou PROCESSING : le versement suit son cours, le reglement reste
    // PENDING et le balayeur de reconciliation tranchera.
    await prisma.partnerSettlement.update({
      where: { id: settlement.id },
      data: { payoutId: payout.id },
    });
  } catch (e) {
    // Un refus AVANT tout appel sortant — pays sans decaissement, aucun
    // agregateur disponible, montant invalide. Rien n'est parti : on relache.
    await relacher(settlement, (e as Error).message.slice(0, 400));
    result.echecs += 1;
    logger.warn(
      { settlement_id: settlement.id, partner_id: partner.id, err: (e as Error).message },
      'Reglement partenaire impossible, accumulations relachees',
    );
  }
}

/**
 * Rend les accumulations a l'etat en attente. Reservee aux echecs dont on sait
 * qu'aucun fonds n'a bouge — jamais a un etat indetermine.
 */
async function relacher(settlement: PartnerSettlement, raison: string): Promise<void> {
  await prisma.$transaction(async (tx) => {
    await tx.partnerAccrual.updateMany({
      where: { settlementId: settlement.id },
      data: { status: 'PENDING', settlementId: null },
    });
    await tx.partnerSettlement.update({
      where: { id: settlement.id },
      data: { status: 'FAILED', failureReason: raison },
    });
  });
}

/* -------------------------------------------------------------------------- */
/* Lecture                                                                    */
/* -------------------------------------------------------------------------- */

/** Ce qu'un marchand doit a ses partenaires et qui n'est pas encore verse. */
export async function pendingByPartner(
  merchantId: string,
  environment: 'test' | 'live',
): Promise<Array<{ partner: PartnerView; currency: string; pending: number; accruals: number }>> {
  const partners = await prisma.partner.findMany({ where: { merchantId, environment } });
  const out = [];

  for (const partner of partners) {
    const agg = await prisma.partnerAccrual.aggregate({
      where: { partnerId: partner.id, status: 'PENDING' },
      _sum: { amount: true },
      _count: true,
    });
    out.push({
      partner: toView(partner),
      currency: partner.currency,
      pending: agg._sum.amount ?? 0,
      accruals: agg._count,
    });
  }

  return out;
}

export async function listSettlements(
  merchantId: string,
  environment: 'test' | 'live',
  limit = 50,
): Promise<PartnerSettlement[]> {
  return prisma.partnerSettlement.findMany({
    where: { merchantId, environment },
    orderBy: { createdAt: 'desc' },
    take: Math.min(limit, 200),
  });
}
