import type { Payment, PaymentAttempt } from '@prisma/client';
import type { Channel } from '../catalog/coverage.js';
import { getCountry } from '../catalog/countries.js';
import { AppError, errors } from '../core/errors.js';
import { ID_PREFIX, newId } from '../core/ids.js';
import { logger } from '../core/logger.js';
import { assertValidAmount } from '../core/money.js';
import { prisma } from '../db/client.js';
import { isProviderError, type ProviderError } from '../providers/errors.js';
import { requireProviderAdapter } from '../providers/registry.js';
import type { AttemptResult, AttemptStatus, CustomerAction } from '../providers/types.js';
import { recordDecision, runInstrumented } from '../routing/instrument.js';
import { selectCandidates, type RoutingPlan } from '../routing/select.js';
import { postPayinSucceeded } from './ledger.js';
import { emitEvent, type EventType } from './webhooks/outbound.js';
import { platformPayinFee } from './pricing.js';
import { buildProviderContext } from './provider-accounts.js';

/**
 * Encaissements.
 *
 * Deux principes structurent tout ce fichier :
 *
 * 1. La ligne de tentative est ecrite EN BASE AVANT l'appel a l'agregateur.
 *    Si le processus meurt entre les deux, la trace existe et la
 *    reconciliation peut trancher. L'inverse laisserait un paiement fantome.
 *
 * 2. Le failover n'est tente que sur un echec dont l'agregateur GARANTIT qu'il
 *    n'a rien traite (`outcome === 'failed'`). Un timeout arrete la sequence :
 *    le client a peut-etre deja valide son push USSD.
 */

const ATTEMPT_TO_PAYMENT: Record<AttemptStatus, Payment['status']> = {
  pending: 'PROCESSING',
  awaiting_customer: 'PROCESSING',
  succeeded: 'SUCCEEDED',
  failed: 'FAILED',
  expired: 'EXPIRED',
  // Etat indetermine : le paiement reste en cours tant que la reconciliation
  // n'a pas tranche. Surtout pas FAILED, qui autoriserait une relance.
  unknown: 'PROCESSING',
};

export interface CreatePaymentInput {
  merchantId: string;
  environment: 'test' | 'live';
  reference: string;
  amount: number;
  currency: string;
  country: string;
  channel: Channel;
  network?: string;
  customer: { phone?: string; email?: string; name?: string };
  description?: string;
  metadata?: Record<string, string>;
  returnUrl?: string;
  preferredProviderId?: string;
}

/* -------------------------------------------------------------------------- */
/* Validation                                                                 */
/* -------------------------------------------------------------------------- */

function validate(input: CreatePaymentInput): void {
  assertValidAmount(input.amount, input.currency);

  const country = getCountry(input.country);
  if (!country) throw errors.invalidRequest(`Pays hors catalogue : ${input.country}.`, 'country');

  if (country.currency !== input.currency.toUpperCase()) {
    // Erreur frequente et couteuse : envoyer XOF sur un pays en XAF passe les
    // validations naives et produit un montant faux chez l'agregateur.
    throw errors.invalidRequest(
      `La devise de ${country.name} est ${country.currency}, pas ${input.currency.toUpperCase()}.`,
      'currency',
      { expected: country.currency },
    );
  }

  if (input.channel === 'mobile_money' && !input.customer.phone) {
    throw errors.invalidRequest(
      'Un numero de telephone est requis pour un paiement mobile money.',
      'customer.phone',
    );
  }
  if (input.channel === 'card' && !input.customer.email) {
    throw errors.invalidRequest('Un email est requis pour un paiement par carte.', 'customer.email');
  }
}

/* -------------------------------------------------------------------------- */
/* Creation                                                                   */
/* -------------------------------------------------------------------------- */

