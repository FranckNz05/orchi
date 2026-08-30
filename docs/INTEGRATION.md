# Intégrer Orchi

Guide d'intégration de l'API Orchi : encaisser (*pay-in*) et décaisser (*payout*)
en Afrique à travers une interface unique, quel que soit l'agrégateur.

> **État actuel.** Webhooks entrants et sortants, balayeur et réconciliation
> sont en place. Seul le simulateur est activé côté agrégateurs. Les adaptateurs FedaPay et
> CinetPay sont écrits mais **non validés** contre un compte sandbox réel — voir
> [Agrégateurs disponibles](#agrégateurs-disponibles). Vous pouvez développer et
> tester intégralement votre intégration dès aujourd'hui.

---

## 1. Le principe : Orchi ne détient pas vos fonds

Vous ouvrez vos propres comptes chez les agrégateurs (FedaPay, CinetPay…) et
vous confiez vos clés à Orchi, qui les conserve **chiffrées**. Orchi route,
réconcilie, et prélève sa commission sur chaque transaction réussie.

Ce que cela change concrètement pour vous :

| | Conséquence |
|---|---|
| Règlement | Vous êtes réglé par votre agrégateur, selon vos conditions avec lui |
| Commission agrégateur | Prélevée par lui, sur le flux, comme aujourd'hui |
| Commission Orchi | Retenue sur le flux, transaction par transaction (voir §10) |
| Réglementation | Vous restez le marchand de référence ; Orchi n'est pas dans la chaîne de détention de fonds |

---

## 2. Authentification

Toutes les requêtes portent une clé API en jeton porteur :

```bash
curl -H "Authorization: Bearer sk_test_..." https://api.orchi.africa/v1/me
```

Deux environnements, deux préfixes :

| Préfixe | Environnement | Comportement |
|---|---|---|
| `sk_test_…` | test | Le simulateur est disponible ; aucun mouvement réel |
| `sk_live_…` | live | Agrégateurs réels uniquement ; le simulateur est **refusé** |

La clé n'est affichée qu'une seule fois à sa création. Orchi n'en conserve
qu'une empreinte HMAC : elle ne peut pas être retrouvée, seulement révoquée et
remplacée.

**Scopes** disponibles : `payments:read`, `payments:write`, `payouts:read`,
`payouts:write`, `accounts:write`.

---

## 3. Montants et devises

**Tous les montants sont des entiers en unités mineures.** Jamais de décimales.

| Valeur envoyée | Devise | Signification |
|---|---|---|
| `15000` | XOF, XAF | 15 000 francs — exposant 0 |
| `15000` | NGN, KES, GHS | 150,00 — exposant 2 |
| `15000` | TND, LYD | 15,000 dinars — exposant 3 |

Un montant décimal est **refusé**, jamais arrondi : `1500.5 XOF` est une erreur
d'unité de votre côté, pas une valeur à corriger discrètement.

La devise doit correspondre au pays. Envoyer `XOF` sur un pays en `XAF` renvoie
une `400` indiquant la devise attendue.

```bash
curl -H "Authorization: Bearer sk_test_..." \
  "https://api.orchi.africa/v1/coverage?country=BJ"
```

---

## 4. Connecter un compte agrégateur

Sans compte agrégateur connecté, aucune transaction ne peut partir.

```bash
curl -X POST https://api.orchi.africa/v1/provider-accounts \
  -H "Authorization: Bearer sk_test_..." \
  -H "content-type: application/json" \
  -d '{
    "provider": "sandbox",
    "credentials": { "webhook_secret": "..." },
    "priority": 1
  }'
```

`priority` exprime **votre** préférence : plus la valeur est basse, plus
l'agrégateur est privilégié à qualité de service égale.

Credentials attendus par agrégateur :

| Agrégateur | Champs requis | Champs supplémentaires pour les décaissements |
|---|---|---|
| `sandbox` | `webhook_secret` | — |
| `fedapay` | `secret_key`, `webhook_secret` | — |
| `cinetpay` | `apikey`, `site_id` | `transfer_login`, `transfer_password` |

`GET /v1/provider-accounts` liste vos comptes. La réponse ne contient que les
**noms** des champs (`credential_keys`), jamais leurs valeurs.

---

## 5. Encaisser

```bash
curl -X POST https://api.orchi.africa/v1/payments \
  -H "Authorization: Bearer sk_test_..." \
  -H "Idempotency-Key: cmd-4821-a" \
  -H "content-type: application/json" \
  -d '{
    "reference": "cmd-4821",
    "amount": 15000,
    "currency": "XOF",
    "country": "BJ",
    "channel": "mobile_money",
    "customer": { "phone": "+22997000000", "name": "Jean Dupont" }
  }'
```

### La réponse ne dit jamais « payé »

Un paiement mobile money est **asynchrone par nature** : l'opérateur envoie une
demande sur le téléphone du client, qui la valide avec son code PIN. Orchi vous
renvoie donc un statut et **une action à faire exécuter** :

```json
{
  "object": "payment",
  "id": "pay_mte4...",
  "reference": "cmd-4821",
  "status": "PROCESSING",
  "action": {
    "type": "ussd_push",
    "instructions": "Une demande de paiement a été envoyée sur le téléphone du client."
  },
  "provider": { "id": "sandbox", "reference": "sbx_ch_..." },
  "attempts": [ { "number": 1, "provider": "sandbox", "status": "AWAITING_CUSTOMER" } ]
}
```

Trois formes d'action :

| `action.type` | Ce que vous devez faire |
|---|---|
| `ussd_push` | Afficher les instructions ; le client valide sur son téléphone |
| `redirect` | Rediriger le navigateur vers `action.url` |
| `none` | Rien — la transaction est terminée |

### Statuts d'un paiement

```
CREATED → PROCESSING → SUCCEEDED
                    ↘ FAILED
                    ↘ EXPIRED
```

`PROCESSING` couvre aussi le cas où l'issue est **indéterminée** (voir §7).
Consultez `attempts[].status` pour le détail.

`GET /v1/payments/:id` interroge l'agrégateur et fait avancer l'état.

### Relancer

Si un paiement échoue, `POST /v1/payments/:id/retry` tente un **autre**
agrégateur. La relance est refusée (`409`) tant qu'une tentative est encore
ouverte : deux demandes de paiement vivantes sur un même client, c'est un double
débit.

---

## 5bis. Encaisser sans écrire de tunnel de paiement

L'intégration la plus courte possible : vous créez une **session**, vous
redirigez votre client, et vous ne manipulez ni numéro de téléphone, ni choix
d'opérateur, ni état de push USSD.

```bash
curl -X POST https://api.orchi.africa/v1/checkout-sessions \
  -H "Authorization: Bearer sk_test_..." \
  -H "content-type: application/json" \
  -d '{
    "reference": "cmd-4821",
    "amount": 25000,
    "currency": "XOF",
    "country": "BJ",
    "description": "Billet Concert",
    "success_url": "https://votre-site.com/merci",
    "cancel_url": "https://votre-site.com/panier"
  }'
```

```json
{
  "object": "checkout_session",
  "id": "cs_mte4...",
  "status": "OPEN",
  "url": "https://api.orchi.africa/pay/syY0QnCD1BUmzDvjJsVaqrL-U_8l71mj...",
  "expires_at": "2026-08-29T13:00:00.000Z"
}
```

Redirigez votre client vers `url`. C'est tout.

### Ce que voit le client

Une page servie par Orchi affichant votre nom commercial, le montant, et
**les opérateurs réellement disponibles dans son pays** — MTN MoMo, Moov Money,
Orange Money, carte bancaire selon le cas. Il choisit, saisit son numéro,
valide sur son téléphone. La page suit l'état en direct et le renvoie sur votre
`success_url`.

Les moyens proposés sont déduits de la couverture **et** de ce que les
adaptateurs branchés savent réellement traiter : un bouton qui échouerait n'est
pas affiché.

### Suivre l'issue

Trois façons, par ordre de préférence :

1. **Webhook** `payment.succeeded` — la bonne méthode (voir §7bis).
2. `GET /v1/checkout-sessions/:id` — renvoie la session *et* le paiement complet.
3. La redirection vers `success_url` — pratique, mais ne vous y fiez jamais
   seule : un client qui ferme son navigateur ne la déclenche pas.

### Durée de vie et sécurité

Une session expire au bout d'**une heure** par défaut (`expires_in_minutes`,
de 5 min à 24 h). Passé ce délai, la page affiche « lien expiré ».

