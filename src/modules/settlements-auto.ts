import type { MerchantSettlement, MerchantSettlementTarget } from '@prisma/client';
import { countryFromPhone } from '../catalog/market.js';
import { AppError, errors } from '../core/errors.js';
import { env } from '../core/env.js';
import { ID_PREFIX, newId } from '../core/ids.js';
import { logger } from '../core/logger.js';
import { prisma } from '../db/client.js';
import { isProviderError } from '../providers/errors.js';
import { getProviderAdapter } from '../providers/registry.js';
import type { AttemptResult } from '../providers/types.js';
import { buildProviderContext } from './provider-accounts.js';
import { heldBalances, postSettlementJournal, settlementErrors } from './settlements.js';

/**
 * Reversement AUTOMATIQUE : Afripaie decaisse elle-meme, en mobile money, ce
 * qu'elle doit au marchand, depuis son propre compte agregateur.
 *
 * Seul Yabetoo le permet aujourd'hui (Congo, XAF). GeniusPay n'a pas d'API de
 * decaissement : son `supports(..., 'payout')` renvoie faux, et la
 * configuration est refusee d'office.
 *
 * LES REGLES DU DECAISSEMENT, LES MEMES QUE POUR /v1/payouts :
 *
 *   1. Le montant est RESERVE avant l'appel : le reversement est cree et le
 *      grand livre debite dans une meme transaction, sous verrou sur le
 *      marchand. Deux envois simultanes ne peuvent pas puiser deux fois.
 *   2. La reference envoyee a l'agregateur est l'identifiant du reversement, et
 *      sert de cle d'idempotence : un meme reversement ne part qu'une fois.
 *   3. Une reponse ambigue (delai depasse, 5xx) n'est JAMAIS un echec : l'argent
 *      est peut-etre parti. Le reversement passe a UNKNOWN, le montant reste
 *      reserve, et rien ne repart tant qu'une personne n'a pas verifie chez
 *      l'agregateur. Relancer sur un doute, c'est payer deux fois.
 *   4. Seul un refus EXPLICITE rend le montant au marchand (contre-ecriture).
 *
 * FRAIS — Yabetoo retient 1,5 % au BENEFICIAIRE. Le marchand ne paie que le
 * taux total de 5 %, tout compris : Afripaie envoie donc un montant majore,
 * calcule pour que le marchand recoive l'integralite de ce qui lui est du, et
 * l'ecart sort de son revenu (providerFeeAmount, constate au grand livre).
 */

/** Montant a envoyer pour que le beneficiaire recoive `owed` apres retenue. */
export function grossUp(owed: number, beneficiaryFeeBps: number): number {
  if (beneficiaryFeeBps <= 0) return owed;
  // Arrondi a l'unite superieure : le marchand recoit au moins son du.
  return Math.ceil((owed * 10_000) / (10_000 - beneficiaryFeeBps));
}

const CHANNEL = 'mobile_money' as const;

/** Prefixes des operateurs congolais. Le reseau reste saisissable a la main. */
const NETWORK_BY_PREFIX: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  CG: { '06': 'MTN_CG', '05': 'AIRTEL_CG', '04': 'AIRTEL_CG' },
};

export function inferNetwork(country: string, phone: string): string | undefined {
  const def = countryFromPhone(phone);
  if (!def || def.iso2 !== country) return undefined;
  const national = phone.replace(/\D/g, '').replace(/^00/, '').slice(def.callingCode.length);
  const table = NETWORK_BY_PREFIX[country];
  return table ? table[national.slice(0, 2)] : undefined;
}

const autoErrors = {
  noTarget: (provider: string) =>
    new AppError({
      type: 'invalid_request_error',
      code: 'settlement_target_missing',
      message: `Aucune destination de reversement ${provider} pour ce marchand.`,
      httpStatus: 400,
      retriable: false,
    }),
  noPlatformAccount: (provider: string, environment: string) =>
    new AppError({
      type: 'invalid_request_error',
      code: 'platform_account_missing',
      message: `Afripaie n'a pas de compte ${provider} actif en ${environment} : rien ne peut partir.`,
      httpStatus: 400,
      retriable: false,
    }),
  unresolved: () =>
    new AppError({
      type: 'invalid_request_error',
      code: 'settlement_unresolved',
      message:
        'Un reversement précédent est « à vérifier » : l’argent est peut-être parti. Vérifiez chez l’agrégateur et tranchez-le avant tout nouvel envoi.',
      httpStatus: 409,
      retriable: false,
    }),
  notResolvable: (status: string) =>
    new AppError({
      type: 'invalid_request_error',
      code: 'settlement_not_resolvable',
      message: `Seul un reversement « à vérifier » ou « en cours » se tranche à la main (statut : ${status}).`,
      httpStatus: 409,
      retriable: false,
    }),
} as const;

