import { createHmac } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { ProviderError } from '../src/providers/errors.js';
import { formatMsisdn, yabetooProvider } from '../src/providers/yabetoo.js';
import type { ChargeRequest, PayoutRequest, ProviderContext } from '../src/providers/types.js';

/**
 * Tests de contrat de l'adaptateur Yabetoo.
 *
 * Les reponses ci-dessous ne sont PAS imaginees : ce sont celles que le sandbox
 * Yabetoo a renvoyees le 10/10/2026, reprises telles quelles (identifiants et
 * montants compris). C'est ce qui distingue ce fichier de celui de GeniusPay,
 * ecrit avant tout appel reel : ici, un test qui echoue signale un ecart avec
 * ce que l'agregateur fait VRAIMENT.
 *
 * Ce qu'ils ne prouvent pas : la signature des webhooks (aucun webhook recu) et
 * tout echec d'encaissement (le sandbox reussit toujours).
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

function reply(key: string, body: unknown, status = 200) {
  responses.set(key, { status, body });
}

function called(method: string, path: string): Recorded | undefined {
  return calls.find((c) => c.method === method && c.path === path);
}

function sent(method: string, path: string): Record<string, unknown> {
  return JSON.parse(called(method, path)!.body) as Record<string, unknown>;
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

      const planned = responses.get(`${req.method} ${path}`);
      if (!planned) {
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ status: 404, code: 'E_NO_STUB' }));
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
  process.env.YABETOO_BASE_URL = `${base}/yb`;
});

afterAll(async () => {
  delete process.env.YABETOO_BASE_URL;
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
  calls = [];
  responses = new Map();
});

const ctx: ProviderContext = {
  merchantId: 'mch_1',
  environment: 'test',
  credentials: { secret_key: 'sk_test_abc', webhook_secret: 'whsec_test' },
};

function charge(over: Partial<ChargeRequest> = {}): ChargeRequest {
  return {
    reference: 'att_1',
    amount: 1500,
    currency: 'XAF',
    country: 'CG',
    channel: 'mobile_money',
    network: 'MTN_CG',
    customer: { phone: '064088868', name: 'Test Afripaie', email: 'client@exemple.test' },
    callbackUrl: 'https://afripaie.local/hooks/yabetoo',
    ...over,
  };
}

function payout(over: Partial<PayoutRequest> = {}): PayoutRequest {
  return {
    reference: 'po_att_1',
    amount: 500,
    currency: 'XAF',
    country: 'CG',
    channel: 'mobile_money',
    recipient: { phone: '+242064088868', network: 'MTN_CG', name: 'Jean Dupont' },
    callbackUrl: 'https://afripaie.local/hooks/yabetoo',
    ...over,
  };
}

/* --- Reponses reelles du sandbox, 10/10/2026 ------------------------------ */

const INTENT_CREATED = {
  amount: 1500,
  currency: 'xaf',
  liveMode: false,
  label: 'payment_intent',
  id: 'pi_byHK51gdrQCJ0hZ3KGIKLqj5JcTSH6S3IC3J',
  // camelCase, et AUCUN `status` : ce que le SDK PHP ne laissait pas deviner.
  clientSecret: 'pi_byHK51gdrQCJ0hZ3KGIKLqj5JcTSH6S3IC3J_secret_24nLmZ77Dc',
};

const CHARGE_SUCCEEDED = {
  id: 'ch_bJPofKMx01iGpf7YFCmiiVelBRndf8NYiUFz',
  object: 'charge',
  intentId: 'pi_byHK51gdrQCJ0hZ3KGIKLqj5JcTSH6S3IC3J',
  amount: 1500,
  status: 'succeeded',
  failureCode: null,
  failureMessage: null,
};

const INTENT_SUCCEEDED = {
  id: 'pi_byHK51gdrQCJ0hZ3KGIKLqj5JcTSH6S3IC3J',
  object: 'intent',
  amount: 1500,
  // Inutilisable : vaut 0 sur un intent pourtant `succeeded`.
  receivedAmount: 0,
  status: 'succeeded',
  // Les frais : decimaux, et seulement a la relecture.
  walletTransaction: { amountFee: 77.5, amountCaptured: 1422.5, operatorFee: 45 },
};

