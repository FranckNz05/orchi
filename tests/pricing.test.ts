import { describe, expect, it } from 'vitest';
import { platformPayinFee, platformPayoutFee, quote } from '../src/modules/pricing.js';

/**
 * La regle tient en une phrase : le marchand paie toujours 5 % au total, et la
 * part Orchi est le solde apres la commission de l'agregateur.
 *
 * Ces tests l'epinglent aux deux bouts — y compris la ou elle cesse d'etre
 * rentable, ce qui est une information de pilotage et non un cas theorique.
 */
const M = 'mch_test';

describe('la part Orchi est le solde du taux total', () => {
  it('prend 3 % quand l’agregateur prend 2 %', () => {
    const fee = platformPayinFee(M, { amountMinor: 100_000, providerFeeBps: 200 });
    expect(fee.providerAmount).toBe(2_000);
    expect(fee.amount).toBe(3_000);
    expect(fee.bps).toBe(300);
  });

  it('prend 1 % quand l’agregateur prend 4 %', () => {
    const fee = platformPayinFee(M, { amountMinor: 100_000, providerFeeBps: 400 });
    expect(fee.providerAmount).toBe(4_000);
    expect(fee.amount).toBe(1_000);
  });

  it('prend tout quand l’agregateur ne prend rien', () => {
    const fee = platformPayinFee(M, { amountMinor: 100_000, providerFeeBps: 0 });
    expect(fee.amount).toBe(5_000);
  });

  it('coute le meme total au marchand, quel que soit l’agregateur', () => {
    // C'est ce qui rend le routage acceptable pour lui : basculer vers un
    // agregateur plus cher ne change pas sa facture.
    for (const providerBps of [0, 100, 195, 250, 300, 425, 500]) {
      const fee = platformPayinFee(M, { amountMinor: 100_000, providerFeeBps: providerBps });
      expect(fee.providerAmount + fee.amount).toBe(5_000);
    }
  });
});

describe('bornes', () => {
  it('ne descend jamais sous zero quand l’agregateur depasse 5 %', () => {
    // Erythree, RCA, Soudan atteignent ou depassent ce niveau.
    const fee = platformPayinFee(M, { amountMinor: 100_000, providerFeeBps: 700 });
    expect(fee.amount).toBe(0);
    expect(fee.capped).toBe(true);
  });

  it('signale explicitement une marge nulle', () => {
    const rentable = platformPayinFee(M, { amountMinor: 100_000, providerFeeBps: 200 });
    const nulle = platformPayinFee(M, { amountMinor: 100_000, providerFeeBps: 500 });
    expect(rentable.capped).toBe(false);
    expect(nulle.capped).toBe(true);
  });

  it('prefere la commission REELLE au taux catalogue', () => {
    // Le taux catalogue n'est qu'une estimation ; ce que l'agregateur a
    // effectivement retenu fait foi.
    const fee = platformPayinFee(M, {
      amountMinor: 100_000,
      providerFeeBps: 200,
      providerFeeAmount: 3_500,
    });
    expect(fee.providerAmount).toBe(3_500);
    expect(fee.amount).toBe(1_500);
  });

  it('traite un taux agregateur inconnu comme nul, sans surfacturer', () => {
    // `providerFeeBps` absent signifie « non fige » : la part Orchi vaut alors
    // le taux total. C'est precisement pourquoi il est enregistre sur la
    // tentative au moment du routage.
    const fee = platformPayinFee(M, { amountMinor: 100_000 });
    expect(fee.providerAmount).toBe(0);
    expect(fee.amount).toBe(5_000);
  });
});

describe('devises a zero decimale', () => {
  it('reste juste sur un montant en francs CFA', () => {
    // 15 000 F CFA, agregateur a 2 % : 300 pour lui, 450 pour Orchi.
    const fee = platformPayinFee(M, { amountMinor: 15_000, providerFeeBps: 200 });
    expect(fee.providerAmount).toBe(300);
    expect(fee.amount).toBe(450);
    expect(fee.providerAmount + fee.amount).toBe(750);
  });

  it('ne produit jamais de centime sur une devise qui n’en a pas', () => {
    const fee = platformPayinFee(M, { amountMinor: 1_234, providerFeeBps: 195 });
    expect(Number.isInteger(fee.amount)).toBe(true);
    expect(Number.isInteger(fee.providerAmount)).toBe(true);
  });
});

describe('decaissements', () => {
  it('applique la meme regle', () => {
    const fee = platformPayoutFee(M, { amountMinor: 50_000, providerFeeBps: 150 });
    expect(fee.providerAmount).toBe(750);
    expect(fee.amount).toBe(1_750);
    expect(fee.providerAmount + fee.amount).toBe(2_500);
  });
});

describe('simulation affichee au marchand', () => {
  it('donne le net exact', () => {
    const q = quote(15_000, 200, 'payin');
    expect(q.provider_fee).toBe(300);
    expect(q.platform_fee).toBe(450);
    expect(q.net).toBe(14_250);
    expect(q.amount - q.net).toBe(750);
  });

  it('montre un net inchange quand l’agregateur change', () => {
    const cher = quote(15_000, 400, 'payin');
    const economique = quote(15_000, 100, 'payin');
    expect(cher.net).toBe(economique.net);
  });
});
