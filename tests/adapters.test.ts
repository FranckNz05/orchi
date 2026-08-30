import { createHmac } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { cinetpayProvider, resetTransferTokens } from '../src/providers/cinetpay.js';
import type { ProviderError } from '../src/providers/errors.js';
import { fedapayProvider } from '../src/providers/fedapay.js';
import { listProviderAdapterIds } from '../src/providers/registry.js';
import type { ChargeRequest, PayoutRequest, ProviderContext } from '../src/providers/types.js';

/**
 * Tests de contrat des adaptateurs FedaPay et CinetPay.
 *
 * Ils ne prouvent PAS que les vraies API se comportent ainsi — aucun compte
 * sandbox reel n'a ete utilise. Ils EPINGLENT les hypotheses tirees de la
 * documentation publique : chemins appeles, champs envoyes, traduction des
 * statuts. Le jour ou un compte sandbox est disponible, ces tests deviennent la
 * liste exacte de ce qu'il faut confronter au reel.
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
/** Reponses programmees par chemin, pour piloter chaque scenario. */
let responses = new Map<string, { status: number; body: unknown }>();

function reply(path: string, body: unknown, status = 200) {
  responses.set(path, { status, body });
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

beforeAll(async () => {
  server = createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      const body = await readBody(req);
      const path = (req.url ?? '').split('?')[0] ?? '';
      calls.push({ method: req.method ?? '', path, headers: req.headers, body });

      const planned = responses.get(`${req.method} ${path}`) ?? responses.get(path);
      if (!planned) {
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: `aucune reponse programmee pour ${req.method} ${path}` }));
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

  process.env.FEDAPAY_BASE_URL = `${base}/v1`;
  process.env.CINETPAY_CHECKOUT_URL = `${base}/v2`;
  process.env.CINETPAY_TRANSFER_URL = `${base}/t1`;
});

afterAll(async () => {
  delete process.env.FEDAPAY_BASE_URL;
  delete process.env.CINETPAY_CHECKOUT_URL;
  delete process.env.CINETPAY_TRANSFER_URL;
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
  calls = [];
  responses = new Map();
  resetTransferTokens();
});

function called(method: string, path: string): Recorded | undefined {
  return calls.find((c) => c.method === method && c.path === path);
}

/* -------------------------------------------------------------------------- */

describe('activation des adaptateurs', () => {
  it("n'active que le simulateur par defaut", () => {
    // FedaPay et CinetPay existent dans le code mais ne sont pas branches :
    // les activer avant validation en sandbox enverrait de vraies transactions
    // sur un contrat suppose.
    expect(listProviderAdapterIds()).toEqual(['sandbox']);
  });
});

/* -------------------------------------------------------------------------- */

const fedapayCtx: ProviderContext = {
  merchantId: 'mch_1',
  environment: 'test',
  credentials: { secret_key: 'sk_sandbox_xxx', webhook_secret: 'wh_secret' },
};

const charge: ChargeRequest = {
  reference: 'cmd-1',
  amount: 15000,
  currency: 'XOF',
  country: 'BJ',
  channel: 'mobile_money',
  network: 'MTN_BENIN',
  customer: { phone: '+22997000000', name: 'Jean Dupont', email: 'jean@test.bj' },
  callbackUrl: 'https://orchi.local/hooks/fedapay',
  description: 'Commande 1',
};

