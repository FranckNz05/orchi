import { env } from '../core/env.js';
import { logger } from '../core/logger.js';
import { purgeExpiredIdempotencyKeys } from '../core/idempotency.js';
import { purgeExpiredSessions } from '../modules/auth.js';
import { sweepStaleAttempts } from '../modules/reconciliation.js';
import { deliverDueEvents } from '../modules/webhooks/outbound.js';
import { persistHealthSnapshot } from '../routing/instrument.js';

/**
 * Taches de fond.
 *
 * Volontairement dans le meme processus que l'API a ce stade : un
 * orchestrateur qui traite quelques milliers de transactions par jour n'a pas
 * besoin d'une file distribuee, et l'ajouter trop tot cree un point de panne
 * supplementaire sans rien resoudre. Le jour ou il faudra plusieurs instances,
 * ces boucles se deplacent dans un worker dedie sans changer une ligne de leur
 * contenu — elles ne partagent aucun etat avec les routes.
 *
 * Chaque boucle est protegee contre le recouvrement : si un passage dure plus
 * longtemps que la periode, le suivant est saute plutot que de s'empiler.
 */

type Loop = { name: string; intervalMs: number; run: () => Promise<unknown> };

const LOOPS: Loop[] = [
  {
    name: 'sweeper',
    intervalMs: env.SWEEPER_INTERVAL_MS,
    run: async () => {
      const result = await sweepStaleAttempts();
      if (result.polled > 0 || result.expired > 0) {
        logger.info(result, 'Balayage des transactions non terminees');
      }
      return result;
    },
  },
  {
    name: 'webhook-delivery',
    // Plus court que le balayeur : un marchand attend ses evenements.
    intervalMs: 5_000,
    run: async () => {
      const result = await deliverDueEvents();
      if (result.delivered > 0 || result.failed > 0 || result.exhausted > 0) {
        logger.info(result, 'Livraison des evenements sortants');
      }
      return result;
    },
  },
  {
    name: 'health-snapshot',
    intervalMs: 30_000,
    run: () => persistHealthSnapshot(),
  },
  {
    name: 'expired-purge',
    intervalMs: 3_600_000,
    run: async () => {
      const [keys, sessions] = await Promise.all([
        purgeExpiredIdempotencyKeys(),
        purgeExpiredSessions(),
      ]);
      if (keys > 0 || sessions > 0) {
        logger.info({ keys, sessions }, 'Cles d’idempotence et sessions expirees purgees');
      }
      return { keys, sessions };
    },
  },
];

const timers: NodeJS.Timeout[] = [];
const running = new Set<string>();

export function startWorkers(): void {
  if (!env.WORKERS_ENABLED) {
    logger.info('Workers desactives (WORKERS_ENABLED=false)');
    return;
  }

  for (const loop of LOOPS) {
    const timer = setInterval(() => {
      if (running.has(loop.name)) {
        // Un passage precedent traine encore : on saute plutot que d'empiler.
        logger.debug({ worker: loop.name }, 'Passage saute, precedent encore en cours');
        return;
      }
      running.add(loop.name);
      void loop
        .run()
        .catch((e: unknown) => logger.error({ err: e, worker: loop.name }, 'Worker en echec'))
        .finally(() => running.delete(loop.name));
    }, loop.intervalMs);

    // Ne doit jamais empecher le processus de s'arreter.
    timer.unref();
    timers.push(timer);
  }

  logger.info({ workers: LOOPS.map((l) => l.name) }, 'Workers demarres');
}

export function stopWorkers(): void {
  for (const timer of timers) clearInterval(timer);
  timers.length = 0;
  running.clear();
}
