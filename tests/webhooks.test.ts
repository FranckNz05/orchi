import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { generateApiKey } from '../src/core/crypto.js';
import { ID_PREFIX, newId } from '../src/core/ids.js';
import { prisma } from '../src/db/client.js';
import { connectProviderAccount } from '../src/modules/provider-accounts.js';
import { sweepStaleAttempts } from '../src/modules/reconciliation.js';
import {
  MAX_DELIVERY_ATTEMPTS,
  SIGNATURE_HEADER,
  deliverDueEvents,
  verifySignature,
} from '../src/modules/webhooks/outbound.js';
import { buildSandboxWebhook } from '../src/providers/sandbox.js';
import { buildServer } from '../src/server.js';

const WEBHOOK_SECRET = 'secret-webhooks-test';

let app: FastifyInstance;
let merchantId: string;
let key: string;
let hookToken: string;
let seeded = false;
let counter = 0;
const ref = (p: string) => `${p}-${Date.now()}-${(counter += 1)}`;

/* --- Serveur marchand simule ---------------------------------------------- */
let receiver: Server;
let receiverUrl: string;
let received: Array<{ body: string; headers: Record<string, string | string[] | undefined> }> = [];
/** Statut que le faux marchand renverra a la prochaine livraison. */
let receiverStatus = 200;

beforeAll(async () => {
  receiver = createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk as Buffer);
      received.push({ body: Buffer.concat(chunks).toString('utf8'), headers: req.headers });
      res.writeHead(receiverStatus);
      res.end('{}');
    })();
  });
  await new Promise<void>((resolve) => receiver.listen(0, '127.0.0.1', resolve));
  const address = receiver.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  receiverUrl = `http://127.0.0.1:${port}/hooks`;

  app = await buildServer();
  await app.ready();
  seeded = (await prisma.country.count()) > 0;

  merchantId = newId(ID_PREFIX.merchant);
  await prisma.merchant.create({
    data: {
      id: merchantId,
      name: 'Marchand webhooks',
      legalType: 'COMPANY',
      country: 'BJ',
      contactEmail: `${merchantId}@test.local`,
    },
  });

  const generated = generateApiKey('test');
  key = generated.secret;
  await prisma.apiKey.create({
    data: {
      id: newId(ID_PREFIX.apiKey),
      merchantId,
      label: 'test',
      prefix: generated.prefix,
      hash: generated.hash,
      environment: 'test',
      scopes: 'payments:read,payments:write,payouts:read,payouts:write,accounts:write',
    },
  });

  await connectProviderAccount({
    merchantId,
    providerId: 'sandbox',
    environment: 'test',
    credentials: { webhook_secret: WEBHOOK_SECRET },
    priority: 1,
  });

  const account = await prisma.providerAccount.findFirst({
    where: { merchantId, providerId: 'sandbox' },
  });
  hookToken = account!.webhookToken;
});

afterAll(async () => {
  await prisma.inboundWebhook.deleteMany({ where: { merchantId } });
  await prisma.outboundDelivery.deleteMany({ where: { merchantId } });
  await prisma.webhookEndpoint.deleteMany({ where: { merchantId } });
  await prisma.routingDecision.deleteMany({ where: { merchantId } });
  await prisma.idempotencyRecord.deleteMany({ where: { merchantId } });
  await prisma.ledgerEntry.deleteMany({ where: { journal: { merchantId } } });
  await prisma.ledgerJournal.deleteMany({ where: { merchantId } });
  await prisma.merchant.deleteMany({ where: { id: merchantId } });
  await app.close();
  await new Promise<void>((resolve) => receiver.close(() => resolve()));
  await prisma.$disconnect();
});

beforeEach(() => {
  received = [];
  receiverStatus = 200;
});

function post(url: string, body: unknown, idem?: string) {
  return app.inject({
    method: 'POST',
    url,
    headers: {
      authorization: `Bearer ${key}`,
      ...(idem ? { 'idempotency-key': idem } : {}),
    },
    payload: body as Record<string, unknown>,
  });
}

function get(url: string) {
  return app.inject({ method: 'GET', url, headers: { authorization: `Bearer ${key}` } });
}

