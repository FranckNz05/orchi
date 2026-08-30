import { describe, expect, it } from 'vitest';
import { decryptSecret, encryptSecret, generateApiKey, hashApiKey } from '../src/core/crypto.js';

describe('cles API', () => {
  it('produit un secret prefixe par environnement et un hash stable', () => {
    const key = generateApiKey('test');
    expect(key.secret.startsWith('sk_test_')).toBe(true);
    expect(key.prefix).toBe(key.secret.slice(0, 16));
    expect(hashApiKey(key.secret)).toBe(key.hash);
  });

  it('ne produit jamais deux fois le meme secret', () => {
    const secrets = new Set(Array.from({ length: 200 }, () => generateApiKey('live').secret));
    expect(secrets.size).toBe(200);
  });

  it('ne laisse pas le secret deductible du hash stocke', () => {
    const key = generateApiKey('live');
    expect(key.hash).not.toContain(key.secret.slice(8));
    expect(key.hash).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('coffre de cles', () => {
  it('chiffre puis dechiffre a l’identique', () => {
    const plaintext = 'fedapay_sk_live_9f2a4c8e1b';
    expect(decryptSecret(encryptSecret(plaintext))).toBe(plaintext);
  });

  it('produit un chiffre different a chaque appel (IV aleatoire)', () => {
    expect(encryptSecret('meme-valeur')).not.toBe(encryptSecret('meme-valeur'));
  });

  it('refuse une charge alteree', () => {
    const payload = encryptSecret('credential-sensible');
    const parts = payload.split('.');
    const tampered = [parts[0], parts[1], parts[2], Buffer.from('autre').toString('base64url')].join('.');
    expect(() => decryptSecret(tampered)).toThrow();
  });

  it('refuse une version inconnue', () => {
    expect(() => decryptSecret('v9.aaa.bbb.ccc')).toThrow(/version inconnue/i);
  });
});
