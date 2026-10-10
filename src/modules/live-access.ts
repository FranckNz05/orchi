import type { Merchant } from '@prisma/client';
import { getCountry } from '../catalog/countries.js';
import { ID_PREFIX, newId } from '../core/ids.js';
import { AppError, errors } from '../core/errors.js';
import { prisma } from '../db/client.js';

/**
 * Passage a l'environnement reel.
 *
 * POURQUOI UNE VALIDATION HUMAINE
 *
 * Un marchand peut tout integrer, tout tester et tout casser en `test` sans
 * demander la permission a personne : c'est le simulateur, aucun argent n'est
 * en jeu. Le `live`, lui, met en circulation de vrais fonds appartenant a de
 * vrais clients finaux. Une plateforme qui laisse ce basculement a la main du
 * marchand devient, du jour au lendemain, l'instrument de qui veut bien s'en
 * servir — encaisser sans jamais livrer, blanchir, ou simplement operer sans
 * les autorisations que son pays exige.
 *
 * La verification n'est donc pas une formalite administrative ajoutee apres
 * coup : c'est la seule chose qui separe une passerelle de paiement d'un
 * distributeur d'argent anonyme.
 *
 * CE QUE LE CODE FAIT, ET CE QU'IL NE FAIT PAS
 *
 * Le code n'accorde jamais l'acces. Il enregistre une demande, la presente a un
 * administrateur, et applique sa decision. Il n'existe volontairement aucun
 * chemin — pas meme une variable d'environnement — permettant de verifier un
 * marchand automatiquement. Un tel chemin finirait par etre emprunte « juste
 * pour un client pressé », et c'est exactement comme ca qu'une regle de
 * conformite cesse d'en etre une.
 *
 * L'UNIQUE POINT DE CONTROLE
 *
 * `assertLiveAllowed` est appele partout ou l'environnement reel peut etre
 * atteint : creation d'une cle `live`, bascule du tableau de bord. Le controle
 * porte sur l'etat du marchand lu en base a l'instant T, jamais sur une valeur
 * transportee dans une session ou un jeton — sans quoi une suspension mettrait
 * des heures a produire son effet.
 */

export type KybStatus = 'UNVERIFIED' | 'PENDING' | 'VERIFIED' | 'REJECTED';

export interface LiveRequestInput {
  merchantId: string;
  /** Ce que le marchand vend. Premier element d'appreciation du dossier. */
  activity: string;
  website?: string;
  /** Volume mensuel estime, en unites mineures de la devise du marchand. */
  monthlyVolumeMinor?: number;
  registrationNumber?: string;
}

export const liveErrors = {
  notVerified(status: KybStatus): AppError {
    const explain: Record<KybStatus, string> = {
      UNVERIFIED:
        "Votre compte n'est pas encore verifie. Deposez une demande d'acces depuis votre tableau de bord.",
      PENDING: "Votre demande d'acces est en cours d'examen. Vous serez notifie de la decision.",
      VERIFIED: '',
      REJECTED:
        "Votre demande d'acces a ete refusee. Le motif figure sur votre tableau de bord ; vous pouvez deposer une nouvelle demande apres correction.",
    };
    return new AppError({
      type: 'invalid_request_error',
      code: 'live_access_denied',
      message: explain[status],
      httpStatus: 403,
      retriable: false,
      details: { kyb_status: status },
    });
  },
};

/**
 * Barriere unique vers l'environnement reel.
 *
 * Renvoie le marchand pour eviter au code appelant une seconde lecture : c'est
 * un controle sur le chemin critique d'une creation de cle, pas une fonction
 * de confort.
 */
export async function assertLiveAllowed(merchantId: string): Promise<Merchant> {
  const merchant = await prisma.merchant.findUnique({ where: { id: merchantId } });
  if (!merchant) throw errors.notFound('merchant', merchantId);
  if (merchant.status !== 'ACTIVE') throw errors.merchantInactive(merchant.status);
  if (merchant.kybStatus !== 'VERIFIED') {
    throw liveErrors.notVerified(merchant.kybStatus as KybStatus);
  }
  return merchant;
}

