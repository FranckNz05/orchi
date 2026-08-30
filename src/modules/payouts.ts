import type { Payout, PayoutAttempt } from '@prisma/client';
import type { Channel } from '../catalog/coverage.js';
import { getCountry } from '../catalog/countries.js';
import { AppError, errors } from '../core/errors.js';
import { ID_PREFIX, newId } from '../core/ids.js';
import { logger } from '../core/logger.js';
import { assertValidAmount } from '../core/money.js';
import { prisma } from '../db/client.js';
import { isProviderError, type ProviderError } from '../providers/errors.js';
import { requireProviderAdapter } from '../providers/registry.js';
import type { AttemptResult } from '../providers/types.js';
import { recordDecision, runInstrumented } from '../routing/instrument.js';
import { selectCandidates, type RoutingPlan } from '../routing/select.js';
import { postPayoutSucceeded } from './ledger.js';
import { emitEvent, type EventType } from './webhooks/outbound.js';
import { platformPayoutFee } from './pricing.js';
import { buildProviderContext } from './provider-accounts.js';

/**
 * Decaissements.
 *
 * Le fichier est volontairement distinct de payments.ts malgre la structure
 * proche : les regles de rejeu ne sont PAS les memes, et les melanger finirait
 * par faire appliquer la souplesse de l'encaissement a un virement.
 *
 * Trois interdits, dans cet ordre d'importance :
 *
 *  1. Aucun rejeu apres un etat indetermine (timeout, 5xx sur creation). Le
 *     virement a peut-etre ete execute. Seule la reconciliation peut trancher.
 *  2. Aucun failover apres un etat indetermine, meme chez un autre agregateur.
 *  3. La ligne de tentative est ecrite avant l'appel sortant, jamais apres.
 */

export interface CreatePayoutInput {
  merchantId: string;
  environment: 'test' | 'live';
  reference: string;
  amount: number;
  currency: string;
  country: string;
  channel: Channel;
  recipient: {
    phone?: string;
    network?: string;
    accountNumber?: string;
    bankCode?: string;
    name?: string;
  };
  description?: string;
  metadata?: Record<string, string>;
  preferredProviderId?: string;
}

function validate(input: CreatePayoutInput): void {
  assertValidAmount(input.amount, input.currency);

  const country = getCountry(input.country);
  if (!country) throw errors.invalidRequest(`Pays hors catalogue : ${input.country}.`, 'country');

  if (country.currency !== input.currency.toUpperCase()) {
    throw errors.invalidRequest(
      `La devise de ${country.name} est ${country.currency}, pas ${input.currency.toUpperCase()}.`,
      'currency',
      { expected: country.currency },
    );
  }

  if (country.payoutMode === 'NONE') {
    throw new AppError({
      type: 'routing_error',
      code: 'payout_unavailable_in_country',
      message: `Aucune voie de decaissement n'existe pour ${country.name}.`,
      httpStatus: 422,
      retriable: false,
      details: { country: country.iso2, note: country.payoutNote },
    });
  }

  if (input.channel === 'mobile_money' && !input.recipient.phone) {
    throw errors.invalidRequest(
      'Un numero de telephone est requis pour un decaissement mobile money.',
      'recipient.phone',
    );
  }
  if (input.channel === 'bank_transfer' && !input.recipient.accountNumber) {
    throw errors.invalidRequest(
      'Un numero de compte est requis pour un virement bancaire.',
      'recipient.account_number',
    );
  }
}

/* -------------------------------------------------------------------------- */

