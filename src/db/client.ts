import { PrismaClient } from '@prisma/client';
import { env, isProduction } from '../core/env.js';
import { logger } from '../core/logger.js';

/**
 * Client Prisma unique pour tout le processus. En developpement, tsx recharge
 * le module a chaque modification : on memorise l'instance sur globalThis pour
 * ne pas ouvrir une connexion par rechargement.
 */
const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

export const prisma =
  globalForPrisma.prisma ??
  new PrismaClient({
    datasources: { db: { url: env.DATABASE_URL } },
    log: isProduction ? ['warn', 'error'] : ['warn', 'error'],
  });

if (!isProduction) globalForPrisma.prisma = prisma;

export async function checkDatabase(): Promise<boolean> {
  try {
    await prisma.$queryRaw`SELECT 1`;
    return true;
  } catch (e) {
    logger.error({ err: e }, 'Base de donnees injoignable');
    return false;
  }
}