/* -------------------------------------------------------------------------- */
/* Destination                                                                */
/* -------------------------------------------------------------------------- */

export interface TargetInput {
  merchantId: string;
  environment: 'test' | 'live';
  providerId: string;
  phone: string;
  network?: string;
  beneficiaryName: string;
  autoEnabled: boolean;
  minAmount: number;
  actorEmail: string;
}

/** Ou part l'argent : numero, reseau et titulaire, valides pour l'agregateur. */
export interface Destination {
  country: string;
  currency: string;
  phone: string;
  network: string;
  beneficiaryName: string;
}

/**
 * Valide un numero de reversement : format international, pays que l'agregateur
 * sait servir, reseau connu (deduit du prefixe s'il n'est pas precise).
 */
export function resolveDestination(input: {
  providerId: string;
  phone: string;
  network?: string | undefined;
  beneficiaryName: string;
}): Destination {
  const adapter = getProviderAdapter(input.providerId);
  if (!adapter) throw errors.invalidRequest(`Agrégateur inconnu ou désactivé : ${input.providerId}.`, 'provider');

  const phone = input.phone.replace(/[\s.\-()]/g, '');
  const country = countryFromPhone(phone);
  if (!country) {
    throw errors.invalidRequest('Numéro attendu au format international (+242…).', 'phone');
  }
  if (!adapter.supports(country.iso2, CHANNEL, 'payout')) {
    throw errors.invalidRequest(
      `Les retraits mobile money vers ${country.name} ne sont pas encore possibles : ${adapter.name} ne sait pas y verser.`,
      'phone',
    );
  }
  const network = input.network?.toUpperCase() || inferNetwork(country.iso2, phone);
  if (!network) throw errors.invalidRequest('Réseau du bénéficiaire introuvable : précisez-le.', 'network');

  const name = input.beneficiaryName.trim();
  if (name.length < 2) throw errors.invalidRequest('Nom du titulaire du numéro requis.', 'beneficiary_name');

  return { country: country.iso2, currency: country.currency, phone, network, beneficiaryName: name };
}

export async function setSettlementTarget(input: TargetInput): Promise<MerchantSettlementTarget> {
  const dest = resolveDestination({
    providerId: input.providerId,
    phone: input.phone,
    network: input.network,
    beneficiaryName: input.beneficiaryName,
  });

  if (!(await prisma.merchant.findUnique({ where: { id: input.merchantId } }))) {
    throw errors.notFound('Marchand', input.merchantId);
  }

  const data = {
    country: dest.country,
    currency: dest.currency,
    phone: dest.phone,
    network: dest.network,
    beneficiaryName: dest.beneficiaryName,
    autoEnabled: input.autoEnabled,
    minAmount: input.minAmount,
    updatedBy: input.actorEmail,
  };
  return prisma.merchantSettlementTarget.upsert({
    where: {
      merchantId_environment_providerId: {
        merchantId: input.merchantId,
        environment: input.environment,
        providerId: input.providerId,
      },
    },
    create: {
      id: newId(ID_PREFIX.merchantSettlement).replace('rvs_', 'rvt_'),
      merchantId: input.merchantId,
      environment: input.environment,
      providerId: input.providerId,
      ...data,
    },
    update: data,
  });
}

export function listTargets(merchantId: string) {
  return prisma.merchantSettlementTarget.findMany({ where: { merchantId }, orderBy: { environment: 'asc' } });
}

/* -------------------------------------------------------------------------- */
/* Envoi                                                                      */
/* -------------------------------------------------------------------------- */