describe('FedaPay — encaissement mobile money', () => {
  it('enchaine creation, jeton, puis push operateur', async () => {
    reply('POST /v1/transactions', { 'v1/transaction': { id: 4242, status: 'pending', reference: 'trx_1' } }, 201);
    reply('POST /v1/transactions/4242/token', { token: 'tok_abc', url: 'https://pay.fedapay/tok_abc' });
    reply('POST /v1/transactions/mtn', { 'v1/transaction': { id: 4242, status: 'pending' } });

    const result = await fedapayProvider.createCharge(charge, fedapayCtx);

    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      'POST /v1/transactions',
      'POST /v1/transactions/4242/token',
      'POST /v1/transactions/mtn',
    ]);
    expect(result.providerReference).toBe('4242');
    expect(result.status).toBe('awaiting_customer');
    expect(result.action.type).toBe('ussd_push');
  });

  it('authentifie par cle secrete en Bearer', async () => {
    reply('POST /v1/transactions', { 'v1/transaction': { id: 1, status: 'pending' } }, 201);
    reply('POST /v1/transactions/1/token', { token: 't', url: 'u' });
    reply('POST /v1/transactions/mtn', {});

    await fedapayProvider.createCharge(charge, fedapayCtx);
    expect(called('POST', '/v1/transactions')!.headers.authorization).toBe('Bearer sk_sandbox_xxx');
  });

  it('envoie le montant en unites mineures et la devise sous forme d’objet', async () => {
    reply('POST /v1/transactions', { 'v1/transaction': { id: 1, status: 'pending' } }, 201);
    reply('POST /v1/transactions/1/token', { token: 't', url: 'u' });
    reply('POST /v1/transactions/mtn', {});

    await fedapayProvider.createCharge(charge, fedapayCtx);
    const sent = JSON.parse(called('POST', '/v1/transactions')!.body);
    expect(sent.amount).toBe(15000);
    expect(sent.currency).toEqual({ iso: 'XOF' });
  });

  it('fait voyager notre reference dans les metadonnees', async () => {
    reply('POST /v1/transactions', { 'v1/transaction': { id: 1, status: 'pending' } }, 201);
    reply('POST /v1/transactions/1/token', { token: 't', url: 'u' });
    reply('POST /v1/transactions/mtn', {});

    await fedapayProvider.createCharge(charge, fedapayCtx);
    const sent = JSON.parse(called('POST', '/v1/transactions')!.body);
    // Sans cela, impossible de rapprocher un settlement FedaPay de nos ecritures.
    expect(sent.custom_metadata.orchi_reference).toBe('cmd-1');
  });

  it('redirige au lieu de pousser en carte', async () => {
    reply('POST /v1/transactions', { 'v1/transaction': { id: 7, status: 'pending' } }, 201);
    reply('POST /v1/transactions/7/token', { token: 't', url: 'https://pay.fedapay/7' });

    const result = await fedapayProvider.createCharge(
      { ...charge, channel: 'card', network: undefined },
      fedapayCtx,
    );
    expect(result.action).toEqual({ type: 'redirect', url: 'https://pay.fedapay/7' });
    // Aucun push operateur en carte.
    expect(called('POST', '/v1/transactions/mtn')).toBeUndefined();
  });

  it('refuse un reseau qu’il ne dessert pas, sans appeler l’API', async () => {
    const error = (await fedapayProvider
      .createCharge({ ...charge, network: 'MPESA_KE' }, fedapayCtx)
      .catch((e) => e)) as ProviderError;
    expect(error.code).toBe('invalid_request');
    expect(calls).toHaveLength(0);
  });

  it('accepte aussi une reponse a plat, sans enveloppe', async () => {
    // L'enveloppe {"v1/transaction": ...} n'est pas confirmee partout : le
    // parseur tolere les deux plutot que de parier.
    reply('POST /v1/transactions', { id: 99, status: 'pending' }, 201);
    reply('POST /v1/transactions/99/token', { token: 't', url: 'u' });
    reply('POST /v1/transactions/mtn', {});

    const result = await fedapayProvider.createCharge(charge, fedapayCtx);
    expect(result.providerReference).toBe('99');
  });
});

describe('FedaPay — traduction des statuts', () => {
  const cases: Array<[string, string]> = [
    ['pending', 'awaiting_customer'],
    ['approved', 'succeeded'],
    ['transferred', 'succeeded'],
    ['declined', 'failed'],
    ['canceled', 'failed'],
  ];

  for (const [fedapay, expected] of cases) {
    it(`traduit ${fedapay} en ${expected}`, async () => {
      reply('/v1/transactions/1', { 'v1/transaction': { id: 1, status: fedapay } });
      const result = await fedapayProvider.getCharge('1', fedapayCtx);
      expect(result.status).toBe(expected);
    });
  }

  it('traduit un statut inconnu en INCONNU, jamais en echec', async () => {
    // Declarer un echec a tort autoriserait une relance sur une transaction
    // peut-etre aboutie.
    reply('/v1/transactions/1', { 'v1/transaction': { id: 1, status: 'quelque_chose_de_neuf' } });
    const result = await fedapayProvider.getCharge('1', fedapayCtx);
    expect(result.status).toBe('unknown');
  });
});