const DISBURSEMENT_SUCCEEDED = {
  id: 'dis_LvDrjJSw0iEpFrQixJpLeMfdy1BPXO9hTKkD',
  status: 'succeeded',
  // 500 demandes, 492.5 annonces.
  amount: 492.5,
  currency: 'XAF',
  failureMessage: null,
};

const P = '/yb/v1/payment-intents';

function stubHappyCharge() {
  reply(`POST ${P}`, INTENT_CREATED, 201);
  reply(`POST ${P}/${INTENT_CREATED.id}/confirm`, CHARGE_SUCCEEDED);
  reply(`GET ${P}/${INTENT_CREATED.id}`, INTENT_SUCCEEDED);
}

/* -------------------------------------------------------------------------- */

describe('couverture', () => {
  it('dessert le Congo-Brazzaville en encaissement ET en decaissement', () => {
    expect(yabetooProvider.supports('CG', 'mobile_money', 'payin')).toBe(true);
    expect(yabetooProvider.supports('CG', 'mobile_money', 'payout')).toBe(true);
    expect(yabetooProvider.supports('cg', 'mobile_money', 'payin')).toBe(true);
  });

  it('ne dessert ni les autres pays ni la carte', () => {
    for (const iso of ['CI', 'CM', 'GA', 'CD', 'SN']) {
      expect(yabetooProvider.supports(iso, 'mobile_money', 'payin'), iso).toBe(false);
    }
    expect(yabetooProvider.supports('CG', 'card', 'payin')).toBe(false);
    expect(yabetooProvider.supports('CG', 'bank_transfer', 'payout')).toBe(false);
  });
});

/* -------------------------------------------------------------------------- */

describe('la cle fixe l’environnement', () => {
  it('refuse une cle de test sur un marchand reel, avant tout appel', async () => {
    // Le sandbox reussit TOUJOURS. Une cle sk_test_ branchee sur un marchand live
    // enregistrerait de vraies ventes comme payees sans qu'un franc ne bouge.
    const error = (await yabetooProvider
      .createCharge(charge(), { ...ctx, environment: 'live' })
      .catch((e) => e)) as ProviderError;

    expect(error.code).toBe('authentication');
    expect(error.message).toContain('sandbox reussit toujours');
    expect(calls).toHaveLength(0);
  });

  it('refuse une cle de production en environnement de test', async () => {
    const error = (await yabetooProvider
      .createCharge(charge(), {
        ...ctx,
        credentials: { secret_key: 'sk_live_abc', webhook_secret: 'w' },
      })
      .catch((e) => e)) as ProviderError;

    expect(error.code).toBe('authentication');
    expect(calls).toHaveLength(0);
  });

  it('refuse l’appel sans cle', async () => {
    const error = (await yabetooProvider
      .createCharge(charge(), { ...ctx, credentials: {} })
      .catch((e) => e)) as ProviderError;
    expect(error.code).toBe('authentication');
    expect(calls).toHaveLength(0);
  });
});

/* -------------------------------------------------------------------------- */

