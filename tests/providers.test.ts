import { beforeEach, describe, expect, it } from 'vitest';
import { ProviderError, isProviderError } from '../src/providers/errors.js';
import { getProviderAdapter, listProviderAdapterIds, requireProviderAdapter } from '../src/providers/registry.js';
import {
  SANDBOX_SIGNATURE_HEADER,
  buildSandboxWebhook,
  resetSandbox,
  sandboxProvider,
  signSandboxPayload,
} from '../src/providers/sandbox.js';
import type { ChargeRequest, PayoutRequest, ProviderContext } from '../src/providers/types.js';
import { isTerminal } from '../src/providers/types.js';

const WEBHOOK_SECRET = 'secret-de-test';

const ctx: ProviderContext = {
  merchantId: 'mch_test',
  environment: 'test',
  credentials: { webhook_secret: WEBHOOK_SECRET },
};

const liveCtx: ProviderContext = { ...ctx, environment: 'live' };

let counter = 0;
function charge(phone: string, over: Partial<ChargeRequest> = {}): ChargeRequest {
  counter += 1;
  return {
    reference: `attempt_${counter}`,
    amount: 15000,
    currency: 'XOF',
    country: 'BJ',
    channel: 'mobile_money',
    network: 'MTN_BENIN',
    customer: { phone },
    callbackUrl: 'https://orchi.local/hooks/sandbox',
    ...over,
  };
}

function payout(phone: string, over: Partial<PayoutRequest> = {}): PayoutRequest {
  counter += 1;
  return {
    reference: `payout_${counter}`,
    amount: 50000,
    currency: 'XOF',
    country: 'BJ',
    channel: 'mobile_money',
    recipient: { phone, network: 'MTN_BENIN', name: 'Jean Dupont' },
    callbackUrl: 'https://orchi.local/hooks/sandbox',
    ...over,
  };
}

beforeEach(() => {
  resetSandbox();
});

/* -------------------------------------------------------------------------- */

describe('registre des adaptateurs', () => {
  it('expose le simulateur', () => {
    expect(listProviderAdapterIds()).toContain('sandbox');
    expect(getProviderAdapter('sandbox')).toBeDefined();
  });

  it("ne connait aucun adaptateur pour les agregateurs pas encore branches", () => {
    expect(getProviderAdapter('fedapay')).toBeUndefined();
    expect(getProviderAdapter('cinetpay')).toBeUndefined();
  });

  it('leve une erreur exploitable plutot que de renvoyer undefined', () => {
    expect(() => requireProviderAdapter('flutterwave')).toThrow(/Aucun adaptateur/);
  });
});

describe('cloisonnement test / live', () => {
  it('refuse tout encaissement avec une cle live', async () => {
    await expect(sandboxProvider.createCharge(charge('+22997000000'), liveCtx)).rejects.toThrow(
      /interdit en environnement live/,
    );
  });

  it('refuse tout decaissement avec une cle live', async () => {
    await expect(sandboxProvider.createPayout(payout('+22997000000'), liveCtx)).rejects.toThrow(
      /interdit en environnement live/,
    );
  });
});

/* -------------------------------------------------------------------------- */

describe('encaissement simule', () => {
  it("n'affirme jamais un paiement immediat : il renvoie une action client", async () => {
    const result = await sandboxProvider.createCharge(charge('+22997000000'), ctx);
    expect(result.status).toBe('awaiting_customer');
    expect(result.action.type).toBe('ussd_push');
    expect(isTerminal(result.status)).toBe(false);
  });

  it('bascule en succes a la premiere interrogation', async () => {
    const created = await sandboxProvider.createCharge(charge('+22997000000'), ctx);
    const polled = await sandboxProvider.getCharge(created.providerReference, ctx);
    expect(polled.status).toBe('succeeded');
    expect(polled.action.type).toBe('none');
  });

  it('propose une redirection en carte plutot qu’un push USSD', async () => {
    const result = await sandboxProvider.createCharge(
      charge('+22997000001', { channel: 'card', customer: { email: 'client@test.local' } }),
      ctx,
    );
    expect(result.action.type).toBe('redirect');
  });

  it('exige plusieurs interrogations en scenario lent', async () => {
    const created = await sandboxProvider.createCharge(charge('+22997000001'), ctx);
    const first = await sandboxProvider.getCharge(created.providerReference, ctx);
    expect(first.status).toBe('awaiting_customer');
    const second = await sandboxProvider.getCharge(created.providerReference, ctx);
    expect(second.status).toBe('succeeded');
  });

  it('renvoie un refus explicite avec son code agregateur', async () => {
    const result = await sandboxProvider.createCharge(charge('+22997000002'), ctx);
    expect(result.status).toBe('failed');
    expect(result.providerCode).toBe('insufficient_funds');
  });
});

