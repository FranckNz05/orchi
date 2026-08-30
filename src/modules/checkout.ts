import { randomBytes } from 'node:crypto';
import type { CheckoutSession } from '@prisma/client';
import { getCountry } from '../catalog/countries.js';
import type { Channel } from '../catalog/coverage.js';
import { AppError, errors } from '../core/errors.js';
import { env } from '../core/env.js';
import { ID_PREFIX, newId } from '../core/ids.js';
import { assertValidAmount } from '../core/money.js';
import { prisma } from '../db/client.js';
import { getProviderAdapter } from '../providers/registry.js';
import { createPayment, getPayment, refreshPayment, serializePayment } from './payments.js';

/**
 * Page de paiement hebergee.
 *
 * Le marchand cree une SESSION, redirige son client vers l'URL renvoyee, et
 * n'a plus rien a faire : il ne manipule ni numero de telephone, ni choix
 * d'operateur, ni etat de push USSD.
 *
 * MODELE DE SECURITE — le jeton d'URL est la seule authentification de cette
 * page, et il est expose dans la barre d'adresse du client final. Il est donc :
 *   - long et non devinable (32 octets) ;
 *   - limite a UNE session : il ne donne acces a aucune autre donnee du
 *     marchand ;
 *   - expirant ;
 *   - en lecture seule sur des champs deja connus du client (montant,
 *     commercant, devise). Rien de sensible n'est expose.
 *
 * Ce que la page publique ne peut PAS faire : lire d'autres transactions,
 * changer le montant, ou apprendre quoi que ce soit sur le marchand au-dela de
 * son nom commercial.
 */

const DEFAULT_TTL_MINUTES = 60;

export interface CreateSessionInput {
  merchantId: string;
  environment: 'test' | 'live';
  reference: string;
  amount: number;
  currency: string;
  country: string;
  description?: string;
  customer?: { name?: string; email?: string; phone?: string };
  successUrl?: string;
  cancelUrl?: string;
  metadata?: Record<string, string>;
  ttlMinutes?: number;
}

export function checkoutUrl(token: string): string {
  return `${env.PUBLIC_BASE_URL}/pay/${token}`;
}

export async function createCheckoutSession(input: CreateSessionInput) {
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

  const existing = await prisma.checkoutSession.findUnique({
    where: { merchantId_reference: { merchantId: input.merchantId, reference: input.reference } },
  });

  if (existing) {
    // Meme logique que pour les paiements : la reference marchand est un filet
    // contre les doublons. Rejouer la creation renvoie la session existante
    // plutot que d'en ouvrir une seconde pour la meme commande.
    if (existing.amount !== input.amount || existing.currency !== input.currency.toUpperCase()) {
      throw new AppError({
        type: 'invalid_request_error',
        code: 'duplicate_reference',
        message: `La reference ${input.reference} designe deja une session de montant different.`,
        httpStatus: 409,
        retriable: false,
        details: { session_id: existing.id },
      });
    }
    return existing;
  }

  const ttl = Math.min(Math.max(input.ttlMinutes ?? DEFAULT_TTL_MINUTES, 5), 24 * 60);

  return prisma.checkoutSession.create({
    data: {
      id: newId(ID_PREFIX.payment).replace('pay_', 'cs_'),
      token: randomBytes(32).toString('base64url'),
      merchantId: input.merchantId,
      environment: input.environment,
      reference: input.reference,
      amount: input.amount,
      currency: input.currency.toUpperCase(),
      country: input.country.toUpperCase(),
      description: input.description ?? null,
      metadata: JSON.stringify(input.metadata ?? {}),
      customerName: input.customer?.name ?? null,
      customerEmail: input.customer?.email ?? null,
      customerPhone: input.customer?.phone ?? null,
      successUrl: input.successUrl ?? null,
      cancelUrl: input.cancelUrl ?? null,
      expiresAt: new Date(Date.now() + ttl * 60_000),
    },
  });
}

export function serializeSession(session: CheckoutSession) {
  return {
    object: 'checkout_session',
    id: session.id,
    reference: session.reference,
    status: session.status,
    amount: session.amount,
    currency: session.currency,
    country: session.country,
    url: checkoutUrl(session.token),
    payment_id: session.paymentId,
    expires_at: session.expiresAt.toISOString(),
    created_at: session.createdAt.toISOString(),
  };
}

/* -------------------------------------------------------------------------- */
/* Vue publique                                                               */
/* -------------------------------------------------------------------------- */

export interface PaymentOption {
  channel: Channel;
  network: string | null;
  label: string;
}

