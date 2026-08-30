export * from './currencies.js';
export * from './countries.js';
export * from './providers.js';
export * from './coverage.js';

import { CURRENCIES, getCurrency } from './currencies.js';
import { COUNTRIES, SOVEREIGN_COUNT } from './countries.js';
import { PROVIDERS, getProvider } from './providers.js';
import { COVERAGE } from './coverage.js';

/**
 * Verification d'integrite du catalogue.
 *
 * Executee par les tests et par le seed : une devise absente ou un agregateur
 * mal orthographie ferait echouer une transaction en production, pas au
 * demarrage. Autant que ce soit ici.
 */
export interface CatalogIssue {
  scope: string;
  message: string;
}

export function validateCatalog(): CatalogIssue[] {
  const issues: CatalogIssue[] = [];

  if (SOVEREIGN_COUNT !== 54) {
    issues.push({
      scope: 'countries',
      message: `${SOVEREIGN_COUNT} Etats souverains dans le catalogue, 54 attendus.`,
    });
  }

  const seenIso2 = new Set<string>();
  for (const country of COUNTRIES) {
    if (seenIso2.has(country.iso2)) {
      issues.push({ scope: 'countries', message: `Code pays duplique : ${country.iso2}.` });
    }
    seenIso2.add(country.iso2);

    if (!getCurrency(country.currency)) {
      issues.push({
        scope: 'countries',
        message: `${country.iso2} reference la devise inconnue ${country.currency}.`,
      });
    }
    if (country.feeMinBps > country.feeMaxBps) {
      issues.push({
        scope: 'countries',
        message: `${country.iso2} : fourchette de commission inversee (${country.feeMinBps} > ${country.feeMaxBps}).`,
      });
    }

    const rules = COVERAGE[country.iso2] ?? [];
    if (rules.length === 0) {
      issues.push({ scope: 'coverage', message: `${country.iso2} n'a aucune regle de couverture.` });
    }

    const seenProviders = new Set<string>();
    for (const rule of rules) {
      if (!getProvider(rule.provider)) {
        issues.push({
          scope: 'coverage',
          message: `${country.iso2} reference l'agregateur inconnu "${rule.provider}".`,
        });
      }
      if (seenProviders.has(rule.provider)) {
        issues.push({
          scope: 'coverage',
          message: `${country.iso2} : agregateur ${rule.provider} declare deux fois.`,
        });
      }
      seenProviders.add(rule.provider);

      if (rule.channels.length === 0) {
        issues.push({
          scope: 'coverage',
          message: `${country.iso2}/${rule.provider} : aucun canal declare.`,
        });
      }
      if (rule.payin === false && rule.payout === false) {
        // Cas legitime (Erythree) mais qui doit rester explicite et rare.
        if (!rule.note) {
          issues.push({
            scope: 'coverage',
            message: `${country.iso2}/${rule.provider} : ni payin ni payout, sans note explicative.`,
          });
        }
      }
    }

    // Un pays declare FULL en decaissement doit avoir au moins une voie de
    // payout reellement ouverte, sinon la promesse commerciale est fausse.
    if (country.payoutMode === 'FULL' && !rules.some((r) => r.payout !== false)) {
      issues.push({
        scope: 'coverage',
        message: `${country.iso2} est annonce payoutMode=FULL mais aucune regle n'ouvre le payout.`,
      });
    }
  }

  for (const iso2 of Object.keys(COVERAGE)) {
    if (!seenIso2.has(iso2)) {
      issues.push({ scope: 'coverage', message: `Regles definies pour un pays absent : ${iso2}.` });
    }
  }

  const seenProviderIds = new Set<string>();
  for (const provider of PROVIDERS) {
    if (seenProviderIds.has(provider.id)) {
      issues.push({ scope: 'providers', message: `Agregateur duplique : ${provider.id}.` });
    }
    seenProviderIds.add(provider.id);
  }

  const seenCurrencies = new Set<string>();
  for (const currency of CURRENCIES) {
    if (seenCurrencies.has(currency.code)) {
      issues.push({ scope: 'currencies', message: `Devise dupliquee : ${currency.code}.` });
    }
    seenCurrencies.add(currency.code);
  }

  return issues;
}