export async function requestLiveAccess(input: LiveRequestInput): Promise<Merchant> {
  const merchant = await prisma.merchant.findUnique({ where: { id: input.merchantId } });
  if (!merchant) throw errors.notFound('merchant', input.merchantId);

  if (merchant.kybStatus === 'VERIFIED') {
    throw new AppError({
      type: 'invalid_request_error',
      code: 'already_verified',
      message: 'Votre compte est deja verifie : l\'environnement reel est ouvert.',
      httpStatus: 409,
      retriable: false,
    });
  }
  if (merchant.kybStatus === 'PENDING') {
    // Redeposer n'apporte rien et fait grossir la file d'examen. On renvoie
    // l'etat courant plutot qu'une erreur : le marchand qui reclique n'a rien
    // fait de mal, il attend.
    return merchant;
  }

  return prisma.merchant.update({
    where: { id: input.merchantId },
    data: {
      kybStatus: 'PENDING',
      liveRequestedAt: new Date(),
      liveActivity: input.activity.slice(0, 600),
      liveWebsite: input.website?.slice(0, 300) ?? null,
      liveVolumeMinor: input.monthlyVolumeMinor ?? null,
      // Une nouvelle demande efface la decision precedente : afficher au
      // marchand « refuse » a cote de « en cours d'examen » n'aurait aucun sens.
      liveReviewedAt: null,
      liveReviewedBy: null,
      liveReviewNote: null,
      ...(input.registrationNumber ? { registrationNumber: input.registrationNumber } : {}),
    },
  });
}

export interface ReviewInput {
  merchantId: string;
  decision: 'approve' | 'reject';
  note?: string;
  /** Utilisateur administrateur qui tranche. Conserve pour la tracabilite. */
  reviewerId: string;
  reviewerEmail: string;
}

export async function reviewLiveAccess(input: ReviewInput): Promise<Merchant> {
  const merchant = await prisma.merchant.findUnique({ where: { id: input.merchantId } });
  if (!merchant) throw errors.notFound('merchant', input.merchantId);

  if (input.decision === 'reject' && !input.note?.trim()) {
    // Un refus sans motif est un refus que le marchand ne peut pas corriger :
    // il redeposera le meme dossier, et l'examen recommencera pour rien.
    throw errors.invalidRequest('Un refus doit etre motive.', 'note');
  }

  return prisma.merchant.update({
    where: { id: input.merchantId },
    data: {
      kybStatus: input.decision === 'approve' ? 'VERIFIED' : 'REJECTED',
      liveReviewedAt: new Date(),
      liveReviewedBy: `${input.reviewerId} (${input.reviewerEmail})`,
      liveReviewNote: input.note?.slice(0, 800) ?? null,
    },
  });
}

/**
 * Retrait de la verification.
 *
 * Les cles `live` deja emises sont revoquees dans le meme mouvement : laisser
 * un marchand suspendu continuer d'encaisser avec une cle distribuee la veille
 * viderait la suspension de tout effet.
 */
export async function revokeLiveAccess(input: ReviewInput): Promise<Merchant> {
  const [merchant] = await prisma.$transaction([
    prisma.merchant.update({
      where: { id: input.merchantId },
      data: {
        kybStatus: 'REJECTED',
        liveReviewedAt: new Date(),
        liveReviewedBy: `${input.reviewerId} (${input.reviewerEmail})`,
        liveReviewNote: input.note?.slice(0, 800) ?? 'Acces reel retire.',
      },
    }),
    prisma.apiKey.updateMany({
      where: { merchantId: input.merchantId, environment: 'live', revokedAt: null },
      data: { revokedAt: new Date() },
    }),
    // Les sessions ouvertes en `live` retombent en `test` : sans cela, un
    // tableau de bord deja ouvert continuerait d'afficher l'environnement reel.
    prisma.session.updateMany({
      where: { user: { merchantId: input.merchantId }, environment: 'live' },
      data: { environment: 'test' },
    }),
  ]);
  return merchant;
}