describe('encaissement', () => {
  it('suit le flux reel : intent, confirmation, relecture des frais', async () => {
    stubHappyCharge();

    const result = await yabetooProvider.createCharge(charge(), ctx);

    // Le deroule : creation, confirmation, puis relecture pour les frais.
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      `POST ${P}`,
      `POST ${P}/${INTENT_CREATED.id}/confirm`,
      `GET ${P}/${INTENT_CREATED.id}`,
    ]);

    // La reference est celle de l'INTENT : c'est elle que les webhooks portent.
    expect(result.providerReference).toBe(INTENT_CREATED.id);
    expect(result.status).toBe('succeeded');
    expect(result.action).toEqual({ type: 'none' });
  });

  it('envoie les bons en-tetes et le bon corps a la creation', async () => {
    stubHappyCharge();
    await yabetooProvider.createCharge(charge({ description: 'Billet concert' }), ctx);

    const created = called('POST', P)!;
    expect(created.headers.authorization).toBe('Bearer sk_test_abc');
    // La reference de TENTATIVE sert de cle d'idempotence : verifie contre le
    // sandbox, la meme cle renvoie le meme intent.
    expect(created.headers['idempotency-key']).toBe('att_1');

    const body = sent('POST', P);
    expect(body).toMatchObject({ amount: 1500, currency: 'XAF', description: 'Billet concert' });
    expect(body.metadata).toEqual({ afripaie_reference: 'att_1' });
  });

  it('confirme avec le clientSecret recu en camelCase, et le numero normalise', async () => {
    stubHappyCharge();
    await yabetooProvider.createCharge(charge(), ctx);

    const body = sent('POST', `${P}/${INTENT_CREATED.id}/confirm`);
    expect(body.client_secret).toBe(INTENT_CREATED.clientSecret);
    expect(body.payment_method_data).toEqual({
      type: 'momo',
      momo: { country: 'cg', msisdn: '+242064088868', operator_name: 'mtn' },
    });
    expect(body.first_name).toBe('Test');
    expect(body.last_name).toBe('Afripaie');
    expect(body.receipt_email).toBe('client@exemple.test');
  });

  it('arrondit les frais decimaux au demi-superieur', async () => {
    // 77,5 XAF : XAF n'a pas de subdivision, et le demi est arrondi vers le haut
    // comme partout ailleurs dans le moteur.
    stubHappyCharge();
    const result = await yabetooProvider.createCharge(charge(), ctx);
    expect(result.providerFeeAmount).toBe(78);
  });

  it('ne pretend pas connaitre des frais que l’agregateur ne communique pas', async () => {
    reply(`POST ${P}`, INTENT_CREATED, 201);
    reply(`POST ${P}/${INTENT_CREATED.id}/confirm`, CHARGE_SUCCEEDED);
    reply(`GET ${P}/${INTENT_CREATED.id}`, { ...INTENT_SUCCEEDED, walletTransaction: undefined });

    const result = await yabetooProvider.createCharge(charge(), ctx);
    expect(result.status).toBe('succeeded');
    expect(result.providerFeeAmount).toBeUndefined();
  });

  it('reussit meme si la relecture des frais echoue', async () => {
    // Les frais sont une information, pas une condition du succes.
    reply(`POST ${P}`, INTENT_CREATED, 201);
    reply(`POST ${P}/${INTENT_CREATED.id}/confirm`, CHARGE_SUCCEEDED);
    reply(`GET ${P}/${INTENT_CREATED.id}`, { status: 500 }, 500);

    const result = await yabetooProvider.createCharge(charge(), ctx);
    expect(result.status).toBe('succeeded');
    expect(result.providerFeeAmount).toBeUndefined();
  });

  it('annonce un push quand la confirmation reste en attente', async () => {
    // Le sandbox repond `succeeded` des la confirmation ; un vrai push mobile
    // money, lui, attend le code PIN du client.
    reply(`POST ${P}`, INTENT_CREATED, 201);
    reply(`POST ${P}/${INTENT_CREATED.id}/confirm`, { ...CHARGE_SUCCEEDED, status: 'pending' });

    const result = await yabetooProvider.createCharge(charge(), ctx);

    expect(result.status).toBe('pending');
    expect(result.action.type).toBe('ussd_push');
    // Pas de relecture des frais : rien n'est encore encaisse.
    expect(called('GET', `${P}/${INTENT_CREATED.id}`)).toBeUndefined();
  });
});

describe('encaissement — ce qui est refuse avant tout appel', () => {
  it.each([
    ['une autre devise', { currency: 'XOF' }],
    ['un montant sous le minimum de 100 XAF', { amount: 99 }],
    ['un reseau absent', { network: undefined }],
    ['un reseau inconnu', { network: 'ORANGE_CG' }],
    ['un numero a huit chiffres', { customer: { phone: '06408886' } }],
    ['un numero absent', { customer: {} }],
  ])('refuse %s sans rien envoyer', async (_nom, over) => {
    const error = (await yabetooProvider
      .createCharge(charge(over as Partial<ChargeRequest>), ctx)
      .catch((e) => e)) as ProviderError;

    expect(error.code).toBe('invalid_request');
    expect(calls).toHaveLength(0);
  });
});

