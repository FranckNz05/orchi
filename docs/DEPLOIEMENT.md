# Déploiement sur Render

Ce document décrit le déploiement d'Orchi sur Render, **et ce qu'il ne faut pas
en attendre**. La section « Ce que ce déploiement n'est pas » est la plus
importante des deux.

---

## 1. Procédure

Tout est décrit dans [`render.yaml`](../render.yaml) à la racine. Render le lit
et crée le service web *et* la base PostgreSQL en une fois.

1. Sur [dashboard.render.com](https://dashboard.render.com) → **New** →
   **Blueprint**.
2. Connecter le dépôt `FranckNz05/orchi`, branche `main`.
3. Render détecte `render.yaml` et affiche ce qu'il va créer : un service web
   `orchi` et une base `orchi-db`.
4. Il demande **deux valeurs** — les seules qui ne peuvent pas vivre dans le
   dépôt :

   | Variable | Valeur |
   |---|---|
   | `BOOTSTRAP_ADMIN_EMAIL` | votre adresse |
   | `BOOTSTRAP_ADMIN_PASSWORD` | 12 caractères minimum |

   Elles créent le premier administrateur de la plateforme. Sans lui, personne
   ne peut ouvrir `/admin`, donc aucun marchand ne peut être vérifié : le
   déploiement serait fonctionnel mais inutilisable.

5. Valider, puis attendre le premier build (~3 min). Le service est en ligne
   quand `/health/ready` répond `200`.

Le reste est automatique : `ENCRYPTION_KEY` et `API_KEY_PEPPER` sont générées
par Render, `DATABASE_URL` est branchée sur la base, et `PUBLIC_BASE_URL` se
déduit de `RENDER_EXTERNAL_URL`.

### Ce que fait le déploiement

| Étape | Commande | Rôle |
|---|---|---|
| Build | `npm ci --include=dev && npm run render:build` | dépendances, bascule du provider Prisma, génération du client, compilation TypeScript |
| Start | `npm run render:start` | synchronisation du schéma, semis du catalogue, amorçage de l'administrateur, démarrage |

Le semis du catalogue (54 pays, devises, agrégateurs, règles de couverture) est
en `upsert` : il est rejoué à chaque démarrage sans effet de bord. Une règle de
couverture supprimée par erreur en production revient d'elle-même au
redémarrage suivant.

### Pourquoi `--include=dev`

Parce que `NODE_ENV=production` est déclaré dans `render.yaml`, que Render
expose les variables **dès le build**, et que npm en déduit qu'il doit omettre
les `devDependencies`. Or `prisma` et `typescript` en font partie.

Sans ce drapeau, le build échoue sur un `prisma: not found` qui ne désigne pas
sa cause — on cherche une dépendance manquante alors que le problème est une
variable d'environnement.

---

## 2. Le premier administrateur

`scripts/create-admin.ts` s'exécute à chaque démarrage. Il ne fait rien si
`BOOTSTRAP_ADMIN_EMAIL` et `BOOTSTRAP_ADMIN_PASSWORD` sont absentes, et rien non
plus si le compte visé est déjà administrateur — sans quoi chaque redémarrage
révoquerait les sessions ouvertes.

**Ce n'est pas une brèche dans la règle « aucune route n'accorde
l'administration ».** Poser une variable d'environnement demande la main sur le
service, soit exactement le niveau de privilège qu'on accorderait de toute
façon. Ce qui reste interdit, et le reste, c'est de devenir administrateur
depuis l'API.

**Une fois le compte créé, supprimez les deux variables** depuis le tableau de
bord Render. Un mot de passe qui traîne dans la configuration d'un service est
un mot de passe que voit toute personne ayant accès à ce service.

Pour créer un autre administrateur ensuite, il faut un shell — donc un plan
payant :

```bash
npx tsx scripts/create-admin.ts email@exemple.com "mot-de-passe-long"
```

---

## 3. SQLite en développement, PostgreSQL en production

Le schéma Prisma a été tenu portable dès le départ — pas d'enum natif, pas de
type `Json`, pas de tableau, uniquement des `@@map`. La bascule d'un moteur à
l'autre est donc la substitution d'une seule ligne, faite au build par
[`scripts/set-db-provider.mjs`](../scripts/set-db-provider.mjs), qui lit le
schéma de `DATABASE_URL` et aligne le `provider` du datasource dessus.

Prisma exige que ce `provider` soit une chaîne littérale : il ne peut pas être
lu depuis une variable d'environnement, contrairement à l'URL. D'où ce script,
qui est idempotent — l'exécuter en local sur une URL SQLite ne modifie rien.

### Pourquoi `db push` et non `migrate deploy`

Les migrations de `prisma/migrations/` ont été générées **pour SQLite**. Leur
SQL n'est pas transposable tel quel à PostgreSQL. Deux options existaient :

- régénérer toute une histoire de migrations PostgreSQL en parallèle ;
- appliquer directement le schéma avec `prisma db push`.

C'est la seconde qui est retenue, parce que rien n'est encore en production :
il n'y a pas de données à préserver, donc pas d'histoire à reconstituer. Le
`db push` est volontairement lancé **sans** `--accept-data-loss` : le jour où le
schéma se rétracte, le déploiement échoue bruyamment au lieu de supprimer une
colonne en silence.

**Le jour où de vraies transactions existent, cette page doit changer.** Il
faudra alors basculer sur une véritable histoire de migrations PostgreSQL
(`prisma migrate deploy`), et `prisma/migrations/migration_lock.toml` devra
passer à `postgresql`.

---

## 4. Ce que ce déploiement n'est pas

### Il ne traite pas de vrais paiements

`PROVIDERS_ENABLED=sandbox`. Les adaptateurs de nos partenaires sont écrits
d'après leur documentation publique et **n'ont jamais été confrontés à un vrai
compte sandbox**. Les activer reviendrait à envoyer de vraies transactions sur
un contrat d'API supposé.

C'est le seul vrai obstacle avant une mise en production, et il ne se lève pas
par du code : il faut ouvrir un compte chez chaque agrégateur, puis confronter
chaque adaptateur au comportement réel.

### Le plan gratuit met le service en veille

Une instance Render gratuite s'endort après 15 minutes sans trafic. Ce n'est pas
qu'une lenteur au réveil : **les workers s'arrêtent avec elle**. Or le balayeur
(`sweeper`) est le filet de sécurité de l'état `UNKNOWN` — c'est lui qui va
demander à l'agrégateur ce qu'est devenue une transaction dont on a perdu la
réponse. Endormi, il ne balaye rien.

Pour une démonstration, c'est sans conséquence. Pour du trafic réel, le plan
payant n'est pas un confort mais une condition de correction.

### La base gratuite expire au bout de 30 jours

Render supprime les bases PostgreSQL du plan gratuit après 30 jours. Passer à
`basic-256mb` dans `render.yaml` dès que des données comptent.

### Un seul processus

Les workers tournent dans le processus web (`WORKERS_ENABLED=true`). Passer le
service à plusieurs instances ferait tourner autant de balayeurs concurrents sur
les mêmes transactions. Avant de monter en charge, il faudra soit séparer un
service `worker` dédié avec `WORKERS_ENABLED=false` sur le web, soit poser un
verrou d'exécution.

### La console est fermée

`CONSOLE_ENABLED=false`. La console d'exploitation invite à coller une clé API
secrète dans un navigateur : acceptable sur `localhost`, pas sur une URL
publique. Le tableau de bord marchand (`/app`) et l'administration (`/admin`),
eux, passent par une session serveur et restent accessibles.

---

## 5. Les deux secrets à ne jamais perdre

Render génère `ENCRYPTION_KEY` et `API_KEY_PEPPER` au premier déploiement et ne
les réaffiche pas. Elles ne sont pas interchangeables avec celles du poste de
développement :

- **`ENCRYPTION_KEY`** chiffre les credentials agrégateurs des marchands
  (AES-256-GCM). La changer rend illisible tout ce qui a déjà été chiffré — les
  marchands devront ressaisir leurs clés.
- **`API_KEY_PEPPER`** poivre le hachage des clés API. La changer invalide
  d'un coup toutes les clés déjà distribuées.

Le format de chiffrement (`v1.<iv>.<tag>.<ct>`) porte un préfixe de version
précisément pour qu'une rotation de clé soit possible plus tard sans casser
l'existant. Ce mécanisme de rotation n'est pas encore écrit.

---

## 6. Domaine personnalisé

Ajouter le domaine dans Render, puis déclarer explicitement la variable dans
`render.yaml` :

```yaml
- key: PUBLIC_BASE_URL
  value: https://api.orchi.africa
```

Elle est prioritaire sur `RENDER_EXTERNAL_URL`. C'est important : cette URL sert
à construire les adresses de callback communiquées aux agrégateurs. Si elle
pointe encore sur `onrender.com` après la bascule, les notifications entrantes
continueront d'arriver sur l'ancienne adresse — et le symptôme (« les webhooks
n'arrivent plus ») ne désignera pas sa cause.

---

## 7. Après le déploiement

```bash
curl https://orchi.onrender.com/health/ready
```

Doit répondre `{"status":"ok","checks":{"database":"up"}}`.

Ensuite :

1. Se connecter sur `/login` avec l'adresse d'amorçage, **changer le mot de
   passe**, puis supprimer les deux variables `BOOTSTRAP_ADMIN_*` dans Render.
2. Ouvrir `/admin` : la file des dossiers d'accès au réel est vide.
3. Créer un compte marchand sur `/register`. Le compte sandbox est branché
   automatiquement : une session de paiement est possible dans la foulée, sans
   configuration.
4. Depuis ce compte marchand, déposer une demande d'accès au réel, puis la
   traiter depuis `/admin`. C'est le chemin complet, de bout en bout.