/** Libelles lisibles par un client final, deduits des codes reseau. */
const NETWORK_LABELS: Readonly<Record<string, string>> = {
  MTN_BENIN: 'MTN MoMo', MOOV_BENIN: 'Moov Money', TMONEY: 'T-Money',
  MOOV_TOGO: 'Moov Money', ORANGE_CI: 'Orange Money', MTN_CI: 'MTN MoMo',
  MOOV_CI: 'Moov Money', WAVE_CI: 'Wave', ORANGE_SN: 'Orange Money',
  FREE_SN: 'Free Money', WAVE_SN: 'Wave', ORANGE_ML: 'Orange Money',
  MALITEL: 'Malitel', ORANGE_BF: 'Orange Money', MOOV_BF: 'Moov Africa',
  ZAMANI: 'Zamani', AIRTEL_NE: 'Airtel Money', ORANGE_GW: 'Orange Money',
  ORANGE_GN: 'Orange Money', MTN_GN: 'MTN MoMo', MTN_GH: 'MTN MoMo',
  TELECEL_GH: 'Telecel Cash', AIRTELTIGO_GH: 'AirtelTigo Money',
  MTN_CM: 'MTN MoMo', ORANGE_CM: 'Orange Money', AIRTEL_GA: 'Airtel Money',
  MOOV_GA: 'Moov Money', MTN_CG: 'MTN MoMo', AIRTEL_CG: 'Airtel Money',
  MPESA_CD: 'M-Pesa', ORANGE_CD: 'Orange Money', AIRTEL_CD: 'Airtel Money',
  AFRICELL_CD: 'Africell Money', MPESA_KE: 'M-Pesa', AIRTEL_KE: 'Airtel Money',
  MTN_UG: 'MTN MoMo', AIRTEL_UG: 'Airtel Money', MTN_RW: 'MTN MoMo',
  AIRTEL_RW: 'Airtel Money', MTN_ZM: 'MTN MoMo', ZAMTEL: 'Zamtel Kwacha',
  ORANGE_SL: 'Orange Money', ORANGE_CF: 'Orange Money', NIBSS: 'Virement bancaire',
  EFT_ZA: 'Virement instantané',
};

function labelFor(network: string): string {
  return NETWORK_LABELS[network] ?? network.replace(/_/g, ' ');
}

/**
 * Moyens de paiement proposables au client, pour ce pays.
 *
 * Deduits de la couverture ET de ce que les adaptateurs branches savent
 * reellement traiter : proposer un bouton qui echouera est pire que ne pas le
 * proposer du tout.
 */
export async function paymentOptionsFor(
  country: string,
  environment: 'test' | 'live',
): Promise<PaymentOption[]> {
  const rules = await prisma.coverageRule.findMany({
    where: {
      countryIso2: country.toUpperCase(),
      enabled: true,
      supportsPayin: true,
      provider: { enabled: true },
    },
    orderBy: { priority: 'asc' },
  });

  const seen = new Set<string>();
  const options: PaymentOption[] = [];

  for (const rule of rules) {
    const adapter = getProviderAdapter(rule.providerId);
    if (!adapter) continue;
    if (rule.providerId === 'sandbox' && environment !== 'test') continue;

    const channels = rule.channels.split(',').map((c) => c.trim()) as Channel[];
    const networks = rule.networks.split(',').map((n) => n.trim()).filter(Boolean);

    for (const channel of channels) {
      if (!adapter.supports(country, channel, 'payin')) continue;

      if (channel === 'mobile_money') {
        for (const network of networks) {
          if (seen.has(network)) continue;
          seen.add(network);
          options.push({ channel, network, label: labelFor(network) });
        }
      } else if (!seen.has(channel)) {
        seen.add(channel);
        options.push({
          channel,
          network: null,
          label: channel === 'card' ? 'Carte bancaire' : 'Virement bancaire',
        });
      }
    }
  }

  return options;
}

const sessionErrors = {
  notFound: () =>
    new AppError({
      type: 'invalid_request_error',
      code: 'checkout_not_found',
      message: 'Ce lien de paiement est introuvable.',
      httpStatus: 404,
      retriable: false,
    }),
  expired: () =>
    new AppError({
      type: 'invalid_request_error',
      code: 'checkout_expired',
      message: 'Ce lien de paiement a expiré.',
      httpStatus: 410,
      retriable: false,
    }),
} as const;

export async function resolveByToken(token: string): Promise<CheckoutSession> {
  const session = await prisma.checkoutSession.findUnique({ where: { token } });
  if (!session) throw sessionErrors.notFound();

  if (session.status === 'OPEN' && session.expiresAt.getTime() < Date.now()) {
    await prisma.checkoutSession.update({ where: { id: session.id }, data: { status: 'EXPIRED' } });
    throw sessionErrors.expired();
  }
  return session;
}

/**
 * Vue exposee au client final.
 *
 * Ne contient QUE ce qu'il doit voir pour payer. Notamment : pas d'identifiant
 * marchand, pas de metadonnees, pas de reference interne.
 */
