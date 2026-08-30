import { getCountry } from '../src/catalog/countries.js';
import type { Channel } from '../src/catalog/coverage.js';
import { generateApiKey } from '../src/core/crypto.js';
import { ID_PREFIX } from '../src/core/ids.js';
import { exponentOf } from '../src/core/money.js';
import { prisma } from '../src/db/client.js';
import { hashPassword } from '../src/modules/auth.js';
import { createCheckoutSession } from '../src/modules/checkout.js';
import { createPayment, refreshPayment } from '../src/modules/payments.js';
import { createPayout, refreshPayout } from '../src/modules/payouts.js';
import { connectProviderAccount } from '../src/modules/provider-accounts.js';

/**
 * Jeu de donnees de demonstration.
 *
 *   npm run seed:demo            regenere entierement le jeu
 *   ... seed-demo.js --auto      n'agit que si SEED_DEMO=true et jeu absent
 *
 * POURQUOI IL PASSE PAR LE VRAI CODE
 *
 * Il aurait ete plus rapide d'inserer directement des lignes dans `payments`
 * et `ledger_entries`. Le resultat aurait ete juste dans une liste et faux
 * partout ailleurs : pas de tentative associee, pas de decision de routage
 * enregistree, un grand livre desequilibre, des frais qui ne correspondent a
 * aucun calcul, et des etats impossibles a atteindre par le vrai chemin.
 *
 * Ce script appelle donc `createPayment` et `createPayout` comme le ferait un
 * marchand. Tout ce que la plateforme produit normalement — tentatives,
 * ecritures comptables en partie double, sante des agregateurs, evenements
 * sortants — est produit ici aussi. La demonstration montre le systeme, pas
 * une maquette du systeme.
 *
 * COMMENT LES ISSUES SONT CHOISIES
 *
 * Le simulateur decide du sort d'une transaction d'apres les quatre derniers
 * chiffres du telephone. On ne « force » donc aucun statut : on choisit un
 * numero, et le systeme fait le reste, exactement comme en integration.
 *
 *   0000 succes immediat      0004 agregateur indisponible (bascule)
 *   0001 succes differe       0005 quota depasse
 *   0002 refus client         0007 le client ne confirme jamais
 *   0003 delai depasse -> UNKNOWN
 *
 * IDEMPOTENCE
 *
 * Les references sont deterministes (`demo-pay-bj-003`). Rejouer le script ne
 * cree donc pas de doublons : la reference marchand est le filet definitif
 * contre les doublons, et `createPayment` renvoie l'existant. On peut le
 * relancer sans reflechir.
 */

/* -------------------------------------------------------------------------- */
/* Marchands                                                                  */
/* -------------------------------------------------------------------------- */

interface DemoMerchant {
  slug: string;
  name: string;
  country: string;
  email: string;
  password: string;
  user: string;
  activity: string;
  website: string;
  kyb: 'UNVERIFIED' | 'PENDING' | 'VERIFIED' | 'REJECTED';
  note?: string;
}