/** Vue du dossier telle que le MARCHAND la voit sur son tableau de bord. */
export function serializeLiveState(merchant: Merchant) {
  return {
    object: 'live_access',
    status: merchant.kybStatus,
    can_go_live: merchant.kybStatus === 'VERIFIED',
    requested_at: merchant.liveRequestedAt?.toISOString() ?? null,
    reviewed_at: merchant.liveReviewedAt?.toISOString() ?? null,
    // `liveReviewedBy` contient l'identite de l'administrateur : elle regarde la
    // plateforme, pas le marchand. Seul le motif lui est renvoye.
    note: merchant.liveReviewNote,
    activity: merchant.liveActivity,
    website: merchant.liveWebsite,
  };
}

/** Vue du dossier telle que l'ADMINISTRATEUR la voit. */
export function serializeForReview(
  merchant: Merchant & { _count?: { users: number; payments: number; apiKeys: number } },
) {
  return {
    object: 'merchant_review',
    id: merchant.id,
    name: merchant.name,
    legal_type: merchant.legalType,
    country: merchant.country,
    registration_number: merchant.registrationNumber,
    contact_email: merchant.contactEmail,
    contact_phone: merchant.contactPhone,
    status: merchant.status,
    kyb_status: merchant.kybStatus,
    activity: merchant.liveActivity,
    website: merchant.liveWebsite,
    monthly_volume_minor: merchant.liveVolumeMinor,
    requested_at: merchant.liveRequestedAt?.toISOString() ?? null,
    reviewed_at: merchant.liveReviewedAt?.toISOString() ?? null,
    reviewed_by: merchant.liveReviewedBy,
    note: merchant.liveReviewNote,
    created_at: merchant.createdAt.toISOString(),
    counts: merchant._count
      ? { users: merchant._count.users, payments: merchant._count.payments, api_keys: merchant._count.apiKeys }
      : undefined,
  };
}

/* -------------------------------------------------------------------------- */
/* Correction d'identite par un administrateur                                */
/* -------------------------------------------------------------------------- */

export interface IdentityPatch {
  name?: string;
  country?: string;
  legalType?: 'COMPANY' | 'INDIVIDUAL';
  registrationNumber?: string | null;
}

export interface CorrectIdentityInput {
  merchantId: string;
  patch: IdentityPatch;
  reason?: string;
  actorId: string;
  actorEmail: string;
  /** Accepte explicitement de retirer l'acces reel. Voir ci-dessous. */
  revokeLive?: boolean;
}

/**
 * Corrige l'identite d'un marchand.
 *
 * POURQUOI CETTE ROUTE N'EXISTE PAS COTE MARCHAND
 *
 * Le pays et la forme juridique determinent les pieces exigees a la
 * verification. Les laisser modifiables par le marchand permettrait de faire
 * valider un dossier sous un regime, puis d'en changer — la verification ne
 * voudrait plus rien dire. La correction passe donc par un administrateur, et
 * laisse une trace.
 *
 * CHANGER LE PAYS D'UN MARCHAND VERIFIE
 *
 * Sa verification a ete prononcee contre les exigences de l'ANCIEN pays. La
 * conserver telle quelle laisserait un marchand encaisser en reel sur la foi
 * d'un dossier qui ne correspond plus. L'appel est donc REFUSE, sauf si
 * l'administrateur demande explicitement le retrait de l'acces reel — auquel
 * cas les cles `live` sont revoquees et les sessions ramenees en `test`,
 * exactement comme pour une revocation ordinaire.
 *
 * Le nom et le numero d'immatriculation, eux, ne changent aucune exigence :
 * ils se corrigent sans condition.
 */
