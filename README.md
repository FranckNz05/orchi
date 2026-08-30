# Orchi — Orchestrateur de paiement pan-africain

API unique pour encaisser (pay-in) et décaisser (payout) en Afrique, en abstrayant
les agrégateurs régionaux (FedaPay, CinetPay, GeniusPay, Flutterwave, Paystack,
M-Pesa, Paymob…).

> **État : étape 6 — feuille de route terminée.** Cycle transactionnel complet,
> routage dynamique, adaptateurs FedaPay/CinetPay (non validés en sandbox réel,
> donc désactivés), webhooks entrants et sortants, balayeur et réconciliation.

**Documentation d'intégration marchand : [docs/INTEGRATION.md](docs/INTEGRATION.md)**
— authentification, endpoints, montants, idempotence, erreurs, tarifs, scénarios
de test et passage en production.

## Décisions structurantes

### Modèle A — passerelle technique (et non collecteur)

Les fonds **ne transitent jamais** par l'orchestrateur. Chaque marchand apporte
ses propres comptes agrégateurs ; Orchi stocke leurs identifiants chiffrés et
route les transactions.

Conséquences :

- aucun agrément EME / PSP requis pour démarrer ;
- revenu = abonnement SaaS + frais fixes par transaction réussie, facturés hors
  flux (et non une marge sur le GMV) ;
- le ledger est un **ledger miroir** : il reflète les flux constatés chez les
  agrégateurs pour le reporting, la facturation et la réconciliation — pas une
  comptabilité de garde.

Le modèle collecteur (encaissement sur comptes propres + reversement avec marge)
reste la cible, pays par pays, une fois les accords sub-merchant signés. Le
schéma de données est prévu pour cette bascule sans migration destructrice.

### Deux tables, pas une : `Payment` et `Attempt`

Une intention de paiement (ce que voit le marchand) est distincte de chaque
tentative auprès d'un agrégateur. C'est ce qui rend le failover, les retries et
la réconciliation traçables : le marchand garde une référence stable, chaque
tentative conserve son état et sa référence externe.

### Le failover n'est pas symétrique

- **Pay-in** : une fois le push USSD/OTP envoyé par l'opérateur, la transaction
  appartient à cet agrégateur. Le routage se décide à la *création* de tentative ;
  après échec, c'est un retry proposé, pas un reroutage transparent.
- **Payout** : le failover automatique est possible, mais uniquement sur un échec
  *explicite* du provider. Sur timeout réseau, l'état est `UNKNOWN` et le
  réconciliateur interroge le provider **avant** toute nouvelle tentative. Un
  retry aveugle produit un double décaissement.

C'est pourquoi chaque erreur de l'API porte un champ `retriable`.

## Démarrage

```bash
npm install
cp .env.example .env
```

Générer les deux clés cryptographiques dans `.env` :

```bash
node -e "console.log('ENCRYPTION_KEY=' + require('crypto').randomBytes(32).toString('base64'))"
```

```bash
node -e "console.log('API_KEY_PEPPER=' + require('crypto').randomBytes(32).toString('base64'))"
```

Puis :

```bash
npm run db:migrate && npm run seed && npm run dev
```

Le seed affiche une clé API de test, montrée **une seule fois**.

```bash
curl -H "Authorization: Bearer sk_test_..." http://localhost:3000/v1/me
```

### Adaptateurs agrégateurs

Tout ce qui est spécifique à FedaPay, CinetPay ou M-Pesa vit derrière le port
[`PaymentProvider`](src/providers/types.ts). Le moteur ne connaît que ce type :
c'est ce qui permet de rerouter une transaction sans que le code métier sache
chez qui elle part.

**La règle qui protège du double paiement** vit dans le type, pas dans la doc.
Chaque échec agrégateur est traduit vers [`ProviderError`](src/providers/errors.ts),
qui expose deux propriétés dont découle toute la logique de reroutage :

| Code | `outcome` | Failover | Signification |
|---|---|---|---|
| `declined` | `failed` | oui | Refus explicite (solde insuffisant) |
| `unavailable` | `failed` | oui | Agrégateur en panne, requête jamais partie |
| `rate_limited` | `failed` | oui | Quota atteint, rejeu possible chez le même |
| `authentication` | `failed` | **non** | Credentials invalides — alerte, pas un aléa |
| `invalid_request` | `failed` | **non** | Notre requête est mauvaise |
| `timeout` | **`unknown`** | **non** | Pas de réponse — l'argent a pu partir |
| `indeterminate` | **`unknown`** | **non** | 5xx sur une création |
| `malformed_response` | **`unknown`** | **non** | Réponse illisible |

`unknown` n'est pas un statut d'erreur : c'est l'aveu que nous ignorons si
l'argent a bougé. Il ne peut être résolu que par une interrogation ultérieure de
l'agrégateur, **jamais par une nouvelle tentative**. Confondre `unknown` et
`failed` sur un décaissement, c'est payer deux fois.