describe('decaissement simule', () => {
  it('part immediatement quand tout va bien', async () => {
    const result = await sandboxProvider.createPayout(payout('+22997000000'), ctx);
    expect(result.status).toBe('succeeded');
    expect(result.action.type).toBe('none');
  });

  it('reste en attente puis aboutit en scenario lent', async () => {
    const created = await sandboxProvider.createPayout(payout('+22997000001'), ctx);
    expect(created.status).toBe('pending');
    await sandboxProvider.getPayout(created.providerReference, ctx);
    const final = await sandboxProvider.getPayout(created.providerReference, ctx);
    expect(final.status).toBe('succeeded');
  });
});

/* -------------------------------------------------------------------------- */

describe('taxonomie des echecs — la regle anti-double-paiement', () => {
  it('classe un timeout en etat INCONNU, sans failover ni rejeu', async () => {
    const error = await sandboxProvider.createPayout(payout('+22997000003'), ctx).catch((e) => e);
    expect(isProviderError(error)).toBe(true);
    const pe = error as ProviderError;
    expect(pe.code).toBe('timeout');
    // Les trois assertions qui protegent du double decaissement.
    expect(pe.outcome).toBe('unknown');
    expect(pe.failoverAllowed).toBe(false);
    expect(pe.retriableSameProvider).toBe(false);
  });

  it('classe une panne agregateur en echec franc, avec failover autorise', async () => {
    const pe = (await sandboxProvider.createCharge(charge('+22997000004'), ctx).catch((e) => e)) as ProviderError;
    expect(pe.code).toBe('unavailable');
    expect(pe.outcome).toBe('failed');
    expect(pe.failoverAllowed).toBe(true);
  });

  it('autorise le rejeu chez le meme agregateur sur quota depasse', async () => {
    const pe = (await sandboxProvider.createCharge(charge('+22997000005'), ctx).catch((e) => e)) as ProviderError;
    expect(pe.code).toBe('rate_limited');
    expect(pe.retriableSameProvider).toBe(true);
    expect(pe.failoverAllowed).toBe(true);
  });

  it('interdit le failover sur credentials invalides — c’est une alerte, pas un aleas', async () => {
    const pe = (await sandboxProvider.createCharge(charge('+22997000006'), ctx).catch((e) => e)) as ProviderError;
    expect(pe.code).toBe('authentication');
    expect(pe.outcome).toBe('failed');
    expect(pe.failoverAllowed).toBe(false);
  });

  it('expose un contexte de log sans secret', async () => {
    const pe = (await sandboxProvider.createCharge(charge('+22997000004'), ctx).catch((e) => e)) as ProviderError;
    expect(pe.toLogContext()).toMatchObject({
      provider: 'sandbox',
      code: 'unavailable',
      outcome: 'failed',
      failover_allowed: true,
    });
  });

  it('ne classe jamais un code inconnu comme echec franc par defaut', () => {
    const pe = new ProviderError({
      providerId: 'sandbox',
      code: 'malformed_response',
      message: 'reponse illisible',
    });
    expect(pe.outcome).toBe('unknown');
    expect(pe.failoverAllowed).toBe(false);
  });

  it('classe un 5xx sur requete mutante en etat indetermine', () => {
    const pe = new ProviderError({ providerId: 'sandbox', code: 'indeterminate', message: '500' });
    expect(pe.outcome).toBe('unknown');
    expect(pe.failoverAllowed).toBe(false);
  });
});

/* -------------------------------------------------------------------------- */

describe('idempotence par reference', () => {
  it('ne cree pas deux transactions pour une meme reference', async () => {
    const request = charge('+22997000000');
    const first = await sandboxProvider.createCharge(request, ctx);
    const second = await sandboxProvider.createCharge(request, ctx);
    expect(second.providerReference).toBe(first.providerReference);
  });

  it('ne fait pas avancer l’etat lors d’un rejeu de creation', async () => {
    const request = charge('+22997000000');
    await sandboxProvider.createCharge(request, ctx);
    const replay = await sandboxProvider.createCharge(request, ctx);
    expect(replay.status).toBe('awaiting_customer');
  });

  it('separe les references d’encaissement et de decaissement', async () => {
    const c = await sandboxProvider.createCharge(charge('+22997000000', { reference: 'ref_partagee' }), ctx);
    const p = await sandboxProvider.createPayout(payout('+22997000000', { reference: 'ref_partagee' }), ctx);
    expect(p.providerReference).not.toBe(c.providerReference);
  });
});

