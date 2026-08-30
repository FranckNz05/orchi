import { createHmac } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { ProviderError } from '../src/providers/errors.js';
import { GENIUSPAY_COUNTRIES, geniuspayProvider } from '../src/providers/geniuspay.js';
import type { ChargeRequest, ProviderContext } from '../src/providers/types.js';

/**
 * Tests de contrat de l'adaptateur GeniusPay.
 *
 * Ils ne prouvent PAS que l'API reelle se comporte ainsi — aucun compte sandbox
 * n'a ete utilise. Ils EPINGLENT les hypotheses tirees de geniuspay.ci/docs/api :
 * chemins appeles, en-tetes, champs envoyes, traduction des statuts et des
 * codes d'erreur. Le jour ou un compte existe, c'est la liste exacte de ce
 * qu'il faut confronter au reel.
 */

interface Recorded {
  method: string;
  path: string;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

let server: Server;
let base: string;
let calls: Recorded[] = [];
let responses = new Map<string, { status: number; body: unknown }>();

function reply(path: string, body: unknown, status = 200) {
  responses.set(path, { status, body });
}

function called(method: string, path: string): Recorded | undefined {
  return calls.find((c) => c.method === method && c.path === path);
}

beforeAll(async () => {
  server = createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk as Buffer);
      const path = (req.url ?? '').split('?')[0] ?? '';
      calls.push({
        method: req.method ?? '',
        path,
        headers: req.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      });

      const planned = responses.get(`${req.method} ${path}`) ?? responses.get(path);
      if (!planned) {
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: { code: 'NO_STUB' } }));
        return;
      }
      res.writeHead(planned.status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(planned.body));
    })();
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  base = `http://127.0.0.1:${port}`;
  process.env.GENIUSPAY_BASE_URL = `${base}/gp`;
});

afterAll(async () => {
  delete process.env.GENIUSPAY_BASE_URL;
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
  calls = [];
  responses = new Map();
});

const ctx: ProviderContext = {
  merchantId: 'mch_1',
  environment: 'test',
  credentials: {
    api_key: 'pk_sandbox_xxx',
    api_secret: 'sk_sandbox_xxx',
    webhook_secret: 'whsec_sandbox_xxx',
  },
};

function charge(over: Partial<ChargeRequest> = {}): ChargeRequest {
  return {
    reference: 'cmd-1',
    amount: 15000,
    currency: 'XOF',
    country: 'CI',
    channel: 'mobile_money',
    network: 'ORANGE_CI',
    customer: { phone: '+2250700000000', name: 'Amadou Diallo' },
    callbackUrl: 'https://orchi.local/hooks/geniuspay',
    ...over,
  };
}

/* -------------------------------------------------------------------------- */

describe('couverture', () => {
  it('declare les 21 pays documentes', () => {
    expect(GENIUSPAY_COUNTRIES).toHaveLength(21);
    for (const iso of ['CI', 'SN', 'ML', 'BF', 'BJ', 'TG', 'NE', 'GW', 'GH', 'NG', 'SL']) {
      expect(GENIUSPAY_COUNTRIES).toContain(iso);
    }
    for (const iso of ['CM', 'GA', 'CG', 'CF', 'CD', 'KE', 'RW', 'UG', 'ZM', 'ZA']) {
      expect(GENIUSPAY_COUNTRIES).toContain(iso);
    }
  });

  it('refuse les pays absents de sa documentation publique', () => {
    // Le Tchad et la Guinee equatoriale figurent dans le document de cadrage
    // interne mais pas sur geniuspay.ci : les annoncer disponibles produirait
    // un echec au premier paiement.
    expect(geniuspayProvider.supports('TD', 'mobile_money', 'payin')).toBe(false);
    expect(geniuspayProvider.supports('GQ', 'card', 'payin')).toBe(false);
    expect(geniuspayProvider.supports('ET', 'mobile_money', 'payin')).toBe(false);
  });

  it('dessert bien les pays documentes', () => {
    expect(geniuspayProvider.supports('CI', 'mobile_money', 'payin')).toBe(true);
    expect(geniuspayProvider.supports('KE', 'mobile_money', 'payin')).toBe(true);
    expect(geniuspayProvider.supports('ZA', 'card', 'payin')).toBe(true);
  });

  it('refuse tout decaissement', async () => {
    // Leur API de cashout n'est pas publiee : on ne route pas d'argent sortant
    // vers un endpoint devine.
    expect(geniuspayProvider.supports('CI', 'mobile_money', 'payout')).toBe(false);

    const error = await geniuspayProvider
      .createPayout(
        {
          reference: 'po-1',
          amount: 10000,
          currency: 'XOF',
          country: 'CI',
          channel: 'mobile_money',
          recipient: { phone: '+2250700000000' },
          callbackUrl: 'https://orchi.local/hooks',
        },
        ctx,
      )
      .catch((e) => e as ProviderError);

    expect((error as ProviderError).code).toBe('invalid_request');
    expect(calls).toHaveLength(0);
  });
});

