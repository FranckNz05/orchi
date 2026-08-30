import { env } from './core/env.js';
import { logger } from './core/logger.js';
import { prisma } from './db/client.js';
import { warmStartBreakers } from './routing/instrument.js';
import { buildServer } from './server.js';
import { startWorkers, stopWorkers } from './workers/index.js';

async function main() {
  const app = await buildServer();

  // Un redemarrage ne doit pas relancer du trafic vers un agregateur que l'on
  // venait de couper : les disjoncteurs ouverts sont restaures avant d'ouvrir
  // le port.
  await warmStartBreakers();

  startWorkers();

  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'Arret en cours');
    try {
      stopWorkers();
      await app.close();
      await prisma.$disconnect();
      process.exit(0);
    } catch (e) {
      logger.error({ err: e }, 'Arret non propre');
      process.exit(1);
    }
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('unhandledRejection', (reason) => {
    logger.fatal({ err: reason }, 'Rejet de promesse non gere');
    process.exit(1);
  });

  await app.listen({ port: env.PORT, host: env.HOST });
  logger.info(`Orchi ecoute sur http://${env.HOST}:${env.PORT} (${env.NODE_ENV})`);
}

main().catch((e) => {
  logger.fatal({ err: e }, 'Demarrage impossible');
  process.exit(1);
});
