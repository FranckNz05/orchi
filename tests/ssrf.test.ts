import { describe, expect, it } from 'vitest';
import { BlockedUrlError, adresseEstPrivee, assertDeliverableUrl } from '../src/core/ssrf.js';

/**
 * Garde-fou SSRF.
 *
 * `adresseEstPrivee` est la piece qui compte : c'est elle qui decide si notre
 * serveur accepte d'aller frapper une adresse. Elle est pure, donc entierement
 * verifiable — contrairement a la resolution DNS, qui ne s'active qu'en
 * production.
 */

describe('classification des adresses', () => {
  it('refuse la boucle locale', () => {
    for (const a of ['127.0.0.1', '127.1.2.3', '::1', '::ffff:127.0.0.1']) {
      expect(adresseEstPrivee(a), a).toBe(true);
    }
  });

  it('refuse le lien-local, ou vivent les metadonnees de l’hebergeur', () => {
    // 169.254.169.254 est l'adresse du service de metadonnees chez la plupart
    // des hebergeurs : c'est la cible classique d'une SSRF.
    expect(adresseEstPrivee('169.254.169.254')).toBe(true);
    expect(adresseEstPrivee('169.254.0.1')).toBe(true);
    expect(adresseEstPrivee('fe80::1')).toBe(true);
  });

  it('refuse les plages privees', () => {
    for (const a of ['10.0.0.1', '172.16.0.1', '172.31.255.255', '192.168.1.1', 'fc00::1', 'fd12::9']) {
      expect(adresseEstPrivee(a), a).toBe(true);
    }
  });

  it('refuse le CGNAT, le multicast, le reserve et l’adresse nulle', () => {
    for (const a of ['100.64.0.1', '224.0.0.1', '240.0.0.1', '0.0.0.0', '::', 'ff02::1']) {
      expect(adresseEstPrivee(a), a).toBe(true);
    }
  });

  it('accepte les adresses publiques', () => {
    for (const a of ['8.8.8.8', '1.1.1.1', '172.32.0.1', '192.169.0.1', '2001:4860:4860::8888']) {
      expect(adresseEstPrivee(a), a).toBe(false);
    }
  });

  it('refuse ce qui n’est pas une adresse : dans le doute, on ne joint pas', () => {
    expect(adresseEstPrivee('pas-une-adresse')).toBe(true);
    expect(adresseEstPrivee('')).toBe(true);
    expect(adresseEstPrivee('999.1.1.1')).toBe(true);
  });

  it('ne se laisse pas tromper par une adresse v4 encapsulee en v6', () => {
    expect(adresseEstPrivee('::ffff:10.0.0.1')).toBe(true);
    expect(adresseEstPrivee('::ffff:8.8.8.8')).toBe(false);
  });
});

/* -------------------------------------------------------------------------- */

describe('validation d’URL', () => {
  it('refuse un schema autre que http ou https', async () => {
    for (const url of ['file:///etc/passwd', 'gopher://x/', 'ftp://x/']) {
      await expect(assertDeliverableUrl(url), url).rejects.toBeInstanceOf(BlockedUrlError);
    }
  });

  it('refuse des identifiants dans l’URL', async () => {
    // Ils finiraient recopies dans nos journaux a chaque livraison.
    await expect(assertDeliverableUrl('https://user:motdepasse@exemple.com/hook')).rejects.toThrow(
      /identifiants/i,
    );
  });

  it('refuse une URL illisible', async () => {
    await expect(assertDeliverableUrl('pas une url')).rejects.toBeInstanceOf(BlockedUrlError);
  });

  it('accepte une URL publique bien formee', async () => {
    await expect(assertDeliverableUrl('https://exemple.com/hooks/orchi')).resolves.toBeUndefined();
  });

  it('laisse passer la boucle locale hors production', async () => {
    // C'est deliberе : la suite de tests et le developpement local font tourner
    // un serveur marchand sur 127.0.0.1. Le blocage par adresse ne se releve
    // qu'en production.
    await expect(assertDeliverableUrl('http://127.0.0.1:8080/hooks')).resolves.toBeUndefined();
  });
});