const MERCHANTS: DemoMerchant[] = [
  {
    slug: 'afro',
    name: 'Afro Nation Bénin',
    country: 'BJ',
    email: 'billetterie@afronation.demo',
    password: 'Cotonou-Festival-2026',
    user: 'Sègbédji Adjovi',
    activity:
      'Billetterie de concerts et festivals au Bénin et au Togo. Billets nominatifs vendus en ligne, clientèle particulière, paiement par mobile money MTN et Moov. Environ 3 000 billets par mois.',
    website: 'https://afronation.demo',
    kyb: 'VERIFIED',
    note: 'RCCM vérifié au registre du commerce de Cotonou. Activité cohérente avec le volume annoncé.',
  },
  {
    slug: 'teranga',
    name: 'Teranga Market',
    country: 'SN',
    email: 'contact@teranga.demo',
    password: 'Dakar-Artisanat-2026',
    user: 'Aminata Diallo',
    activity:
      'Place de marché en ligne pour artisans sénégalais : maroquinerie, textile et bijouterie. Livraison à Dakar et expédition internationale.',
    website: 'https://teranga.demo',
    kyb: 'VERIFIED',
    note: 'NINEA vérifié. Marketplace, reversement aux artisans par décaissement.',
  },
  {
    slug: 'kivu',
    name: 'Kivu Logistics',
    country: 'CD',
    email: 'finance@kivu.demo',
    password: 'Goma-Transport-2026',
    user: 'Espérance Mukendi',
    activity:
      'Transport de marchandises entre Goma, Bukavu et Kinshasa. Facturation des expéditeurs à la course, paiement par M-Pesa, Orange Money et Airtel Money.',
    website: 'https://kivu.demo',
    kyb: 'PENDING',
  },
  {
    slug: 'savane',
    name: 'Savane Assurances',
    country: 'CI',
    email: 'primes@savane.demo',
    password: 'Abidjan-Prevoyance-2026',
    user: 'Koffi N’Guessan',
    activity:
      'Micro-assurance santé et obsèques. Encaissement de primes mensuelles par prélèvement mobile money, versement des indemnités par décaissement.',
    website: 'https://savane.demo',
    kyb: 'PENDING',
  },
  {
    slug: 'douala',
    name: 'Douala Fresh',
    country: 'CM',
    email: 'commandes@doualafresh.demo',
    password: 'Douala-Maraicher-2026',
    user: 'Bertrand Njoya',
    activity: 'Livraison de paniers de fruits et légumes à Douala et Yaoundé.',
    website: 'https://doualafresh.demo',
    kyb: 'REJECTED',
    note: 'Le numéro RCCM fourni ne correspond à aucune inscription au registre de Douala. Merci de le corriger et de redéposer.',
  },
  {
    slug: 'sahel',
    name: 'Sahel Éducation',
    country: 'BF',
    email: 'scolarite@sahel.demo',
    password: 'Ouaga-Scolarite-2026',
    user: 'Fatimata Ouédraogo',
    activity: 'Paiement des frais de scolarité pour un réseau d’écoles privées.',
    website: 'https://sahel.demo',
    kyb: 'UNVERIFIED',
  },
];

/* -------------------------------------------------------------------------- */
/* Transactions                                                               */
/* -------------------------------------------------------------------------- */

/**
 * Suffixes de telephone, et donc issues, avec leur poids.
 *
 * La repartition imite un trafic reel : l'ecrasante majorite passe, une part
 * significative est refusee par le client, et les pannes restent rares. Une
 * demonstration ou tout reussit ne montre justement pas ce que fait la
 * plateforme quand tout ne reussit pas.
 */
const OUTCOMES: Array<{ suffix: string; weight: number }> = [
  { suffix: '0000', weight: 62 }, // succès immédiat
  { suffix: '0001', weight: 14 }, // succès différé
  { suffix: '0002', weight: 12 }, // refus client
  { suffix: '0007', weight: 6 }, // jamais confirmé
  { suffix: '0004', weight: 4 }, // agrégateur indisponible
  { suffix: '0003', weight: 2 }, // délai dépassé → UNKNOWN
];

/** Indicatifs, pour que les numeros aient l'air de venir du bon pays. */
const DIALING: Readonly<Record<string, string>> = {
  BJ: '+229 97', SN: '+221 77', CD: '+243 81', CI: '+225 07',
  CM: '+237 67', BF: '+226 70', TG: '+228 90', ML: '+223 76',
};

const NETWORKS: Readonly<Record<string, string[]>> = {
  BJ: ['MTN_BENIN', 'MOOV_BENIN'],
  SN: ['ORANGE_SN', 'FREE_SN', 'WAVE_SN'],
  CD: ['MPESA_CD', 'ORANGE_CD', 'AIRTEL_CD'],
  CI: ['ORANGE_CI', 'MTN_CI', 'MOOV_CI'],
  CM: ['MTN_CM', 'ORANGE_CM'],
  BF: ['ORANGE_BF', 'MOOV_BF'],
};

const DESCRIPTIONS: Readonly<Record<string, string[]>> = {
  afro: ['Billet Afro Nation — Pelouse', 'Billet Afro Nation — Carré or', 'Pass 2 jours', 'Billet duo'],
  teranga: ['Sac en cuir tanné', 'Boubou brodé main', 'Parure argent Ndiaye', 'Panier tressé'],
  kivu: ['Fret Goma → Bukavu', 'Fret Kinshasa → Matadi', 'Enlèvement express', 'Palette 400 kg'],
  savane: ['Prime santé — janvier', 'Prime obsèques — janvier', 'Prime santé — février', 'Prime famille'],
  douala: ['Panier hebdo — moyen', 'Panier hebdo — grand', 'Panier découverte', 'Ajout mangues'],
  sahel: ['Scolarité 1er trimestre', 'Scolarité 2e trimestre', 'Frais de cantine', 'Fournitures'],
};

