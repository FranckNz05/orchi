import { copyFileSync, existsSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Base de donnees dediee aux tests.
 *
 * Sans cela, la suite partage `dev.db` avec tout ce qui tourne par ailleurs —
 * typiquement le serveur de developpement, dont le balayeur interroge et modifie
 * les memes transactions au milieu d'un test. Le symptome est une suite qui
 * passe fichier par fichier mais echoue en entier, ce qui fait perdre bien plus
 * de temps qu'il n'en coute a isoler.
 *
 * On COPIE la base de developpement plutot que de rejouer les migrations : le
 * catalogue des 54 pays y est deja seede, et la copie coute quelques
 * millisecondes contre plusieurs secondes de migration.
 */
const DEV_DB = resolve(process.cwd(), 'prisma/dev.db');
const TEST_DB = resolve(process.cwd(), 'prisma/test.db');

export function setup(): void {
  for (const suffix of ['', '-journal', '-wal', '-shm']) {
    const path = `${TEST_DB}${suffix}`;
    if (existsSync(path)) rmSync(path);
  }

  if (!existsSync(DEV_DB)) {
    throw new Error(
      'prisma/dev.db introuvable. Lancez `npm run db:migrate && npm run seed` avant les tests.',
    );
  }

  copyFileSync(DEV_DB, TEST_DB);
}

export function teardown(): void {
  // La base est conservee apres coup : inspecter l'etat laisse par un test qui
  // vient d'echouer est souvent le moyen le plus rapide de comprendre pourquoi.
}