/* -------------------------------------------------------------------------- */

describe('encaissement', () => {
  it('authentifie par deux en-tetes distincts', async () => {
    reply('POST /gp/payments', {
      success: true,
      data: { reference: 'MTX-A1B2C3', status: 'pending', payment_url: 'https://pay/1' },
    });

    await geniuspayProvider.createCharge(charge(), ctx);
    const headers = called('POST', '/gp/payments')!.headers;
    // La cle publique identifie, la cle secrete prouve. Ce n'est pas un jeton
    // porteur : envoyer l'une sans l'autre est refuse.
    expect(headers['x-api-key']).toBe('pk_sandbox_xxx');
    expect(headers['x-api-secret']).toBe('sk_sandbox_xxx');
  });

  it('refuse d’appeler l’API sans les deux cles', async () => {
    const error = (await geniuspayProvider
      .createCharge(charge(), { ...ctx, credentials: { api_key: 'pk_x' } })
      .catch((e) => e)) as ProviderError;
    expect(error.code).toBe('authentication');
    expect(calls).toHaveLength(0);
  });

  it('traduit le reseau en gateway et en code operateur PawaPay', async () => {
    reply('POST /gp/payments', {
      success: true,
      data: { reference: 'MTX-1', status: 'pending', payment_url: 'https://pay/1' },
    });

    await geniuspayProvider.createCharge(charge(), ctx);
    const sent = JSON.parse(called('POST', '/gp/payments')!.body);
    expect(sent.payment_method).toBe('orange_money');
    expect(sent.mmo_provider).toBe('ORANGE_CIV');
    expect(sent.customer.country).toBe('CI');
    expect(sent.amount).toBe(15000);
  });

  it('fait voyager notre reference dans les metadonnees', async () => {
    reply('POST /gp/payments', {
      success: true,
      data: { reference: 'MTX-2', status: 'pending', payment_url: 'https://pay/2' },
    });

    await geniuspayProvider.createCharge(charge(), ctx);
    const sent = JSON.parse(called('POST', '/gp/payments')!.body);
    // Sans elle, impossible de rapprocher un settlement GeniusPay de nos ecritures.
    expect(sent.metadata.orchi_reference).toBe('cmd-1');
  });

  it('demande le guichet hebergé quand aucun reseau n’est choisi', async () => {
    reply('POST /gp/payments', {
      success: true,
      data: {
        reference: 'MTX-3',
        status: 'pending',
        checkout_url: 'https://geniuspay.ci/checkout/MTX-3',
      },
    });

    const result = await geniuspayProvider.createCharge(charge({ network: undefined }), ctx);
    const sent = JSON.parse(called('POST', '/gp/payments')!.body);
    // Sans `payment_method`, GeniusPay renvoie sa propre page de choix.
    expect(sent.payment_method).toBeUndefined();
    expect(result.action).toMatchObject({ type: 'redirect' });
    expect(result.providerReference).toBe('MTX-3');
  });

  it('refuse un montant sous le minimum, sans appeler l’API', async () => {
    const error = (await geniuspayProvider
      .createCharge(charge({ amount: 150 }), ctx)
      .catch((e) => e)) as ProviderError;
    expect(error.code).toBe('invalid_request');
    // Creer une transaction vouee au refus laisserait une trace a reconcilier
    // pour rien.
    expect(calls).toHaveLength(0);
  });

  it('refuse un pays non desservi, sans appeler l’API', async () => {
    const error = (await geniuspayProvider
      .createCharge(charge({ country: 'TD' }), ctx)
      .catch((e) => e)) as ProviderError;
    expect(error.code).toBe('invalid_request');
    expect(calls).toHaveLength(0);
  });

  it('retient la commission REELLE communiquee par l’agregateur', async () => {
    reply('/gp/payments/MTX-9', {
      success: true,
      data: { reference: 'MTX-9', status: 'completed', fees: 450, net_amount: 14550 },
    });

    const result = await geniuspayProvider.getCharge('MTX-9', ctx);
    expect(result.status).toBe('succeeded');
    // Cette valeur prime sur le taux catalogue dans le calcul de la part Orchi.
    expect(result.providerFeeAmount).toBe(450);
  });

  it('signale une reponse sans enveloppe `data`', async () => {
    reply('POST /gp/payments', { success: true });
    const error = (await geniuspayProvider.createCharge(charge(), ctx).catch((e) => e)) as ProviderError;
    expect(error.code).toBe('malformed_response');
    expect(error.outcome).toBe('unknown');
  });
});