Le jeton dans l'URL est la seule authentification de cette page. Il fait
32 octets, ne donne accès qu'à **cette** session, et n'expose du marchand que
son nom commercial — ni identifiant, ni métadonnées, ni autres transactions.
La page porte `noindex` : un lien de paiement n'a rien à faire dans un moteur
de recherche.

Recharger la page après paiement ne relance **aucune** transaction.

---

## 6. Décaisser

```bash
curl -X POST https://api.orchi.africa/v1/payouts \
  -H "Authorization: Bearer sk_test_..." \
  -H "Idempotency-Key: po-9981-a" \
  -H "content-type: application/json" \
  -d '{
    "reference": "po-9981",
    "amount": 50000,
    "currency": "XOF",
    "country": "BJ",
    "channel": "mobile_money",
    "recipient": { "phone": "+22997000000", "network": "MTN_BENIN", "name": "Jean Dupont" }
  }'
```

Statuts : `CREATED → PROCESSING → SUCCEEDED | FAILED | UNKNOWN`.

---

## 7. `UNKNOWN` : la règle la plus importante de cette API

Quand un appel à l'agrégateur n'aboutit pas — délai dépassé, erreur serveur — il
est **impossible de savoir si l'argent est parti**. Orchi ne devine pas :

```json
{
  "status": "UNKNOWN",
  "warning": {
    "code": "indeterminate_state",
    "message": "L'issue de ce décaissement est inconnue. Ne le rejouez pas."
  }
}
```