export async function publicView(token: string) {
  const session = await resolveByToken(token);
  const merchant = await prisma.merchant.findUniqueOrThrow({
    where: { id: session.merchantId },
    select: { name: true },
  });

  const payment = session.paymentId
    ? await prisma.payment.findUnique({ where: { id: session.paymentId } })
    : null;

  const attempt = payment?.currentAttemptId
    ? await prisma.paymentAttempt.findUnique({ where: { id: payment.currentAttemptId } })
    : null;

  return {
    status: session.status,
    merchant: merchant.name,
    amount: session.amount,
    currency: session.currency,
    country: session.country,
    description: session.description,
    environment: session.environment,
    prefill: { name: session.customerName, email: session.customerEmail, phone: session.customerPhone },
    options: session.status === 'OPEN' ? await paymentOptionsFor(session.country, session.environment as 'test' | 'live') : [],
    expires_at: session.expiresAt.toISOString(),
    payment: payment
      ? {
          status: payment.status,
          action: attempt?.actionType ?? 'none',
          action_url: attempt?.actionUrl ?? null,
          instructions: attempt?.actionInstructions ?? null,
          /** Reseau retenu, pour nommer l'operateur dans le message d'attente. */
          network: payment.network,
          provider: attempt?.providerId ?? null,
          failure: attempt?.providerMessage ?? null,
        }
      : null,
    return_url:
      session.status === 'COMPLETED' ? session.successUrl : session.cancelUrl ?? session.successUrl,
  };
}

/* -------------------------------------------------------------------------- */
/* Paiement depuis la page                                                    */
/* -------------------------------------------------------------------------- */

export interface ConfirmInput {
  token: string;
  channel: Channel;
  network?: string;
  phone?: string;
  name?: string;
  email?: string;
}

export async function confirmCheckout(input: ConfirmInput) {
  const session = await resolveByToken(input.token);

  if (session.status !== 'OPEN') {
    // Idempotent : recharger la page apres paiement ne doit pas relancer une
    // transaction. On renvoie l'etat courant.
    return publicView(input.token);
  }

  // Le moyen choisi doit figurer parmi ceux que l'on a proposes : sans cette
  // verification, un client pourrait forcer un canal non desservi.
  const options = await paymentOptionsFor(session.country, session.environment as 'test' | 'live');
  const chosen = options.find(
    (o) => o.channel === input.channel && (o.network ?? null) === (input.network ?? null),
  );
  if (!chosen) {
    throw errors.invalidRequest('Ce moyen de paiement n’est pas disponible.', 'channel');
  }

  if (input.channel === 'mobile_money' && !input.phone) {
    throw errors.invalidRequest('Numéro de téléphone requis.', 'phone');
  }
  if (input.channel === 'card' && !input.email) {
    throw errors.invalidRequest('Adresse e-mail requise.', 'email');
  }

  const { payment } = await createPayment({
    merchantId: session.merchantId,
    environment: session.environment as 'test' | 'live',
    reference: session.reference,
    amount: session.amount,
    currency: session.currency,
    country: session.country,
    channel: input.channel,
    ...(chosen.network ? { network: chosen.network } : {}),
    customer: {
      ...(input.phone ? { phone: input.phone } : {}),
      ...(input.email ?? session.customerEmail ? { email: input.email ?? session.customerEmail! } : {}),
      ...(input.name ?? session.customerName ? { name: input.name ?? session.customerName! } : {}),
    },
    ...(session.description ? { description: session.description } : {}),
    metadata: {
      ...(JSON.parse(session.metadata) as Record<string, string>),
      orchi_checkout_session: session.id,
    },
    ...(session.successUrl ? { returnUrl: session.successUrl } : {}),
  });

  await prisma.checkoutSession.update({
    where: { id: session.id },
    data: { paymentId: payment.id },
  });

  return publicView(input.token);
}

/**
 * Etat courant, interroge par la page pendant que le client valide son push.
 *
 * Rafraichit le paiement aupres de l'agregateur : sans cela, la page tournerait
 * indefiniment en attendant un webhook qui peut ne jamais arriver.
 */
export async function pollCheckout(token: string) {
  const session = await resolveByToken(token);

  if (session.paymentId) {
    try {
      const { payment } = await refreshPayment(session.merchantId, session.paymentId);

      if (payment.status === 'SUCCEEDED' && session.status !== 'COMPLETED') {
        await prisma.checkoutSession.update({
          where: { id: session.id },
          data: { status: 'COMPLETED', completedAt: new Date() },
        });
      }
    } catch {
      // Une interrogation qui echoue ne doit pas casser la page : on renvoie
      // simplement le dernier etat connu.
    }
  }

  return publicView(token);
}

/** Detail complet, reserve au marchand authentifie. */
export async function getSessionForMerchant(merchantId: string, id: string) {
  const session = await prisma.checkoutSession.findFirst({ where: { id, merchantId } });
  if (!session) throw errors.notFound('Session de paiement', id);

  const payment = session.paymentId
    ? await getPayment(merchantId, session.paymentId).catch(() => null)
    : null;

  return {
    ...serializeSession(session),
    payment: payment ? serializePayment(payment.payment, payment.attempts) : null,
  };
}