/* -------------------------------------------------------------------------- */

describe('traduction des statuts', () => {
  const cases: Array<[string, string]> = [
    ['pending', 'awaiting_customer'],
    ['processing', 'pending'],
    ['completed', 'succeeded'],
    ['failed', 'failed'],
    ['cancelled', 'failed'],
    ['refunded', 'failed'],
    ['expired', 'expired'],
  ];

  for (const [genius, expected] of cases) {
    it(`traduit ${genius} en ${expected}`, async () => {
      reply('/gp/payments/MTX-S', { success: true, data: { reference: 'MTX-S', status: genius } });
      const result = await geniuspayProvider.getCharge('MTX-S', ctx);
      expect(result.status).toBe(expected);
    });
  }

  it('traduit un statut inconnu en INCONNU, jamais en echec', async () => {
    // GeniusPay peut en introduire un nouveau : declarer un echec a tort
    // autoriserait une relance sur une transaction peut-etre aboutie.
    reply('/gp/payments/MTX-S', { success: true, data: { reference: 'MTX-S', status: 'en_revue' } });
    const result = await geniuspayProvider.getCharge('MTX-S', ctx);
    expect(result.status).toBe('unknown');
  });
});

/* -------------------------------------------------------------------------- */

describe('codes d’erreur', () => {
  const cases: Array<[string, string, boolean]> = [
    ['INVALID_API_KEY', 'authentication', false],
    ['MISSING_API_KEY', 'authentication', false],
    ['MERCHANT_INACTIVE', 'authentication', false],
    ['VALIDATION_ERROR', 'invalid_request', false],
    ['COUNTRY_NOT_SUPPORTED', 'invalid_request', false],
    ['PAYMENT_INIT_FAILED', 'unavailable', true],
  ];

  for (const [code, expected, failover] of cases) {
    it(`classe ${code} en ${expected}`, async () => {
      reply('POST /gp/payments', { success: false, error: { code, message: 'refus' } });
      const error = (await geniuspayProvider.createCharge(charge(), ctx).catch((e) => e)) as ProviderError;
      expect(error.code).toBe(expected);
      // Basculer vers un autre agregateur n'a de sens que si le refus vient de
      // GeniusPay, pas de notre requete ni de nos credentials.
      expect(error.failoverAllowed).toBe(failover);
      expect(error.providerCode).toBe(code);
    });
  }
});

/* -------------------------------------------------------------------------- */

