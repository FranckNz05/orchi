import { ID_PREFIX, newId } from '../../core/ids.js';
import { logger } from '../../core/logger.js';
import { prisma } from '../../db/client.js';
import { getProviderAdapter } from '../../providers/registry.js';
import type { AttemptResult, WebhookInput } from '../../providers/types.js';
import { applyPaymentUpdate, refreshPayment } from '../payments.js';
import { applyPayoutUpdate, refreshPayout } from '../payouts.js';
import { buildProviderContext } from '../provider-accounts.js';

/**
 * Webhooks entrants : l'agregateur vers Orchi.
 *
 * Quatre principes, tous issus du fait qu'un webhook est une entree hostile :
 *
 * 1. ON ENREGISTRE AVANT DE TRAITER, et meme quand la signature est invalide.
 *    Une rafale de webhooks non signes est un signal de securite, pas un
 *    non-evenement.
 * 2. LE CORPS BRUT EST CONSERVE. La signature porte sur les octets recus ; un
 *    JSON reserialise ne se verifie plus.
 * 3. LA DEDUPLICATION EST STRUCTURELLE. Une contrainte d'unicite sur
 *    (agregateur, identifiant d'evenement) : les agregateurs rejouent leurs
 *    notifications, c'est normal et attendu.
 * 4. UN WEBHOOK NE FAIT JAMAIS REGRESSER UN ETAT TERMINAL. Les notifications
 *    arrivent dans le desordre ; celle qui arrive en retard ne doit pas
 *    ecraser celle qui a conclu.
 *
 * La reponse HTTP est toujours 200 des lors que la requete est bien formee :
 * un agregateur qui recoit une erreur reessaie, et une rafale de reprises sur
 * un evenement que nous ne saurons de toute facon pas traiter n'aide personne.
 * Le detail du traitement est dans `outcome`.
 */

export type InboundOutcome = 'APPLIED' | 'IGNORED' | 'REJECTED' | 'DUPLICATE' | 'POLLED';

export interface InboundResult {
  outcome: InboundOutcome;
  note: string;
  attemptId?: string;
}

export interface InboundRequest {
  providerId: string;
  /** Jeton d'URL identifiant le compte agregateur destinataire. */
  token: string;
  rawBody: string;
  headers: Record<string, string | string[] | undefined>;
}

export async function handleInboundWebhook(request: InboundRequest): Promise<InboundResult> {
  const account = await prisma.providerAccount.findUnique({
    where: { webhookToken: request.token },
  });

  // Jeton inconnu : on ne sait meme pas a quel marchand rattacher la trace.
  // Rien n'est enregistre, sinon n'importe qui pourrait remplir la table.
  if (!account || account.providerId !== request.providerId) {
    logger.warn({ provider: request.providerId }, 'Webhook entrant sur un jeton inconnu');
    return { outcome: 'REJECTED', note: 'Jeton de callback inconnu.' };
  }

  const adapter = getProviderAdapter(request.providerId);
  if (!adapter) {
    return await record({
      providerId: request.providerId,
      account,
      eventId: `unmapped_${Date.now()}`,
      rawBody: request.rawBody,
      signatureValid: false,
      rejectReason: 'Aucun adaptateur pour cet agregateur.',
      outcome: 'REJECTED',
      note: 'Aucun adaptateur pour cet agregateur.',
    });
  }

  const ctx = await buildProviderContext(account.id);
  const input: WebhookInput = { rawBody: request.rawBody, headers: request.headers };

  let verdict: ReturnType<typeof adapter.verifyWebhook>;
  try {
    verdict = adapter.verifyWebhook(input, ctx);
  } catch (e) {
    // Le port interdit a verifyWebhook de lever. Si cela arrive quand meme, on
    // le traite comme un rejet plutot que de laisser tomber le serveur.
    logger.error({ err: e, provider: request.providerId }, 'verifyWebhook a leve');
    verdict = { valid: false, reason: 'Verification impossible.' };
  }

  if (!verdict.valid) {
    return await record({
      providerId: request.providerId,
      account,
      eventId: `invalid_${newId(ID_PREFIX.webhookEvent)}`,
      rawBody: request.rawBody,
      signatureValid: false,
      rejectReason: verdict.reason,
      outcome: 'REJECTED',
      note: verdict.reason,
    });
  }

  const stored = await record({
    providerId: request.providerId,
    account,
    eventId: verdict.eventId,
    rawBody: request.rawBody,
    signatureValid: true,
    providerReference: verdict.providerReference,
    kind: verdict.kind,
    status: verdict.status,
    outcome: 'RECEIVED',
    note: 'Recu.',
  });

  if (stored.outcome === 'DUPLICATE') return stored;

  const result: AttemptResult = {
    providerReference: verdict.providerReference,
    status: verdict.status,
    action: { type: 'none' },
    ...(verdict.providerCode !== undefined ? { providerCode: verdict.providerCode } : {}),
    ...(verdict.providerMessage !== undefined ? { providerMessage: verdict.providerMessage } : {}),
    raw: verdict.raw,
  };

  const applied =
    verdict.kind === 'payout'
      ? await applyPayoutUpdate(request.providerId, verdict.providerReference, result)
      : await applyPaymentUpdate(request.providerId, verdict.providerReference, result);

  // Etat non concluant — le cas de CinetPay, dont la notification ne porte
  // aucune information d'etat. On va chercher la verite chez l'agregateur.
  if (!applied.applied && applied.reason?.startsWith('Etat non concluant')) {
    const polled = await pollFrom(applied.attemptId, verdict.kind);
    await finalize(stored.attemptId ?? null, verdict.eventId, request.providerId, {
      outcome: 'POLLED',
      note: polled,
      attemptId: applied.attemptId ?? null,
    });
    return { outcome: 'POLLED', note: polled, ...(applied.attemptId ? { attemptId: applied.attemptId } : {}) };
  }

  const outcome: InboundOutcome = applied.applied ? 'APPLIED' : 'IGNORED';
  const note = applied.applied ? 'Etat applique.' : (applied.reason ?? 'Ignore.');
  await finalize(stored.attemptId ?? null, verdict.eventId, request.providerId, {
    outcome,
    note,
    attemptId: applied.attemptId ?? null,
  });

  return { outcome, note, ...(applied.attemptId ? { attemptId: applied.attemptId } : {}) };
}