describe('selection explicite de scenario', () => {
  it('accepte une consigne par metadata, indispensable en carte', async () => {
    const result = await sandboxProvider.createCharge(
      charge('+22997000000', {
        channel: 'card',
        customer: { email: 'client@test.local' },
        metadata: { sandbox_scenario: 'declined' },
      }),
      ctx,
    );
    expect(result.status).toBe('failed');
  });

  it('refuse un scenario inconnu au lieu de retomber sur le succes', async () => {
    await expect(
      sandboxProvider.createCharge(charge('+22997000000', { metadata: { sandbox_scenario: 'magique' } }), ctx),
    ).rejects.toThrow(/Scenario sandbox inconnu/);
  });
});

/* -------------------------------------------------------------------------- */

describe('verification des webhooks', () => {
  it('accepte un webhook correctement signe', async () => {
    const created = await sandboxProvider.createCharge(charge('+22997000000'), ctx);
    const hook = buildSandboxWebhook(created.providerReference, WEBHOOK_SECRET);
    const verdict = sandboxProvider.verifyWebhook({ rawBody: hook.body, headers: hook.headers }, ctx);
    expect(verdict.valid).toBe(true);
    if (verdict.valid) {
      expect(verdict.providerReference).toBe(created.providerReference);
      expect(verdict.kind).toBe('payin');
      expect(verdict.eventId).toMatch(/^evt_sbx_/);
    }
  });

  it('rejette un corps altere apres signature', async () => {
    const created = await sandboxProvider.createCharge(charge('+22997000000'), ctx);
    const hook = buildSandboxWebhook(created.providerReference, WEBHOOK_SECRET);
    const tampered = hook.body.replace('"amount":15000', '"amount":1');
    const verdict = sandboxProvider.verifyWebhook({ rawBody: tampered, headers: hook.headers }, ctx);
    expect(verdict).toEqual({ valid: false, reason: 'Signature invalide.' });
  });

  it('rejette une signature calculee avec un autre secret', async () => {
    const created = await sandboxProvider.createCharge(charge('+22997000000'), ctx);
    const hook = buildSandboxWebhook(created.providerReference, WEBHOOK_SECRET);
    const verdict = sandboxProvider.verifyWebhook(
      {
        rawBody: hook.body,
        headers: { [SANDBOX_SIGNATURE_HEADER]: signSandboxPayload(hook.body, 'mauvais-secret') },
      },
      ctx,
    );
    expect(verdict.valid).toBe(false);
  });

  it('rejette un webhook non signe', async () => {
    const created = await sandboxProvider.createCharge(charge('+22997000000'), ctx);
    const hook = buildSandboxWebhook(created.providerReference, WEBHOOK_SECRET);
    const verdict = sandboxProvider.verifyWebhook({ rawBody: hook.body, headers: {} }, ctx);
    expect(verdict).toEqual({ valid: false, reason: 'Signature absente.' });
  });

  it('ne leve jamais : un webhook illisible se signale par valid:false', () => {
    const body = 'ceci-n-est-pas-du-json';
    const verdict = sandboxProvider.verifyWebhook(
      { rawBody: body, headers: { [SANDBOX_SIGNATURE_HEADER]: signSandboxPayload(body, WEBHOOK_SECRET) } },
      ctx,
    );
    expect(verdict).toEqual({ valid: false, reason: 'Corps non JSON.' });
  });

  it('rejette un statut hors taxonomie', async () => {
    const created = await sandboxProvider.createCharge(charge('+22997000000'), ctx);
    const body = JSON.stringify({
      event_id: 'evt_1',
      type: 'charge.updated',
      reference: created.providerReference,
      status: 'presque_paye',
    });
    const verdict = sandboxProvider.verifyWebhook(
      { rawBody: body, headers: { [SANDBOX_SIGNATURE_HEADER]: signSandboxPayload(body, WEBHOOK_SECRET) } },
      ctx,
    );
    expect(verdict.valid).toBe(false);
  });

  it('produit un identifiant d’evenement stable, support de la deduplication', async () => {
    const created = await sandboxProvider.createCharge(charge('+22997000000'), ctx);
    const a = buildSandboxWebhook(created.providerReference, WEBHOOK_SECRET);
    const b = buildSandboxWebhook(created.providerReference, WEBHOOK_SECRET);
    expect(JSON.parse(a.body).event_id).toBe(JSON.parse(b.body).event_id);
  });
});
