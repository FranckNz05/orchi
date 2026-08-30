import { describe, expect, it } from 'vitest';
import {
  COUNTRIES,
  COVERAGE,
  CURRENCIES,
  PROVIDERS,
  SOVEREIGN_COUNT,
  getCountry,
  getCurrency,
  getProvider,
  validateCatalog,
} from '../src/catalog/index.js';

describe('integrite du catalogue', () => {
  it('ne remonte aucun probleme', () => {
    const issues = validateCatalog();
    // Message explicite : sans cela, un echec ici est illisible.
    expect(issues.map((i) => `[${i.scope}] ${i.message}`)).toEqual([]);
  });

  it('couvre exactement les 54 Etats africains', () => {
    expect(SOVEREIGN_COUNT).toBe(54);
  });

  it('distingue les territoires non souverains du compte des 54', () => {
    const territories = COUNTRIES.filter((c) => !c.sovereign);
    expect(territories.map((c) => c.iso2)).toEqual(['SH']);
  });

  it('rattache chaque pays a une devise connue', () => {
    for (const country of COUNTRIES) {
      expect(getCurrency(country.currency), `devise de ${country.iso2}`).toBeDefined();
    }
  });

  it('ne reference que des agregateurs declares', () => {
    for (const [iso2, rules] of Object.entries(COVERAGE)) {
      for (const rule of rules) {
        expect(getProvider(rule.provider), `${iso2} -> ${rule.provider}`).toBeDefined();
      }
    }
  });
});

describe('exposants de devise', () => {
  it('donne 0 decimale aux francs CFA', () => {
    expect(getCurrency('XOF')?.exponent).toBe(0);
    expect(getCurrency('XAF')?.exponent).toBe(0);
  });

  it('donne 3 decimales au dinar tunisien', () => {
    expect(getCurrency('TND')?.exponent).toBe(3);
  });

  it('n’attribue que des exposants ISO 4217 valides', () => {
    for (const currency of CURRENCIES) {
      expect([0, 2, 3]).toContain(currency.exponent);
    }
  });
});

describe('zone franc CFA — perimetre de la phase 1', () => {
  const CFA = ['BJ', 'TG', 'CI', 'SN', 'ML', 'BF', 'NE', 'GW', 'CM', 'GA', 'CG', 'TD', 'CF', 'GQ'];

  it('regroupe 14 pays en XOF ou XAF', () => {
    const zone = COUNTRIES.filter((c) => c.currency === 'XOF' || c.currency === 'XAF');
    expect(zone.map((c) => c.iso2).sort()).toEqual([...CFA].sort());
  });

  it('place FedaPay ou CinetPay en tete au Benin', () => {
    const rules = COVERAGE.BJ ?? [];
    expect(rules[0]?.provider).toBe('fedapay');
    expect(rules.map((r) => r.provider)).toContain('cinetpay');
  });

  it('place GeniusPay en tete au Cameroun', () => {
    expect((COVERAGE.CM ?? [])[0]?.provider).toBe('geniuspay');
  });
});

describe('coherence des promesses de decaissement', () => {
  it('n’annonce jamais payoutMode=FULL sans voie de payout ouverte', () => {
    for (const country of COUNTRIES) {
      if (country.payoutMode !== 'FULL') continue;
      const rules = COVERAGE[country.iso2] ?? [];
      expect(
        rules.some((r) => r.payout !== false),
        `${country.iso2} annonce FULL sans payout`,
      ).toBe(true);
    }
  });

  it('marque l’Erythree comme non desservie', () => {
    const er = getCountry('ER');
    expect(er?.payoutMode).toBe('NONE');
    expect((COVERAGE.ER ?? [])[0]?.payin).toBe(false);
  });

  it('signale les pays a accord direct sans les annoncer routables', () => {
    const direct = PROVIDERS.filter((p) => p.integration === 'DIRECT_AGREEMENT');
    expect(direct.length).toBeGreaterThan(0);
    for (const provider of direct) {
      expect(provider.integration).not.toBe('LIVE');
    }
  });
});