describe('FedaPay — decaissement', () => {
  it('cree puis declenche le payout', async () => {
    reply('POST /v1/payouts', { 'v1/payout': { id: 55, status: 'pending' } }, 201);
    reply('PUT /v1/payouts/start', { 'v1/payouts': [{ id: 55, status: 'scheduled' }] });

    const payout: PayoutRequest = {
      reference: 'po-1',
      amount: 50000,
      currency: 'XOF',
      country: 'BJ',
      channel: 'mobile_money',
      recipient: { phone: '+22997000000', network: 'MTN_BENIN', name: 'Jean Dupont' },
      callbackUrl: 'https://orchi.local/hooks/fedapay',
    };

    const result = await fedapayProvider.createPayout(payout, fedapayCtx);

    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      'POST /v1/payouts',
      'PUT /v1/payouts/start',
    ]);
    expect(result.providerReference).toBe('55');
    expect(result.status).toBe('pending');
  });

  it('signale un etat INDETERMINE si le declenchement echoue', async () => {
    // Le payout existe chez FedaPay mais dort : ni succes, ni echec franc.
    // Le classer `failed` autoriserait un second virement.
    reply('POST /v1/payouts', { 'v1/payout': { id: 56, status: 'pending' } }, 201);
    reply('PUT /v1/payouts/start', { message: 'refus' }, 422);

    const error = (await fedapayProvider
      .createPayout(
        {
          reference: 'po-2',
          amount: 50000,
          currency: 'XOF',
          country: 'BJ',
          channel: 'mobile_money',
          recipient: { phone: '+22997000000', network: 'MTN_BENIN' },
          callbackUrl: 'https://orchi.local/hooks/fedapay',
        },
        fedapayCtx,
      )
      .catch((e) => e)) as ProviderError;

    expect(error.code).toBe('indeterminate');
    expect(error.outcome).toBe('unknown');
    expect(error.failoverAllowed).toBe(false);
  });
});

describe('FedaPay — webhooks', () => {
  function signed(payload: object, secret = 'wh_secret', at = Math.floor(Date.now() / 1000)) {
    const body = JSON.stringify(payload);
    const signature = createHmac('sha256', secret).update(`${at}.${body}`).digest('hex');
    return { rawBody: body, headers: { 'x-fedapay-signature': `t=${at},s=${signature}` } };
  }

  it('accepte un evenement correctement signe', () => {
    const verdict = fedapayProvider.verifyWebhook(
      signed({ id: 'evt_1', name: 'transaction.approved', entity: { id: 4242, status: 'approved' } }),
      fedapayCtx,
    );
    expect(verdict.valid).toBe(true);
    if (verdict.valid) {
      expect(verdict.providerReference).toBe('4242');
      expect(verdict.status).toBe('succeeded');
      expect(verdict.kind).toBe('payin');
    }
  });

  it('rejette une signature calculee avec un autre secret', () => {
    const verdict = fedapayProvider.verifyWebhook(
      signed({ id: 'e', name: 'transaction.approved', entity: { id: 1 } }, 'mauvais'),
      fedapayCtx,
    );
    expect(verdict.valid).toBe(false);
  });

  it('rejette un webhook rejoue plus de cinq minutes apres', () => {
    const old = Math.floor(Date.now() / 1000) - 3600;
    const verdict = fedapayProvider.verifyWebhook(
      signed({ id: 'e', name: 'transaction.approved', entity: { id: 1 } }, 'wh_secret', old),
      fedapayCtx,
    );
    expect(verdict).toEqual({ valid: false, reason: 'Signature expiree (plus de 5 minutes).' });
  });

  it('distingue un evenement de decaissement', () => {
    const verdict = fedapayProvider.verifyWebhook(
      signed({ id: 'e', name: 'payout.sent', entity: { id: 55, status: 'sent' } }),
      fedapayCtx,
    );
    expect(verdict.valid).toBe(true);
    if (verdict.valid) {
      expect(verdict.kind).toBe('payout');
      expect(verdict.status).toBe('succeeded');
    }
  });
});