export async function createPayment(
  input: CreatePaymentInput,
  linkResource?: (id: string) => Promise<void>,
): Promise<{ payment: Payment; attempts: PaymentAttempt[] }> {
  validate(input);

  const existing = await prisma.payment.findUnique({
    where: { merchantId_reference: { merchantId: input.merchantId, reference: input.reference } },
  });

  if (existing) {
    // La reference marchand est le filet definitif contre les doublons : elle
    // ne depend d'aucun en-tete et n'expire jamais.
    const sameIntent =
      existing.amount === input.amount &&
      existing.currency === input.currency.toUpperCase() &&
      existing.country === input.country.toUpperCase();

    if (!sameIntent) {
      throw new AppError({
        type: 'invalid_request_error',
        code: 'duplicate_reference',
        message: `La reference ${input.reference} designe deja un paiement de montant different.`,
        httpStatus: 409,
        retriable: false,
        details: { payment_id: existing.id },
      });
    }

    if (linkResource) await linkResource(existing.id);
    return { payment: existing, attempts: await attemptsOf(existing.id) };
  }

  const payment = await prisma.payment.create({
    data: {
      id: newId(ID_PREFIX.payment),
      merchantId: input.merchantId,
      reference: input.reference,
      amount: input.amount,
      currency: input.currency.toUpperCase(),
      country: input.country.toUpperCase(),
      channel: input.channel,
      network: input.network ?? null,
      customerPhone: input.customer.phone ?? null,
      customerEmail: input.customer.email ?? null,
      customerName: input.customer.name ?? null,
      description: input.description ?? null,
      metadata: JSON.stringify(input.metadata ?? {}),
      returnUrl: input.returnUrl ?? null,
      environment: input.environment,
      status: 'CREATED',
    },
  });

  if (linkResource) await linkResource(payment.id);

  const plan = await selectCandidates({
    merchantId: input.merchantId,
    environment: input.environment,
    country: payment.country,
    channel: input.channel,
    direction: 'payin',
    seed: payment.reference,
    ...(input.preferredProviderId ? { preferredProviderId: input.preferredProviderId } : {}),
  });

  const updated = await runAttempts(payment, plan);
  return { payment: updated, attempts: await attemptsOf(payment.id) };
}

/**
 * Essaie les agregateurs dans l'ordre, en s'arretant des qu'un resultat est
 * obtenu ou des qu'un echec interdit de continuer.
 */