describe('webhooks', () => {
  function signed(payload: object, secret = 'whsec_sandbox_xxx', at = Math.floor(Date.now() / 1000)) {
    const body = JSON.stringify(payload);
    const signature = createHmac('sha256', secret).update(`${at}.${body}`).digest('hex');
    return {
      rawBody: body,
      headers: { 'x-webhook-signature': signature, 'x-webhook-timestamp': String(at) },
    };
  }

  it('accepte un evenement correctement signe', () => {
    const verdict = geniuspayProvider.verifyWebhook(
      signed({
        id: 'evt-1',
        event: 'payment.success',
        data: { reference: 'MTX-A1', status: 'completed' },
      }),
      ctx,
    );
    expect(verdict.valid).toBe(true);
    if (verdict.valid) {
      expect(verdict.providerReference).toBe('MTX-A1');
      expect(verdict.status).toBe('succeeded');
      expect(verdict.kind).toBe('payin');
      expect(verdict.eventId).toBe('evt-1');
    }
  });

  it('verifie sur le CORPS BRUT recu', () => {
    // Leur exemple PHP reserialise la charge (`json_encode($payload)`), ce qui
    // ne fonctionne que si l'ordre des cles et l'echappement sont identiques
    // d'un langage a l'autre. Le corps brut est exactement ce qu'ils ont signe.
    const raw = '{"id":"e","event":"payment.success","data":{"reference":"MTX-B","status":"completed"}}';
    const at = Math.floor(Date.now() / 1000);
    const signature = createHmac('sha256', 'whsec_sandbox_xxx').update(`${at}.${raw}`).digest('hex');

    const verdict = geniuspayProvider.verifyWebhook(
      { rawBody: raw, headers: { 'x-webhook-signature': signature, 'x-webhook-timestamp': String(at) } },
      ctx,
    );
    expect(verdict.valid).toBe(true);
  });

  it('rejette une signature calculee avec un autre secret', () => {
    const verdict = geniuspayProvider.verifyWebhook(
      signed({ id: 'e', event: 'payment.success', data: { reference: 'MTX-C' } }, 'mauvais'),
      ctx,
    );
    expect(verdict.valid).toBe(false);
  });

  it('rejette un evenement rejoue au-dela de cinq minutes', () => {
    const old = Math.floor(Date.now() / 1000) - 3600;
    const verdict = geniuspayProvider.verifyWebhook(
      signed({ id: 'e', event: 'payment.success', data: { reference: 'MTX-D' } }, 'whsec_sandbox_xxx', old),
      ctx,
    );
    expect(verdict).toEqual({ valid: false, reason: 'Signature expiree (plus de 5 minutes).' });
  });

  it('rejette un webhook non signe', () => {
    const verdict = geniuspayProvider.verifyWebhook({ rawBody: '{}', headers: {} }, ctx);
    expect(verdict.valid).toBe(false);
  });

  it('ne rattache pas un evenement cashout a une tentative', () => {
    // `cashout.*` concerne les retraits du marchand chez GeniusPay, pas nos
    // decaissements : les confondre modifierait la mauvaise transaction.
    const verdict = geniuspayProvider.verifyWebhook(
      signed({ id: 'e', event: 'cashout.completed', data: { reference: 'MTX-E', status: 'completed' } }),
      ctx,
    );
    expect(verdict.valid).toBe(true);
    if (verdict.valid) expect(verdict.kind).toBe('unknown');
  });

  it('ne leve jamais : un corps illisible se signale par valid:false', () => {
    const at = Math.floor(Date.now() / 1000);
    const raw = 'ceci-n-est-pas-du-json';
    const signature = createHmac('sha256', 'whsec_sandbox_xxx').update(`${at}.${raw}`).digest('hex');

    const verdict = geniuspayProvider.verifyWebhook(
      { rawBody: raw, headers: { 'x-webhook-signature': signature, 'x-webhook-timestamp': String(at) } },
      ctx,
    );
    expect(verdict).toEqual({ valid: false, reason: 'Corps non JSON.' });
  });
});