export interface SendInput {
  merchantId: string;
  environment: 'test' | 'live';
  providerId: string;
  /** Par defaut : tout le disponible. */
  amount?: number;
  /** Plancher du montant envoye (retrait demande par le marchand). */
  minAmount?: number;
  /**
   * Numero saisi pour CE retrait (retrait demande par le marchand). A defaut,
   * la destination enregistree par un administrateur.
   */
  destination?: { phone: string; network?: string | undefined; beneficiaryName: string };
  actorId: string;
  actorEmail: string;
}

export async function sendSettlement(input: SendInput): Promise<MerchantSettlement> {
  let target: Destination;
  if (input.destination) {
    target = resolveDestination({ providerId: input.providerId, ...input.destination });
  } else {
    const registered = await prisma.merchantSettlementTarget.findUnique({
      where: {
        merchantId_environment_providerId: {
          merchantId: input.merchantId,
          environment: input.environment,
          providerId: input.providerId,
        },
      },
    });
    if (!registered) throw autoErrors.noTarget(input.providerId);
    target = {
      country: registered.country,
      currency: registered.currency,
      phone: registered.phone,
      network: registered.network,
      beneficiaryName: registered.beneficiaryName,
    };
  }

  const adapter = getProviderAdapter(input.providerId);
  if (!adapter) throw errors.invalidRequest(`Agrégateur désactivé : ${input.providerId}.`, 'provider');

  const account = env.PLATFORM_MERCHANT_ID
    ? await prisma.providerAccount.findFirst({
        where: {
          merchantId: env.PLATFORM_MERCHANT_ID,
          providerId: input.providerId,
          environment: input.environment,
          status: 'ACTIVE',
        },
      })
    : null;
  if (!account) throw autoErrors.noPlatformAccount(input.providerId, input.environment);
  // Avant toute reservation : un compte illisible doit echouer sans laisser de
  // reversement « a verifier » qui n'est jamais parti.
  const ctx = await buildProviderContext(account.id);

  // 1. Reservation : creation et debit dans la meme transaction, sous verrou.
  const settlement = await prisma.$transaction(async (tx) => {
    await tx.merchant.update({ where: { id: input.merchantId }, data: { updatedAt: new Date() } });

    const doubt = await tx.merchantSettlement.count({
      where: { merchantId: input.merchantId, environment: input.environment, status: 'UNKNOWN' },
    });
    if (doubt > 0) throw autoErrors.unresolved();

    const balance = (await heldBalances(input.merchantId, new Date(), tx)).find(
      (b) =>
        b.environment === input.environment && b.currency === target.currency && b.provider === input.providerId,
    ) ?? { environment: input.environment, currency: target.currency, provider: input.providerId, held: 0, maturing: 0, available: 0 };

    const amount = input.amount ?? balance.available;
    if (!Number.isInteger(amount) || amount <= 0 || amount > balance.available) {
      throw settlementErrors.insufficient(balance);
    }
    if (input.minAmount !== undefined && amount < input.minAmount) {
      throw errors.invalidRequest(
        `Retrait minimum : ${input.minAmount} ${target.currency}.`,
        'amount',
        { minimum: input.minAmount },
      );
    }

    const created = await tx.merchantSettlement.create({
      data: {
        id: newId(ID_PREFIX.merchantSettlement),
        merchantId: input.merchantId,
        environment: input.environment,
        currency: target.currency,
        amount,
        providerFeeAmount: grossUp(amount, adapter.payoutBeneficiaryFeeBps ?? 0) - amount,
        sourceProviderId: input.providerId,
        method: 'MOBILE_MONEY',
        mode: 'AUTOMATIC',
        destination: target.phone,
        network: target.network,
        status: 'PROCESSING',
        actorId: input.actorId,
        actorEmail: input.actorEmail,
      },
    });
    await postSettlementJournal(tx, created, 'settlement.sent');
    return created;
  });

  // 2. Envoi, hors transaction : un appel reseau ne doit pas tenir un verrou.
  let result: AttemptResult;
  try {
    result = await adapter.createPayout(
      {
        reference: settlement.id,
        amount: settlement.amount + settlement.providerFeeAmount,
        currency: settlement.currency,
        country: target.country,
        channel: CHANNEL,
        recipient: { phone: target.phone, network: target.network, name: target.beneficiaryName },
        callbackUrl: ctx.callbackUrl,
        description: `Reversement Afripaie ${settlement.id}`,
        metadata: { afripaie_settlement: settlement.id, merchant_id: settlement.merchantId },
      },
      ctx,
    );
  } catch (e) {
    // 3. Seul un refus garanti rend l'argent ; tout le reste est un doute.
    if (isProviderError(e) && e.outcome === 'failed') {
      return fail(settlement, e.message);
    }
    logger.error({ err: e, settlement: settlement.id }, 'Reversement automatique : issue inconnue');
    return update(settlement.id, {
      status: 'UNKNOWN',
      failureReason: e instanceof Error ? e.message.slice(0, 500) : 'Erreur inconnue',
      checkedAt: new Date(),
    });
  }

  return applyResult(settlement, result);
}

