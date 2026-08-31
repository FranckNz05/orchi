import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { isProduction } from './env.js';
import { AppError } from './errors.js';

/**
 * Garde-fou SSRF pour les URL fournies par un marchand.
 *
 * LE PROBLEME
 *
 * Un marchand declare librement l'URL de son endpoint de webhook, et c'est
 * NOTRE serveur qui va la joindre. Sans controle, `https://…` accepte aussi
 * bien `http://169.254.169.254/latest/meta-data/` (service de metadonnees de
 * l'hebergeur, souvent porteur de credentials), `http://127.0.0.1:3000/v1/…`
 * (notre propre API, vue depuis l'interieur), ou n'importe quelle adresse
 * privee du reseau. Le marchand ne lit pas la reponse, mais le code de statut
 * et le delai suffisent a cartographier un reseau interne — et certaines
 * routes internes agissent sur un simple POST.
 *
 * CE QUI EST VERIFIE
 *
 *   - le schema : http ou https, rien d'autre (`file:`, `gopher:`…) ;
 *   - l'absence d'identifiants dans l'URL, qui fuiteraient dans nos journaux ;
 *   - l'adresse RESOLUE, pas seulement le nom : `interne.exemple.com` peut
 *     pointer sur 10.0.0.5.
 *
 * DEUX VERIFICATIONS, ET C'EST VOLONTAIRE
 *
 * Une seule validation a la declaration ne suffirait pas : le DNS peut changer
 * entre le moment ou l'endpoint est enregistre et celui ou l'evenement part
 * (« DNS rebinding »). La verification est donc rejouee AVANT CHAQUE
 * LIVRAISON. C'est un cout de resolution par envoi, accepte sciemment.
 *
 * EN DEHORS DE LA PRODUCTION
 *
 * Les adresses locales sont autorisees : le developpement et la suite de tests
 * font tourner un serveur marchand sur 127.0.0.1. Le garde-fou ne se releve
 * qu'en production, la ou un reseau interne existe reellement.
 */

export class BlockedUrlError extends AppError {
  constructor(message: string, url: string) {
    super({
      type: 'invalid_request_error',
      code: 'url_not_allowed',
      message,
      httpStatus: 400,
      retriable: false,
      param: 'url',
      details: { url },
    });
    this.name = 'BlockedUrlError';
  }
}

function ipv4EstPrive(adresse: string): boolean {
  const o = adresse.split('.').map(Number);
  if (o.length !== 4 || o.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true;
  const [a, b] = o as [number, number, number, number];

  if (a === 0) return true; // 0.0.0.0/8
  if (a === 10) return true; // prive
  if (a === 127) return true; // boucle locale
  if (a === 169 && b === 254) return true; // lien-local — metadonnees hebergeur
  if (a === 172 && b >= 16 && b <= 31) return true; // prive
  if (a === 192 && b === 168) return true; // prive
  if (a === 192 && b === 0) return true; // IETF
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
  if (a === 198 && (b === 18 || b === 19)) return true; // bancs d'essai
  if (a >= 224) return true; // multicast et reserve
  return false;
}

function ipv6EstPrive(adresse: string): boolean {
  const a = adresse.toLowerCase();
  if (a === '::1' || a === '::') return true;

  // Adresse IPv4 encapsulee : c'est l'adresse v4 qui compte.
  const mappee = a.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mappee) return ipv4EstPrive(mappee[1]!);

  const debut = a.split(':')[0] ?? '';
  if (/^f[cd]/.test(debut)) return true; // fc00::/7 — unique local
  if (/^fe[89ab]/.test(debut)) return true; // fe80::/10 — lien-local
  if (/^ff/.test(debut)) return true; // ff00::/8 — multicast
  return false;
}

export function adresseEstPrivee(adresse: string): boolean {
  const version = isIP(adresse);
  if (version === 4) return ipv4EstPrive(adresse);
  if (version === 6) return ipv6EstPrive(adresse);
  return true; // ni v4 ni v6 : on ne sait pas, donc on refuse
}

/**
 * Valide une URL de destination fournie par un marchand.
 *
 * Leve `BlockedUrlError` si elle ne peut pas etre jointe sans risque. Ne
 * renvoie rien : l'appelant continue avec l'URL d'origine.
 */
export async function assertDeliverableUrl(brut: string): Promise<void> {
  let url: URL;
  try {
    url = new URL(brut);
  } catch {
    throw new BlockedUrlError('URL illisible.', brut);
  }

  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new BlockedUrlError(
      `Schema non autorise : ${url.protocol.replace(':', '')}. Utilisez https.`,
      brut,
    );
  }

  // En clair, un evenement signe circule lisible par tout intermediaire. Le
  // refuser en production est le minimum ; en local, http reste commode.
  if (isProduction && url.protocol !== 'https:') {
    throw new BlockedUrlError('Seul https est accepte pour un endpoint de webhook.', brut);
  }

  if (url.username || url.password) {
    throw new BlockedUrlError(
      "L'URL ne doit pas contenir d'identifiants : ils apparaitraient dans nos journaux.",
      brut,
    );
  }

  // Hors production, on s'arrete la : la suite de tests et le developpement
  // local visent 127.0.0.1, et aucun reseau interne n'est en jeu.
  if (!isProduction) return;

  const hote = url.hostname.replace(/^\[|\]$/g, '');

  if (isIP(hote)) {
    if (adresseEstPrivee(hote)) {
      throw new BlockedUrlError('Cette adresse IP appartient a un reseau prive ou reserve.', brut);
    }
    return;
  }

  let adresses: Array<{ address: string }>;
  try {
    adresses = await lookup(hote, { all: true });
  } catch {
    throw new BlockedUrlError(`Nom de domaine introuvable : ${hote}.`, brut);
  }

  if (adresses.length === 0) {
    throw new BlockedUrlError(`Nom de domaine sans adresse : ${hote}.`, brut);
  }

  // TOUTES les adresses doivent etre publiques. Un nom qui resout a la fois sur
  // une adresse publique et une adresse interne est precisement le montage
  // qu'on cherche a bloquer.
  for (const { address } of adresses) {
    if (adresseEstPrivee(address)) {
      throw new BlockedUrlError(
        `${hote} resout vers une adresse privee ou reservee (${address}).`,
        brut,
      );
    }
  }
}