export async function createPayout(
  input: CreatePayoutInput,
  linkResource?: (id: string) => Promise<void>,
): Promise<{ payout: Payout; attempts: PayoutAttempt[] }> {
  validate(input);

  const existing = await prisma.payout.findUnique({
    where: { merchantId_reference: { merchantId: input.merchantId, reference: input.reference } },
  });

  if (existing) {
    // Filet definitif : la reference du marchand n'expire jamais, contrairement
    // a une cle d'idempotence. Sur un decaissement, c'est ce qui empeche un
    // rejeu tardif de payer une seconde fois.
    if (existing.amount !== input.amount || existing.currency !== input.currency.toUpperCase()) {
      throw new AppError({
        type: 'invalid_request_error',
        code: 'duplicate_reference',
        message: `La reference ${input.reference} designe deja un decaissement de montant different.`,
        httpStatus: 409,
        retriable: false,
        details: { payout_id: existing.id },
      });
    }
    if (linkResource) await linkResource(existing.id);
    return { payout: existing, attempts: await attemptsOf(existing.id) };
  }

  const payout = await prisma.payout.create({
    data: {
      id: newId(ID_PREFIX.payout),
      merchantId: input.merchantId,
      reference: input.reference,
      amount: input.amount,
      currency: input.currency.toUpperCase(),
      country: input.country.toUpperCase(),
      channel: input.channel,
      recipientPhone: input.recipient.phone ?? null,
      recipientNetwork: input.recipient.network ?? null,
      recipientAccountNumber: input.recipient.accountNumber ?? null,
      recipientBankCode: input.recipient.bankCode ?? null,
      recipientName: input.recipient.name ?? null,
      description: input.description ?? null,
      metadata: JSON.stringify(input.metadata ?? {}),
      environment: input.environment,
      status: 'CREATED',
    },
  });

  if (linkResource) await linkResource(payout.id);

  const plan = await selectCandidates({
    merchantId: input.merchantId,
    environment: input.environment,
    country: payout.country,
    channel: input.channel,
    direction: 'payout',
    seed: payout.reference,
    ...(input.preferredProviderId ? { preferredProviderId: input.preferredProviderId } : {}),
  });

  const updated = await runAttempts(payout, plan);
  return { payout: updated, attempts: await attemptsOf(payout.id) };
}

async function runAttempts(payout: Payout, plan: RoutingPlan): Promise<Payout> {
  let attemptNumber = await prisma.payoutAttempt.count({ where: { payoutId: payout.id } });
  let blockingError: ProviderError | undefined;

  for (const candidate of plan.candidates) {
    attemptNumber += 1;

    // Ecriture AVANT l'appel : si le processus meurt juste apres l'envoi, la
    // trace existe et la reconciliation saura quoi interroger.
    const attempt = await prisma.payoutAttempt.create({
      data: {
        id: newId(ID_PREFIX.payoutAttempt),
        payoutId: payout.id,
        attemptNumber,
        providerId: candidate.providerId,
        providerAccountId: candidate.providerAccountId,
        reference: `${payout.reference}-${attemptNumber}`,
        status: 'PENDING',
        /** Voir payments.ts : le taux agregateur est fige au routage. */
        providerFeeBps: candidate.feeBps,
      },
    });

    await prisma.payout.update({
      where: { id: payout.id },
      data: { status: 'PROCESSING', currentAttemptId: attempt.id },
    });

    await recordDecision({
      merchantId: payout.merchantId,
      refType: 'payout',
      refId: payout.id,
      attemptId: attempt.id,
      country: payout.country,
      channel: payout.channel,
      direction: 'payout',
      chosen: candidate,
      candidates: plan.candidates,
      rejected: plan.rejected,
    });

    const ctx = await buildProviderContext(candidate.providerAccountId);
    const adapter = requireProviderAdapter(candidate.providerId);
    const call = { providerId: candidate.providerId, country: payout.country, channel: payout.channel };

    try {
      const result = await runInstrumented(call, () =>
        adapter.createPayout(
        {
          reference: attempt.reference,
          amount: payout.amount,
          currency: payout.currency,
          country: payout.country,
          channel: payout.channel as Channel,
          recipient: {
            ...(payout.recipientPhone ? { phone: payout.recipientPhone } : {}),
            ...(payout.recipientNetwork ? { network: payout.recipientNetwork } : {}),
            ...(payout.recipientAccountNumber ? { accountNumber: payout.recipientAccountNumber } : {}),
            ...(payout.recipientBankCode ? { bankCode: payout.recipientBankCode } : {}),
            ...(payout.recipientName ? { name: payout.recipientName } : {}),
          },
          callbackUrl: ctx.callbackUrl,
          ...(payout.description ? { description: payout.description } : {}),
          metadata: JSON.parse(payout.metadata) as Record<string, string>,
        },
        ctx,
        ),
      );

      const applied = await applyAttemptResult(attempt.id, payout.id, result);
      if (applied.status !== 'FAILED') return applied;
      continue;
    } catch (e) {
      if (!isProviderError(e)) throw e;

      const indeterminate = e.outcome === 'unknown';

      await prisma.payoutAttempt.update({
        where: { id: attempt.id },
        data: {
          status: indeterminate ? 'UNKNOWN' : 'FAILED',
          failureCode: e.code,
          providerMessage: e.message,
          ...(e.providerCode ? { providerCode: e.providerCode } : {}),
          completedAt: indeterminate ? null : new Date(),
        },
      });

      logger.warn({ payout_id: payout.id, ...e.toLogContext() }, 'Tentative de decaissement en echec');

      if (indeterminate) {
        // LA regle du produit. Le decaissement passe en UNKNOWN et y reste :
        // ni relance, ni failover, ni echec declare. Seule la reconciliation
        // pourra le faire sortir de cet etat.
        logger.error(
          { payout_id: payout.id, attempt_id: attempt.id, provider: e.providerId },
          'Decaissement en etat indetermine : reconciliation requise',
        );
        return prisma.payout.update({ where: { id: payout.id }, data: { status: 'UNKNOWN' } });
      }

      if (!e.failoverAllowed) {
        blockingError = e;
        break;
      }
    }
  }

  const final = await prisma.payout.update({ where: { id: payout.id }, data: { status: 'FAILED' } });

  if (blockingError) {
    throw new AppError({
      type: 'provider_error',
      code: `provider_${blockingError.code}`,
      message: `${blockingError.providerId} : ${blockingError.message}`,
      httpStatus: 502,
      retriable: false,
      details: { provider: blockingError.providerId, outcome: blockingError.outcome },
    });
  }

  return final;
}