export async function correctMerchantIdentity(
  input: CorrectIdentityInput,
): Promise<Merchant> {
  const merchant = await prisma.merchant.findUnique({ where: { id: input.merchantId } });
  if (!merchant) throw errors.notFound('Marchand', input.merchantId);

  const champs: Array<[string, string | null, string | null]> = [];

  if (input.patch.name !== undefined && input.patch.name !== merchant.name) {
    champs.push(['name', merchant.name, input.patch.name]);
  }

  let paysChange = false;
  if (input.patch.country !== undefined) {
    const cible = input.patch.country.toUpperCase();
    const pays = getCountry(cible);
    if (!pays) throw errors.invalidRequest(`Pays hors catalogue : ${cible}.`, 'country');
    if (cible !== merchant.country) {
      paysChange = true;
      champs.push(['country', merchant.country, cible]);
    }
  }

  if (input.patch.legalType !== undefined && input.patch.legalType !== merchant.legalType) {
    champs.push(['legal_type', merchant.legalType, input.patch.legalType]);
  }

  if (
    input.patch.registrationNumber !== undefined &&
    (input.patch.registrationNumber ?? null) !== merchant.registrationNumber
  ) {
    champs.push(['registration_number', merchant.registrationNumber, input.patch.registrationNumber ?? null]);
  }

  if (champs.length === 0) {
    // Rien a faire n'est pas une erreur : rejouer une correction doit etre sans
    // effet, pas produire une ligne d'audit vide.
    return merchant;
  }

  const verifie = merchant.kybStatus === 'VERIFIED';
  if (paysChange && verifie && !input.revokeLive) {
    throw new AppError({
      type: 'invalid_request_error',
      code: 'country_change_requires_revocation',
      message:
        "Ce marchand est verifie : sa verification a ete prononcee contre les exigences de " +
        `${merchant.country}. Changer son pays exige de retirer l'acces reel — renvoyez la ` +
        'requete avec `revoke_live: true`.',
      httpStatus: 409,
      retriable: false,
      param: 'country',
      details: { kyb_status: merchant.kybStatus, current_country: merchant.country },
    });
  }

  const retirer = paysChange && verifie && input.revokeLive === true;

  const donnees: Record<string, unknown> = {};
  for (const [champ, , apres] of champs) {
    if (champ === 'name') donnees.name = apres;
    if (champ === 'country') donnees.country = apres;
    if (champ === 'legal_type') donnees.legalType = apres;
    if (champ === 'registration_number') donnees.registrationNumber = apres;
  }

  if (retirer) {
    donnees.kybStatus = 'PENDING';
    donnees.liveReviewedAt = new Date();
    donnees.liveReviewedBy = `${input.actorId} (${input.actorEmail})`;
    donnees.liveReviewNote =
      input.reason?.slice(0, 800) ??
      `Acces reel retire : pays corrige de ${merchant.country} vers ${input.patch.country}.`;
  }

  const [modifie] = await prisma.$transaction([
    prisma.merchant.update({ where: { id: merchant.id }, data: donnees }),
    prisma.merchantAudit.createMany({
      data: champs.map(([field, oldValue, newValue]) => ({
        id: newId(ID_PREFIX.merchantAudit),
        merchantId: merchant.id,
        field,
        oldValue,
        newValue,
        actorId: input.actorId,
        actorEmail: input.actorEmail,
        reason: input.reason?.slice(0, 800) ?? null,
      })),
    }),
    ...(retirer
      ? [
          prisma.apiKey.updateMany({
            where: { merchantId: merchant.id, environment: 'live', revokedAt: null },
            data: { revokedAt: new Date() },
          }),
          prisma.session.updateMany({
            where: { user: { merchantId: merchant.id }, environment: 'live' },
            data: { environment: 'test' },
          }),
        ]
      : []),
  ]);

  return modifie;
}

/** Historique des corrections, du plus recent au plus ancien. */
export async function merchantAuditTrail(merchantId: string, limit = 50) {
  return prisma.merchantAudit.findMany({
    where: { merchantId },
    orderBy: { createdAt: 'desc' },
    take: Math.min(limit, 200),
  });
}
