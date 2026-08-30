import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { env, isProduction } from '../../core/env.js';
import { logger } from '../../core/logger.js';

/**
 * Pages HTML servies par l'application.
 *
 * Pas de build, pas de bundler : chaque page est un fichier autonome de
 * `public/`. C'est un choix assume tant que l'interface reste modeste — ajouter
 * une chaine de build ici couterait plus qu'elle ne rapporterait, et rien
 * n'empeche de la mettre en place le jour ou l'interface le justifie.
 */
const PAGES = join(process.cwd(), 'public');

const cache = new Map<string, string>();

async function page(name: string): Promise<string> {
  // En developpement on relit a chaque appel : editer la page et rafraichir
  // suffit, sans redemarrer le serveur.
  const cached = cache.get(name);
  if (cached && isProduction) return cached;
  const html = await readFile(join(PAGES, name), 'utf8');
  cache.set(name, html);
  return html;
}

async function serve(reply: FastifyReply, name: string, request: FastifyRequest) {
  try {
    const html = await page(name);
    return reply
      .type('text/html; charset=utf-8')
      // Les pages ne chargent aucune ressource externe : on le declare, ce qui
      // neutralise toute injection de script tiers.
      .header(
        'content-security-policy',
        // `'self'` couvre les ressources partagees de /assets ; `'unsafe-inline'`
        // reste necessaire tant que les pages portent leur style et leur script
        // en ligne. A remplacer par des nonces le jour ou une chaine de build
        // existe.
        "default-src 'none'; style-src 'self' 'unsafe-inline'; " +
          "script-src 'self' 'unsafe-inline'; img-src 'self' data:; " +
          "connect-src 'self'; form-action 'self'",
      )
      .send(html);
  } catch (e) {
    logger.error({ err: e, page: name }, 'Page introuvable');
    return reply.status(500).send({
      error: {
        type: 'api_error',
        code: 'page_unavailable',
        message: `public/${name} introuvable.`,
        retriable: false,
        request_id: String(request.id),
      },
    });
  }
}

/** L'appelant est-il un navigateur qui attend une page, ou un client d'API ? */
function wantsHtml(request: FastifyRequest): boolean {
  const accept = request.headers.accept ?? '';
  return accept.includes('text/html');
}

export interface ServiceIndex {
  [key: string]: unknown;
}

export async function pageRoutes(app: FastifyInstance, serviceIndex: () => ServiceIndex) {
  /**
   * Racine : site vitrine pour un navigateur, index de service pour un client
   * d'API. Servir l'un ou l'autre selon `Accept` evite d'avoir a choisir entre
   * une page inutilisable en curl et un JSON incomprehensible en navigateur.
   */
  app.get('/', async (request, reply) => {
    if (!wantsHtml(request)) return serviceIndex();
    return serve(reply, 'site.html', request);
  });

  /**
   * Ressources partagees entre les pages (theme, globe anime).
   *
   * Le nom de fichier est valide contre une liste blanche d'extensions ET
   * normalise : sans cela, `/assets/../../.env` sortirait du dossier public.
   */
  const ASSET_TYPES: Record<string, string> = {
    '.css': 'text/css; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.svg': 'image/svg+xml',
  };

  app.get('/assets/:file', async (request, reply) => {
    const { file } = request.params as { file: string };
    const type = ASSET_TYPES[extname(file)];

    if (!type || /[/\\]/.test(file) || normalize(file) !== file) {
      return reply.status(404).send({ error: { code: 'not_found', message: 'Ressource inconnue.' } });
    }

    try {
      const content = await readFile(join(PAGES, 'assets', file), 'utf8');
      return reply
        .type(type)
        .header('cache-control', isProduction ? 'public, max-age=3600' : 'no-store')
        .send(content);
    } catch {
      return reply.status(404).send({ error: { code: 'not_found', message: 'Ressource inconnue.' } });
    }
  });

  /**
   * Documentation d'integration, servie telle quelle.
   *
   * Le Markdown brut plutot qu'une page rendue : la source vit dans le depot,
   * elle est donc toujours a jour, et un integrateur la lit aussi bien dans un
   * navigateur que dans son editeur. Convertir en HTML introduirait une chaine
   * de build pour un gain nul.
   */
  app.get('/docs', async (_request, reply) => {
    try {
      const md = await readFile(join(process.cwd(), 'docs', 'INTEGRATION.md'), 'utf8');
      return reply.type('text/markdown; charset=utf-8').send(md);
    } catch {
      return reply.status(404).send({
        error: { code: 'not_found', message: 'Documentation indisponible.' },
      });
    }
  });

  /**
   * Page de paiement hebergee. Publique par nature : le client final n'a pas de
   * compte, le jeton d'URL est sa seule cle. `noindex` est dans la page — un
   * lien de paiement n'a rien a faire dans un moteur de recherche.
   */
  app.get('/pay/:token', async (request, reply) => serve(reply, 'pay.html', request));

  app.get('/login', async (request, reply) => serve(reply, 'login.html', request));
  app.get('/register', async (request, reply) => serve(reply, 'register.html', request));
  app.get('/app', async (request, reply) => serve(reply, 'app.html', request));

  /**
   * Console d'exploitation : refusee par defaut en production, car elle invite
   * a coller une cle API secrete dans un navigateur. Acceptable en local, pas
   * au-dela — le tableau de bord marchand, lui, passe par une session serveur.
   */
  if (!isProduction || env.CONSOLE_ENABLED) {
    app.get('/console', async (request, reply) => serve(reply, 'console.html', request));
  } else {
    logger.info('Console desactivee en production (CONSOLE_ENABLED=false)');
  }
}
