# Intégrer Afripaie

Guide d'intégration de l'API Afripaie : encaisser (*pay-in*) et décaisser (*payout*)
en Afrique à travers une interface unique, quel que soit l'agrégateur.

> **État actuel.** Webhooks entrants et sortants, balayeur et réconciliation
> sont en place. Deux agrégateurs sont activés : le **simulateur** et
> **GeniusPay**, dont l'encaissement a été validé contre un compte sandbox réel.
> FedaPay et CinetPay sont écrits mais **non validés**, donc désactivés — voir
> [Agrégateurs disponibles](#agrégateurs-disponibles). Vous pouvez développer et
> tester intégralement votre intégration dès aujourd'hui.

---

## 1. Le principe : Afripaie ne détient pas vos fonds

Vous ouvrez vos propres comptes chez les agrégateurs partenaires et
vous confiez vos clés à Afripaie, qui les conserve **chiffrées**. Afripaie route,
réconcilie, et prélève sa commission sur chaque transaction réussie.

Ce que cela change concrètement pour vous :

| | Conséquence |
|---|---|
| Règlement | Vous êtes réglé par votre agrégateur, selon vos conditions avec lui |
| Commission agrégateur | Prélevée par lui, sur le flux, comme aujourd'hui |
| Commission Afripaie | **Jamais** retenue sur le flux : constatée à chaque transaction, puis facturée (voir §10) |
| Réglementation | Vous restez le marchand de référence ; Afripaie n'est pas dans la chaîne de détention de fonds |

---

## 2. Authentification

Toutes les requêtes portent une clé API en jeton porteur :

```bash
curl -H "Authorization: Bearer sk_test_..." https://afripaie.online/v1/me
```

Deux environnements, deux préfixes :

| Préfixe | Environnement | Comportement |
|---|---|---|
| `sk_test_…` | test | Le simulateur est disponible ; aucun mouvement réel |
| `sk_live_…` | live | Agrégateurs réels uniquement ; le simulateur est **refusé** |

La clé n'est affichée qu'une seule fois à sa création. Afripaie n'en conserve
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
  "https://afripaie.online/v1/coverage?country=BJ"
```

---

## 4. Connecter un compte agrégateur

Sans compte agrégateur connecté, aucune transaction ne peut partir.

```bash
curl -X POST https://afripaie.online/v1/provider-accounts \
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
| `geniuspay` | `api_key`, `webhook_secret` ; ajouter `api_secret` si `api_key` est une clé **publique** (`pk_…`) | — |
| `yabetoo` | `secret_key`, `webhook_secret` | — |

`GET /v1/provider-accounts` liste vos comptes. La réponse ne contient que les
**noms** des champs (`credential_keys`), jamais leurs valeurs.

---

## 5. Encaisser

```bash
curl -X POST https://afripaie.online/v1/payments \
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

### Pays et agrégateur : déduits du numéro

`country` est **facultatif**. À défaut, l'indicatif du numéro du client désigne
le pays, et le routage choisit l'agrégateur qui le dessert : `+242…` part au
Congo (Yabetoo), `+225…` en Côte d'Ivoire (GeniusPay), et ainsi de suite. Le
numéro doit alors être au format international (`+242…` ou `00242…`) ; un
numéro local (`06 123 45 67`) ne désigne aucun pays et la requête est refusée
(`400`, `param: country`). Un `country` explicite reste prioritaire.

Les francs CFA sont interchangeables : XAF et XOF ont la même parité fixe avec
l'euro, donc `1 000 XAF` facturés à un client ivoirien deviennent `1 000 XOF`,
sans conversion. Toute autre différence de devise est refusée.

Vous n'avez **besoin d'aucun compte agrégateur** : sans compte à vous, Afripaie
encaisse par les siens et vous reverse le net. Si vous en connectez un (§4), il
est utilisé en priorité.

Ce qu'Afripaie vous doit, et ce qu'elle vous a déjà reversé, se lit à tout
moment :

```bash
curl https://afripaie.online/v1/settlements -H "Authorization: Bearer sk_test_..."
```

`balances` donne, par agrégateur, le montant dû (`held`), la part encore en
cours de règlement chez l'agrégateur (`maturing`, en général moins de 24 h) et
le reversable (`available`). `data` liste les reversements reçus, avec la
référence du virement.

Au Congo, Afripaie peut vous reverser automatiquement en mobile money (MTN ou
Airtel), chaque jour au-delà d'un minimum convenu. Le numéro de destination est
enregistré par Afripaie, à votre demande : vous ne pouvez pas le modifier
vous-même, pour qu'une session volée ne suffise pas à détourner vos fonds.
Les frais de l'opérateur sont pris en charge par Afripaie : vous recevez
l'intégralité de votre dû. `targets` indique la destination
active ; un reversement `PROCESSING` est en cours, `UNKNOWN` en vérification.

### La réponse ne dit jamais « payé »

Un paiement mobile money est **asynchrone par nature** : l'opérateur envoie une
demande sur le téléphone du client, qui la valide avec son code PIN. Afripaie vous
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
curl -X POST https://afripaie.online/v1/checkout-sessions \
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
  "url": "https://afripaie.online/pay/syY0QnCD1BUmzDvjJsVaqrL-U_8l71mj...",
  "expires_at": "2026-08-29T13:00:00.000Z"
}
```

Redirigez votre client vers `url`. C'est tout.

### Ce que voit le client

Une page servie par Afripaie affichant votre nom commercial, le montant, et
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
curl -X POST https://afripaie.online/v1/payouts \
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
est **impossible de savoir si l'argent est parti**. Afripaie ne devine pas :

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

- Afripaie n'essaie **aucun autre agrégateur**.
- `POST /v1/payouts/:id/retry` répond `409 payout_indeterminate` avec
  `retriable: false`.
- Seule une interrogation de l'agrégateur (`GET /v1/payouts/:id`) peut lever le
  blocage.

**Ce que vous devez faire :** interroger la ressource, pas la rejouer. Un
virement rejoué dans le doute, c'est un virement payé deux fois.

---

## 7bis. Recevoir nos évènements (webhooks sortants)

Interroger `GET /v1/payments/:id` en boucle fonctionne, mais ne passe pas à
l'échelle. Déclarez un endpoint et Afripaie vous notifie.

```bash
curl -X POST https://afripaie.online/v1/webhook-endpoints \
  -H "Authorization: Bearer sk_test_..." \
  -H "content-type: application/json" \
  -d '{"url":"https://votre-site.com/afripaie/hooks","events":["*"]}'
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

En-tête `Afripaie-Signature: t=<horodatage>,v1=<hmac>`. Le HMAC-SHA256 porte sur
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
https://afripaie.online/v1/hooks/fedapay/xK9mP2vQ...
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

La commission Afripaie n'est que **le solde après celle de votre agrégateur** :

| Commission agrégateur | Commission Afripaie | Votre coût total |
|---|---|---|
| 1,0 % | 4,0 % | **5 %** |
| 2,0 % | 3,0 % | **5 %** |
| 3,5 % | 1,5 % | **5 %** |
| 4,5 % | 0,5 % | **5 %** |
| 5,0 % et plus | 0 | **égal à celui de l'agrégateur** |

C'est ce qui rend le routage automatique acceptable pour vous : quand Afripaie
bascule vers un agrégateur plus cher parce que le premier est tombé, **votre
facture ne bouge pas**.

### Exemple

Encaissement de 15 000 XOF au Bénin, agrégateur à 2,0 % :

```
Le client paie                    15 000 XOF
Commission agrégateur (2,0 %)       −300 XOF
Vous encaissez                    14 700 XOF   ← immédiatement
Commission Afripaie (3,0 %)             450 XOF   ← facturée ensuite
Coût total                            750 XOF · 5,00 %
```

Le même encaissement via un agrégateur à 4,0 % : celui-ci prend 600 XOF, Afripaie
prend 150 XOF, et votre coût total reste **750 XOF**.

Notez la différence entre les deux lignes : seule la commission de l'agrégateur
est déduite de votre encaissement. La part d'Afripaie ne transite jamais par le
flux — elle vous est facturée après coup, ce qui joue en faveur de votre
trésorerie.

Chaque transaction expose son détail :

```json
"fees": { "provider": 300, "platform": 450 }
```

### Prélèvement

La commission Afripaie n'est **pas retenue sur le flux** : elle est constatée à
chaque transaction réussie, puis facturée. Vos encaissements vous parviennent
intégralement, diminués de la seule commission de votre agrégateur.

C'est une conséquence directe du modèle : Afripaie ne détient jamais vos fonds, il
ne peut donc rien y prélever. Le mode de perception est réglé par
`PLATFORM_FEE_COLLECTION` :

| Valeur | Mécanisme | État |
|---|---|---|
| `invoice` | La part est constatée puis facturée séparément | **Défaut** |
| `split` | L'agrégateur reverse directement la part Afripaie | Nécessite un accord sub-merchant |
| `on_top` | La part est ajoutée au montant payé par le client final | Non implémenté |

> **Ce que cela change pour vous.** Vous recevez plus tôt et payez plus tard :
> sur l'exemple ci-dessus, 14 700 XOF arrivent sur votre compte agrégateur au
> lieu de 14 250, et les 450 XOF d'Afripaie vous sont réclamés ensuite. Votre coût
> total est identique, votre trésorerie non.

### Transactions échouées

**Aucun frais.** Ni de l'agrégateur, ni d'Afripaie.

### Une limite honnête

Quelques agrégateurs prennent **plus de 5 %** — Érythrée, le haut de fourchette en
RCA et au Soudan, et Yabetoo sur les petits montants (3,5 % + 25 XAF dépassent 5 %
sous 1 667 XAF). Vous restez à 5 % : c'est Afripaie qui paie l'écart. Le champ
`fees.platform` est alors **négatif** (par exemple `-10` sur 1 000 XAF chez
Yabetoo), et vient en déduction de votre facture.

### Taux configurable

`PLATFORM_TOTAL_PAYIN_BPS` et `PLATFORM_TOTAL_PAYOUT_BPS` fixent le taux total
en points de base (500 = 5,00 %). Une tarification négociée par marchand est
prévue mais pas encore implémentée.

## 10bis. Reverser une part à des partenaires

Si une part de chaque encaissement revient à des tiers — apporteurs d'affaires,
vendeurs d'une place de marché, co-contractants — déclarez-les comme
**partenaires**. Afripaie calcule ce qui leur est dû à chaque vente et le leur verse
automatiquement.

```bash
curl -X POST https://afripaie.online/v1/partners   -H "Authorization: Bearer sk_test_..."   -H "Content-Type: application/json"   -d '{
    "reference": "transporteur-nord",
    "name": "Transports Sahel SARL",
    "country": "BJ",
    "currency": "XOF",
    "channel": "mobile_money",
    "share_bps": 1000,
    "recipient": { "phone": "+22997000001", "network": "MTN_BENIN", "name": "Transports Sahel" }
  }'