Dans cet état :

- Orchi n'essaie **aucun autre agrégateur**.
- `POST /v1/payouts/:id/retry` répond `409 payout_indeterminate` avec
  `retriable: false`.
- Seule une interrogation de l'agrégateur (`GET /v1/payouts/:id`) peut lever le
  blocage.

**Ce que vous devez faire :** interroger la ressource, pas la rejouer. Un
virement rejoué dans le doute, c'est un virement payé deux fois.

---

## 7bis. Recevoir nos évènements (webhooks sortants)

Interroger `GET /v1/payments/:id` en boucle fonctionne, mais ne passe pas à
l'échelle. Déclarez un endpoint et Orchi vous notifie.

```bash
curl -X POST https://api.orchi.africa/v1/webhook-endpoints \
  -H "Authorization: Bearer sk_test_..." \
  -H "content-type: application/json" \
  -d '{"url":"https://votre-site.com/orchi/hooks","events":["*"]}'
```

La réponse contient un `secret` (`whsec_…`) **montré une seule fois**.

### Évènements émis

| Évènement | Quand |
|---|---|
| `payment.succeeded` | L'encaissement a abouti |
| `payment.failed` | L'encaissement a échoué |
| `payment.expired` | Le client n'a jamais confirmé |
| `payout.succeeded` | Le décaissement est parti |
| `payout.failed` | Le décaissement a échoué |
| `payout.indeterminate` | **L'issue est inconnue — action requise** |

### Forme d'un évènement

```json
{
  "id": "evt_pay_mte4..._payment.succeeded",
  "type": "payment.succeeded",
  "created_at": "2026-08-29T09:14:22.001Z",
  "data": { "object": "payment", "id": "pay_mte4...", "status": "SUCCEEDED", "...": "..." }
}
```