async function applyAttemptResult(
  attemptId: string,
  payoutId: string,
  result: AttemptResult,
): Promise<Payout> {
  const terminal = result.status === 'succeeded' || result.status === 'failed' || result.status === 'expired';

  await prisma.payoutAttempt.update({
    where: { id: attemptId },
    data: {
      status: result.status === 'expired' ? 'FAILED' : result.status.toUpperCase(),
      providerReference: result.providerReference,
      ...(result.providerCode !== undefined ? { providerCode: result.providerCode } : {}),
      ...(result.providerMessage !== undefined ? { providerMessage: result.providerMessage } : {}),
      ...(result.providerFeeAmount !== undefined ? { providerFeeAmount: result.providerFeeAmount } : {}),
      rawResponse: JSON.stringify(result.raw),
      completedAt: terminal ? new Date() : null,
    },
  });

  const payout = await prisma.payout.findUniqueOrThrow({ where: { id: payoutId } });

  if (result.status === 'succeeded' && payout.status !== 'SUCCEEDED') {
    const settled = await settleSuccess(payout, attemptId, result);
    await notify(settled);
    return settled;
  }

  const status =
    result.status === 'failed' || result.status === 'expired'
      ? 'FAILED'
      : result.status === 'unknown'
        ? 'UNKNOWN'
        : 'PROCESSING';

  const updated = await prisma.payout.update({
    where: { id: payoutId },
    data: { status, currentAttemptId: attemptId },
  });

  if (payout.status !== updated.status) await notify(updated);
  return updated;
}

const EVENT_BY_STATUS: Partial<Record<string, EventType>> = {
  SUCCEEDED: 'payout.succeeded',
  FAILED: 'payout.failed',
  // Evenement a part entiere : le marchand doit savoir qu'un virement est en
  // suspens. C'est le seul cas qui demande une decision humaine.
  UNKNOWN: 'payout.indeterminate',
};

async function notify(payout: Payout): Promise<void> {
  const type = EVENT_BY_STATUS[payout.status];
  if (!type) return;

  try {
    const attempts = await attemptsOf(payout.id);
    await emitEvent({
      merchantId: payout.merchantId,
      environment: payout.environment === 'live' ? 'live' : 'test',
      type,
      resourceId: payout.id,
      data: serializePayout(payout, attempts),
    });
  } catch (e) {
    logger.warn({ err: e, payout_id: payout.id }, 'Evenement sortant non mis en file');
  }
}

/** Voir applyPaymentUpdate : memes garde-fous, appliques aux decaissements. */
export async function applyPayoutUpdate(
  providerId: string,
  providerReference: string,
  result: AttemptResult,
): Promise<{ applied: boolean; attemptId?: string; reason?: string }> {
  const attempt = await prisma.payoutAttempt.findFirst({
    where: { providerId, providerReference },
    orderBy: { createdAt: 'desc' },
  });
  if (!attempt) return { applied: false, reason: 'Aucune tentative pour cette reference.' };

  if (['SUCCEEDED', 'FAILED'].includes(attempt.status)) {
    return { applied: false, attemptId: attempt.id, reason: `Tentative deja ${attempt.status}.` };
  }

  if (result.status === 'pending' || result.status === 'unknown') {
    return {
      applied: false,
      attemptId: attempt.id,
      reason: 'Etat non concluant : interrogation requise.',
    };
  }

  await applyAttemptResult(attempt.id, attempt.payoutId, result);
  return { applied: true, attemptId: attempt.id };
}

