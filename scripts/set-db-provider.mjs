/**
 * Aligne le `provider` du datasource Prisma sur DATABASE_URL.
 *
 * POURQUOI CE SCRIPT EXISTE
 *
 * Prisma exige que le provider du datasource soit une chaine litterale : il ne
 * peut pas etre lu depuis une variable d'environnement, contrairement a l'URL.
 * Un projet qui developpe sur SQLite et deploie sur PostgreSQL doit donc ecrire
 * la valeur dans le fichier avant `prisma generate`.
 *
 * Le schema a ete tenu portable des le depart (pas d'enum natif, pas de Json,
 * pas de tableau, uniquement des `@@map`) precisement pour que cette bascule
 * reste une substitution d'une ligne et non une reecriture.
 *
 * Le script est idempotent et ne touche au fichier que si la valeur change :
 * l'executer en local sur une URL SQLite ne produit aucune modification.
 */
// DATABASE_URL vient de l'environnement sur un PaaS, mais du fichier .env sur
// un poste de developpement. Sans ce chargement, le script ne trouvait rien en
// local et laissait le schema tel quel EN SILENCE — le pire des deux mondes :
// il ne servait a rien la ou on peut le tester, et n'etait exerce qu'en
// production. `dotenv` ne fait rien quand le fichier est absent, ce qui est
// exactement le comportement voulu sur Render.
import 'dotenv/config';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCHEMA = join(dirname(dirname(fileURLToPath(import.meta.url))), 'prisma', 'schema.prisma');

function providerFor(url) {
  if (!url) return null;
  if (url.startsWith('postgres://') || url.startsWith('postgresql://')) return 'postgresql';
  if (url.startsWith('file:')) return 'sqlite';
  if (url.startsWith('mysql://')) return 'mysql';
  return null;
}

const provider = providerFor(process.env.DATABASE_URL);

if (!provider) {
  // Pas d'URL exploitable. On echoue plutot que de laisser passer : un schema
  // fige sur le mauvais provider ne se manifeste qu'au premier appel a la base,
  // loin de sa cause.
  console.error(
    '[db-provider] DATABASE_URL absente ou non reconnue' +
      (process.env.DATABASE_URL ? ` : ${process.env.DATABASE_URL.slice(0, 24)}…` : '.'),
  );
  process.exit(1);
}

const source = readFileSync(SCHEMA, 'utf8');
const current = source.match(/datasource\s+db\s*\{[^}]*?provider\s*=\s*"([^"]+)"/s)?.[1];

if (current === provider) {
  console.log(`[db-provider] deja "${provider}", rien a faire.`);
  process.exit(0);
}

const updated = source.replace(
  /(datasource\s+db\s*\{[^}]*?provider\s*=\s*")[^"]+(")/s,
  `$1${provider}$2`,
);

if (updated === source) {
  console.error('[db-provider] bloc datasource introuvable dans prisma/schema.prisma.');
  process.exit(1);
}

writeFileSync(SCHEMA, updated);
console.log(`[db-provider] provider "${current}" -> "${provider}".`);
