import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { env } from '../src/core/env.js';
import { ID_PREFIX, newId } from '../src/core/ids.js';
import { prisma } from '../src/db/client.js';
import { assertLedgerBalanced, postPayinSucceeded, postPayoutSucceeded } from '../src/modules/ledger.js';
import { grossUp } from '../src/modules/settlements-auto.js';

/**
 * Le marchand paie 5 %, tout compris, quel que soit l'agregateur : au-dela,
 * c'est Afripaie qui paie. Ces tests verifient que le grand livre le constate.
 */

let merchantId: string;
const initialCollection = env.PLATFORM_FEE_COLLECTION;

beforeAll(async () => {
  merchantId = newId(ID_PREFIX.merchant);
  await prisma.merchant.create({
    data: { id: merchantId, name: 'Frais', legalType: 'COMPANY', country: 'CG', contactEmail: `${merchantId}@test.local` },
  });
});

afterAll(async () => {
  env.PLATFORM_FEE_COLLECTION = initialCollection;
  await prisma.ledgerEntry.deleteMany({ where: { journal: { merchantId } } });
  await prisma.ledgerJournal.deleteMany({ where: { merchantId } });
  await prisma.merchant.deleteMany({ where: { id: merchantId } });
  await prisma.$disconnect();
});

async function entriesOf(refId: string) {
  const rows = await prisma.ledgerEntry.findMany({ where: { journal: { refId } }, include: { journal: true } });
  return rows.map((e) => ({ type: e.journal.type, account: e.account, side: e.side, amount: e.amount }));
}

describe('frais superieurs a 5 %', () => {
  it('en garde Afripaie : le marchand est credite de 95 %, Afripaie paie l’ecart', async () => {
    // Yabetoo sur 1 000 XAF : 3,5 % + 25 = 60, soit 6 %. Part Afripaie : -10.
    const refId = newId(ID_PREFIX.payment);
    await postPayinSucceeded({
      merchantId, paymentId: refId, providerId: 'yabetoo', currency: 'XAF',
      amount: 1_000, providerFee: 60, platformFee: -10, custody: 'platform',
    });

    const e = await entriesOf(refId);
    expect(e).toContainEqual({ type: 'payin.succeeded', account: `merchant:${merchantId}:held`, side: 'CREDIT', amount: 950 });
    expect(e).toContainEqual({ type: 'payin.succeeded', account: 'afripaie:revenue', side: 'DEBIT', amount: 10 });
    expect(e).toContainEqual({ type: 'payin.succeeded', account: 'provider:yabetoo:fees', side: 'CREDIT', amount: 60 });
    expect(e.some((x) => x.type === 'fee.accrued')).toBe(false);
    await expect(assertLedgerBalanced(merchantId)).resolves.toBeUndefined();
  });

  it('en facturation : l’ecart devient un avoir au marchand', async () => {
    env.PLATFORM_FEE_COLLECTION = 'invoice';
    const refId = newId(ID_PREFIX.payment);
    await postPayinSucceeded({
      merchantId, paymentId: refId, providerId: 'yabetoo', currency: 'XAF',
      amount: 1_000, providerFee: 60, platformFee: -10,
    });

    const e = await entriesOf(refId);
    expect(e).toContainEqual({ type: 'fee.accrued', account: `merchant:${merchantId}:billing`, side: 'CREDIT', amount: 10 });
    expect(e).toContainEqual({ type: 'fee.accrued', account: 'afripaie:revenue', side: 'DEBIT', amount: 10 });
    await expect(assertLedgerBalanced(merchantId)).resolves.toBeUndefined();
  });

  it('en split : l’agregateur ne verse pas d’ecart, il passe en avoir', async () => {
    env.PLATFORM_FEE_COLLECTION = 'split';
    const refId = newId(ID_PREFIX.payment);
    await postPayinSucceeded({
      merchantId, paymentId: refId, providerId: 'yabetoo', currency: 'XAF',
      amount: 1_000, providerFee: 60, platformFee: -10,
    });

    const e = await entriesOf(refId);
    expect(e).toContainEqual({ type: 'payin.succeeded', account: `merchant:${merchantId}:receivable`, side: 'CREDIT', amount: 940 });
    expect(e).toContainEqual({ type: 'fee.accrued', account: `merchant:${merchantId}:billing`, side: 'CREDIT', amount: 10 });
    await expect(assertLedgerBalanced(merchantId)).resolves.toBeUndefined();
  });

  it('en decaissement facture : une part reduite par les frais du beneficiaire reste une creance', async () => {
    env.PLATFORM_FEE_COLLECTION = 'invoice';
    const refId = newId(ID_PREFIX.payout);
    await postPayoutSucceeded({
      merchantId, payoutId: refId, providerId: 'yabetoo', currency: 'XAF',
      amount: 100_000, providerFee: 0, platformFee: 3_500,
    });
    const e = await entriesOf(refId);
    expect(e).toContainEqual({ type: 'fee.accrued', account: `merchant:${merchantId}:billing`, side: 'DEBIT', amount: 3_500 });
    await expect(assertLedgerBalanced(merchantId)).resolves.toBeUndefined();
  });
});

describe('reversement net de frais', () => {
  it('envoie de quoi faire recevoir au marchand l’integralite de son du', () => {
    // Yabetoo retient 1,5 % : pour que 19 000 arrivent, il faut en envoyer 19 290.
    expect(grossUp(19_000, 150)).toBe(19_290);
    expect(Math.floor(grossUp(19_000, 150) * 0.985)).toBeGreaterThanOrEqual(19_000);
    for (const owed of [100, 985, 1_000, 5_000, 123_457]) {
      expect(grossUp(owed, 150) * 0.985).toBeGreaterThanOrEqual(owed);
    }
    expect(grossUp(19_000, 0)).toBe(19_000);
  });
});
