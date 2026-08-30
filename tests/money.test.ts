import { describe, expect, it } from 'vitest';
import { applyBps, assertValidAmount, exponentOf, formatMoney } from '../src/core/money.js';

describe('unites mineures', () => {
  it('connait les devises a zero decimale', () => {
    expect(exponentOf('XOF')).toBe(0);
    expect(exponentOf('XAF')).toBe(0);
  });

  it('connait le dinar tunisien a trois decimales', () => {
    expect(exponentOf('TND')).toBe(3);
  });

  it('rejette une devise inconnue plutot que de supposer deux decimales', () => {
    expect(() => exponentOf('USD')).toThrow(/Devise inconnue/);
  });
});

describe('validation des montants', () => {
  it('accepte un entier positif', () => {
    expect(assertValidAmount(15000, 'xof')).toEqual({ amount: 15000, currency: 'XOF' });
  });

  it('refuse un montant decimal au lieu de l’arrondir en silence', () => {
    expect(() => assertValidAmount(1500.5, 'XOF')).toThrow(/entier en unites mineures/);
  });

  it('refuse zero et les montants negatifs', () => {
    expect(() => assertValidAmount(0, 'XOF')).toThrow(/strictement positif/);
    expect(() => assertValidAmount(-100, 'XOF')).toThrow(/strictement positif/);
  });
});

describe('commissions en points de base', () => {
  it('applique 2,50 % sur 10 000', () => {
    expect(applyBps(10000, 250)).toBe(250);
  });

  it('arrondit au demi-superieur, jamais a la baisse', () => {
    // 1,95 % de 999 = 19,4805 -> 19 ; de 1000 = 19,5 -> 20
    expect(applyBps(999, 195)).toBe(19);
    expect(applyBps(1000, 195)).toBe(20);
  });

  it('reste exact sur de gros montants (aucun flottant intermediaire)', () => {
    expect(applyBps(1_000_000_000, 275)).toBe(27_500_000);
  });
});

describe('affichage', () => {
  it('groupe les milliers sans decimale en XOF', () => {
    expect(formatMoney(15000, 'XOF')).toBe('15 000 XOF');
  });

  it('affiche deux decimales en KES', () => {
    expect(formatMoney(15000, 'KES')).toBe('150,00 KES');
  });

  it('affiche trois decimales en TND', () => {
    expect(formatMoney(15000, 'TND')).toBe('15,000 TND');
  });

  it('gere les montants inferieurs a l’unite', () => {
    expect(formatMoney(5, 'KES')).toBe('0,05 KES');
  });
});