`data` contient l'**état complet** de la ressource, jamais un delta. Ce n'est pas
une facilité : **l'ordre de livraison n'est pas garanti**, et un delta serait
ininterprétable si les évènements arrivent inversés.

### Vérifier la signature

En-tête `Orchi-Signature: t=<horodatage>,v1=<hmac>`. Le HMAC-SHA256 porte sur
`<t>.<corps brut>`, calculé avec votre secret.

```js
import { createHmac, timingSafeEqual } from 'node:crypto';

function verify(rawBody, header, secret) {
  const parts = Object.fromEntries(header.split(',').map((p) => p.split('=')));
  // Rejeter au-delà de 5 minutes : sans cela, un évènement capturé serait rejouable.
  if (Math.abs(Date.now() / 1000 - Number(parts.t)) > 300) return false;
  const expected = createHmac('sha256', secret).update(`${parts.t}.${rawBody}`).digest('hex');
  return timingSafeEqual(Buffer.from(parts.v1), Buffer.from(expected));
}
```

**Utilisez le corps brut**, pas le JSON reparsé puis resérialisé : la signature
porte sur les octets reçus.

### Trois règles pour votre endpoint

1. **Répondez `2xx` rapidement**, puis traitez en tâche de fond. Nous coupons
   au-delà de 10 secondes.
2. **Soyez idempotent.** La livraison est *au moins une fois* : le même
   évènement peut arriver deux fois. L'`id` est stable — dédupliquez dessus.
3. **N'attendez pas un ordre.** Fiez-vous à `data.status`, pas à la séquence
   d'arrivée.

En cas d'échec, nous réessayons **5 fois** : 30 s, 2 min, 10 min, 1 h, 6 h.
Ensuite la livraison est abandonnée. `GET /v1/webhook-deliveries` donne le
journal complet, avec le code HTTP et l'erreur de chaque tentative.

---

## 7ter. Déclarer l'URL de callback chez votre agrégateur

`GET /v1/provider-accounts` renvoie, pour chaque compte, un champ
`callback_url` :

```
https://api.orchi.africa/v1/hooks/fedapay/xK9mP2vQ...
```

**Copiez-la dans le tableau de bord de votre agrégateur.** Le jeton final n'est
pas décoratif : une notification entrante n'indique pas de quel marchand elle
provient, donc quelles credentials utiliser pour vérifier sa signature. C'est
l'URL qui porte cette information.

Sans cette déclaration, tout continue de fonctionner — le balayeur interroge les
agrégateurs toutes les minutes — mais les confirmations arrivent avec un délai
au lieu d'être immédiates.

---

## 7quater. Ce qui se passe si un webhook se perd

Rien de grave, et c'est délibéré. **Aucune transaction ne dépend uniquement des
webhooks.** Un balayeur reprend en continu toute tentative restée non terminale
et va demander son état à l'agrégateur, dans cet ordre de priorité :

1. les décaissements **indéterminés** — de l'argent est peut-être parti ;
2. les décaissements en cours ;
3. les encaissements en cours.

`GET /v1/reconciliation` liste ce qui reste à trancher :

```json
{
  "indeterminate_payouts": [
    { "id": "po_...", "reference": "po-9981", "amount": 50000, "currency": "XOF",
      "provider": "fedapay", "since": "2026-08-29T09:02:11.000Z" }
  ],
  "stuck_payments": 0,
  "undelivered_events": 0,
  "rejected_webhooks_24h": 0
}
```

C'est le seul écran à surveiller quotidiennement : les décaissements
indéterminés sont les seuls éléments qui peuvent demander une décision humaine.

---

## 8. Idempotence

`Idempotency-Key` est **obligatoire** sur `POST /v1/payments` et
`POST /v1/payouts`.

| Situation | Réponse |
|---|---|
| Même clé, même corps | La réponse d'origine est rejouée — en-tête `Idempotent-Replayed: true` |
| Même clé, corps différent | `409 idempotency_key_reused` |
| Requête encore en cours | `409 request_in_progress`, avec `resource_id` pour la consulter |
| Clé absente | `400 idempotency_key_required` |