async function runAttempts(payment: Payment, plan: RoutingPlan): Promise<Payment> {
  let attemptNumber = await prisma.paymentAttempt.count({ where: { paymentId: payment.id } });
  let lastError: ProviderError | undefined;

  for (const candidate of plan.candidates) {
    attemptNumber += 1;
    const attempt = await prisma.paymentAttempt.create({
      data: {
        id: newId(ID_PREFIX.paymentAttempt),
        paymentId: payment.id,
        attemptNumber,
        providerId: candidate.providerId,
        providerAccountId: candidate.providerAccountId,
        reference: `${payment.reference}-${attemptNumber}`,
        status: 'PENDING',
        // Le taux de l'agregateur est FIGE ici : la commission Orchi en est le
        // solde, et une modification ulterieure du catalogue ne doit pas
        // recalculer retroactivement une transaction deja passee.
        providerFeeBps: candidate.feeBps,
      },
    });

    await prisma.payment.update({
      where: { id: payment.id },
      data: { status: 'PROCESSING', currentAttemptId: attempt.id },
    });

    await recordDecision({
      merchantId: payment.merchantId,
      refType: 'payment',
      refId: payment.id,
      attemptId: attempt.id,
      country: payment.country,
      channel: payment.channel,
      direction: 'payin',
      chosen: candidate,
      candidates: plan.candidates,
      rejected: plan.rejected,
    });

    const ctx = await buildProviderContext(candidate.providerAccountId);
    const adapter = requireProviderAdapter(candidate.providerId);
    const call = { providerId: candidate.providerId, country: payment.country, channel: payment.channel };

    try {
      const result = await runInstrumented(call, () =>
        adapter.createCharge(
        {
          reference: attempt.reference,
          amount: payment.amount,
          currency: payment.currency,
          country: payment.country,
          channel: payment.channel as Channel,
          ...(payment.network ? { network: payment.network } : {}),
          customer: {
            ...(payment.customerPhone ? { phone: payment.customerPhone } : {}),
            ...(payment.customerEmail ? { email: payment.customerEmail } : {}),
            ...(payment.customerName ? { name: payment.customerName } : {}),
          },
          callbackUrl: ctx.callbackUrl,
          ...(payment.returnUrl ? { returnUrl: payment.returnUrl } : {}),
          ...(payment.description ? { description: payment.description } : {}),
          metadata: JSON.parse(payment.metadata) as Record<string, string>,
        },
        ctx,
        ),
      );

      const applied = await applyAttemptResult(attempt.id, payment.id, result);
      if (applied.status !== 'FAILED') return applied;

      // Refus explicite de l'agregateur : on peut proposer le suivant.
      lastError = undefined;
      continue;
    } catch (e) {
      if (!isProviderError(e)) throw e;
      lastError = e;

      await prisma.paymentAttempt.update({
        where: { id: attempt.id },
        data: {
          status: e.outcome === 'unknown' ? 'UNKNOWN' : 'FAILED',
          failureCode: e.code,
          providerMessage: e.message,
          ...(e.providerCode ? { providerCode: e.providerCode } : {}),
          completedAt: e.outcome === 'unknown' ? null : new Date(),
        },
      });

      logger.warn({ payment_id: payment.id, ...e.toLogContext() }, 'Tentative en echec');

      if (e.outcome === 'unknown') {
        // Arret net : l'argent a peut-etre bouge. Aucun autre agregateur,
        // aucun rejeu. La reconciliation tranchera.
        return prisma.payment.update({
          where: { id: payment.id },
          data: { status: 'PROCESSING' },
        });
      }

      if (!e.failoverAllowed) break;
    }
  }

  const final = await prisma.payment.update({
    where: { id: payment.id },
    data: { status: 'FAILED' },
  });

  if (lastError && !lastError.failoverAllowed) {
    // Erreur bloquante (credentials, requete invalide) : la remonter telle
    // quelle est plus utile au marchand qu'un paiement en echec silencieux.
    throw providerErrorToAppError(lastError);
  }

  return final;
}

function providerErrorToAppError(e: ProviderError): AppError {
  const type = e.code === 'authentication' ? 'provider_error' : 'provider_error';
  return new AppError({
    type,
    code: `provider_${e.code}`,
    message: `${e.providerId} : ${e.message}`,
    httpStatus: e.code === 'authentication' ? 502 : 502,
    retriable: e.retriableSameProvider,
    details: { provider: e.providerId, outcome: e.outcome },
  });
}

/* -------------------------------------------------------------------------- */
/* Application d'un resultat                                                  */
/* -------------------------------------------------------------------------- */

async function applyAttemptResult(
  attemptId: string,
  paymentId: string,
  result: AttemptResult,
): Promise<Payment> {
  const action = result.action;
  const terminal = result.status === 'succeeded' || result.status === 'failed' || result.status === 'expired';

  await prisma.paymentAttempt.update({
    where: { id: attemptId },
    data: {
      status: result.status.toUpperCase(),
      providerReference: result.providerReference,
      ...(result.providerCode !== undefined ? { providerCode: result.providerCode } : {}),
      ...(result.providerMessage !== undefined ? { providerMessage: result.providerMessage } : {}),
      ...(result.providerFeeAmount !== undefined
        ? { providerFeeAmount: result.providerFeeAmount }
        : {}),
      actionType: action.type,
      actionUrl: action.type === 'redirect' ? action.url : null,
      actionInstructions:
        action.type === 'ussd_push' || action.type === 'otp_required' ? action.instructions : null,
      actionExpiresAt: 'expiresAt' in action && action.expiresAt ? new Date(action.expiresAt) : null,
      rawResponse: JSON.stringify(result.raw),
      completedAt: terminal ? new Date() : null,
    },
  });

  const payment = await prisma.payment.findUniqueOrThrow({ where: { id: paymentId } });
  const nextStatus = ATTEMPT_TO_PAYMENT[result.status];

  if (result.status === 'succeeded' && payment.status !== 'SUCCEEDED') {
    const settled = await settleSuccess(payment, attemptId, result);
    await notify(settled);
    return settled;
  }

  const updated = await prisma.payment.update({
    where: { id: paymentId },
    data: { status: nextStatus, currentAttemptId: attemptId },
  });

  if (payment.status !== updated.status) await notify(updated);
  return updated;
}