async function settleSuccess(
  payout: Payout,
  attemptId: string,
  result: AttemptResult,
): Promise<Payout> {
  const attempt = await prisma.payoutAttempt.findUniqueOrThrow({ where: { id: attemptId } });

  const fee = platformPayoutFee(payout.merchantId, {
    amountMinor: payout.amount,
    providerFeeAmount: result.providerFeeAmount ?? null,
    providerFeeBps: attempt.providerFeeBps,
  });
  const providerFee = fee.providerAmount;

  if (fee.capped) {
    logger.warn(
      { payout_id: payout.id, provider: attempt.providerId, provider_fee: providerFee },
      'Commission agregateur superieure au taux total : marge Orchi nulle',
    );
  }

  return prisma.$transaction(async (tx) => {
    const updated = await tx.payout.update({
      where: { id: payout.id },
      data: {
        status: 'SUCCEEDED',
        currentAttemptId: attemptId,
        providerFeeAmount: providerFee,
        platformFeeAmount: fee.amount,
        settledAt: new Date(),
      },
    });

    await postPayoutSucceeded(
      {
        merchantId: payout.merchantId,
        payoutId: payout.id,
        providerId: attempt.providerId,
        currency: payout.currency,
        amount: payout.amount,
        providerFee,
        platformFee: fee.amount,
      },
      tx,
    );

    return updated;
  });
}

/* -------------------------------------------------------------------------- */

async function attemptsOf(payoutId: string): Promise<PayoutAttempt[]> {
  return prisma.payoutAttempt.findMany({ where: { payoutId }, orderBy: { attemptNumber: 'asc' } });
}

/* -------------------------------------------------------------------------- */
/* Liste                                                                      */
/* -------------------------------------------------------------------------- */

export interface PayoutListFilters {
  status?: string;
  country?: string;
  limit: number;
  startingAfter?: string;
}

/** Vue compacte. Le detail s'obtient par GET /v1/payouts/:id. */
export function serializePayoutRow(
  payout: Payout & { attempts: { providerId: string; status: string }[] },
) {
  const last = payout.attempts[payout.attempts.length - 1];
  return {
    object: 'payout',
    id: payout.id,
    reference: payout.reference,
    status: payout.status,
    amount: payout.amount,
    currency: payout.currency,
    country: payout.country,
    channel: payout.channel,
    recipient_phone: payout.recipientPhone,
    provider: last?.providerId ?? null,
    attempt_count: payout.attempts.length,
    created_at: payout.createdAt.toISOString(),
    settled_at: payout.settledAt?.toISOString() ?? null,
  };
}

export async function listPayouts(merchantId: string, filters: PayoutListFilters) {
  const rows = await prisma.payout.findMany({
    where: {
      merchantId,
      ...(filters.status ? { status: filters.status } : {}),
      ...(filters.country ? { country: filters.country.toUpperCase() } : {}),
    },
    include: { attempts: { orderBy: { attemptNumber: 'asc' } } },
    orderBy: { createdAt: 'desc' },
    take: filters.limit,
    ...(filters.startingAfter ? { skip: 1, cursor: { id: filters.startingAfter } } : {}),
  });

  return {
    object: 'list',
    count: rows.length,
    next_cursor: rows.length === filters.limit ? (rows[rows.length - 1]?.id ?? null) : null,
    data: rows.map(serializePayoutRow),
  };
}

export async function getPayout(
  merchantId: string,
  payoutId: string,
): Promise<{ payout: Payout; attempts: PayoutAttempt[] }> {
  const payout = await prisma.payout.findFirst({ where: { id: payoutId, merchantId } });
  if (!payout) throw errors.notFound('Decaissement', payoutId);
  return { payout, attempts: await attemptsOf(payout.id) };
}

/**
 * Interroge l'agregateur. C'est le SEUL mecanisme autorise a sortir un
 * decaissement de l'etat UNKNOWN : on demande a l'agregateur ce qu'il a fait,
 * on ne suppose jamais.
 */
export async function refreshPayout(
  merchantId: string,
  payoutId: string,
): Promise<{ payout: Payout; attempts: PayoutAttempt[] }> {
  const { payout, attempts } = await getPayout(merchantId, payoutId);
  const current = attempts.find((a) => a.id === payout.currentAttemptId);

  if (!current || !current.providerReference) return { payout, attempts };
  if (['SUCCEEDED', 'FAILED'].includes(current.status)) return { payout, attempts };

  const adapter = requireProviderAdapter(current.providerId);
  const ctx = await buildProviderContext(current.providerAccountId);

  try {
    const result = await runInstrumented(
      { providerId: current.providerId, country: payout.country, channel: payout.channel },
      () => adapter.getPayout(current.providerReference!, ctx),
    );
    const updated = await applyAttemptResult(current.id, payout.id, result);
    return { payout: updated, attempts: await attemptsOf(payout.id) };
  } catch (e) {
    if (!isProviderError(e)) throw e;
    logger.warn({ payout_id: payout.id, ...e.toLogContext() }, 'Rafraichissement impossible');
    return { payout, attempts };
  }
}