```

`share_bps` est en points de base : `1000` = 10 %. La `reference` est la vôtre —
rejouer le même appel met à jour le partenaire au lieu d'en créer un second.

### Le versement est différé, et groupé

**C'est le point à comprendre avant de vendre cette fonction à votre propre
client.** Rien n'est versé à l'instant du paiement, pour deux raisons :

- **Les fonds ne sont pas encore là.** Un encaissement « réussi » signifie que le
  client a payé, pas que l'argent est disponible sur votre compte agrégateur :
  ceux-ci règlent généralement à J+1 ou J+2. Verser immédiatement échouerait pour
  solde insuffisant.
- **Chaque versement coûte.** Un décaissement supporte le taux complet. Verser à
  trois partenaires à chaque transaction, ce serait trois frais par transaction —
  la répartition coûterait vite plus cher que ce qu'elle distribue.

Afripaie **accumule** donc ce qui est dû à chaque vente, puis regroupe toutes les
sommes échues d'un partenaire en **un seul versement**. Trois cents ventes
produisent un versement par jour et par partenaire, pas trois cents.

La promesse tenable auprès de votre client est donc « le lendemain », pas
« instantanément ». C'est une contrainte du règlement des agrégateurs, pas
d'Afripaie.

### Sur quoi la part est calculée

Par défaut sur le **net** : ce que vous gardez réellement, après commission
agrégateur *et* commission Afripaie. C'est la seule assiette qui ne peut pas vous
engager au-delà de ce que vous encaissez.

```
Vente de 15 000 XOF, agrégateur à 0 %, partenaire à 10 %