Durée de vie d'une clé : **24 heures**.

### Le second filet : votre `reference`

La `reference` que vous fournissez est unique chez vous et **n'expire jamais**.
Réutiliser une référence avec un montant identique renvoie la transaction
existante ; avec un montant différent, `409 duplicate_reference`.

C'est la protection qui subsiste quand la clé d'idempotence a expiré. Utilisez
votre identifiant de commande métier, pas un UUID aléatoire.

---

## 9. Erreurs

Toutes les erreurs partagent la même forme :

```json
{
  "error": {
    "type": "invalid_request_error",
    "code": "duplicate_reference",
    "message": "La référence cmd-4821 désigne déjà un paiement de montant différent.",
    "retriable": false,
    "request_id": "req_mte4..."
  }
}
```

**`retriable` est le champ le plus important du corps.** Il dit si rejouer la
requête est sûr. Ne construisez pas votre logique de reprise sur le code HTTP.

| `type` | HTTP | Signification |
|---|---|---|
| `authentication_error` | 401 | Clé absente, invalide ou révoquée |
| `permission_error` | 403 | Scope insuffisant, ou compte suspendu |
| `invalid_request_error` | 400 / 404 / 409 | Requête malformée ou conflit |
| `idempotency_error` | 400 / 409 | Problème de clé d'idempotence |
| `routing_error` | 422 | Aucun agrégateur ne peut traiter la transaction |
| `provider_error` | 502 | L'agrégateur a refusé ou est indisponible |
| `rate_limit_error` | 429 | Trop de requêtes |
| `api_error` | 500 | Erreur interne |

Communiquez toujours le `request_id` au support : il figure dans nos journaux.

---

## 10. Tarifs

### Un taux unique, tout compris

**Vous payez 5 % au total sur chaque transaction réussie.** Pas d'abonnement,
pas de frais fixe, pas de facture en fin de mois.

La commission Orchi n'est que **le solde après celle de votre agrégateur** :

| Commission agrégateur | Commission Orchi | Votre coût total |
|---|---|---|
| 1,0 % | 4,0 % | **5 %** |
| 2,0 % | 3,0 % | **5 %** |
| 3,5 % | 1,5 % | **5 %** |
| 4,5 % | 0,5 % | **5 %** |
| 5,0 % et plus | 0 | **égal à celui de l'agrégateur** |

C'est ce qui rend le routage automatique acceptable pour vous : quand Orchi
bascule vers un agrégateur plus cher parce que le premier est tombé, **votre
facture ne bouge pas**.

### Exemple

Encaissement de 15 000 XOF au Bénin, agrégateur à 2,0 % :

```
Le client paie                    15 000 XOF
Commission agrégateur (2,0 %)       −300 XOF
Commission Orchi (3,0 %)            −450 XOF
Vous recevez                      14 250 XOF
Coût total                            750 XOF · 5,00 %
```

Le même encaissement via un agrégateur à 4,0 % : celui-ci prend 600 XOF, Orchi
prend 150 XOF, et vous recevez toujours **14 250 XOF**.

Chaque transaction expose son détail :

```json
"fees": { "provider": 300, "platform": 450 }
```

### Prélèvement

La commission est **retenue sur le flux, transaction par transaction** — elle
n'est pas facturée séparément. Le mode de perception effectif est réglé par
`PLATFORM_FEE_COLLECTION` :

| Valeur | Mécanisme |
|---|---|
| `split` | L'agrégateur reverse directement la part Orchi (accord requis) |
| `on_top` | La part est ajoutée au montant payé par le client final |
| `invoice` | La part est constatée puis facturée séparément |

> **Conséquence à connaître.** Prélever sur le flux signifie qu'Orchi se trouve
> dans le chemin des fonds. C'est le modèle **collecteur**, qui suppose un
> accord sub-merchant avec chaque agrégateur et une trajectoire réglementaire
> (statut d'agent ou d'EME). Le mode `invoice` est la seule variante qui reste
> hors flux.