function hook(rawBody: string, headers: Record<string, string> = {}, token = hookToken) {
  return app.inject({
    method: 'POST',
    url: `/v1/hooks/sandbox/${token}`,
    headers: { 'content-type': 'application/json', ...headers },
    payload: rawBody,
  });
}

async function createPayment(phone = '+22997000001') {
  const res = await post(
    '/v1/payments',
    {
      reference: ref('pay'),
      amount: 15000,
      currency: 'XOF',
      country: 'BJ',
      channel: 'mobile_money',
      customer: { phone },
    },
    ref('idem'),
  );
  return res.json();
}

/* -------------------------------------------------------------------------- */

describe('URL de callback', () => {
  it('porte un jeton non devinable, propre au compte agregateur', async () => {
    const res = await get('/v1/provider-accounts');
    const account = res.json().data[0];
    expect(account.callback_url).toContain('/v1/hooks/sandbox/');
    expect(account.callback_url).toContain(hookToken);
    // Sans ce jeton, une notification entrante ne dirait pas de quel marchand
    // elle provient, donc quelles credentials utiliser pour la verifier.
    expect(hookToken.length).toBeGreaterThan(20);
  });
});

describe('webhooks entrants', () => {
  it('rejette un jeton inconnu sans rien enregistrer', async () => {
    const before = await prisma.inboundWebhook.count();
    const res = await hook('{}', {}, 'jeton-inexistant-mais-assez-long');

    expect(res.statusCode).toBe(200);
    expect(res.json().outcome).toBe('REJECTED');
    // Sinon n'importe qui pourrait remplir la table.
    expect(await prisma.inboundWebhook.count()).toBe(before);
  });

  it('applique un evenement signe et fait aboutir le paiement', async () => {
    if (!seeded) return;
    const payment = await createPayment();
    const providerRef = payment.provider.reference;

    const signed = buildSandboxWebhook(providerRef, WEBHOOK_SECRET, { status: 'succeeded' });
    const res = await hook(signed.body, signed.headers);

    expect(res.json().outcome).toBe('APPLIED');
    const after = await get(`/v1/payments/${payment.id}`);
    expect(after.json().status).toBe('SUCCEEDED');
  });

  it('enregistre le corps brut et le verdict de signature', async () => {
    if (!seeded) return;
    const payment = await createPayment();
    const signed = buildSandboxWebhook(payment.provider.reference, WEBHOOK_SECRET, {
      status: 'succeeded',
      eventId: ref('evt'),
    });
    await hook(signed.body, signed.headers);

    const stored = await prisma.inboundWebhook.findFirst({
      where: { merchantId, providerReference: payment.provider.reference },
      orderBy: { createdAt: 'desc' },
    });
    expect(stored!.signatureValid).toBe(true);
    // Le corps brut est indispensable : la signature porte sur les octets recus.
    expect(stored!.rawBody).toBe(signed.body);
  });

  it('deduplique un evenement rejoue', async () => {
    if (!seeded) return;
    const payment = await createPayment();
    const signed = buildSandboxWebhook(payment.provider.reference, WEBHOOK_SECRET, {
      status: 'succeeded',
      eventId: ref('evt'),
    });

    const first = await hook(signed.body, signed.headers);
    const second = await hook(signed.body, signed.headers);

    expect(first.json().outcome).toBe('APPLIED');
    // Les agregateurs rejouent leurs notifications : c'est normal, pas une erreur.
    expect(second.json().outcome).toBe('DUPLICATE');
  });

  it('enregistre un webhook mal signe au lieu de l’ignorer', async () => {
    if (!seeded) return;
    const payment = await createPayment();
    const signed = buildSandboxWebhook(payment.provider.reference, WEBHOOK_SECRET);
    const before = await prisma.inboundWebhook.count({ where: { signatureValid: false } });

    const res = await hook(signed.body, { 'x-orchi-sandbox-signature': 'faux' });

    expect(res.json().outcome).toBe('REJECTED');
    // Une rafale de webhooks non signes est un signal de securite.
    const after = await prisma.inboundWebhook.count({ where: { signatureValid: false } });
    expect(after).toBe(before + 1);
  });

  it('ne fait jamais regresser un etat terminal', async () => {
    if (!seeded) return;
    const payment = await createPayment();
    const providerRef = payment.provider.reference;

    const success = buildSandboxWebhook(providerRef, WEBHOOK_SECRET, {
      status: 'succeeded',
      eventId: ref('evt-ok'),
    });
    await hook(success.body, success.headers);

    // Notification en retard annoncant un echec : elle doit etre ignoree.
    const late = buildSandboxWebhook(providerRef, WEBHOOK_SECRET, {
      status: 'failed',
      eventId: ref('evt-late'),
    });
    const res = await hook(late.body, late.headers);

    expect(res.json().outcome).toBe('IGNORED');
    const after = await get(`/v1/payments/${payment.id}`);
    expect(after.json().status).toBe('SUCCEEDED');
  });

  it('repond 200 meme sur rejet, pour ne pas declencher de rafale de reprises', async () => {
    const res = await hook('pas du json', { 'x-orchi-sandbox-signature': 'x' });
    expect(res.statusCode).toBe(200);
    expect(res.json().received).toBe(true);
  });
});