describe('encaissement — les echecs', () => {
  it('traite un echec a la CREATION de l’intent comme un echec franc', async () => {
    // Un intent non confirme n'est qu'une intention : aucun fonds n'a pu bouger.
    // Un 5xx ici autorise donc le failover, contrairement a un 5xx sur un debit.
    reply(`POST ${P}`, { status: 500 }, 500);

    const error = (await yabetooProvider.createCharge(charge(), ctx).catch((e) => e)) as ProviderError;

    expect(error.outcome).toBe('failed');
    expect(error.failoverAllowed).toBe(true);
    expect(called('POST', `${P}/${INTENT_CREATED.id}/confirm`)).toBeUndefined();
  });

  it('rend un resultat INCONNU, avec sa reference, quand la confirmation echoue en 5xx', async () => {
    // C'est le cas qui justifie la forme de l'adaptateur. La confirmation est ce
    // qui envoie le push : un 5xx ne dit pas si le client a ete debite. Lever une
    // exception perdrait l'identifiant de l'intent, et le balayeur ne pourrait
    // plus jamais trancher.
    reply(`POST ${P}`, INTENT_CREATED, 201);
    reply(`POST ${P}/${INTENT_CREATED.id}/confirm`, { status: 500 }, 500);

    const result = await yabetooProvider.createCharge(charge(), ctx);

    expect(result.status).toBe('unknown');
    expect(result.providerReference).toBe(INTENT_CREATED.id);
  });

  it('lit l’etat reel quand l’intent est deja confirme', async () => {
    // 422 E_INVALID_STATE_TRANSITION : le push est DEJA parti. Annoncer un
    // echec serait faux.
    reply(`POST ${P}`, INTENT_CREATED, 201);
    reply(
      `POST ${P}/${INTENT_CREATED.id}/confirm`,
      { status: 422, code: 'E_INVALID_STATE_TRANSITION', message: 'Invalid state transition' },
      422,
    );
    reply(`GET ${P}/${INTENT_CREATED.id}`, INTENT_SUCCEEDED);

    const result = await yabetooProvider.createCharge(charge(), ctx);

    expect(result.status).toBe('succeeded');
    expect(result.providerReference).toBe(INTENT_CREATED.id);
  });

  it('remonte le motif d’un refus 422 de l’agregateur', async () => {
    reply(
      `POST ${P}`,
      {
        status: 422,
        code: 'E_MINIMUM_AMOUNT',
        message: 'Minimum Amount Error',
        detail: 'The min amount for XAF is 100',
      },
      422,
    );

    const error = (await yabetooProvider.createCharge(charge(), ctx).catch((e) => e)) as ProviderError;

    expect(error.code).toBe('invalid_request');
    expect(error.providerCode).toBe('E_MINIMUM_AMOUNT');
    expect(error.message).toContain('min amount for XAF is 100');
  });
});

/* -------------------------------------------------------------------------- */

describe('relecture d’un encaissement', () => {
  it('lit le succes et les frais', async () => {
    reply(`GET ${P}/${INTENT_CREATED.id}`, INTENT_SUCCEEDED);

    const result = await yabetooProvider.getCharge(INTENT_CREATED.id, ctx);

    expect(result.status).toBe('succeeded');
    expect(result.providerFeeAmount).toBe(78);
  });

  it('lit le motif d’un echec sur la premiere charge', async () => {
    reply(`GET ${P}/pi_failed`, {
      id: 'pi_failed',
      status: 'failed',
      charges: [{ failureCode: 'PAYER_NOT_FOUND', failureMessage: 'Payer not found' }],
    });

    const result = await yabetooProvider.getCharge('pi_failed', ctx);

    expect(result.status).toBe('failed');
    expect(result.providerCode).toBe('PAYER_NOT_FOUND');
    expect(result.providerMessage).toBe('Payer not found');
  });

  it('traduit un statut inconnu en `unknown`, jamais en echec', async () => {
    reply(`GET ${P}/pi_x`, { id: 'pi_x', status: 'quelque_chose_de_nouveau' });
    const result = await yabetooProvider.getCharge('pi_x', ctx);
    expect(result.status).toBe('unknown');
  });
});

