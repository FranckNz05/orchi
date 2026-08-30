/**
 * Rejoue le catalogue versionne (src/catalog/*.ts) dans la base.
 *
 * Idempotent : chaque execution met a jour l'existant sans jamais supprimer de
 * pays ni d'agregateur. Les modifications faites en base a la main sur les
 * champs pilotables (`enabled`) sont donc ecrasees volontairement — le fichier
 * reste la source de verite ; une fermeture de pays durable doit etre commitee.
 *
 *   npm run seed:catalog
 */
import {
  COUNTRIES,
  COVERAGE,
  CURRENCIES,
  PROVIDERS,
  validateCatalog,
  type CoverageSeed,
} from '../src/catalog/index.js';
import { prisma } from '../src/db/client.js';

async function main() {
  const issues = validateCatalog();
  if (issues.length > 0) {
    console.error(`Catalogue invalide — ${issues.length} probleme(s) :\n`);
    for (const issue of issues) console.error(`  [${issue.scope}] ${issue.message}`);
    console.error('\nAucune ecriture effectuee.');
    process.exitCode = 1;
    return;
  }

  for (const currency of CURRENCIES) {
    await prisma.currency.upsert({
      where: { code: currency.code },
      create: { code: currency.code, exponent: currency.exponent, name: currency.name },
      update: { exponent: currency.exponent, name: currency.name },
    });
  }

  for (const provider of PROVIDERS) {
    await prisma.provider.upsert({
      where: { id: provider.id },
      create: {
        id: provider.id,
        name: provider.name,
        type: provider.type,
        integration: provider.integration,
        scope: provider.scope,
      },
      update: {
        name: provider.name,
        type: provider.type,
        integration: provider.integration,
        scope: provider.scope,
      },
    });
  }

  let ruleCount = 0;
  for (const country of COUNTRIES) {
    const data = {
      name: country.name,
      region: country.region,
      currencyCode: country.currency,
      callingCode: country.callingCode,
      zones: country.zones.join(','),
      sovereign: country.sovereign,
      kycRequirement: country.kycRequirement,
      kycLabel: country.kycLabel,
      allowsIndividual: country.allowsIndividual,
      feeMinBps: country.feeMinBps,
      feeMaxBps: country.feeMaxBps,
      payoutMode: country.payoutMode,
      payoutNote: country.payoutNote,
    };

    await prisma.country.upsert({
      where: { iso2: country.iso2 },
      create: { iso2: country.iso2, ...data },
      update: data,
    });

    const declared = COVERAGE[country.iso2] ?? [];

    /**
     * Le simulateur recoit une VRAIE regle de couverture par pays, au lieu
     * d'etre injecte a la volee dans chaque lecture.
     *
     * La version precedente le fabriquait dans le service de catalogue, dans le
     * routeur, puis dans la page de paiement — et l'oubli du troisieme endroit
     * a produit une page de paiement sans aucun moyen affiche. Cinquante-cinq
     * lignes en base coutent moins cher qu'un cas particulier duplique.
     *
     * Il reste interdit en production : les requetes filtrent sur
     * l'environnement de la cle, pas sur la presence de la regle.
     */
    const sandboxChannels = [...new Set(declared.flatMap((r) => r.channels))];
    // Le simulateur reprend les RESEAUX REELS du pays : un marchand qui teste
    // doit voir « MTN MoMo » et « Orange Money », pas un bouton generique. Sans
    // eux, la page de paiement n'affiche aucun moyen mobile.
    const sandboxNetworks = [...new Set(declared.flatMap((r) => r.networks ?? []))];

    const rules: CoverageSeed[] = [
      {
        provider: 'sandbox',
        channels: sandboxChannels.length > 0 ? sandboxChannels : ['mobile_money', 'card'],
        networks: sandboxNetworks,
        payin: true,
        payout: true,
        feeMinBps: 0,
        feeMaxBps: 0,
        note: 'Simulateur interne — environnement de test uniquement.',
      },
      ...declared,
    ];

    for (const [index, rule] of rules.entries()) {
      const ruleData = {
        channels: rule.channels.join(','),
        supportsPayin: rule.payin !== false,
        supportsPayout: rule.payout !== false,
        networks: (rule.networks ?? []).join(','),
        feeMinBps: rule.feeMinBps ?? null,
        feeMaxBps: rule.feeMaxBps ?? null,
        // Le simulateur est en tete (0) : en test il doit passer avant les
        // agregateurs reels, qu'aucun compte ne dessert de toute facon.
        priority: index,
        note: rule.note ?? null,
      };

      await prisma.coverageRule.upsert({
        where: {
          countryIso2_providerId: { countryIso2: country.iso2, providerId: rule.provider },
        },
        create: {
          id: `cov_${country.iso2.toLowerCase()}_${rule.provider}`,
          countryIso2: country.iso2,
          providerId: rule.provider,
          ...ruleData,
        },
        update: ruleData,
      });
      ruleCount += 1;
    }
  }

  const sovereign = COUNTRIES.filter((c) => c.sovereign).length;
  const territories = COUNTRIES.length - sovereign;

  console.log('Catalogue synchronise :');
  console.log(`  ${CURRENCIES.length} devises`);
  console.log(`  ${PROVIDERS.length} agregateurs / operateurs / banques`);
  console.log(`  ${sovereign} Etats souverains + ${territories} territoire(s)`);
  console.log(`  ${ruleCount} regles de couverture`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