Le client paie              15 000 XOF
Commission Afripaie (5 %)         750 XOF   ← facturée ensuite
Net                         14 250 XOF
Part du partenaire (10 %)    1 425 XOF   ← versée le lendemain, groupée
```

Passez `"share_base": "gross"` pour calculer sur le montant payé par le client
final. La somme des parts actives ne peut pas dépasser **90 %** : au-delà, il ne
vous resterait rien pour régler la commission Afripaie.

**L'arrondi** se fait toujours à l'inférieur, et le reste vous demeure. Un
partenaire n'est donc jamais payé au-delà de sa part. Faites figurer cette règle
dans votre accord avec lui.

### Suivre ce qui est dû

```bash
curl -H "Authorization: Bearer sk_test_..." https://afripaie.online/v1/partners/pending
```

Répond, partenaire par partenaire, ce qui est accumulé et pas encore versé.
`GET /v1/partner-settlements` liste les versements groupés déjà déclenchés, avec
leur statut et l'identifiant du décaissement correspondant.

Un règlement peut porter l'état **`BLOCKED`** : le décaissement s'est terminé
dans un état indéterminé, et Afripaie refuse de le rejouer tant que la
réconciliation n'a pas tranché. Les sommes concernées ne sont ni perdues ni
versées deux fois — elles attendent. C'est la même règle que pour vos propres
décaissements, décrite au chapitre 7.

Désactiver un partenaire (`DELETE /v1/partners/{id}`) arrête les nouvelles
accumulations mais **n'annule pas** ce qui lui est déjà dû.

### Limite à connaître

Le pays du partenaire doit supporter le décaissement, et sa devise doit être
celle de l'encaissement — Afripaie ne convertit pas. Une part configurée dans une
autre devise que la vente est ignorée, et l'événement est journalisé. Vérifiez la
couverture avant de vous engager auprès de votre client.

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

Afripaie choisit l'agrégateur à la **création de chaque tentative**, d'après :

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
  "https://afripaie.online/v1/routing/decisions?payment=pay_..."
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
| `POST` | `/v1/partners` | Déclarer ou mettre à jour un partenaire |
| `GET` | `/v1/partners` | Lister ses partenaires |
| `DELETE` | `/v1/partners/:id` | Désactiver un partenaire (sans effacer ce qui lui est dû) |
| `GET` | `/v1/partners/pending` | Ce qui est dû et pas encore versé |
| `GET` | `/v1/partner-settlements` | Versements groupés et leur statut |
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
| `yabetoo` | Congo-Brazzaville (MTN, Airtel) — XAF | pay-in + payout | **Actif** — encaissement et décaissement validés en sandbox réel ; webhooks non vérifiés |
| `geniuspay` | CI, SN, ML, BF, BJ, TG, NE, GW — **XOF uniquement** | **pay-in seul** | **Actif** — encaissement validé en sandbox réel. Aucun décaissement : leur API de cashout n'est pas publiée |
| `fedapay` | BJ, TG, CI, SN, NE | pay-in + payout | Écrit d'après la doc publique — **non validé en sandbox réel** |
| `cinetpay` | CI, BJ, TG, ML, BF, NE, SN, GW, GN, CM, CD | pay-in + payout | Écrit d'après la doc publique — **non validé en sandbox réel** |

**GeniusPay** annonce 21 pays et neuf devises. Son API n'en accepte que **trois**
(XOF, EUR, USD) : une création en XAF est refusée, au Cameroun comme au Congo.
Seuls les huit pays en XOF sont donc routés vers lui. Son API de décaissement
n'étant pas publiée, aucun virement sortant n'y est routé.

### Ce qu'il faut savoir de Yabetoo

- **Montant minimum d'encaissement : 100 XAF.** En dessous, la transaction est
  refusée avant tout appel.
- **Le réseau est obligatoire** (`MTN_CG` ou `AIRTEL_CG`) : un numéro congolais
  ne permet pas de deviner l'opérateur. Le numéro doit comporter 9 chiffres
  après `+242` (ex. `+242 06 123 4567`).
- **Frais d'encaissement : 3,5 % + 25 XAF** (mesuré en sandbox). Vous payez 5 %
  quoi qu'il arrive : sous environ 1 667 XAF, Afripaie paie l'écart ; au-delà sa
  part est positive (1 % à 5 000 XAF, 1,45 % à 50 000 XAF).
- **Décaissement : Yabetoo prélève 1,5 % sur la somme versée.** Un décaissement
  de 10 000 XAF crédite 9 850 XAF au bénéficiaire ; votre compte Yabetoo est
  débité des 10 000. Le message de la tentative l'indique
  (`Yabetoo annonce 9850 pour 10000 demandes.`). Ces 1,5 % comptent dans les 5 % :
  la part d'Afripaie n'est alors que de 3,5 %. Si le bénéficiaire doit recevoir la
  somme exacte, majorez le montant demandé.
- **Une clé de test (`sk_test_…`) ne fonctionne qu'en environnement `test`**, et
  une clé de production qu'en `live`. Le sandbox Yabetoo réussit *toujours*,
  même avec un numéro inexistant : une clé de test branchée sur un marchand réel
  enregistrerait de vraies ventes sans qu'un franc ne bouge. Afripaie refuse
  l'appel plutôt que de laisser faire.
- **Les décaissements Airtel échouent en sandbox** (« only available in live
  mode »). MTN fonctionne.

Deux pays (Tchad, Guinée équatoriale) figurent au catalogue avec ce partenaire
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