/* -------------------------------------------------------------------------- */

describe('decaissement', () => {
  const D = '/yb/v1/disbursements';

  it('envoie le bon corps, avec une cle d’idempotence', async () => {
    reply(`POST ${D}`, DISBURSEMENT_SUCCEEDED);

    await yabetooProvider.createPayout(payout(), ctx);

    const req = called('POST', D)!;
    // Verifie contre le sandbox : la meme cle renvoie le meme decaissement, alors
    // que deux appels sans cle en creent deux. Deuxieme ligne de defense contre
    // le double paiement.
    expect(req.headers['idempotency-key']).toBe('po_att_1');
    expect(req.headers.authorization).toBe('Bearer sk_test_abc');

    const body = sent('POST', D);
    expect(body).toMatchObject({ amount: 500, currency: 'XAF', first_name: 'Jean', last_name: 'Dupont' });
    expect(body.payment_method_data).toEqual({
      type: 'momo',
      momo: { country: 'CG', msisdn: '+242064088868', operator_name: 'mtn' },
    });
  });

  it('rend la reference du decaissement et son statut', async () => {
    reply(`POST ${D}`, DISBURSEMENT_SUCCEEDED);

    const result = await yabetooProvider.createPayout(payout(), ctx);

    expect(result.providerReference).toBe(DISBURSEMENT_SUCCEEDED.id);
    expect(result.status).toBe('succeeded');
  });

  it('declare des frais NULS, explicitement : le moteur n’en invente pas', async () => {
    // Yabetoo preleve 1,5 % sur la somme versee ; le portefeuille, lui, est debite
    // du montant demande. Laisser `providerFeeAmount` absent n'est pas neutre :
    // le moteur retombe sur l'estimation du catalogue et ecrit des frais jamais
    // payes (constate en bout en bout : 52 pour 1 000, soit 1 052 debites d'un
    // portefeuille qui n'a perdu que 1 000).
    reply(`POST ${D}`, DISBURSEMENT_SUCCEEDED);

    const result = await yabetooProvider.createPayout(payout(), ctx);

    expect(result.providerFeeAmount).toBe(0);
    expect(result.providerMessage).toBe('Yabetoo annonce 492.5 pour 500 demandes.');
  });

  it('lit un decaissement REFUSE dans le corps : HTTP 200, status failed', async () => {
    // Reponse reelle du sandbox pour un decaissement Airtel. Le refus ne passe
    // PAS par le code HTTP : un adaptateur qui ne lirait que celui-ci
    // enregistrerait un versement reussi.
    reply(`POST ${D}`, {
      id: 'dis_Hc7lQ8SHqSByxgc0jaUwP8gXS17zLQIuoqNJ',
      status: 'failed',
      amount: 98.5,
      currency: 'XAF',
      transactionId: null,
      failureMessage: 'Airtel transfer is only available in live mode',
    });

    const result = await yabetooProvider.createPayout(
      payout({ recipient: { phone: '+242054000000', network: 'AIRTEL_CG', name: 'Marie Ngoma' } }),
      ctx,
    );

    expect(result.status).toBe('failed');
    expect(result.providerMessage).toBe('Airtel transfer is only available in live mode');
    expect(result.providerReference).toBe('dis_Hc7lQ8SHqSByxgc0jaUwP8gXS17zLQIuoqNJ');
    expect(sent('POST', D).payment_method_data).toMatchObject({ momo: { operator_name: 'airtel' } });
  });

  it('classe un solde insuffisant comme un REFUS explicite', async () => {
    reply(
      `POST ${D}`,
      {
        status: 422,
        code: 'E_INSUFFICIENT_BALANCE',
        message: 'Insufficient Balance Error',
        detail: 'Insufficient balance on wallet wa_X: current 422.5, required 50000000',
      },
      422,
    );

    const error = (await yabetooProvider.createPayout(payout(), ctx).catch((e) => e)) as ProviderError;

    expect(error.code).toBe('declined');
    expect(error.outcome).toBe('failed');
    expect(error.providerCode).toBe('E_INSUFFICIENT_BALANCE');
    // Le detail de l'agregateur contient le solde du portefeuille : il n'est pas
    // recopie dans le message expose.
    expect(error.message).not.toContain('422.5');
  });

  it('ne traite JAMAIS un 5xx comme un echec', async () => {
    // La lecon de l'integration PHP : un 5xx traite comme un refus definitif a
    // fait payer deux fois des organisateurs. Ici l'issue est inconnue, et le
    // moteur interdit toute nouvelle tentative.
    reply(`POST ${D}`, { status: 500 }, 500);

    const error = (await yabetooProvider.createPayout(payout(), ctx).catch((e) => e)) as ProviderError;

    expect(error.outcome).toBe('unknown');
    expect(error.failoverAllowed).toBe(false);
  });

  it('refuse un operateur non pris en charge sans rien envoyer', async () => {
    const error = (await yabetooProvider
      .createPayout(payout({ recipient: { phone: '+242064088868', network: 'ORANGE_CG' } }), ctx)
      .catch((e) => e)) as ProviderError;

    expect(error.code).toBe('invalid_request');
    expect(calls).toHaveLength(0);
  });

  it('relit un decaissement', async () => {
    reply(`GET ${D}/${DISBURSEMENT_SUCCEEDED.id}`, DISBURSEMENT_SUCCEEDED);
    const result = await yabetooProvider.getPayout(DISBURSEMENT_SUCCEEDED.id, ctx);
    expect(result.status).toBe('succeeded');
  });
});