/* -------------------------------------------------------------------------- */

const cinetpayCtx: ProviderContext = {
  merchantId: 'mch_1',
  environment: 'test',
  credentials: {
    apikey: 'apikey_xxx',
    site_id: '5872',
    transfer_login: 'login',
    transfer_password: 'motdepasse',
  },
};

describe('CinetPay — encaissement', () => {
  it('initialise le paiement et renvoie le guichet hebergé', async () => {
    reply('POST /v2/payment', {
      code: '201',
      message: 'CREATED',
      data: { payment_token: 'tok', payment_url: 'https://checkout.cinetpay/tok' },
    });

    const result = await cinetpayProvider.createCharge(charge, cinetpayCtx);

    const sent = JSON.parse(called('POST', '/v2/payment')!.body);
    expect(sent.apikey).toBe('apikey_xxx');
    expect(sent.site_id).toBe('5872');
    // Notre reference devient leur transaction_id : c'est ce qui rend l'appel
    // idempotent de leur cote et interrogeable ensuite.
    expect(sent.transaction_id).toBe('cmd-1');
    expect(result.providerReference).toBe('cmd-1');
    expect(result.action).toEqual({ type: 'redirect', url: 'https://checkout.cinetpay/tok' });
  });

  it('refuse un montant non multiple de 5 en franc CFA, sans appeler l’API', async () => {
    const error = (await cinetpayProvider
      .createCharge({ ...charge, amount: 15003 }, cinetpayCtx)
      .catch((e) => e)) as ProviderError;
    expect(error.code).toBe('invalid_request');
    expect(calls).toHaveLength(0);
  });

  it('classe un refus 6xx en requete invalide, pas en panne', async () => {
    // Basculer vers un autre agregateur ne servirait a rien : il refuserait
    // pour la meme raison.
    reply('POST /v2/payment', { code: '609', message: 'AUTH_NOT_FOUND' });
    const error = (await cinetpayProvider.createCharge(charge, cinetpayCtx).catch((e) => e)) as ProviderError;
    expect(error.code).toBe('invalid_request');
    expect(error.failoverAllowed).toBe(false);
    expect(error.providerCode).toBe('609');
  });

  it('interroge le statut par notre transaction_id', async () => {
    reply('POST /v2/payment/check', { code: '00', message: 'SUCCES', data: { status: 'ACCEPTED' } });
    const result = await cinetpayProvider.getCharge('cmd-1', cinetpayCtx);

    const sent = JSON.parse(called('POST', '/v2/payment/check')!.body);
    expect(sent.transaction_id).toBe('cmd-1');
    expect(result.status).toBe('succeeded');
  });

  it('lit le code 662 comme une attente, pas comme une erreur', async () => {
    reply('POST /v2/payment/check', { code: '662', message: 'WAITING_CUSTOMER_TO_VALIDATE' });
    const result = await cinetpayProvider.getCharge('cmd-1', cinetpayCtx);
    expect(result.status).toBe('awaiting_customer');
  });

  it('traduit un refus en echec', async () => {
    reply('POST /v2/payment/check', { code: '00', data: { status: 'REFUSED' } });
    const result = await cinetpayProvider.getCharge('cmd-1', cinetpayCtx);
    expect(result.status).toBe('failed');
  });

  it('traduit un statut inconnu en INCONNU', async () => {
    reply('POST /v2/payment/check', { code: '00', data: { status: 'ETAT_INEDIT' } });
    const result = await cinetpayProvider.getCharge('cmd-1', cinetpayCtx);
    expect(result.status).toBe('unknown');
  });
});

