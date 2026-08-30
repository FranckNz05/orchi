import { hashPassword } from '../src/modules/auth.js';
import { ID_PREFIX, newId } from '../src/core/ids.js';
import { prisma } from '../src/db/client.js';

/**
 * Cree ou met a jour un administrateur de la plateforme.
 *
 *   npx tsx scripts/create-admin.ts <email> <mot-de-passe> ["Nom complet"]
 *
 * Sans argument, le script se rabat sur BOOTSTRAP_ADMIN_EMAIL et
 * BOOTSTRAP_ADMIN_PASSWORD, et ne fait RIEN si elles sont absentes. C'est ce
 * qui permet de l'enchainer au demarrage d'un deploiement sans le casser quand
 * il n'y a pas d'amorcage a faire.
 *
 * POURQUOI UN SCRIPT ET PAS UNE ROUTE
 *
 * Aucune route de l'API ne permet d'accorder le drapeau `platformAdmin`. Si une
 * telle route existait, elle serait la cible la plus interessante de toute la
 * plateforme : une faille dans n'importe quelle route de compte deviendrait une
 * escalade de privileges. Devenir administrateur exige donc la main sur le
 * serveur — sa base ou ses variables d'environnement — ce qui est deja le
 * niveau de privilege qu'on accorderait.
 *
 * L'administrateur est rattache au marchand de la plateforme elle-meme. Ce
 * n'est pas un artifice : Orchi est un compte comme un autre, et son
 * administrateur est un utilisateur ordinaire qui porte, en plus, une autorite
 * sur la plateforme. Le drapeau est separe du role (`OWNER` / `MEMBER`) parce
 * que les deux ne repondent pas a la meme question.
 */

const PLATFORM_MERCHANT_ID = 'mch_orchi_platform';

async function main() {
  const [argEmail, argPassword, argName] = process.argv.slice(2);

  const email = argEmail ?? process.env.BOOTSTRAP_ADMIN_EMAIL;
  const password = argPassword ?? process.env.BOOTSTRAP_ADMIN_PASSWORD;
  const name = argName ?? process.env.BOOTSTRAP_ADMIN_NAME;

  // Enchaine au demarrage d'un service, ce script doit etre silencieux et
  // inoffensif quand il n'y a rien a faire — pas bloquer le demarrage.
  if (!email && !password && process.argv.length <= 2) {
    console.log('[admin] aucun amorcage demande, rien a faire.');
    return;
  }

  if (!email || !password) {
    console.error('Usage : npx tsx scripts/create-admin.ts <email> <mot-de-passe> ["Nom"]');
    console.error('   ou : BOOTSTRAP_ADMIN_EMAIL + BOOTSTRAP_ADMIN_PASSWORD');
    process.exit(1);
  }
  if (password.length < 12) {
    // Meme exigence que pour un marchand. Un compte qui peut ouvrir
    // l'environnement reel a tous les autres ne merite pas moins.
    console.error('Le mot de passe doit faire au moins 12 caracteres.');
    process.exit(1);
  }

  const merchant = await prisma.merchant.upsert({
    where: { id: PLATFORM_MERCHANT_ID },
    update: {},
    create: {
      id: PLATFORM_MERCHANT_ID,
      name: 'Orchi — plateforme',
      legalType: 'COMPANY',
      country: 'BJ',
      contactEmail: email,
      // La plateforme n'encaisse pas pour son propre compte : elle reste
      // UNVERIFIED, comme n'importe quel compte qui n'a pas depose de dossier.
      kybStatus: 'UNVERIFIED',
    },
  });

  const existing = await prisma.user.findUnique({ where: { email: email.toLowerCase() } });

  // Relance a chaque demarrage quand l'amorcage passe par les variables
  // d'environnement : on ne rehache le mot de passe que s'il y a une raison,
  // sans quoi chaque redemarrage revoquerait les sessions de l'administrateur.
  const alreadyAdmin = existing?.platformAdmin === true && existing.status === 'ACTIVE';
  if (alreadyAdmin && !argEmail) {
    console.log(`[admin] ${existing.email} est deja administrateur, inchange.`);
    return;
  }

  const passwordHash = await hashPassword(password);

  const user = existing
    ? await prisma.user.update({
        where: { id: existing.id },
        data: { passwordHash, platformAdmin: true, status: 'ACTIVE' },
      })
    : await prisma.user.create({
        data: {
          id: newId(ID_PREFIX.merchant).replace('mch_', 'usr_'),
          email: email.toLowerCase(),
          passwordHash,
          name: name ?? 'Administrateur',
          merchantId: merchant.id,
          role: 'OWNER',
          platformAdmin: true,
        },
      });

  // Toutes les sessions ouvertes sont revoquees : changer le mot de passe d'un
  // administrateur doit fermer les sessions qui l'utilisaient, sinon la
  // rotation ne protege de rien.
  const { count } = await prisma.session.updateMany({
    where: { userId: user.id, revokedAt: null },
    data: { revokedAt: new Date() },
  });

  console.log(`${existing ? 'Mis a jour' : 'Cree'} : ${user.email}`);
  console.log(`  utilisateur    ${user.id}`);
  console.log(`  marchand       ${merchant.id} (${merchant.name})`);
  console.log(`  administrateur oui`);
  if (count > 0) console.log(`  sessions revoquees : ${count}`);
  console.log('\nConnexion sur /login, puis /admin.');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
