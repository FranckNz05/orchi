import { hashPassword } from '../src/modules/auth.js';
import { ID_PREFIX, newId } from '../src/core/ids.js';
import { prisma } from '../src/db/client.js';

/**
 * Cree ou met a jour un administrateur de la plateforme.
 *
 *   npx tsx scripts/create-admin.ts <email> <mot-de-passe> ["Nom complet"]
 *
 * POURQUOI UN SCRIPT ET PAS UNE ROUTE
 *
 * Aucune route de l'API ne permet d'accorder le drapeau `platformAdmin`. Si une
 * telle route existait, elle serait la cible la plus interessante de toute la
 * plateforme : une faille dans n'importe quelle route de compte deviendrait une
 * escalade de privileges. Devenir administrateur exige donc un acces au serveur
 * et a la base — ce qui est deja le niveau de privilege qu'on accorderait.
 *
 * L'administrateur est rattache au marchand de la plateforme elle-meme. Ce
 * n'est pas un artifice : Orchi est un compte comme un autre, et son
 * administrateur est un utilisateur ordinaire qui porte, en plus, une autorite
 * sur la plateforme. Le drapeau est separe du role (`OWNER` / `MEMBER`) parce
 * que les deux ne repondent pas a la meme question.
 */

const PLATFORM_MERCHANT_ID = 'mch_orchi_platform';

async function main() {
  const [email, password, name] = process.argv.slice(2);

  if (!email || !password) {
    console.error('Usage : npx tsx scripts/create-admin.ts <email> <mot-de-passe> ["Nom"]');
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

  const passwordHash = await hashPassword(password);
  const existing = await prisma.user.findUnique({ where: { email: email.toLowerCase() } });

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