/* -------------------------------------------------------------------------- */

describe('webhooks', () => {
  const secret = 'whsec_test';

  function signed(payload: unknown, over: { secret?: string; timestamp?: number; prefix?: boolean } = {}) {
    const rawBody = JSON.stringify(payload);
    const timestamp = String(over.timestamp ?? Math.floor(Date.now() / 1000));
    const hex = createHmac('sha256', over.secret ?? secret).update(`${timestamp}.${rawBody}`).digest('hex');
    return {
      rawBody,
      headers: {
        'x-yabetoo-webhook-signature': over.prefix === false ? hex : `v1=${hex}`,
        'x-yabetoo-webhook-timestamp': timestamp,
      },
    };
  }

  const INTENT_COMPLETED = {
    id: 'evt_1',
    type: 'intent.completed',
    data: { charge: { intentId: 'pi_abc', status: 'succeeded' } },
  };

  it('accepte une signature valide et rattache l’evenement a l’intent', () => {
    const verdict = yabetooProvider.verifyWebhook(signed(INTENT_COMPLETED), ctx);

    expect(verdict).toMatchObject({
      valid: true,
      eventId: 'evt_1',
      kind: 'payin',
      providerReference: 'pi_abc',
      status: 'succeeded',
    });
  });

  it('accepte la signature sans le prefixe v1=', () => {
    const verdict = yabetooProvider.verifyWebhook(signed(INTENT_COMPLETED, { prefix: false }), ctx);
    expect(verdict.valid).toBe(true);
  });

  it('rattache un evenement de decaissement', () => {
    const verdict = yabetooProvider.verifyWebhook(
      signed({
        id: 'evt_2',
        type: 'disbursement.completed',
        data: { disbursement: { id: 'dis_abc', status: 'succeeded' } },
      }),
      ctx,
    );

    expect(verdict).toMatchObject({ valid: true, kind: 'payout', providerReference: 'dis_abc', status: 'succeeded' });
  });

  it('lit un echec avec son motif', () => {
    const verdict = yabetooProvider.verifyWebhook(
      signed({
        id: 'evt_3',
        type: 'intent.failed',
        data: { charge: { intentId: 'pi_abc', status: 'failed', failureCode: 'PAYER_NOT_FOUND' } },
      }),
      ctx,
    );

    expect(verdict).toMatchObject({ valid: true, status: 'failed', providerCode: 'PAYER_NOT_FOUND' });
  });

  it('se rabat sur le suffixe du type quand le statut est absent', () => {
    const verdict = yabetooProvider.verifyWebhook(
      signed({ id: 'evt_4', type: 'intent.completed', data: { intent: { id: 'pi_abc' } } }),
      ctx,
    );
    expect(verdict).toMatchObject({ valid: true, status: 'succeeded', providerReference: 'pi_abc' });
  });

  it('ne plante pas quand `data.object` est une simple chaine', () => {
    // Observe cote client : Yabetoo y met parfois le libelle du type. Sans garde,
    // cette chaine etait traitee comme un objet et l'evenement etait perdu.
    const verdict = yabetooProvider.verifyWebhook(
      signed({ id: 'evt_5', type: 'disbursement.completed', data: { object: 'disbursement', id: 'dis_zzz' } }),
      ctx,
    );
    expect(verdict.valid).toBe(true);
  });

  it('accepte, sans rattachement, un evenement etranger a nos tentatives', () => {
    // Les `withdraw.*` concernent des operations menees directement chez
    // Yabetoo. La signature est valide : le rejeter fausserait le journal.
    const verdict = yabetooProvider.verifyWebhook(
      signed({ id: 'evt_6', type: 'withdraw.completed', data: { withdraw: { id: 'wd_1' } } }),
      ctx,
    );
    expect(verdict.valid).toBe(true);
    if (verdict.valid) expect(verdict.kind).toBe('unknown');
  });

  it('rejette une signature falsifiee', () => {
    const verdict = yabetooProvider.verifyWebhook(signed(INTENT_COMPLETED, { secret: 'autre_secret' }), ctx);
    expect(verdict).toEqual({ valid: false, reason: 'Signature invalide.' });
  });

  it('rejette un evenement trop ancien', () => {
    // Sans cela, un evenement authentique capture une fois serait rejouable.
    const verdict = yabetooProvider.verifyWebhook(
      signed(INTENT_COMPLETED, { timestamp: Math.floor(Date.now() / 1000) - 3600 }),
      ctx,
    );
    expect(verdict).toEqual({ valid: false, reason: 'Signature expiree (plus de 5 minutes).' });
  });

  it('rejette un corps modifie apres signature', () => {
    const { headers } = signed(INTENT_COMPLETED);
    const verdict = yabetooProvider.verifyWebhook(
      { rawBody: JSON.stringify({ ...INTENT_COMPLETED, id: 'evt_pirate' }), headers },
      ctx,
    );
    expect(verdict.valid).toBe(false);
  });

  it('rejette tout si aucun secret n’est configure', () => {
    const verdict = yabetooProvider.verifyWebhook(signed(INTENT_COMPLETED), {
      ...ctx,
      credentials: { secret_key: 'sk_test_abc' },
    });
    expect(verdict.valid).toBe(false);
  });

  it('rejette l’absence de signature', () => {
    const verdict = yabetooProvider.verifyWebhook({ rawBody: '{}', headers: {} }, ctx);
    expect(verdict.valid).toBe(false);
  });
});

/* -------------------------------------------------------------------------- */

describe('formatMsisdn', () => {
  it.each([
    ['064088868', '+242064088868'],
    ['+242064088868', '+242064088868'],
    ['242064088868', '+242064088868'],
    ['+242 06 408 8868', '+242064088868'],
    ['06-408-8868', '+242064088868'],
  ])('normalise %s en %s', (entree, attendu) => {
    expect(formatMsisdn(entree)).toBe(attendu);
  });

  it.each([['06408886'], ['0640888681'], [''], ['abc']])(
    'refuse %s plutot que de deviner un chiffre',
    (entree) => {
      expect(formatMsisdn(entree)).toBeNull();
    },
  );
});