const EVENT_BY_STATUS: Partial<Record<string, EventType>> = {
  SUCCEEDED: 'payment.succeeded',
  FAILED: 'payment.failed',
  EXPIRED: 'payment.expired',
};

/**
 * Notifie le marchand d'un changement d'etat.
 *
 * L'echec de la notification ne remonte jamais jusqu'au paiement : la
 * transaction a eu lieu, que le marchand soit joignable ou non. Le worker de
 * livraison se charge des reprises.
 */
async function notify(payment: Payment): Promise<void> {
  const type = EVENT_BY_STATUS[payment.status];
  if (!type) return;

  try {
    const attempts = await attemptsOf(payment.id);
    await emitEvent({
      merchantId: payment.merchantId,
      environment: payment.environment === 'live' ? 'live' : 'test',
      type,
      resourceId: payment.id,
      data: serializePayment(payment, attempts),
    });
  } catch (e) {
    logger.warn({ err: e, payment_id: payment.id }, 'Evenement sortant non mis en file');
  }
}

/**
 * Applique un etat recu d'un agregateur (webhook entrant ou balayeur).
 *
 * Deux garde-fous :
 *   - un etat TERMINAL n'est jamais ecrase : un webhook en retard ne doit pas
 *     faire regresser un paiement deja abouti ;
 *   - un etat non concluant (`pending`, `unknown`) n'ecrase rien non plus : il
 *     signale qu'une interrogation est necessaire, pas un changement d'etat.
 */
export async function applyPaymentUpdate(
  providerId: string,
  providerReference: string,
  result: AttemptResult,
): Promise<{ applied: boolean; attemptId?: string; reason?: string }> {
  const attempt = await prisma.paymentAttempt.findFirst({
    where: { providerId, providerReference },
    orderBy: { createdAt: 'desc' },
  });
  if (!attempt) return { applied: false, reason: 'Aucune tentative pour cette reference.' };

  if (['SUCCEEDED', 'FAILED', 'EXPIRED'].includes(attempt.status)) {
    return { applied: false, attemptId: attempt.id, reason: `Tentative deja ${attempt.status}.` };
  }

  if (result.status === 'pending' || result.status === 'unknown') {
    return {
      applied: false,
      attemptId: attempt.id,
      reason: 'Etat non concluant : interrogation requise.',
    };
  }

  await applyAttemptResult(attempt.id, attempt.paymentId, result);
  return { applied: true, attemptId: attempt.id };
}

/** Encaissement confirme : ecriture au ledger et cloture. */
async function settleSuccess(
  payment: Payment,
  attemptId: string,
  result: AttemptResult,
): Promise<Payment> {
  const attempt = await prisma.paymentAttempt.findUniqueOrThrow({ where: { id: attemptId } });

  // La commission reellement communiquee par l'agregateur prime sur le taux
  // catalogue : c'est la seule valeur exacte, le reste est une estimation.
  const fee = platformPayinFee(payment.merchantId, {
    amountMinor: payment.amount,
    providerFeeAmount: result.providerFeeAmount ?? null,
    providerFeeBps: attempt.providerFeeBps,
  });
  const providerFee = fee.providerAmount;

  if (fee.capped) {
    logger.warn(
      { payment_id: payment.id, provider: attempt.providerId, provider_fee: providerFee },
      'Commission agregateur superieure au taux total : marge Orchi nulle',
    );
  }

  return prisma.$transaction(async (tx) => {
    const updated = await tx.payment.update({
      where: { id: payment.id },
      data: {
        status: 'SUCCEEDED',
        currentAttemptId: attemptId,
        providerFeeAmount: providerFee,
        platformFeeAmount: fee.amount,
        succeededAt: new Date(),
      },
    });

    await postPayinSucceeded(
      {
        merchantId: payment.merchantId,
        paymentId: payment.id,
        providerId: attempt.providerId,
        currency: payment.currency,
        amount: payment.amount,
        providerFee,
        platformFee: fee.amount,
      },
      tx,
    );

    return updated;
  });
}