### Transactions échouées

**Aucun frais.** Ni de l'agrégateur, ni d'Orchi.

### Une limite honnête

Quelques pays du catalogue ont des commissions agrégateur **supérieures à 5 %**
— Érythrée, et le haut de fourchette en RCA et au Soudan. Dans ces cas la part
d'Orchi tombe à zéro : la transaction passe, elle ne rapporte simplement rien.
Le champ `fees.platform` vaut alors `0`.

### Taux configurable

`PLATFORM_TOTAL_PAYIN_BPS` et `PLATFORM_TOTAL_PAYOUT_BPS` fixent le taux total
en points de base (500 = 5,00 %). Une tarification négociée par marchand est
prévue mais pas encore implémentée.

## 11. Environnement de test

Avec une clé `sk_test_`, le simulateur couvre **tous les pays et tous les
canaux**. Vous pouvez développer votre intégration complète avant d'avoir signé
le moindre contrat agrégateur.

Le scénario est déclenché par les **4 derniers chiffres du numéro**, ou par
`metadata.sandbox_scenario` (seule option en carte) :

| Suffixe | Scénario | Ce que vous observez |
|---|---|---|
| `0000` | succès | `PROCESSING`, puis `SUCCEEDED` à la première lecture |
| `0001` | succès lent | `SUCCEEDED` après deux lectures |
| `0002` | refus client | `FAILED`, code `insufficient_funds` |
| `0003` | délai dépassé | **`UNKNOWN`** — testez votre logique de non-rejeu |
| `0004` | agrégateur en panne | Bascule vers un autre agrégateur |
| `0005` | quota dépassé | `rate_limited` |
| `0006` | credentials invalides | `authentication` |
| `0007` | client ne confirme jamais | `EXPIRED` |

Testez impérativement **`0003`**. C'est le seul scénario qui met en jeu de
l'argent réel en production.

---

## 12. Routage : ce qu'il faut savoir

Orchi choisit l'agrégateur à la **création de chaque tentative**, d'après :

```
score = 0,45 × santé + 0,25 × coût + 0,20 × latence + 0,10 × votre préférence
```

Deux conséquences pour vous :

1. **Le basculement n'est pas magique.** Une fois la demande envoyée au
   téléphone du client, la transaction appartient à cet agrégateur. Le
   basculement se joue avant, ou lors d'une relance explicite.
2. **Router vers plusieurs agrégateurs suppose d'avoir un compte chez chacun.**
   Un seul compte connecté signifie aucun basculement possible.

Un agrégateur qui tombe est écarté automatiquement — d'abord par son score,
puis par un disjoncteur si l'incident persiste. Vous pouvez inspecter chaque
décision :

```bash
curl -H "Authorization: Bearer sk_test_..." \
  "https://api.orchi.africa/v1/routing/decisions?payment=pay_..."
```

---

## 13. Passer en production

- [ ] Comptes ouverts chez au moins **deux** agrégateurs du pays visé — sans
      quoi il n'y a pas de basculement possible