/* -------------------------------------------------------------------------- */
/* Suivi                                                                      */
/* -------------------------------------------------------------------------- */

async function applyResult(settlement: MerchantSettlement, result: AttemptResult): Promise<MerchantSettlement> {
  const reference = result.providerReference || settlement.providerReference || null;

  switch (result.status) {
    case 'succeeded':
      return update(settlement.id, {
        status: 'PAID',
        providerReference: reference,
        externalReference: reference,
        failureReason: result.providerMessage ?? null,
        checkedAt: new Date(),
      });
    case 'failed':
    case 'expired':
      return fail(settlement, result.providerMessage ?? 'Décaissement refusé par l’agrégateur.', reference);
    default:
      // pending, unknown : sans reference, impossible d'interroger plus tard.
      return update(settlement.id, {
        status: reference ? 'PROCESSING' : 'UNKNOWN',
        providerReference: reference,
        checkedAt: new Date(),
        ...(reference ? {} : { failureReason: 'Aucune référence renvoyée par l’agrégateur.' }),
      });
  }
}

/** Refus explicite : le reversement echoue et le montant redevient du. */
async function fail(
  settlement: MerchantSettlement,
  reason: string,
  providerReference: string | null = settlement.providerReference,
): Promise<MerchantSettlement> {
  return prisma.$transaction(async (tx) => {
    // Seule la premiere transition l'emporte : le balayeur et une interrogation
    // manuelle ne doivent pas contre-passer deux fois.
    const { count } = await tx.merchantSettlement.updateMany({
      where: { id: settlement.id, status: { in: ['PROCESSING', 'UNKNOWN'] } },
      data: { status: 'FAILED', failureReason: reason.slice(0, 500), providerReference, checkedAt: new Date() },
    });
    if (count === 1) await postSettlementJournal(tx, settlement, 'settlement.reversed');
    return tx.merchantSettlement.findUniqueOrThrow({ where: { id: settlement.id } });
  });
}

async function update(
  id: string,
  data: Partial<Pick<MerchantSettlement, 'status' | 'providerReference' | 'externalReference' | 'failureReason' | 'checkedAt'>>,
): Promise<MerchantSettlement> {
  // Un etat terminal n'est jamais ecrase par une reponse tardive.
  await prisma.merchantSettlement.updateMany({
    where: { id, status: { in: ['PROCESSING', 'UNKNOWN'] } },
    data,
  });
  return prisma.merchantSettlement.findUniqueOrThrow({ where: { id } });
}

/** Interroge l'agregateur pour un reversement en cours. */
export async function refreshSettlement(id: string): Promise<MerchantSettlement> {
  const settlement = await prisma.merchantSettlement.findUnique({ where: { id } });
  if (!settlement) throw errors.notFound('Reversement', id);
  if (settlement.status !== 'PROCESSING' || !settlement.providerReference) return settlement;

  const adapter = getProviderAdapter(settlement.sourceProviderId);
  const account = env.PLATFORM_MERCHANT_ID
    ? await prisma.providerAccount.findFirst({
        where: {
          merchantId: env.PLATFORM_MERCHANT_ID,
          providerId: settlement.sourceProviderId,
          environment: settlement.environment,
        },
      })
    : null;
  if (!adapter || !account) return settlement;

  try {
    const ctx = await buildProviderContext(account.id);
    return await applyResult(settlement, await adapter.getPayout(settlement.providerReference, ctx));
  } catch (e) {
    // Une lecture ratee ne conclut rien : on reessaiera au prochain passage.
    logger.warn({ err: e, settlement: id }, 'Reversement : interrogation impossible');
    return update(id, { checkedAt: new Date() });
  }
}