/* -------------------------------------------------------------------------- */

interface RecordInput {
  providerId: string;
  account: { id: string; merchantId: string } | null;
  eventId: string;
  rawBody: string;
  signatureValid: boolean;
  rejectReason?: string;
  providerReference?: string;
  kind?: string;
  status?: string;
  outcome: string;
  note: string;
}

async function record(input: RecordInput): Promise<InboundResult & { attemptId?: string }> {
  // Chemin rapide : un agregateur qui rejoue une notification est un cas
  // NOMINAL. Le lire d'abord evite de produire une violation de contrainte — et
  // le log d'erreur qui va avec — a chaque reprise.
  const known = await prisma.inboundWebhook.findUnique({
    where: { providerId_eventId: { providerId: input.providerId, eventId: input.eventId } },
  });
  if (known) return { outcome: 'DUPLICATE', note: 'Evenement deja traite.' };

  try {
    await prisma.inboundWebhook.create({
      data: {
        id: newId(ID_PREFIX.webhookEvent),
        providerId: input.providerId,
        providerAccountId: input.account?.id ?? null,
        merchantId: input.account?.merchantId ?? null,
        eventId: input.eventId,
        // Tronque : un agregateur peut envoyer une charge volumineuse, et la
        // table de webhooks ne doit pas devenir le poste de stockage principal.
        rawBody: input.rawBody.slice(0, 20_000),
        signatureValid: input.signatureValid,
        rejectReason: input.rejectReason ?? null,
        providerReference: input.providerReference ?? null,
        kind: input.kind ?? 'unknown',
        status: input.status ?? null,
        outcome: input.outcome,
        note: input.note,
      },
    });
  } catch {
    // Violation d'unicite (providerId, eventId) : l'agregateur rejoue.
    return { outcome: 'DUPLICATE', note: 'Evenement deja traite.' };
  }

  return { outcome: input.outcome as InboundOutcome, note: input.note };
}

async function finalize(
  _unused: string | null,
  eventId: string,
  providerId: string,
  data: { outcome: string; note: string; attemptId: string | null },
): Promise<void> {
  await prisma.inboundWebhook
    .update({
      where: { providerId_eventId: { providerId, eventId } },
      data: {
        outcome: data.outcome,
        note: data.note,
        appliedToAttemptId: data.attemptId,
        processedAt: new Date(),
      },
    })
    .catch((e: unknown) => logger.warn({ err: e }, 'Trace de webhook non finalisee'));
}

/** Va chercher l'etat reel chez l'agregateur pour la tentative concernee. */
async function pollFrom(attemptId: string | undefined, kind: string): Promise<string> {
  if (!attemptId) return 'Aucune tentative a interroger.';

  try {
    if (kind === 'payout') {
      const attempt = await prisma.payoutAttempt.findUnique({
        where: { id: attemptId },
        include: { payout: true },
      });
      if (!attempt) return 'Tentative introuvable.';
      const { payout } = await refreshPayout(attempt.payout.merchantId, attempt.payoutId);
      return `Interroge : decaissement ${payout.status}.`;
    }

    const attempt = await prisma.paymentAttempt.findUnique({
      where: { id: attemptId },
      include: { payment: true },
    });
    if (!attempt) return 'Tentative introuvable.';
    const { payment } = await refreshPayment(attempt.payment.merchantId, attempt.paymentId);
    return `Interroge : paiement ${payment.status}.`;
  } catch (e) {
    logger.warn({ err: e, attempt_id: attemptId }, 'Interrogation declenchee par webhook en echec');
    return 'Interrogation impossible pour le moment.';
  }
}