- [ ] Dossier KYB accepté par chacun (RCCM, CAC, NINEA… selon la juridiction ;
      `GET /v1/countries` indique l'exigence par pays)
- [ ] Clés `live` créées et connectées via `POST /v1/provider-accounts`
- [ ] Scénario `0003` testé de bout en bout : votre code ne doit **jamais**
      rejouer un décaissement `UNKNOWN`
- [ ] `Idempotency-Key` posé sur 100 % des créations
- [ ] Vos `reference` sont des identifiants métier stables, pas des aléas
- [ ] Vous stockez le `request_id` des erreurs
- [ ] Si vous utilisez la page hébergée : vous confirmez l'issue par webhook ou par `GET /v1/checkout-sessions/:id`, **jamais** par la seule redirection
- [ ] `callback_url` déclarée chez chaque agrégateur
- [ ] Endpoint de webhook déclaré, signature vérifiée, traitement idempotent
- [ ] `GET /v1/reconciliation` surveillé quotidiennement

---

## 14. Référence des endpoints

| Méthode | Chemin | Rôle |
|---|---|---|
| `GET` | `/health`, `/health/ready` | Disponibilité |
| `GET` | `/v1/me` | Identité associée à la clé |
| `GET` | `/v1/countries` | Les 54 pays couverts |
| `GET` | `/v1/coverage?country=BJ` | Agrégateurs, canaux, KYC, frais |
| `POST` | `/v1/provider-accounts` | Connecter un compte agrégateur |
| `GET` | `/v1/provider-accounts` | Lister ses comptes |
| `DELETE` | `/v1/provider-accounts/:id` | Désactiver un compte |
| `POST` | `/v1/checkout-sessions` | Créer une page de paiement hébergée |
| `GET` | `/v1/checkout-sessions/:id` | Consulter une session et son paiement |
| `POST` | `/v1/payments` | Créer un encaissement |
| `GET` | `/v1/payments/:id` | Consulter et rafraîchir |
| `POST` | `/v1/payments/:id/retry` | Relancer chez un autre agrégateur |
| `POST` | `/v1/payouts` | Créer un décaissement |
| `GET` | `/v1/payouts/:id` | Consulter et rafraîchir |
| `POST` | `/v1/payouts/:id/retry` | Relancer (refusé si `UNKNOWN`) |
| `POST` | `/v1/webhook-endpoints` | Déclarer un endpoint de notification |
| `GET` | `/v1/webhook-endpoints` | Lister ses endpoints |
| `DELETE` | `/v1/webhook-endpoints/:id` | Désactiver un endpoint |
| `GET` | `/v1/webhook-deliveries` | Journal des livraisons |
| `GET` | `/v1/reconciliation` | Points à trancher |
| `GET` | `/v1/routing/health` | État des agrégateurs |
| `GET` | `/v1/routing/decisions` | Pourquoi cette transaction est partie là |

---

## Agrégateurs disponibles

| Agrégateur | Pays | Sens | État de l'intégration |
|---|---|---|---|
| `sandbox` | Tous (test uniquement) | pay-in + payout | **Actif** |
| `geniuspay` | 21 pays — UEMOA, CEMAC, Afrique de l'Est et australe | **pay-in seul** | Écrit d'après la doc publique — **non validé en sandbox réel** |
| `fedapay` | BJ, TG, CI, SN, NE | pay-in + payout | Écrit d'après la doc publique — **non validé en sandbox réel** |
| `cinetpay` | CI, BJ, TG, ML, BF, NE, SN, GW, GN, CM, CD | pay-in + payout | Écrit d'après la doc publique — **non validé en sandbox réel** |

**GeniusPay** couvre CI, SN, ML, BF, BJ, TG, NE, GW, GH, NG, SL, CM, GA, CG, CF,
CD, KE, RW, UG, ZM, ZA. Son API de décaissement n'étant pas publiée, aucun
virement sortant n'y est routé — `supports()` renvoie `false` pour les payouts.

Deux pays (Tchad, Guinée équatoriale) figurent au catalogue avec GeniusPay
d'après le document de cadrage mais **sont absents de sa documentation
publique** : `GET /v1/coverage` les renvoie avec `connected: false`, et le
routeur les ignore.

Les deux adaptateurs sont désactivés par défaut (`PROVIDERS_ENABLED=sandbox`).
Les activer avant validation enverrait de vraies transactions sur un contrat
supposé. Le détail de ce qui reste à confirmer figure en tête de
[`src/providers/fedapay.ts`](../src/providers/fedapay.ts) et
[`src/providers/cinetpay.ts`](../src/providers/cinetpay.ts).

Les 54 pays du catalogue sont **documentés**, pas branchés :
`GET /v1/coverage` renvoie `routable_now` et, par agrégateur, `connected` —
deux champs qui disent la vérité sur ce qui peut réellement passer aujourd'hui.