/**
 * Relance d'un decaissement.
 *
 * Autorisee uniquement si AUCUNE tentative n'est en etat indetermine. Une
 * seule ligne UNKNOWN dans l'historique bloque le decaissement : tant que nous
 * ignorons si un virement est parti, en emettre un second est indefendable.
 */
export async function retryPayout(
  merchantId: string,
  payoutId: string,
  environment: 'test' | 'live',
): Promise<{ payout: Payout; attempts: PayoutAttempt[] }> {
  const { payout, attempts } = await getPayout(merchantId, payoutId);

  if (payout.status === 'SUCCEEDED') {
    throw new AppError({
      type: 'invalid_request_error',
      code: 'payout_already_settled',
      message: 'Ce decaissement a deja abouti.',
      httpStatus: 409,
      retriable: false,
    });
  }

  const indeterminate = attempts.find((a) => a.status === 'UNKNOWN');
  if (indeterminate || payout.status === 'UNKNOWN') {
    throw new AppError({
      type: 'invalid_request_error',
      code: 'payout_indeterminate',
      message:
        "L'etat d'une tentative est indetermine : le virement a peut-etre ete execute. " +
        'Toute relance est bloquee tant que la reconciliation n’a pas tranche.',
      httpStatus: 409,
      retriable: false,
      details: {
        attempt_number: indeterminate?.attemptNumber ?? null,
        provider: indeterminate?.providerId ?? null,
        resolution: 'GET /v1/payouts/:id interroge l’agregateur et peut lever le blocage.',
      },
    });
  }

  const open = attempts.find((a) => a.status === 'PENDING');
  if (open) {
    throw new AppError({
      type: 'invalid_request_error',
      code: 'attempt_still_open',
      message: 'Une tentative est encore en cours.',
      httpStatus: 409,
      retriable: true,
    });
  }

  const tried = [...new Set(attempts.map((a) => a.providerId))];
  const plan = await selectCandidates({
    merchantId,
    environment,
    country: payout.country,
    channel: payout.channel as Channel,
    direction: 'payout',
    seed: payout.reference,
    excludeProviderIds: tried,
  });

  const updated = await runAttempts(payout, plan);
  return { payout: updated, attempts: await attemptsOf(payout.id) };
}

/* -------------------------------------------------------------------------- */

export function serializePayout(payout: Payout, attempts: PayoutAttempt[]) {
  const current = attempts.find((a) => a.id === payout.currentAttemptId);

  return {
    object: 'payout',
    id: payout.id,
    reference: payout.reference,
    status: payout.status,
    amount: payout.amount,
    currency: payout.currency,
    country: payout.country,
    channel: payout.channel,
    recipient: {
      phone: payout.recipientPhone,
      network: payout.recipientNetwork,
      account_number: payout.recipientAccountNumber,
      bank_code: payout.recipientBankCode,
      name: payout.recipientName,
    },
    description: payout.description,
    metadata: JSON.parse(payout.metadata) as Record<string, string>,
    fees: { provider: payout.providerFeeAmount, platform: payout.platformFeeAmount },
    /**
     * Present uniquement en etat UNKNOWN : dit au marchand ce qu'il ne doit
     * surtout pas faire.
     */
    ...(payout.status === 'UNKNOWN'
      ? {
          warning: {
            code: 'indeterminate_state',
            message:
              "L'issue de ce decaissement est inconnue. Ne le rejouez pas : interrogez cette " +
              'ressource jusqu’a resolution.',
          },
        }
      : {}),
    provider: current
      ? {
          id: current.providerId,
          reference: current.providerReference,
          code: current.providerCode,
          message: current.providerMessage,
        }
      : null,
    attempts: attempts.map((a) => ({
      number: a.attemptNumber,
      provider: a.providerId,
      status: a.status,
      provider_reference: a.providerReference,
      failure_code: a.failureCode,
      created_at: a.createdAt.toISOString(),
    })),
    settled_at: payout.settledAt?.toISOString() ?? null,
    created_at: payout.createdAt.toISOString(),
  };
}