/**
 * Generateur pseudo-aleatoire a graine.
 *
 * `Math.random()` donnerait un jeu different a chaque execution : impossible
 * de reproduire un bug apercu dans une demonstration, et deux environnements
 * ne montreraient jamais la meme chose. La graine fixe garantit que le meme
 * script produit toujours le meme jeu.
 */
function seeded(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

const rnd = seeded(20260830);

function pick<T>(list: readonly T[]): T {
  return list[Math.floor(rnd() * list.length)]!;
}

function pickOutcome(): string {
  const total = OUTCOMES.reduce((n, o) => n + o.weight, 0);
  let roll = rnd() * total;
  for (const o of OUTCOMES) {
    roll -= o.weight;
    if (roll <= 0) return o.suffix;
  }
  return '0000';
}

function phone(country: string, suffix: string): string {
  const prefix = DIALING[country] ?? '+229 97';
  const middle = String(Math.floor(rnd() * 100)).padStart(2, '0');
  return `${prefix}${middle}${suffix}`.replace(/\s/g, '');
}

/**
 * Montant plausible, exprime en unites mineures.
 *
 * Le tirage se fait sur des unites MAJEURES puis est converti : tirer
 * directement en unites mineures donnerait, sur une devise a deux decimales,
 * des montants comme « 4 137,29 » la ou un vrai panier fait « 4 200,00 ».
 */
function amount(currency: string, floor: number, ceiling: number): number {
  const exp = exponentOf(currency);
  const step = exp === 0 ? 500 : 1;
  const major = Math.round((floor + rnd() * (ceiling - floor)) / step) * step;
  return major * 10 ** exp;
}

/* -------------------------------------------------------------------------- */

const PAYMENTS_PER_MERCHANT = 22;
const PAYOUTS_PER_MERCHANT = 5;
/** Etalement des dates. Les transactions les plus recentes datent d'aujourd'hui. */
const SPREAD_DAYS = 45;

async function ensureMerchant(def: DemoMerchant) {
  const id = `mch_demo_${def.slug}`;
  const country = getCountry(def.country);
  if (!country) throw new Error(`Pays hors catalogue : ${def.country}`);

  const merchant = await prisma.merchant.upsert({
    where: { id },
    update: {},
    create: {
      id,
      name: def.name,
      legalType: 'COMPANY',
      country: def.country,
      registrationNumber: `${def.country}-DEMO-${def.slug.toUpperCase()}`,
      contactEmail: def.email,
      contactPhone: phone(def.country, '0000'),
      kybStatus: 'UNVERIFIED',
    },
  });

  // Le dossier d'acces au reel est pose directement : le faire passer par les
  // routes demanderait une session HTTP, pour un resultat identique.
  const dossier =
    def.kyb === 'UNVERIFIED'
      ? {}
      : {
          kybStatus: def.kyb,
          liveActivity: def.activity,
          liveWebsite: def.website,
          liveVolumeMinor: amount(country.currency, 1_000_000, 9_000_000),
          liveRequestedAt: new Date(Date.now() - 9 * 86_400_000),
          ...(def.kyb === 'PENDING'
            ? {}
            : {
                liveReviewedAt: new Date(Date.now() - 6 * 86_400_000),
                liveReviewedBy: 'demo (admin@orchi.africa)',
                liveReviewNote: def.note ?? null,
              }),
        };
  if (Object.keys(dossier).length > 0) {
    await prisma.merchant.update({ where: { id }, data: dossier });
  }

  const existingUser = await prisma.user.findUnique({ where: { email: def.email } });
  if (!existingUser) {
    await prisma.user.create({
      data: {
        id: `usr_demo_${def.slug}`,
        email: def.email,
        passwordHash: await hashPassword(def.password),
        name: def.user,
        merchantId: id,
        role: 'OWNER',
      },
    });
  }

  const account = await prisma.providerAccount.findFirst({
    where: { merchantId: id, providerId: 'sandbox', environment: 'test' },
  });
  if (!account) {
    await connectProviderAccount({
      merchantId: id,
      providerId: 'sandbox',
      environment: 'test',
      credentials: { webhook_secret: `demo-${def.slug}` },
      priority: 1,
    });
  }

  const key = await prisma.apiKey.findFirst({ where: { merchantId: id, environment: 'test' } });
  if (!key) {
    const generated = generateApiKey('test');
    await prisma.apiKey.create({
      data: {
        id: `key_demo_${def.slug}`,
        merchantId: id,
        label: 'Clé de démonstration',
        prefix: generated.prefix,
        hash: generated.hash,
        environment: 'test',
        scopes: 'payments:read,payments:write,payouts:read,payouts:write,accounts:write',
      },
    });
    console.log(`    clé API : ${generated.secret}`);
  }

  const hook = await prisma.webhookEndpoint.findFirst({ where: { merchantId: id } });
  if (!hook) {
    await prisma.webhookEndpoint.create({
      data: {
        id: `whe_demo_${def.slug}`,
        merchantId: id,
        url: `${def.website}/webhooks/orchi`,
        secret: `whsec_demo_${def.slug}`,
        environment: 'test',
        events: 'payment.succeeded,payment.failed,payout.succeeded,payout.failed',
      },
    });
  }

  return { merchant, currency: country.currency };
}

async function run() {
  // Mode automatique, employe dans la chaine de demarrage d'un deploiement.
  //
  // Deux garde-fous : la variable doit etre explicitement a `true`, et le jeu
  // n'est pas regenere s'il existe deja. Sans le second, chaque reveil d'une
  // instance endormie rejouerait 160 transactions — une minute perdue au
  // demarrage, a chaque fois, pour un resultat identique.
  const auto = process.argv.includes('--auto');
  if (auto) {
    if (process.env.SEED_DEMO !== 'true') {
      console.log('[demo] SEED_DEMO absent, rien a faire.');
      return;
    }
    const existing = await prisma.payment.count({
      where: { merchantId: { startsWith: 'mch_demo_' } },
    });
    if (existing > 0) {
      console.log(`[demo] jeu deja present (${existing} encaissements), inchange.`);
      return;
    }
  }

  const catalogue = await prisma.country.count();
  if (catalogue === 0) {
    console.error('Catalogue vide. Lancer d\'abord : npm run seed:catalog');
    process.exit(1);
  }

  await reset();

  const stats = { payments: 0, payouts: 0, sessions: 0, byStatus: {} as Record<string, number> };
  const touched: string[] = [];

  for (const def of MERCHANTS) {
    console.log(`\n${def.name} (${def.country}) — ${def.kyb}`);
    const { merchant, currency } = await ensureMerchant(def);
    const networks = NETWORKS[def.country] ?? ['MTN_BENIN'];
    const labels = DESCRIPTIONS[def.slug] ?? ['Commande'];

    for (let i = 1; i <= PAYMENTS_PER_MERCHANT; i += 1) {
      const suffix = pickOutcome();
      const reference = `demo-${def.slug}-pay-${String(i).padStart(3, '0')}`;
      const { payment } = await createPayment({
        merchantId: merchant.id,
        environment: 'test',
        reference,
        amount: amount(currency, 1_000, 85_000),
        currency,
        country: def.country,
        channel: 'mobile_money' as Channel,
        network: pick(networks),
        customer: { phone: phone(def.country, suffix), name: def.user },
        description: pick(labels),
      });
      touched.push(payment.id);

      // Un paiement laisse en PROCESSING attend une notification qui, en
      // demonstration, n'arrivera jamais. On interroge donc l'agregateur comme
      // le ferait le balayeur — c'est le meme chemin, pas un raccourci.
      const final =
        payment.status === 'PROCESSING' ? (await refreshPayment(merchant.id, payment.id)).payment : payment;

      stats.payments += 1;
      stats.byStatus[final.status] = (stats.byStatus[final.status] ?? 0) + 1;
    }

    for (let i = 1; i <= PAYOUTS_PER_MERCHANT; i += 1) {
      const suffix = pickOutcome();
      const reference = `demo-${def.slug}-out-${String(i).padStart(3, '0')}`;
      try {
        const { payout } = await createPayout({
          merchantId: merchant.id,
          environment: 'test',
          reference,
          amount: amount(currency, 5_000, 120_000),
          currency,
          country: def.country,
          channel: 'mobile_money' as Channel,
          recipient: { phone: phone(def.country, suffix), network: pick(networks), name: 'Bénéficiaire' },
          description: 'Reversement hebdomadaire',
        });
        touched.push(payout.id);
        if (payout.status === 'PROCESSING') await refreshPayout(merchant.id, payout.id);
        stats.payouts += 1;
      } catch (e) {
        // Certains pays sont en payout LIMITED ou NONE au catalogue : le refus
        // est le comportement correct, pas une panne du script.
        console.log(`    décaissement refusé : ${(e as Error).message}`);
      }
    }

    // Deux liens de paiement ouverts, pour que la page hebergee ait de quoi
    // etre montree sans avoir a en fabriquer un a la main.
    for (let i = 1; i <= 2; i += 1) {
      const session = await createCheckoutSession({
        merchantId: merchant.id,
        environment: 'test',
        reference: `demo-${def.slug}-lien-${i}`,
        amount: amount(currency, 5_000, 40_000),
        currency,
        country: def.country,
        description: pick(labels),
        successUrl: `${def.website}/merci`,
        ttlMinutes: 24 * 60,
      });
      stats.sessions += 1;
      if (i === 1) console.log(`    lien de paiement : /pay/${session.token}`);
    }

    console.log(`    ${PAYMENTS_PER_MERCHANT} encaissements, ${PAYOUTS_PER_MERCHANT} décaissements`);
  }

  // Deux passes : le scenario « succes differe » n'aboutit qu'au bout de
  // plusieurs interrogations, exactement comme un agregateur qui met quelques
  // secondes a confirmer.
  await settle();
  await settle();
  await backdate(touched);
  await report();
}

/**
 * Efface le jeu de demonstration precedent.
 *
 * POURQUOI ON NE PEUT PAS SE CONTENTER D'AJOUTER
 *
 * Le simulateur garde l'etat de ses transactions EN MEMOIRE DU PROCESSUS.
 * Relancer le script dans un nouveau processus retrouve bien les paiements en
 * base — les references sont deterministes — mais le simulateur, lui, ne
 * connait plus leurs references : toute interrogation echoue en 404, et les
 * transactions restees en cours ne peuvent plus JAMAIS aboutir. Elles
 * s'accumulent alors a chaque execution, et le tableau de bord se remplit de
 * paiements eternellement « en cours » qu'aucun balayeur ne denouera.
 *
 * On repart donc de zero a chaque fois. Le perimetre est etroit et explicite :
 * les marchands `mch_demo_*` et rien d'autre. Aucun compte cree a la main, ni
 * aucun marchand reel, n'est touche.
 */
async function reset() {
  const ids = MERCHANTS.map((m) => `mch_demo_${m.slug}`);
  const scope = { merchantId: { in: ids } };

  const before = await prisma.payment.count({ where: scope });

  // Ordre impose par les cles etrangeres : les enfants avant les parents.
  await prisma.ledgerEntry.deleteMany({ where: { journal: scope } });
  await prisma.ledgerJournal.deleteMany({ where: scope });
  await prisma.routingDecision.deleteMany({ where: scope });
  await prisma.outboundDelivery.deleteMany({ where: scope });
  await prisma.inboundWebhook.deleteMany({ where: scope });
  await prisma.paymentAttempt.deleteMany({ where: { payment: scope } });
  await prisma.payoutAttempt.deleteMany({ where: { payout: scope } });
  await prisma.checkoutSession.deleteMany({ where: scope });
  await prisma.payment.deleteMany({ where: scope });
  await prisma.payout.deleteMany({ where: scope });
  await prisma.idempotencyRecord.deleteMany({ where: scope });

  if (before > 0) console.log(`jeu précédent effacé : ${before} encaissements`);
}

/**
 * Passe de reglement.
 *
 * Le scenario « succes differe » ne se resout qu'apres quelques secondes. Un
 * seul appel juste apres la creation laisse donc ces transactions en cours pour
 * toujours, puisque aucune notification n'arrivera jamais en demonstration.
 *
 * On rejoue ici ce que fait le balayeur toutes les minutes : interroger
 * l'agregateur pour les transactions non terminees. Ce n'est pas un raccourci
 * reserve au script, c'est le meme chemin qu'en production.
 */
async function settle() {
  const payments = await prisma.payment.findMany({
    where: { reference: { startsWith: 'demo-' }, status: 'PROCESSING' },
    select: { id: true, merchantId: true },
  });
  for (const p of payments) {
    await refreshPayment(p.merchantId, p.id).catch(() => undefined);
  }

  const payouts = await prisma.payout.findMany({
    where: { reference: { startsWith: 'demo-' }, status: 'PROCESSING' },
    select: { id: true, merchantId: true },
  });
  for (const p of payouts) {
    await refreshPayout(p.merchantId, p.id).catch(() => undefined);
  }

  console.log(`\nrèglement : ${payments.length} encaissements et ${payouts.length} décaissements réinterrogés`);
}

async function report() {
  const [payments, payouts] = await Promise.all([
    prisma.payment.groupBy({
      by: ['status'], _count: { _all: true }, where: { reference: { startsWith: 'demo-' } },
    }),
    prisma.payout.groupBy({
      by: ['status'], _count: { _all: true }, where: { reference: { startsWith: 'demo-' } },
    }),
  ]);

  const encaisse = await prisma.payment.aggregate({
    _sum: { amount: true, platformFeeAmount: true },
    where: { reference: { startsWith: 'demo-' }, status: 'SUCCEEDED' },
  });

  console.log('\n─────────────────────────────────────────');
  console.log(`marchands          ${MERCHANTS.length}`);
  console.log('\nencaissements :');
  for (const s of payments.sort((a, b) => b._count._all - a._count._all)) {
    console.log(`  ${s.status.padEnd(12)} ${s._count._all}`);
  }
  console.log('décaissements :');
  for (const s of payouts.sort((a, b) => b._count._all - a._count._all)) {
    console.log(`  ${s.status.padEnd(12)} ${s._count._all}`);
  }

  console.log(`\nvolume encaissé (unités mineures, devises mêlées) : ${encaisse._sum.amount ?? 0}`);
  console.log(`dont commission Orchi : ${encaisse._sum.platformFeeAmount ?? 0}`);

  // Combien de paiements ont demande plus d'une tentative. Avec un seul
  // agregateur branche, la bascule n'a nulle part ou aller : le chiffre reste
  // a zero, et c'est le comportement correct, pas une donnee manquante.
  const attempts = await prisma.payment.findMany({
    where: { reference: { startsWith: 'demo-' } },
    select: { attempts: { select: { id: true } } },
  });
  const bascules = attempts.filter((p) => p.attempts.length > 1).length;
  console.log(`paiements à plusieurs tentatives : ${bascules}`);
  if (bascules === 0) {
    console.log('  (un seul agrégateur branché : la bascule n’a aucune cible)');
  }

  await checkLedger();
}

/**
 * Verification du grand livre.
 *
 * Les montants sont stockes POSITIFS, avec un champ `side` qui porte le sens.
 * Sommer la colonne `amount` ne prouve donc rien : il faut comparer le total
 * des debits a celui des credits, journal par journal.
 */
async function checkLedger() {
  const sides = await prisma.ledgerEntry.groupBy({ by: ['side'], _sum: { amount: true }, _count: true });
  const debit = sides.find((s) => s.side === 'DEBIT')?._sum.amount ?? 0;
  const credit = sides.find((s) => s.side === 'CREDIT')?._sum.amount ?? 0;
  const journals = await prisma.ledgerJournal.count();

  console.log(`\ngrand livre : ${journals} journaux, ${sides.reduce((n, s) => n + s._count, 0)} écritures`);
  console.log(`  débits  ${debit}`);
  console.log(`  crédits ${credit}`);
  console.log(debit === credit ? '  équilibré ✓' : `  DÉSÉQUILIBRÉ de ${debit - credit} ✗`);

  if (debit !== credit) process.exitCode = 1;
}

/**
 * Etale les dates de creation sur les dernieres semaines.
 *
 * C'est une REECRITURE APRES COUP, purement cosmetique : tout a reellement ete
 * cree a l'instant. Sans elle, chaque graphique et chaque « il y a 3 jours »
 * afficherait la meme minute, et le tableau de bord paraitrait vide de passe.
 * Seules les dates de creation bougent — les enchainements internes d'une
 * transaction, eux, ne sont pas touches.
 */
async function backdate(ids: string[]) {
  const rand = seeded(4242);
  for (const id of ids) {
    // Racine cubique : concentre les transactions sur les jours recents, comme
    // une activite qui monte, plutot que de les repartir uniformement.
    const age = Math.round(SPREAD_DAYS * rand() ** 3 * 86_400_000);
    const at = new Date(Date.now() - age);
    if (id.startsWith(ID_PREFIX.payment)) {
      await prisma.payment.update({ where: { id }, data: { createdAt: at } });
      await prisma.paymentAttempt.updateMany({ where: { paymentId: id }, data: { createdAt: at } });
    } else {
      await prisma.payout.update({ where: { id }, data: { createdAt: at } });
      await prisma.payoutAttempt.updateMany({ where: { payoutId: id }, data: { createdAt: at } });
    }
  }
  console.log(`\ndates étalées sur ${SPREAD_DAYS} jours (${ids.length} transactions)`);
}

run()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