/**
 * Decision humaine sur un reversement douteux, apres verification chez
 * l'agregateur. `paid` exige la reference constatee : c'est la preuve.
 */
export async function resolveSettlement(input: {
  settlementId: string;
  outcome: 'paid' | 'failed';
  reason: string;
  externalReference?: string;
  actorEmail: string;
}): Promise<MerchantSettlement> {
  const settlement = await prisma.merchantSettlement.findUnique({ where: { id: input.settlementId } });
  if (!settlement) throw errors.notFound('Reversement', input.settlementId);
  if (settlement.status !== 'UNKNOWN' && settlement.status !== 'PROCESSING') {
    throw autoErrors.notResolvable(settlement.status);
  }

  const note = `${input.reason.trim()} — tranché par ${input.actorEmail}`;
  if (input.outcome === 'failed') return fail(settlement, note);

  if (!input.externalReference?.trim()) {
    throw errors.invalidRequest('La référence constatée chez l’agrégateur est requise.', 'external_reference');
  }
  return update(settlement.id, {
    status: 'PAID',
    externalReference: input.externalReference.trim(),
    failureReason: note,
    checkedAt: new Date(),
  });
}

/* -------------------------------------------------------------------------- */
/* Taches de fond                                                             */
/* -------------------------------------------------------------------------- */

/** Interroge les reversements en cours. */
export async function pollSettlements(): Promise<{ polled: number; settled: number; failed: number }> {
  const pending = await prisma.merchantSettlement.findMany({
    where: { status: 'PROCESSING', providerReference: { not: null } },
    take: 50,
  });
  let settled = 0;
  let failed = 0;
  for (const s of pending) {
    const after = await refreshSettlement(s.id);
    if (after.status === 'PAID') settled += 1;
    if (after.status === 'FAILED') failed += 1;
  }
  return { polled: pending.length, settled, failed };
}

/**
 * Reversement periodique du disponible, pour les destinations ou il est active.
 *
 * Saute un marchand qui a deja un reversement en cours ou douteux, ou qui a
 * ete servi depuis moins de MERCHANT_AUTO_SETTLEMENT_EVERY_MS.
 */
export async function runAutoSettlements(now = new Date()): Promise<{ sent: number; skipped: number }> {
  if (!env.PLATFORM_MERCHANT_ID) return { sent: 0, skipped: 0 };

  const targets = await prisma.merchantSettlementTarget.findMany({ where: { autoEnabled: true } });
  let sent = 0;
  let skipped = 0;

  for (const t of targets) {
    const [open, last] = await Promise.all([
      prisma.merchantSettlement.count({
        where: { merchantId: t.merchantId, environment: t.environment, status: { in: ['PROCESSING', 'UNKNOWN'] } },
      }),
      prisma.merchantSettlement.findFirst({
        where: {
          merchantId: t.merchantId,
          environment: t.environment,
          sourceProviderId: t.providerId,
          mode: 'AUTOMATIC',
        },
        orderBy: { createdAt: 'desc' },
      }),
    ]);
    if (open > 0 || (last && now.getTime() - last.createdAt.getTime() < env.MERCHANT_AUTO_SETTLEMENT_EVERY_MS)) {
      skipped += 1;
      continue;
    }

    const balance = (await heldBalances(t.merchantId, now)).find(
      (b) => b.environment === t.environment && b.currency === t.currency && b.provider === t.providerId,
    );
    if (!balance || balance.available < t.minAmount) {
      skipped += 1;
      continue;
    }

    try {
      const s = await sendSettlement({
        merchantId: t.merchantId,
        environment: t.environment as 'test' | 'live',
        providerId: t.providerId,
        amount: balance.available,
        actorId: 'automate',
        actorEmail: 'reversement-automatique',
      });
      sent += 1;
      logger.info(
        { merchant: t.merchantId, settlement: s.id, amount: s.amount, currency: s.currency, status: s.status },
        'Reversement automatique envoye',
      );
    } catch (e) {
      skipped += 1;
      logger.warn({ err: e, merchant: t.merchantId }, 'Reversement automatique non envoye');
    }
  }
  return { sent, skipped };
}
