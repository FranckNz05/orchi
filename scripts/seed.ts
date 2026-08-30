/**
 * Cree un marchand de demonstration et sa cle API de test.
 * Le secret n'est affiche qu'ici : il n'est pas recuperable ensuite.
 *
 *   npm run seed
 */
import { randomBytes } from 'node:crypto';
import { generateApiKey } from '../src/core/crypto.js';
import { connectProviderAccount } from '../src/modules/provider-accounts.js';
import { newId, ID_PREFIX } from '../src/core/ids.js';
import { prisma } from '../src/db/client.js';

const DEMO_EMAIL = 'demo@orchi.africa';

async function main() {
  let merchant = await prisma.merchant.findFirst({ where: { contactEmail: DEMO_EMAIL } });

  if (!merchant) {
    merchant = await prisma.merchant.create({
      data: {
        id: newId(ID_PREFIX.merchant),
        name: 'Demo Marchand SARL',
        legalType: 'COMPANY',
        country: 'BJ',
        registrationNumber: 'RB/COT/24 B 12345',
        contactEmail: DEMO_EMAIL,
        contactPhone: '+22997000000',
        kybStatus: 'VERIFIED',
      },
    });
    console.log(`Marchand cree : ${merchant.id} (${merchant.name})`);
  } else {
    console.log(`Marchand existant : ${merchant.id} (${merchant.name})`);
  }

  const key = generateApiKey('test');
  await prisma.apiKey.create({
    data: {
      id: newId(ID_PREFIX.apiKey),
      merchantId: merchant.id,
      label: 'Cle de developpement',
      prefix: key.prefix,
      hash: key.hash,
      environment: 'test',
      scopes: 'payments:read,payments:write,payouts:read,payouts:write,accounts:write',
    },
  });

  // Compte simulateur : permet un cycle pay-in / payout complet sans aucun
  // contrat agregateur. L'adaptateur l'interdit en environnement live.
  const webhookSecret = randomBytes(24).toString('base64url');
  const account = await connectProviderAccount({
    merchantId: merchant.id,
    providerId: 'sandbox',
    environment: 'test',
    credentials: { webhook_secret: webhookSecret },
    priority: 1,
  });
  console.log(`Compte simulateur connecte : ${account.id}`);

  console.log('\nCle API de test (affichee une seule fois) :\n');
  console.log(`  ${key.secret}\n`);
  console.log('Verification :');
  console.log(`  curl -H "Authorization: Bearer ${key.secret}" http://localhost:3000/v1/me\n`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