Le client HTTP [`providerFetch`](src/providers/http.ts) impose cette traduction :
un 500 sur une *lecture* est une indisponibilité (rien n'a changé), le même 500
sur une *création* est indéterminé (l'agrégateur a pu traiter avant de tomber).

### Agrégateurs

| Agrégateur | Pays | Sens | État |
|---|---|---|---|
| `sandbox` | Tous (test uniquement) | pay-in + payout | **Actif** |
| `geniuspay` | 21 pays | **pay-in seul** | Écrit d'après la doc publique — **non validé** |
| `fedapay` | BJ, TG, CI, SN, NE | pay-in + payout | Écrit d'après la doc publique — **non validé** |
| `cinetpay` | 11 pays UEMOA/CEMAC | pay-in + payout | Écrit d'après la doc publique — **non validé** |

`connected` est calculé **par pays**, pas par agrégateur : un adaptateur
enregistré ne dessert pas forcément le pays consulté. GeniusPay est branché mais
sa documentation ne couvre pas le Tchad — l'annoncer disponible là-bas
produirait un échec au premier paiement.

`PROVIDERS_ENABLED` contrôle les adaptateurs enregistrés (`sandbox` par défaut).
Être présent dans le code ne suffit pas à recevoir du trafic : activer un
adaptateur non validé enverrait de vraies transactions sur un contrat supposé.
Ce qui reste à confirmer en sandbox est listé en tête de chaque fichier
d'adaptateur.

Deux décisions notables dans ces adaptateurs :

- **Un statut agrégateur inconnu devient `unknown`, jamais `failed`.** Déclarer
  un échec à tort autoriserait une relance sur une transaction peut-être aboutie.
- **La notification CinetPay est traitée comme un simple signal.** Elle n'est
  pas signée de façon vérifiable et documentée ; plutôt que d'inventer un schéma
  de signature, Orchi la lit pour en extraire l'identifiant, puis interroge
  `/v2/payment/check`. L'état vient toujours d'un appel sortant authentifié.
  Une notification forgée ne peut donc pas faire passer un paiement en
  `SUCCEEDED`.

### Page de paiement hébergée

`POST /v1/checkout-sessions` renvoie une URL vers laquelle rediriger le client.
Il choisit son opérateur, saisit son numéro, valide sur son téléphone — le
marchand n'écrit aucun tunnel de paiement.

Les moyens affichés sont déduits de la couverture **et** de ce que les
adaptateurs savent réellement traiter : un bouton qui échouerait n'est pas
proposé. Le jeton d'URL est la seule authentification de la page ; il n'expose
du marchand que son nom commercial, et recharger après paiement ne relance
aucune transaction.

### Simulateur

Le simulateur n'existe pas pour « faire semblant » mais pour déclencher à la
demande ce qu'aucun sandbox tiers ne produit de façon fiable. Le scénario est
choisi par les 4 derniers chiffres du numéro, ou par `metadata.sandbox_scenario`
(seule option en carte) :

| Suffixe | Scénario | Comportement |
|---|---|---|
| `0000` | `success` | Attente client, puis succès au premier polling |
| `0001` | `slow_success` | Succès après 2 pollings |
| `0002` | `declined` | Refus explicite, `insufficient_funds` |
| `0003` | `timeout` | **État inconnu** — aucun rejeu autorisé |
| `0004` | `unavailable` | Panne agrégateur, failover autorisé |
| `0005` | `rate_limited` | Quota dépassé |
| `0006` | `auth_error` | Credentials invalides |
| `0007` | `expired` | Le client ne confirme jamais |

Il est **interdit en environnement `live`** : `createCharge` refuse un contexte
non-`test`. Rejouer la même référence ne crée pas une seconde transaction — le
simulateur renvoie l'état existant, ce qui permet de tester l'idempotence.

### Encaisser et décaisser

```bash
curl -X POST http://localhost:3000/v1/payments   -H "Authorization: Bearer sk_test_..."   -H "Idempotency-Key: cmd-4821-a"   -H "content-type: application/json"   -d '{"reference":"cmd-4821","amount":15000,"currency":"XOF","country":"BJ","channel":"mobile_money","customer":{"phone":"+22997000000"}}'
```

La réponse ne dit **jamais** « payé ». Elle renvoie un statut et une **action à
faire exécuter par le client** :

```json
{ "status": "PROCESSING",
  "action": { "type": "ussd_push", "instructions": "Un push a été envoyé..." } }
```

Un paiement mobile money est asynchrone par nature. `GET /v1/payments/:id`
interroge l'agrégateur et fait avancer l'état.

### Les quatre protections contre le double paiement

Elles se recouvrent volontairement — chacune couvre ce que les autres laissent
passer :

1. **`Idempotency-Key`**, obligatoire sur `POST /v1/payments` et `/v1/payouts`.
   Même clé + même corps ⇒ la réponse d'origine est rejouée (en-tête
   `Idempotent-Replayed: true`). Même clé + corps différent ⇒ `409`. Durée de
   vie 24 h.
2. **La `reference` marchand**, unique et sans expiration. C'est le filet
   définitif : une clé d'idempotence périmée ne protège plus, une référence si.
3. **La ligne de tentative écrite avant l'appel sortant.** Si le processus meurt
   entre les deux, la trace existe et la réconciliation peut trancher.
4. **L'état `UNKNOWN`.** Sur timeout, un décaissement passe en `UNKNOWN` et y
   reste : ni relance, ni failover, ni échec déclaré.

```json
{ "status": "UNKNOWN",
  "warning": { "code": "indeterminate_state",
               "message": "L'issue de ce décaissement est inconnue. Ne le rejouez pas." } }
```

`POST /v1/payouts/:id/retry` répond alors `409 payout_indeterminate` avec
`retriable: false`. Seule une interrogation de l'agrégateur peut lever le
blocage.

### Failover

Il n'est tenté que sur un échec dont l'agrégateur **garantit** qu'il n'a rien
traité (`outcome: 'failed'`). Un `Payment` porte plusieurs `PaymentAttempt` :
chaque tentative garde son agrégateur, son état et sa référence externe. Le
marchand voit une ressource stable, l'historique complet reste auditable.

### Routage dynamique

Le score se calcule **par rapport aux autres candidats du même appel** — une
normalisation absolue n'aurait pas de sens, 2,5 % étant cher au Kenya et bon
marché au Tchad :

```
score = 0,45 × santé + 0,25 × coût + 0,20 × latence + 0,10 × préférence marchand
```

La santé domine volontairement : un agrégateur moins cher qui échoue une fois
sur trois coûte infiniment plus cher qu'un agrégateur fiable à 0,5 % de plus.

**La santé est lissée** — un agrégateur sans historique obtient 0,5, pas 0 ni 1.
Sans ce prior, le premier échec d'un agrégateur neuf le condamnerait, et un
agrégateur jamais essayé serait toujours préféré.

**Le départage est stable par intention** : dérivé d'un hash de la référence.
Une relance repart donc dans le même ordre, tout en répartissant le trafic
entre transactions différentes.

### Disjoncteur

Par `(agrégateur, pays, canal)` — **jamais global**. CinetPay peut être sain en
Côte d'Ivoire et injoignable au Mali ; un disjoncteur global couperait le
trafic sain avec le trafic malade.

Ce qui l'ouvre : `timeout`, `unavailable`, `rate_limited`, `indeterminate`.
Ce qui ne l'ouvre **jamais** : les refus clients (`declined`) et nos propres
requêtes invalides. Une veille de paie, beaucoup de clients n'ont pas de solde —
compter ces refus comme des pannes couperait un agrégateur en parfait état.

En pratique, **le disjoncteur intervient rarement** : dès qu'une alternative
saine existe, le score contourne l'agrégateur malade en quelques transactions.
Le disjoncteur est le filet pour le cas où le malade reste le seul candidat.

Séquence : `CLOSED → OPEN` (30 s) `→ HALF_OPEN` (une seule sonde à la fois)
`→ CLOSED` si elle réussit, ou `OPEN` avec attente doublée si elle échoue. Les
échecs survenant *après* l'ouverture ne rallongent pas l'attente — sinon une
rafale de requêtes en vol enverrait la temporisation au plafond dès la première
panne. Les disjoncteurs ouverts sont **restaurés au démarrage** : un
redéploiement ne doit pas relancer du trafic vers un agrégateur qu'on venait de
couper.

### Expliquer une transaction

```bash
curl -H "Authorization: Bearer sk_test_..." "http://localhost:3000/v1/routing/decisions?payment=pay_..."
```

Renvoie, pour chaque tentative : les candidats, leur score et son détail, et les
agrégateurs **écartés** avec le motif. Sans cette trace, impossible d'expliquer
à un marchand pourquoi sa transaction est partie chez tel agrégateur — donc
impossible de défendre le produit le jour où il conteste.

`GET /v1/routing/health` expose l'état des disjoncteurs, le taux de succès, la
latence p95 et le nombre de refus clients (suivis, mais sans effet sur le
disjoncteur).

### Tarification

**Le marchand paie toujours 5 % au total**, sur chaque transaction réussie. La
part Orchi est le **solde après la commission de l'agrégateur** : s'il prend
2 %, Orchi prend 3 % ; s'il prend 4 %, Orchi prend 1 %.

C'est ce qui rend le routage automatique acceptable pour le marchand : basculer
vers un agrégateur plus cher ne change pas sa facture.

Deux bornes, toutes deux atteintes par de vrais pays du catalogue :

- **agrégateur à 5 % ou plus** (Érythrée, RCA, Soudan) — la part Orchi tombe à
  zéro. Elle ne devient jamais négative : on ne paie pas pour transporter.
- **taux agrégateur inconnu** — la part Orchi vaudrait alors le taux entier, ce
  qui surfacturerait le marchand. Le taux est donc **figé sur la tentative** au
  moment du routage, et une modification ultérieure du catalogue ne recalcule
  pas rétroactivement une transaction passée.

> **Conséquence structurelle.** Prélever sur chaque transaction suppose d'être
> dans le flux des fonds : c'est le modèle **collecteur**, pas la passerelle
> technique décrite au cadrage. Cela réactive la trajectoire réglementaire
> (statut d'agent ou d'EME) et exige un accord sub-merchant avec chaque
> agrégateur. `PLATFORM_FEE_COLLECTION` documente le mode de perception.

### Ledger

Partie double. Un encaissement de 15 000 XOF avec un agrégateur à 2 % produit un
seul journal — plus sûr qu'en deux, un journal unique ne pouvant pas être à
moitié écrit :

```
payin.succeeded   DEBIT  provider:cinetpay:clearing  15000
                  CREDIT merchant:mch_x:receivable   14250
                  CREDIT provider:cinetpay:fees        300
                  CREDIT orchi:revenue                 450
```

`postJournal` refuse toute écriture déséquilibrée — une erreur doit échouer là
où elle est produite, pas être découverte six mois plus tard.

### Coffre de clés### Coffre de clés

`POST /v1/provider-accounts` enregistre les clés du marchand chez un agrégateur,
chiffrées en AES-256-GCM. L'API ne renvoie que les **noms** des champs
(`credential_keys`), jamais les valeurs.

### Webhooks et réconciliation

**Entrants.** Chaque compte agrégateur expose une `callback_url` portant un
jeton non devinable : `/v1/hooks/{provider}/{token}`. Ce jeton n'est pas
décoratif — une notification entrante n'indique pas de quel marchand elle
provient, donc quelles credentials utiliser pour vérifier sa signature.

Quatre règles, toutes issues du fait qu'un webhook est une entrée hostile :

- **On enregistre avant de traiter**, et même quand la signature est invalide :
  une rafale de webhooks non signés est un signal de sécurité, pas un
  non-évènement.
- **Le corps brut est conservé** : la signature porte sur les octets reçus, un
  JSON resérialisé ne se vérifie plus.
- **La déduplication est structurelle** — contrainte d'unicité sur
  `(agrégateur, id d'évènement)`. Les agrégateurs rejouent, c'est normal.
- **Un webhook ne fait jamais régresser un état terminal.** Celui qui arrive en
  retard n'écrase pas celui qui a conclu.

La réponse est toujours `200` dès lors que la requête est bien formée, **même
sur rejet** : un agrégateur qui reçoit une erreur réessaie longtemps, et rejouer
un évènement qu'on ne saura pas traiter n'aide personne.

**Sortants.** `Orchi-Signature: t=…,v1=…`, HMAC-SHA256 sur `<t>.<corps>`.
Livraison *au moins une fois*, 5 tentatives (30 s → 6 h), **sans ordre garanti**
— d'où l'état complet de la ressource dans chaque évènement plutôt qu'un delta.

**Le balayeur est le filet.** Aucune transaction ne dépend uniquement des
webhooks : ils se perdent, arrivent en double ou dans le désordre. Toute
tentative restée non terminale est réinterrogée, décaissements indéterminés
d'abord — c'est là que de l'argent est en jeu.

`GET /v1/reconciliation` liste ce qui reste à trancher.

### Workers

Sweeper, livraison des webhooks, instantané de santé et purge des clés
d'idempotence tournent dans le même processus que l'API. C'est délibéré : un
orchestrateur à quelques milliers de transactions par jour n'a pas besoin d'une
file distribuée, et l'ajouter trop tôt crée un point de panne de plus sans rien
résoudre. Les boucles ne partagent aucun état avec les routes — elles se
déplacent dans un worker dédié sans changer une ligne. `WORKERS_ENABLED=false`
les désactive.

## Commandes

### Catalogue

Les 54 États africains, 86 agrégateurs/opérateurs/banques et 145 règles de
couverture vivent en **base de données**, pas dans le code : ouvrir un pays,
corriger une commission ou couper un agrégateur défaillant se fait sans
redéploiement. Les fichiers `src/catalog/*.ts` restent la source versionnée,
rejouée par `npm run seed:catalog` (idempotent, refuse d'écrire si l'intégrité
du catalogue est en défaut).

```bash
curl -H "Authorization: Bearer sk_test_..." "http://localhost:3000/v1/coverage?country=BJ&direction=payout"
```

Deux champs méritent attention dans la réponse :

- **`routable_now`** — un agrégateur présent au catalogue n'est pas un
  agrégateur branché. Ce booléen dit si une transaction peut réellement passer
  aujourd'hui sur ce pays. Avec une clé `live`, il vaut `false` partout tant
  qu'aucun adaptateur n'est écrit.
- **`payout: false`** sur une règle ne veut pas dire « impossible » mais « pas
  via API standard » : un accord direct avec l'opérateur ou la banque est requis.
  C'est une information de vente autant que de technique.

Sainte-Hélène figure au catalogue avec `sovereign: false` et n'est jamais
comptée dans les 54 : `GET /v1/countries` renvoie 54, et 55 seulement avec
`?include_territories=true`.

Les fourchettes de commission sont **indicatives**, reprises du document de
cadrage. Elles servent au scoring de routage et à l'affichage commercial, et
doivent être remplacées par les taux contractuels réels avant toute facturation.

### Adaptateurs agrégateurs

Tout ce qui est spécifique à FedaPay, CinetPay ou M-Pesa vit derrière le port
[`PaymentProvider`](src/providers/types.ts). Le moteur ne connaît que ce type :
c'est ce qui permet de rerouter une transaction sans que le code métier sache
chez qui elle part.

**La règle qui protège du double paiement** vit dans le type, pas dans la doc.
Chaque échec agrégateur est traduit vers [`ProviderError`](src/providers/errors.ts),
qui expose deux propriétés dont découle toute la logique de reroutage :

| Code | `outcome` | Failover | Signification |
|---|---|---|---|
| `declined` | `failed` | oui | Refus explicite (solde insuffisant) |
| `unavailable` | `failed` | oui | Agrégateur en panne, requête jamais partie |
| `rate_limited` | `failed` | oui | Quota atteint, rejeu possible chez le même |
| `authentication` | `failed` | **non** | Credentials invalides — alerte, pas un aléa |
| `invalid_request` | `failed` | **non** | Notre requête est mauvaise |
| `timeout` | **`unknown`** | **non** | Pas de réponse — l'argent a pu partir |
| `indeterminate` | **`unknown`** | **non** | 5xx sur une création |
| `malformed_response` | **`unknown`** | **non** | Réponse illisible |

`unknown` n'est pas un statut d'erreur : c'est l'aveu que nous ignorons si
l'argent a bougé. Il ne peut être résolu que par une interrogation ultérieure de
l'agrégateur, **jamais par une nouvelle tentative**. Confondre `unknown` et
`failed` sur un décaissement, c'est payer deux fois.

Le client HTTP [`providerFetch`](src/providers/http.ts) impose cette traduction :
un 500 sur une *lecture* est une indisponibilité (rien n'a changé), le même 500
sur une *création* est indéterminé (l'agrégateur a pu traiter avant de tomber).

### Agrégateurs

| Agrégateur | Pays | Sens | État |
|---|---|---|---|
| `sandbox` | Tous (test uniquement) | pay-in + payout | **Actif** |
| `geniuspay` | 21 pays | **pay-in seul** | Écrit d'après la doc publique — **non validé** |
| `fedapay` | BJ, TG, CI, SN, NE | pay-in + payout | Écrit d'après la doc publique — **non validé** |
| `cinetpay` | 11 pays UEMOA/CEMAC | pay-in + payout | Écrit d'après la doc publique — **non validé** |

`connected` est calculé **par pays**, pas par agrégateur : un adaptateur
enregistré ne dessert pas forcément le pays consulté. GeniusPay est branché mais
sa documentation ne couvre pas le Tchad — l'annoncer disponible là-bas
produirait un échec au premier paiement.

`PROVIDERS_ENABLED` contrôle les adaptateurs enregistrés (`sandbox` par défaut).
Être présent dans le code ne suffit pas à recevoir du trafic : activer un
adaptateur non validé enverrait de vraies transactions sur un contrat supposé.
Ce qui reste à confirmer en sandbox est listé en tête de chaque fichier
d'adaptateur.

Deux décisions notables dans ces adaptateurs :

- **Un statut agrégateur inconnu devient `unknown`, jamais `failed`.** Déclarer
  un échec à tort autoriserait une relance sur une transaction peut-être aboutie.
- **La notification CinetPay est traitée comme un simple signal.** Elle n'est
  pas signée de façon vérifiable et documentée ; plutôt que d'inventer un schéma
  de signature, Orchi la lit pour en extraire l'identifiant, puis interroge
  `/v2/payment/check`. L'état vient toujours d'un appel sortant authentifié.
  Une notification forgée ne peut donc pas faire passer un paiement en
  `SUCCEEDED`.

### Page de paiement hébergée

`POST /v1/checkout-sessions` renvoie une URL vers laquelle rediriger le client.
Il choisit son opérateur, saisit son numéro, valide sur son téléphone — le
marchand n'écrit aucun tunnel de paiement.

Les moyens affichés sont déduits de la couverture **et** de ce que les
adaptateurs savent réellement traiter : un bouton qui échouerait n'est pas
proposé. Le jeton d'URL est la seule authentification de la page ; il n'expose
du marchand que son nom commercial, et recharger après paiement ne relance
aucune transaction.

### Simulateur

Le simulateur n'existe pas pour « faire semblant » mais pour déclencher à la
demande ce qu'aucun sandbox tiers ne produit de façon fiable. Le scénario est
choisi par les 4 derniers chiffres du numéro, ou par `metadata.sandbox_scenario`
(seule option en carte) :

| Suffixe | Scénario | Comportement |
|---|---|---|
| `0000` | `success` | Attente client, puis succès au premier polling |
| `0001` | `slow_success` | Succès après 2 pollings |
| `0002` | `declined` | Refus explicite, `insufficient_funds` |
| `0003` | `timeout` | **État inconnu** — aucun rejeu autorisé |
| `0004` | `unavailable` | Panne agrégateur, failover autorisé |
| `0005` | `rate_limited` | Quota dépassé |
| `0006` | `auth_error` | Credentials invalides |
| `0007` | `expired` | Le client ne confirme jamais |

Il est **interdit en environnement `live`** : `createCharge` refuse un contexte
non-`test`. Rejouer la même référence ne crée pas une seconde transaction — le
simulateur renvoie l'état existant, ce qui permet de tester l'idempotence.

### Encaisser et décaisser

```bash
curl -X POST http://localhost:3000/v1/payments   -H "Authorization: Bearer sk_test_..."   -H "Idempotency-Key: cmd-4821-a"   -H "content-type: application/json"   -d '{"reference":"cmd-4821","amount":15000,"currency":"XOF","country":"BJ","channel":"mobile_money","customer":{"phone":"+22997000000"}}'
```

La réponse ne dit **jamais** « payé ». Elle renvoie un statut et une **action à
faire exécuter par le client** :

```json
{ "status": "PROCESSING",
  "action": { "type": "ussd_push", "instructions": "Un push a été envoyé..." } }
```

Un paiement mobile money est asynchrone par nature. `GET /v1/payments/:id`
interroge l'agrégateur et fait avancer l'état.

### Les quatre protections contre le double paiement

Elles se recouvrent volontairement — chacune couvre ce que les autres laissent
passer :

1. **`Idempotency-Key`**, obligatoire sur `POST /v1/payments` et `/v1/payouts`.
   Même clé + même corps ⇒ la réponse d'origine est rejouée (en-tête
   `Idempotent-Replayed: true`). Même clé + corps différent ⇒ `409`. Durée de
   vie 24 h.
2. **La `reference` marchand**, unique et sans expiration. C'est le filet
   définitif : une clé d'idempotence périmée ne protège plus, une référence si.
3. **La ligne de tentative écrite avant l'appel sortant.** Si le processus meurt
   entre les deux, la trace existe et la réconciliation peut trancher.
4. **L'état `UNKNOWN`.** Sur timeout, un décaissement passe en `UNKNOWN` et y
   reste : ni relance, ni failover, ni échec déclaré.

```json
{ "status": "UNKNOWN",
  "warning": { "code": "indeterminate_state",
               "message": "L'issue de ce décaissement est inconnue. Ne le rejouez pas." } }
```

`POST /v1/payouts/:id/retry` répond alors `409 payout_indeterminate` avec
`retriable: false`. Seule une interrogation de l'agrégateur peut lever le
blocage.

### Failover

Il n'est tenté que sur un échec dont l'agrégateur **garantit** qu'il n'a rien
traité (`outcome: 'failed'`). Un `Payment` porte plusieurs `PaymentAttempt` :
chaque tentative garde son agrégateur, son état et sa référence externe. Le
marchand voit une ressource stable, l'historique complet reste auditable.

### Routage dynamique

Le score se calcule **par rapport aux autres candidats du même appel** — une
normalisation absolue n'aurait pas de sens, 2,5 % étant cher au Kenya et bon
marché au Tchad :

```
score = 0,45 × santé + 0,25 × coût + 0,20 × latence + 0,10 × préférence marchand
```

La santé domine volontairement : un agrégateur moins cher qui échoue une fois
sur trois coûte infiniment plus cher qu'un agrégateur fiable à 0,5 % de plus.

**La santé est lissée** — un agrégateur sans historique obtient 0,5, pas 0 ni 1.
Sans ce prior, le premier échec d'un agrégateur neuf le condamnerait, et un
agrégateur jamais essayé serait toujours préféré.

**Le départage est stable par intention** : dérivé d'un hash de la référence.
Une relance repart donc dans le même ordre, tout en répartissant le trafic
entre transactions différentes.

### Disjoncteur

Par `(agrégateur, pays, canal)` — **jamais global**. CinetPay peut être sain en
Côte d'Ivoire et injoignable au Mali ; un disjoncteur global couperait le
trafic sain avec le trafic malade.

Ce qui l'ouvre : `timeout`, `unavailable`, `rate_limited`, `indeterminate`.
Ce qui ne l'ouvre **jamais** : les refus clients (`declined`) et nos propres
requêtes invalides. Une veille de paie, beaucoup de clients n'ont pas de solde —
compter ces refus comme des pannes couperait un agrégateur en parfait état.

En pratique, **le disjoncteur intervient rarement** : dès qu'une alternative
saine existe, le score contourne l'agrégateur malade en quelques transactions.
Le disjoncteur est le filet pour le cas où le malade reste le seul candidat.

Séquence : `CLOSED → OPEN` (30 s) `→ HALF_OPEN` (une seule sonde à la fois)
`→ CLOSED` si elle réussit, ou `OPEN` avec attente doublée si elle échoue. Les
échecs survenant *après* l'ouverture ne rallongent pas l'attente — sinon une
rafale de requêtes en vol enverrait la temporisation au plafond dès la première
panne. Les disjoncteurs ouverts sont **restaurés au démarrage** : un
redéploiement ne doit pas relancer du trafic vers un agrégateur qu'on venait de
couper.

### Expliquer une transaction

```bash
curl -H "Authorization: Bearer sk_test_..." "http://localhost:3000/v1/routing/decisions?payment=pay_..."
```

Renvoie, pour chaque tentative : les candidats, leur score et son détail, et les
agrégateurs **écartés** avec le motif. Sans cette trace, impossible d'expliquer
à un marchand pourquoi sa transaction est partie chez tel agrégateur — donc
impossible de défendre le produit le jour où il conteste.

`GET /v1/routing/health` expose l'état des disjoncteurs, le taux de succès, la
latence p95 et le nombre de refus clients (suivis, mais sans effet sur le
disjoncteur).

### Ledger miroir

Orchi ne détient pas les fonds — pourquoi tenir une partie double ? Parce que
c'est le seul dispositif qui rend un écart **visible** : si le settlement de
l'agrégateur ne correspond pas à nos écritures, le déséquilibre saute aux yeux.
`postJournal` refuse toute écriture déséquilibrée.

Un encaissement de 15 000 XOF produit deux journaux distincts :

```
payin.succeeded   DEBIT  provider:sandbox:clearing     15000
                  CREDIT merchant:mch_x:receivable     15000
fee.accrued       DEBIT  merchant:mch_x:billing           75
                  CREDIT orchi:revenue                    75
```

Les séparer n'est pas cosmétique : en modèle A le marchand reçoit
**l'intégralité** de ce que verse l'agrégateur. La commission Orchi est une
créance à facturer, pas un prélèvement sur le flux.

### Coffre de clés

`POST /v1/provider-accounts` enregistre les clés du marchand chez un agrégateur,
chiffrées en AES-256-GCM. L'API ne renvoie que les **noms** des champs
(`credential_keys`), jamais les valeurs.

### Webhooks et réconciliation

**Entrants.** Chaque compte agrégateur expose une `callback_url` portant un
jeton non devinable : `/v1/hooks/{provider}/{token}`. Ce jeton n'est pas
décoratif — une notification entrante n'indique pas de quel marchand elle
provient, donc quelles credentials utiliser pour vérifier sa signature.

Quatre règles, toutes issues du fait qu'un webhook est une entrée hostile :

- **On enregistre avant de traiter**, et même quand la signature est invalide :
  une rafale de webhooks non signés est un signal de sécurité, pas un
  non-évènement.
- **Le corps brut est conservé** : la signature porte sur les octets reçus, un
  JSON resérialisé ne se vérifie plus.
- **La déduplication est structurelle** — contrainte d'unicité sur
  `(agrégateur, id d'évènement)`. Les agrégateurs rejouent, c'est normal.
- **Un webhook ne fait jamais régresser un état terminal.** Celui qui arrive en
  retard n'écrase pas celui qui a conclu.

La réponse est toujours `200` dès lors que la requête est bien formée, **même
sur rejet** : un agrégateur qui reçoit une erreur réessaie longtemps, et rejouer
un évènement qu'on ne saura pas traiter n'aide personne.

**Sortants.** `Orchi-Signature: t=…,v1=…`, HMAC-SHA256 sur `<t>.<corps>`.
Livraison *au moins une fois*, 5 tentatives (30 s → 6 h), **sans ordre garanti**
— d'où l'état complet de la ressource dans chaque évènement plutôt qu'un delta.

**Le balayeur est le filet.** Aucune transaction ne dépend uniquement des
webhooks : ils se perdent, arrivent en double ou dans le désordre. Toute
tentative restée non terminale est réinterrogée, décaissements indéterminés
d'abord — c'est là que de l'argent est en jeu.

`GET /v1/reconciliation` liste ce qui reste à trancher.

### Workers

Sweeper, livraison des webhooks, instantané de santé et purge des clés
d'idempotence tournent dans le même processus que l'API. C'est délibéré : un
orchestrateur à quelques milliers de transactions par jour n'a pas besoin d'une
file distribuée, et l'ajouter trop tôt crée un point de panne de plus sans rien
résoudre. Les boucles ne partagent aucun état avec les routes — elles se
déplacent dans un worker dédié sans changer une ligne. `WORKERS_ENABLED=false`
les désactive.

## Commandes

| Commande | Rôle |
|---|---|
| `npm run dev` | serveur en rechargement à chaud |
| `npm run typecheck` | vérification TypeScript stricte |
| `npm test` | suite de tests (Vitest, base isolée) |
| `npm run db:migrate` | applique les migrations Prisma |
| `npm run db:studio` | explorateur de base |
| `npm run seed` | catalogue + marchand de démo et sa clé API |
| `npm run seed:catalog` | (re)synchronise le catalogue seul |

## Structure

```
src/
├── catalog/       54 pays, devises, agrégateurs, matrice de couverture
├── core/          env validée, erreurs, logger, crypto, money, ids
├── providers/     port PaymentProvider, taxonomie d'échecs, HTTP, sandbox
├── routing/       santé, disjoncteur, scoring, sélection, traçabilité
├── modules/       payments, payouts, ledger, pricing, comptes agrégateurs,
│                  webhooks (entrants/sortants), réconciliation
├── workers/       boucles de fond
├── db/            client Prisma
├── api/
│   ├── plugins/   authentification, gestionnaire d'erreurs
│   └── routes/    health, me, catalog
├── server.ts      assemblage Fastify
└── index.ts       démarrage + arrêt propre
```

## Sécurité

- Les secrets de clés API ne sont **jamais** stockés : seul un HMAC-SHA256 avec
  un pepper conservé hors base l'est. Une fuite de la base seule ne permet pas de
  rejouer les clés.
- Les identifiants agrégateurs des marchands sont chiffrés en AES-256-GCM
  (`src/core/crypto.ts`), avec un préfixe de version permettant la rotation.
- Le logger applique une redaction sur `authorization`, `credentials`, `*.secret`,
  `*.apiKey`.
- Le processus refuse de démarrer si une variable d'environnement est absente ou
  malformée.

## Montants

Tous les montants circulent en **unités mineures entières**, jamais en
flottants. L'exposant dépend de la devise et c'est la donnée la plus dangereuse
du catalogue :

| Valeur envoyée | Devise | Signification |
|---|---|---|
| `15000` | XOF / XAF | 15 000 francs (exposant 0) |
| `15000` | KES | 150,00 shillings (exposant 2) |
| `15000` | TND | 15,000 dinars (exposant 3) |

`assertValidAmount` **refuse** un montant décimal plutôt que de l'arrondir en
silence : `1500.5 XOF` est une erreur d'unité côté intégrateur, pas une valeur à
corriger discrètement.

## Tests

La suite tourne sur **sa propre base** (`prisma/test.db`), copiée depuis
`dev.db` au démarrage et jamais partagée. Sans cette isolation, les tests
partagent la base avec le serveur de développement, dont le balayeur interroge
et modifie les mêmes transactions au milieu d'une assertion — symptôme typique :
une suite qui passe fichier par fichier mais échoue en entier.

Les workers sont désactivés pendant les tests pour la même raison. La base de
test est conservée après coup : inspecter l'état laissé par un test qui vient
d'échouer est souvent le chemin le plus court vers la cause.

## Base de données

SQLite en développement, PostgreSQL en production. Le schéma reste portable :
pas d'enum natif, pas de type `Json`, pas de tableau. Pour passer à Postgres,
changer `provider` dans `prisma/schema.prisma` et `DATABASE_URL`.

## Feuille de route

| Étape | Contenu | État |
|---|---|---|
| 0 | Socle : Fastify, Prisma, config, auth, erreurs | **fait** |
| 1 | Catalogue 54 pays + `GET /v1/coverage` | **fait** |
| 2 | Port `PaymentProvider` + adaptateur sandbox | **fait** |
| 3 | Payments / Payouts + idempotence + ledger | **fait** |
| 4 | Routage + circuit breaker par (provider, pays, canal) | à venir |
| 5 | Adaptateurs FedaPay et CinetPay | **fait** (à valider en sandbox) |
| 6 | Webhooks entrants/sortants, sweeper, réconciliation | **fait** |