/* -------------------------------------------------------------------------- */
/* Lecture et rafraichissement                                                */
/* -------------------------------------------------------------------------- */

async function attemptsOf(paymentId: string): Promise<PaymentAttempt[]> {
  return prisma.paymentAttempt.findMany({
    where: { paymentId },
    orderBy: { attemptNumber: 'asc' },
  });
}

/* -------------------------------------------------------------------------- */
/* Liste                                                                      */
/* -------------------------------------------------------------------------- */

export interface ListFilters {
  status?: string;
  country?: string;
  limit: number;
  /** Curseur : identifiant du dernier element de la page precedente. */
  startingAfter?: string;
}

/**
 * Vue compacte pour les listes.
 *
 * Volontairement plus pauvre que `serializePayment` : renvoyer l'historique
 * complet des tentatives pour cent transactions produirait une reponse
 * enorme et lente, alors qu'une liste n'a besoin que de l'essentiel. Le detail
 * s'obtient par GET /v1/payments/:id.
 */
export function serializePaymentRow(
  payment: Payment & { attempts: { providerId: string; status: string }[] },
) {
  const last = payment.attempts[payment.attempts.length - 1];
  return {
    object: 'payment',
    id: payment.id,
    reference: payment.reference,
    status: payment.status,
    amount: payment.amount,
    currency: payment.currency,
    country: payment.country,
    channel: payment.channel,
    customer_phone: payment.customerPhone,
    provider: last?.providerId ?? null,
    attempt_count: payment.attempts.length,
    created_at: payment.createdAt.toISOString(),
    succeeded_at: payment.succeededAt?.toISOString() ?? null,
  };
}