/* -------------------------------------------------------------------------- */

describe('webhooks sortants', () => {
  async function createEndpoint() {
    const res = await post('/v1/webhook-endpoints', { url: receiverUrl, events: ['*'] });
    return res.json();
  }

  it('ne montre le secret de signature qu’a la creation', async () => {
    const endpoint = await createEndpoint();
    expect(endpoint.secret).toMatch(/^whsec_/);

    const list = await get('/v1/webhook-endpoints');
    const stored = list.json().data.find((e: { id: string }) => e.id === endpoint.id);
    expect(stored.secret).toBeUndefined();

    await app.inject({
      method: 'DELETE',
      url: `/v1/webhook-endpoints/${endpoint.id}`,
      headers: { authorization: `Bearer ${key}` },
    });
  });

  it('livre un evenement signe et verifiable', async () => {
    if (!seeded) return;
    const endpoint = await createEndpoint();

    const payment = await createPayment('+22997000000');
    await get(`/v1/payments/${payment.id}`); // fait aboutir le paiement

    const outcome = await deliverDueEvents();
    expect(outcome.delivered).toBeGreaterThanOrEqual(1);
    expect(received).toHaveLength(1);

    const signature = received[0]!.headers[SIGNATURE_HEADER] as string;
    expect(verifySignature(received[0]!.body, signature, endpoint.secret)).toBe(true);

    const event = JSON.parse(received[0]!.body);
    expect(event.type).toBe('payment.succeeded');
    // Etat COMPLET de la ressource : l'ordre de livraison n'etant pas garanti,
    // un delta serait ininterpretable.
    expect(event.data.id).toBe(payment.id);
    expect(event.data.status).toBe('SUCCEEDED');

    await app.inject({
      method: 'DELETE',
      url: `/v1/webhook-endpoints/${endpoint.id}`,
      headers: { authorization: `Bearer ${key}` },
    });
  });

  it('rejette une signature calculee avec un autre secret', () => {
    expect(verifySignature('{}', 't=1,v1=abc', 'whsec_autre')).toBe(false);
  });

  it('refuse une signature trop ancienne', () => {
    const old = Math.floor(Date.now() / 1000) - 3600;
    expect(verifySignature('{}', `t=${old},v1=peu importe`, 'whsec_x')).toBe(false);
  });

  it('reprogramme la livraison apres un echec, sans la perdre', async () => {
    if (!seeded) return;
    const endpoint = await createEndpoint();
    receiverStatus = 500;

    const payment = await createPayment('+22997000000');
    await get(`/v1/payments/${payment.id}`);

    const outcome = await deliverDueEvents();
    expect(outcome.delivered).toBe(0);
    expect(outcome.failed).toBeGreaterThanOrEqual(1);

    const delivery = await prisma.outboundDelivery.findFirst({
      where: { merchantId, endpointId: endpoint.id },
      orderBy: { createdAt: 'desc' },
    });
    expect(delivery!.status).toBe('PENDING');
    expect(delivery!.attempts).toBe(1);
    expect(delivery!.lastStatusCode).toBe(500);
    // Un marchand indisponible ne doit pas perdre ses evenements.
    expect(delivery!.nextAttemptAt.getTime()).toBeGreaterThan(Date.now());

    await app.inject({
      method: 'DELETE',
      url: `/v1/webhook-endpoints/${endpoint.id}`,
      headers: { authorization: `Bearer ${key}` },
    });
  });

  it('abandonne apres epuisement des tentatives', async () => {
    if (!seeded) return;
    const endpoint = await createEndpoint();
    receiverStatus = 500;

    const payment = await createPayment('+22997000000');
    await get(`/v1/payments/${payment.id}`);

    // Chaque reprise est repoussee de plus en plus loin : l'horloge simulee
    // doit avancer a chaque tour, sinon la livraison n'est jamais due.
    for (let i = 1; i <= MAX_DELIVERY_ATTEMPTS; i += 1) {
      await deliverDueEvents(50, new Date(Date.now() + i * 24 * 3600 * 1000));
    }

    const delivery = await prisma.outboundDelivery.findFirst({
      where: { merchantId, endpointId: endpoint.id },
      orderBy: { createdAt: 'desc' },
    });
    // Un marchand definitivement mort ne doit pas saturer le worker.
    expect(delivery!.status).toBe('FAILED');
    expect(delivery!.attempts).toBe(MAX_DELIVERY_ATTEMPTS);

    await app.inject({
      method: 'DELETE',
      url: `/v1/webhook-endpoints/${endpoint.id}`,
      headers: { authorization: `Bearer ${key}` },
    });
  });

  it('ne met pas deux fois le meme evenement en file', async () => {
    if (!seeded) return;
    const endpoint = await createEndpoint();

    const payment = await createPayment('+22997000000');
    await get(`/v1/payments/${payment.id}`);
    await get(`/v1/payments/${payment.id}`); // seconde lecture, meme etat

    const count = await prisma.outboundDelivery.count({
      where: { endpointId: endpoint.id, eventId: `evt_${payment.id}_payment.succeeded` },
    });
    expect(count).toBe(1);

    await app.inject({
      method: 'DELETE',
      url: `/v1/webhook-endpoints/${endpoint.id}`,
      headers: { authorization: `Bearer ${key}` },
    });
  });
});