describe('CinetPay — decaissement', () => {
  const payout: PayoutRequest = {
    reference: 'po-1',
    amount: 50000,
    currency: 'XOF',
    country: 'BJ',
    channel: 'mobile_money',
    recipient: { phone: '+22997000000', network: 'MTN_BENIN', name: 'Jean Dupont' },
    callbackUrl: 'https://orchi.local/hooks/cinetpay',
  };

  it('obtient un jeton puis envoie le transfert', async () => {
    reply('POST /t1/auth/login', { code: 0, data: { token: 'tok_transfer' } });
    reply('POST /t1/transfer/money/send/contact', {
      code: 0,
      message: 'OPERATION_SUCCES',
      data: [{ transaction_id: 'ctp_9', client_transaction_id: 'po-1', treatment_status: 'PENDING' }],
    });

    const result = await cinetpayProvider.createPayout(payout, cinetpayCtx);

    expect(calls.map((c) => c.path)).toEqual([
      '/t1/auth/login',
      '/t1/transfer/money/send/contact',
    ]);
    expect(result.providerReference).toBe('ctp_9');
    expect(result.status).toBe('pending');
  });

  it('separe l’indicatif du numero, comme l’exige leur API', async () => {
    reply('POST /t1/auth/login', { code: 0, data: { token: 'tok' } });
    reply('POST /t1/transfer/money/send/contact', { code: 0, data: [{ transaction_id: 'x' }] });

    await cinetpayProvider.createPayout(payout, cinetpayCtx);
    const sent = new URLSearchParams(called('POST', '/t1/transfer/money/send/contact')!.body);
    const data = JSON.parse(sent.get('data')!)[0];
    expect(data.prefix).toBe('229');
    expect(data.phone).toBe('97000000');
    expect(data.client_transaction_id).toBe('po-1');
  });

  it('reutilise le jeton entre deux decaissements', async () => {
    reply('POST /t1/auth/login', { code: 0, data: { token: 'tok' } });
    reply('POST /t1/transfer/money/send/contact', { code: 0, data: [{ transaction_id: 'x' }] });

    await cinetpayProvider.createPayout(payout, cinetpayCtx);
    await cinetpayProvider.createPayout({ ...payout, reference: 'po-2' }, cinetpayCtx);

    // Le jeton ne vit que 5 minutes : le redemander a chaque virement
    // doublerait la latence et le risque d'echec.
    expect(calls.filter((c) => c.path === '/t1/auth/login')).toHaveLength(1);
  });

  it('exige les credentials de transfert, distincts de ceux d’encaissement', async () => {
    const error = (await cinetpayProvider
      .createPayout(payout, { ...cinetpayCtx, credentials: { apikey: 'a', site_id: 'b' } })
      .catch((e) => e)) as ProviderError;
    expect(error.code).toBe('authentication');
  });

  it('signale une reponse sans detail comme etat INCONNU', async () => {
    reply('POST /t1/auth/login', { code: 0, data: { token: 'tok' } });
    reply('POST /t1/transfer/money/send/contact', { code: 0, message: 'ok' });

    const error = (await cinetpayProvider.createPayout(payout, cinetpayCtx).catch((e) => e)) as ProviderError;
    expect(error.code).toBe('malformed_response');
    expect(error.outcome).toBe('unknown');
  });
});

describe('CinetPay — la notification n’est qu’un signal', () => {
  it('extrait la transaction et demande une verification, sans conclure', () => {
    const verdict = cinetpayProvider.verifyWebhook(
      { rawBody: JSON.stringify({ cpm_trans_id: 'cmd-1' }), headers: {} },
      cinetpayCtx,
    );

    expect(verdict.valid).toBe(true);
    if (verdict.valid) {
      expect(verdict.providerReference).toBe('cmd-1');
      // Volontairement `pending` : un attaquant qui forgerait une notification
      // ne peut pas faire passer un paiement en SUCCEEDED. Au pire il declenche
      // une verification inutile.
      expect(verdict.status).toBe('pending');
    }
  });

  it('accepte aussi la forme formulaire', () => {
    const verdict = cinetpayProvider.verifyWebhook(
      { rawBody: 'cpm_trans_id=cmd-2&cpm_site_id=5872', headers: {} },
      cinetpayCtx,
    );
    expect(verdict.valid).toBe(true);
    if (verdict.valid) expect(verdict.providerReference).toBe('cmd-2');
  });

  it('rejette une notification sans identifiant de transaction', () => {
    const verdict = cinetpayProvider.verifyWebhook({ rawBody: '{}', headers: {} }, cinetpayCtx);
    expect(verdict).toEqual({ valid: false, reason: 'cpm_trans_id absent.' });
  });
});