export async function listPayments(merchantId: string, filters: ListFilters) {
  const rows = await prisma.payment.findMany({
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
    /** Present tant qu'une page suivante est possible. */
    next_cursor: rows.length === filters.limit ? (rows[rows.length - 1]?.id ?? null) : null,
    data: rows.map(serializePaymentRow),
  };
}

export async function getPayment(
  merchantId: string,
  paymentId: string,
): Promise<{ payment: Payment; attempts: PaymentAttempt[] }> {
  const payment = await prisma.payment.findFirst({ where: { id: paymentId, merchantId } });
  if (!payment) throw errors.notFound('Paiement', paymentId);
  return { payment, attempts: await attemptsOf(payment.id) };
}

/**
 * Interroge l'agregateur pour une tentative non terminee.
 *
 * A l'etape 3, c'est le seul moyen de faire avancer un paiement : les webhooks
 * et le balayeur automatique arrivent a l'etape 6. Cette fonction restera
 * ensuite comme filet, parce qu'un webhook peut toujours se perdre.
 */
export async function refreshPayment(
  merchantId: string,
  paymentId: string,
): Promise<{ payment: Payment; attempts: PaymentAttempt[] }> {
  const { payment, attempts } = await getPayment(merchantId, paymentId);
  const current = attempts.find((a) => a.id === payment.currentAttemptId);

  if (!current || !current.providerReference) return { payment, attempts };
  if (['SUCCEEDED', 'FAILED', 'EXPIRED'].includes(current.status)) return { payment, attempts };

  const adapter = requireProviderAdapter(current.providerId);
  const ctx = await buildProviderContext(current.providerAccountId);

  try {
    const result = await runInstrumented(
      { providerId: current.providerId, country: payment.country, channel: payment.channel },
      () => adapter.getCharge(current.providerReference!, ctx),
    );
    const updated = await applyAttemptResult(current.id, payment.id, result);
    return { payment: updated, attempts: await attemptsOf(payment.id) };
  } catch (e) {
    if (!isProviderError(e)) throw e;
    // Une interrogation qui echoue ne change RIEN a l'etat connu : on renvoie
    // ce que l'on sait, sans degrader le statut.
    logger.warn({ payment_id: payment.id, ...e.toLogContext() }, 'Rafraichissement impossible');
    return { payment, attempts };
  }
}

/* -------------------------------------------------------------------------- */
/* Relance                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Nouvelle tentative sur un autre agregateur.
 *
 * Interdite tant que la tentative en cours peut encore aboutir : deux push
 * USSD vivants sur un meme paiement, c'est un double debit du client.
 */
export async function retryPayment(
  merchantId: string,
  paymentId: string,
  environment: 'test' | 'live',
): Promise<{ payment: Payment; attempts: PaymentAttempt[] }> {
  const { payment, attempts } = await getPayment(merchantId, paymentId);

  if (payment.status === 'SUCCEEDED') {
    throw new AppError({
      type: 'invalid_request_error',
      code: 'payment_already_succeeded',
      message: 'Ce paiement a deja abouti.',
      httpStatus: 409,
      retriable: false,
    });
  }

  const current = attempts.find((a) => a.id === payment.currentAttemptId);
  if (current && !['FAILED', 'EXPIRED'].includes(current.status)) {
    throw new AppError({
      type: 'invalid_request_error',
      code: 'attempt_still_open',
      message:
        current.status === 'UNKNOWN'
          ? "L'etat de la tentative en cours est indetermine. Aucune relance avant reconciliation."
          : 'Une tentative est encore en cours. Attendez son issue avant de relancer.',
      httpStatus: 409,
      retriable: current.status !== 'UNKNOWN',
      details: { attempt_status: current.status },
    });
  }

  const tried = [...new Set(attempts.map((a) => a.providerId))];
  const plan = await selectCandidates({
    merchantId,
    environment,
    country: payment.country,
    channel: payment.channel as Channel,
    direction: 'payin',
    seed: payment.reference,
    excludeProviderIds: tried,
  });

  const updated = await runAttempts(payment, plan);
  return { payment: updated, attempts: await attemptsOf(payment.id) };
}

/* -------------------------------------------------------------------------- */
/* Serialisation API                                                          */
/* -------------------------------------------------------------------------- */

function serializeAction(attempt: PaymentAttempt | undefined): CustomerAction {
  if (!attempt || !attempt.actionType) return { type: 'none' };
  switch (attempt.actionType) {
    case 'redirect':
      return {
        type: 'redirect',
        url: attempt.actionUrl ?? '',
        ...(attempt.actionExpiresAt ? { expiresAt: attempt.actionExpiresAt.toISOString() } : {}),
      };
    case 'ussd_push':
    case 'otp_required':
      return {
        type: attempt.actionType,
        instructions: attempt.actionInstructions ?? '',
        ...(attempt.actionExpiresAt ? { expiresAt: attempt.actionExpiresAt.toISOString() } : {}),
      };
    default:
      return { type: 'none' };
  }
}

export function serializePayment(payment: Payment, attempts: PaymentAttempt[]) {
  const current = attempts.find((a) => a.id === payment.currentAttemptId);

  return {
    object: 'payment',
    id: payment.id,
    reference: payment.reference,
    status: payment.status,
    amount: payment.amount,
    currency: payment.currency,
    country: payment.country,
    channel: payment.channel,
    network: payment.network,
    customer: {
      phone: payment.customerPhone,
      email: payment.customerEmail,
      name: payment.customerName,
    },
    description: payment.description,
    metadata: JSON.parse(payment.metadata) as Record<string, string>,
    fees: {
      provider: payment.providerFeeAmount,
      platform: payment.platformFeeAmount,
    },
    /** Ce que le marchand doit faire executer par son client. */
    action: serializeAction(current),
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
      provider_code: a.providerCode,
      created_at: a.createdAt.toISOString(),
    })),
    succeeded_at: payment.succeededAt?.toISOString() ?? null,
    created_at: payment.createdAt.toISOString(),
  };
}
