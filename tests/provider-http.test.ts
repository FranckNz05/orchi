import { createServer, type Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ProviderError } from '../src/providers/errors.js';
import { providerFetch } from '../src/providers/http.js';

/**
 * Ces tests verifient la traduction des echecs HTTP reels vers la taxonomie.
 * C'est la couche qui empeche un adaptateur de laisser fuiter un timeout brut
 * que le moteur interpreterait comme un echec — et rejouerait.
 */
let server: Server;
let base: string;

beforeAll(async () => {
  server = createServer((req, res) => {
    const url = req.url ?? '/';
    if (url === '/ok') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"status":"ok"}');
      return;
    }
    if (url === '/slow') {
      // Ne repond jamais : declenche l'abandon cote client.
      return;
    }
    const match = /^\/status\/(\d+)$/.exec(url);
    if (match) {
      res.writeHead(Number(match[1]), { 'content-type': 'application/json' });
      res.end('{"error":"simule"}');
      return;
    }
    res.writeHead(404);
    res.end('{}');
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  base = `http://127.0.0.1:${port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

function call(path: string, mutating: boolean, timeoutMs?: number) {
  return providerFetch({
    providerId: 'test',
    method: mutating ? 'POST' : 'GET',
    url: `${base}${path}`,
    mutating,
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
    ...(mutating ? { body: '{}' } : {}),
  });
}

describe('reponses normales', () => {
  it('renvoie le corps brut', async () => {
    const res = await call('/ok', false);
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ status: 'ok' });
  });
});

describe('traduction des statuts HTTP', () => {
  const cases: Array<[number, boolean, string, 'failed' | 'unknown']> = [
    [429, false, 'rate_limited', 'failed'],
    [401, false, 'authentication', 'failed'],
    [403, false, 'authentication', 'failed'],
    [400, false, 'invalid_request', 'failed'],
    [422, false, 'invalid_request', 'failed'],
    [503, true, 'unavailable', 'failed'],
    [504, true, 'unavailable', 'failed'],
  ];

  for (const [status, mutating, code, outcome] of cases) {
    it(`traduit ${status} en ${code} (${outcome})`, async () => {
      const e = (await call(`/status/${status}`, mutating).catch((err) => err)) as ProviderError;
      expect(e.code).toBe(code);
      expect(e.outcome).toBe(outcome);
    });
  }

  it('lit un 500 sur LECTURE comme une indisponibilite : rien n’a change', async () => {
    const e = (await call('/status/500', false).catch((err) => err)) as ProviderError;
    expect(e.code).toBe('unavailable');
    expect(e.outcome).toBe('failed');
  });

  it('lit un 500 sur CREATION comme indetermine : l’agregateur a pu traiter', async () => {
    const e = (await call('/status/500', true).catch((err) => err)) as ProviderError;
    expect(e.code).toBe('indeterminate');
    expect(e.outcome).toBe('unknown');
    expect(e.failoverAllowed).toBe(false);
  });
});

describe('echecs reseau', () => {
  it('classe un abandon sur delai en etat inconnu', async () => {
    const e = (await call('/slow', true, 150).catch((err) => err)) as ProviderError;
    expect(e.code).toBe('timeout');
    expect(e.outcome).toBe('unknown');
    expect(e.failoverAllowed).toBe(false);
  });

  it('classe un refus de connexion en indisponibilite : la requete n’est jamais partie', async () => {
    // Un port reellement ferme : on en ouvre un, on note son numero, on ferme.
    const probe = createServer();
    await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
    const address = probe.address();
    const closedPort = typeof address === 'object' && address ? address.port : 0;
    await new Promise<void>((resolve) => probe.close(() => resolve()));

    const e = (await providerFetch({
      providerId: 'test',
      method: 'POST',
      url: `http://127.0.0.1:${closedPort}/charge`,
      mutating: true,
      body: '{}',
      timeoutMs: 3000,
    }).catch((err) => err)) as ProviderError;

    expect(e.code).toBe('unavailable');
    expect(e.outcome).toBe('failed');
    // Un decaissement peut repartir ailleurs : rien n'a ete soumis.
    expect(e.failoverAllowed).toBe(true);
  });

  it('classe une URL mal configuree en erreur de requete, pas en etat inconnu', async () => {
    const e = (await providerFetch({
      providerId: 'test',
      method: 'POST',
      url: 'http://127.0.0.1:1/charge',
      mutating: true,
      body: '{}',
    }).catch((err) => err)) as ProviderError;
    expect(e.code).toBe('invalid_request');
    expect(e.outcome).toBe('failed');
  });
});