/* -------------------------------------------------------------------------- */

describe('balayeur', () => {
  it('reprend un encaissement laisse en attente et le resout', async () => {
    if (!seeded) return;
    const payment = await createPayment('+22997000000');
    expect(payment.status).toBe('PROCESSING');

    // Le balayeur n'interroge qu'au-dela d'un seuil d'age : on avance l'horloge
    // plutot que d'attendre.
    const result = await sweepStaleAttempts(25, new Date(Date.now() + 120_000));
    expect(result.polled).toBeGreaterThanOrEqual(1);

    const after = await get(`/v1/payments/${payment.id}`);
    expect(after.json().status).toBe('SUCCEEDED');
  });

  it('reprend un decaissement indetermine sans jamais le conclure seul', async () => {
    if (!seeded) return;
    const created = await post(
      '/v1/payouts',
      {
        reference: ref('po'),
        amount: 25000,
        currency: 'XOF',
        country: 'BJ',
        channel: 'mobile_money',
        recipient: { phone: '+22997000003', network: 'MTN_BENIN' },
      },
      ref('idem'),
    );
    const id = created.json().id;
    expect(created.json().status).toBe('UNKNOWN');

    // Le balayeur est GLOBAL : il reprend les transactions de tous les
    // marchands. On n'asserte donc que sur ce que ce test controle — l'etat de
    // son propre decaissement — et non sur des compteurs partages.
    await sweepStaleAttempts(25, new Date(Date.now() + 120_000));

    const after = await prisma.payout.findUnique({ where: { id } });
    // L'appel a expire : aucune reference agregateur a interroger. Le balayage
    // ne doit ni conclure, ni faire echouer le processus.
    expect(after!.status).toBe('UNKNOWN');
  });
});

describe('rapport de reconciliation', () => {
  it('liste les decaissements a trancher avec leur montant', async () => {
    if (!seeded) return;
    const res = await get('/v1/reconciliation');
    const report = res.json();

    expect(Array.isArray(report.indeterminate_payouts)).toBe(true);
    expect(report.indeterminate_payouts.length).toBeGreaterThanOrEqual(1);
    // Le montant en jeu doit etre visible immediatement.
    expect(report.indeterminate_payouts[0]).toHaveProperty('amount');
    expect(report.indeterminate_payouts[0]).toHaveProperty('reference');
    expect(report).toHaveProperty('rejected_webhooks_24h');
  });
});
