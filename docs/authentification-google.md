# Authentification Google et foyers partagés — plan de mise en œuvre

## Administration graphique et compte Google

L’interface `/admin` réutilise le client OAuth Google du planning. Aucun nouveau
client OAuth ni mot de passe applicatif n’est nécessaire.

### Côté Google

1. Ouvrir [Google Auth Platform](https://console.cloud.google.com/auth/overview)
   dans le **projet utilisé pour la connexion existante**.
2. Dans **Clients**, sélectionner le client de type **Application Web**.
   Son URI de redirection de production doit être exactement :
   `https://dailyplanner.fr/api/auth/google/callback`.
   Pour un essai local, ajouter l’URI exacte de l’origine locale, par exemple
   `http://localhost:3000/api/auth/google/callback`.
   **Ne pas utiliser `https://dailyplanner.fr/admin` comme callback.**
3. Conserver uniquement les scopes d’identité `openid`, `email`, `profile`.
   Aucune permission Gmail, Drive ou OpenAI n’est requise.
4. Dans **Audience**, si le projet est en mode **Test**, ajouter le compte
   administrateur aux utilisateurs de test. Si l’application est publiée,
   conserver l’audience prévue pour ses utilisateurs : le rôle admin n’est pas
   un réglage de l’audience Google.
5. Sur [la sécurité du compte Google](https://myaccount.google.com/security),
   activer **Validation en deux étapes**, configurer une passkey ou une clé de
   sécurité et conserver les moyens de récupération dans un endroit sûr.
   L’application ne reçoit pas le mot de passe Google et ne garantit pas qu’un
   second facteur sera redemandé à chaque flux OAuth.

Les menus Google peuvent changer ; référence du flux :
[documentation OpenID Connect Google](https://developers.google.com/identity/openid-connect/openid-connect).

### Sur le serveur

Les valeurs `GOOGLE_CLIENT_ID` et `GOOGLE_CLIENT_SECRET` restent dans `.env`,
avec `AUTH_ENABLED=true` et `PUBLIC_ORIGIN=https://dailyplanner.fr`.
Se connecter au **planning** une première fois avec le compte choisi, puis :

```powershell
npm run admin -- users
```

Identifier le compte par son nom et son e-mail vérifié, et copier son **UUID
complet**. Dans `.env`, renseigner :

```dotenv
ADMIN_USER_IDS=<UUID-complet-du-compte>
```

Plusieurs UUID sont possibles, séparés par des virgules. Aucun droit n’est
attribué automatiquement au premier inscrit, à une adresse e-mail ou à un
membre du foyer. Une liste vide interdit toute élévation admin.

```powershell
npm run build
# Arrêter puis redémarrer le processus serveur habituel.
```

Ouvrir `/admin` à l’origine exacte configurée et choisir **Connexion admin avec
Google**. Le retour OAuth revient sur `/admin`, sans importer ni synchroniser le
carnet local. Une nouvelle session admin de 30 minutes est liée à la session
utilisateur par un jeton conservé uniquement sous forme de hash côté serveur.
Une connexion depuis le planning seul ne crée pas cette session admin.
Les tentatives de callback invalides ne donnent aucun droit.

Chaque route admin vérifie les droits et l’expiration ; chaque écriture vérifie
aussi l’origine exacte, le jeton CSRF et une confirmation. Les actions réussies
sont conservées dans `admin_audit` ; les refus et erreurs sont journalisés côté
serveur. Aucune clé Google/OpenAI, cookie ou jeton de session n’est affiché.
Les données restent uniquement en mémoire du navigateur et ne sont pas mises en
cache par la PWA ; à expiration, déconnexion ou perte du réseau, l’interface
retire les données affichées et exige une nouvelle vérification.

Pour retirer les droits, enlever l’UUID de `ADMIN_USER_IDS` puis redémarrer.
Pour fermer immédiatement tous les appareils du compte :

```powershell
npm run admin -- revoke-sessions --email <adresse-du-compte>
```

### Rubriques et limites

- **Tableau de bord** : comptes, foyers, sessions actives, recettes, demandes,
  états d’analyse et compteurs IA globaux.
- **Utilisateurs / foyers** : listes recherchables et paginées, inscription,
  dernière connexion, rattachement et révocation des sessions.
- **OpenAI** : quotas quotidiens/mensuels par foyer, plafonds globaux, pause
  des nouveaux appels et compteurs de tokens. Les plafonds portent sur les
  **appels**, pas sur les euros ; le solde/rechargement reste chez OpenAI.
- **Administration** : correction/retrait/restauration des recettes communes,
  réponses aux demandes, sauvegarde SQLite sur le serveur et journal des actions.
  Les corrections refusent les versions devenues obsolètes et ne modifient pas
  les copies privées déjà présentes dans les carnets.

Les opérations destructives sur les comptes, déplacements de foyers,
restaurations de base et changements de secrets restent en ligne de commande.
Les sauvegardes et le journal peuvent contenir des données personnelles :
restreindre leurs accès et prévoir leur conservation selon les besoins réels.

---

Ce document décrit **tout** ce qu'il faut pour ajouter une connexion Google facultative à
À table !, avec synchronisation par foyer. Il est conçu pour être exécuté en une seule
intervention une fois les valeurs de la section 2 réunies.

Ordre de lecture : décisions (1) → valeurs à réunir (2) → préparation Google/Cloudflare (3, 4)
→ spécification technique (5 à 12) → tests (13) → déploiement (14) → prompt de lancement (15).

> Ne jamais écrire de secret (client secret Google, clé OpenAI, jeton Cloudflare) dans ce
> fichier, dans Git, ni dans une variable `VITE_*`. Les secrets vont uniquement dans `.env`.

---

## 1. Décisions validées

| Sujet | Décision |
|---|---|
| Arrivée sur l'application | Sans compte. Mode **invité** : tout reste dans IndexedDB, aucune donnée envoyée au serveur. |
| Incitation | Bandeau en bas de page invitant à se connecter avec Google (risque de perte expliqué). |
| Fournisseur | Google uniquement pour l'instant. Architecture prête pour Apple (fournisseurs interchangeables), **sans l'implémenter**. |
| Inscriptions | Ouvertes à tout compte Google. |
| Propriété des données | Par **foyer**. Plusieurs comptes peuvent rejoindre un même foyer et partager planning, carnet et réglages. |
| Foyers par compte | Un seul. |
| Première connexion sans invitation | Création automatique d'un foyer, puis import des données invitées. |
| Première connexion avec invitation | Rattachement au foyer invité, puis import des données invitées dans ce foyer. |
| Compte déjà connu + données invitées | **Fusion automatique** avec la règle actuelle (dernière version gagne, par enregistrement). |
| Invitations | Lien copiable à usage unique, valable 7 jours, utilisable par le compte Google qui l'accepte. |
| Droits | Tous les membres modifient les données **et** administrent le foyer (inviter, retirer, renommer). |
| Déconnexion | Retour au mode invité. Le cache du compte est **conservé séparément** et retrouvé à la reconnexion. |
| Session | 30 jours glissants. Hors ligne : lecture/saisie locales possibles. Session expirée : modifications conservées, reconnexion demandée avant envoi. |
| Fonctions serveur en invité | Aucune : pas d'IA, pas d'import de recette par URL, pas de demande d'évolution. Saisie, carnet, réglages et tirage au hasard restent disponibles. |
| `AUTH_ENABLED=false` | Comportement actuel : synchronisation sans compte dans un **espace commun** distinct, qui n'expose jamais les foyers. |
| Données serveur existantes | Placées dans l'espace commun lors de la migration, puis **attribuées explicitement** par commande d'administration à un compte désigné. Jamais au premier inscrit. |
| IA | 20 requêtes par jour et par foyer (Europe/Paris), sauf exemption administrative. Compteurs du foyer. |
| Hébergement | D'abord réseau domestique, puis Internet via un domaine et Cloudflare Tunnel vers le PC. |

---

## 2. Valeurs à réunir avant de lancer la mise en œuvre

Compléter ce tableau (sans secret) avant de lancer le prompt de la section 15.

| Valeur | Exemple | Valeur retenue |
|---|---|---|
| Domaine public (acheté chez OVHcloud) | domaine racine, sans `www` | `dailyplanner.fr` |
| `PUBLIC_ORIGIN` de production | origine HTTPS, sans slash final | `https://dailyplanner.fr` |
| `PUBLIC_ORIGIN` de développement | `http://localhost:3000` | `http://localhost:3000` |
| URI de retour Google (dev) | `http://localhost:3000/api/auth/google/callback` | identique à l'exemple |
| URI de retour Google (prod) | retour du flux serveur Google | `https://dailyplanner.fr/api/auth/google/callback` |
| Projet Google Cloud | `a-table-prod` | `À COMPLÉTER` |
| Comptes de test Google (phase test) | adresses Gmail de la famille | `À COMPLÉTER` |
| Compte qui reçoit les données existantes | adresse Google de l'administrateur | `À COMPLÉTER` |
| Nom par défaut d'un nouveau foyer | `Foyer de {prénom}` | `Foyer de {prénom}` |
| Tunnel Cloudflare | nom du tunnel | `À COMPLÉTER` |

Secrets à placer **uniquement** dans `.env` : `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`
(et `OPENAI_API_KEY` existante).

Adresse canonique retenue : **`https://dailyplanner.fr`**, sans `www` ni sous-domaine.
Si `www.dailyplanner.fr` est ajouté plus tard, le rediriger vers l'adresse canonique ;
ne pas en faire une deuxième origine applicative (IndexedDB et cookies seraient distincts).
L'achat du domaine ne signifie pas encore que le DNS, le tunnel ou HTTPS fonctionnent.

---

## 3. Préparation Google (console)

### 3.1 Créer le projet

1. Ouvrir la [console Google Cloud](https://console.cloud.google.com/).
2. Dans le sélecteur de projet en haut, choisir **Nouveau projet** :
   nom suggéré `DailyPlanner`. Le nom du projet n'est pas le nom montré aux utilisateurs.
3. Sélectionner ce projet et ouvrir
   [Google Auth Platform](https://console.cloud.google.com/auth/overview).
4. Si l'assistant **Premiers pas / Get started** apparaît : renseigner le nom de l'application
   `À table !`, l'adresse de support, l'audience **Externe / External**, l'adresse de contact
   développeur, puis accepter les conditions et créer la configuration.

Il n'est pas nécessaire d'activer Gmail, Drive ou Calendar : on utilise Google uniquement pour
l'identité. Le compte Google garde son mot de passe ; l'application ne le reçoit jamais.

### 3.2 Branding / Informations sur l'application

Ouvrir [Branding](https://console.cloud.google.com/auth/branding) et utiliser :

| Champ Google | Valeur |
|---|---|
| Nom de l'application | `À table !` |
| Adresse e-mail d'assistance utilisateur | Une adresse Google que tu consultes et peux sélectionner dans la console |
| Logo | Facultatif ; le laisser vide au début simplifie la préparation |
| Page d'accueil de l'application | `https://dailyplanner.fr` |
| Lien vers les règles de confidentialité | `https://dailyplanner.fr/confidentialite` |
| Lien vers les conditions d'utilisation | `https://dailyplanner.fr/conditions-utilisation` |
| Domaines autorisés | `dailyplanner.fr` (**sans** `https://`, chemin ni slash) |
| Coordonnées du développeur | Une adresse e-mail que tu consultes |

Les deux pages juridiques sont **des routes à créer**, pas des pages déjà disponibles.
Leur contenu doit être adapté à l'exploitation réelle du service. Elles doivent être publiques,
lisibles sans connexion, et ne pas simplement afficher le planning via le repli de la SPA.
Si Google exige leur disponibilité, terminer la préparation avec le client localhost et ne
soumettre la configuration de production à vérification qu'une fois ces pages en ligne.

Pour la propriété du domaine :

1. Ouvrir [Google Search Console](https://search.google.com/search-console/).
2. Ajouter une propriété de type **Domaine** : `dailyplanner.fr`.
3. Copier la valeur TXT `google-site-verification=...` fournie.
4. Ajouter ce TXT à la racine (`@`, ou champ sous-domaine vide selon le portail) dans la zone DNS
   **actuellement autoritaire** : OVHcloud si les serveurs DNS sont encore ceux d'OVHcloud,
   Cloudflare si le transfert des serveurs DNS est déjà effectué.
5. Attendre la propagation, puis cliquer **Valider**. Conserver ce TXT, y compris si la zone
   DNS est ensuite déplacée chez Cloudflare.

Utiliser pour la validation un compte Google propriétaire ou éditeur du projet OAuth.

### 3.3 Audience

Ouvrir [Audience](https://console.cloud.google.com/auth/audience) :

- type d'utilisateur **External**, pas *Internal* ;
- garder le statut **Testing** pendant la préparation ;
- ajouter ton compte Google et les comptes de la famille aux **Test users**, si la console
  propose cette liste ;
- passer à **In production** une fois les essais et les prérequis publics terminés.

**Attention : correction par rapport à la première version du guide.** Avec uniquement
`openid`, `email`, `profile`, Google prévoit une exception : même en *Testing*, les utilisateurs
n'ont pas besoin de figurer dans la liste de test et l'autorisation n'expire pas après sept
jours. Le statut *Testing* **ne constitue donc pas une liste d'accès privée** pour ce projet.
La session applicative de 30 jours reste indépendante de cette règle.
Voir la [documentation officielle sur l'audience](https://support.google.com/cloud/answer/15549945).

### 3.4 Data access / Accès aux données

Ouvrir [Data access](https://console.cloud.google.com/auth/scopes), puis **Add or remove scopes**.
Sélectionner uniquement :

| Scope | Équivalent éventuellement affiché dans la console |
|---|---|
| `openid` | `openid` |
| `email` | `https://www.googleapis.com/auth/userinfo.email` |
| `profile` | `https://www.googleapis.com/auth/userinfo.profile` |

Ces permissions d'identité ne sont pas sensibles. Ne pas ajouter Gmail, Drive, Calendar ni
d'autorisation hors ligne Google : on ne veut ni leurs données ni leurs jetons de rafraîchissement.

### 3.5 Clients OAuth : URL exactes à entrer

Créer de préférence **deux clients OAuth**, dans
[Clients](https://console.cloud.google.com/auth/clients) → **Create client / Créer un client**.
Ils peuvent appartenir au même projet.

| Champ | Client de développement | Client du domaine |
|---|---|---|
| Type d'application | **Web application / Application Web** | **Web application / Application Web** |
| Nom du client (interne à la console) | `DailyPlanner - local` | `DailyPlanner - production` |
| Origines JavaScript autorisées | **Laisser vide** | **Laisser vide** |
| URI de redirection autorisés | `http://localhost:3000/api/auth/google/callback` | `https://dailyplanner.fr/api/auth/google/callback` |

Les origines JavaScript restent vides car le flux retenu est un **flux serveur par redirection**,
pas le SDK Google exécuté dans le navigateur. Ne pas mettre le callback dans ce champ.
Ce n'est pas un client « Application de bureau », même si le serveur tourne sur ton PC.

Après création de chaque client, récupérer le **Client ID** (se termine généralement par
`.apps.googleusercontent.com`) et le **Client secret**. Conserver le secret dès sa création :
la console peut ne plus permettre de l'afficher ensuite. Ne pas déposer de fichier JSON
d'identifiants dans le dépôt.

Le `.env` utilise **une seule paire à la fois** :

```dotenv
# Essai sur le PC, après implémentation de l'authentification
PUBLIC_ORIGIN=http://localhost:3000
AUTH_ENABLED=true
GOOGLE_CLIENT_ID=<identifiant du client DailyPlanner - local>
GOOGLE_CLIENT_SECRET=<secret de ce même client>
```

```dotenv
# Application sur le domaine, après implémentation et configuration du tunnel
HOST=127.0.0.1
PORT=3000
PUBLIC_ORIGIN=https://dailyplanner.fr
AUTH_ENABLED=true
GOOGLE_CLIENT_ID=<identifiant du client DailyPlanner - production>
GOOGLE_CLIENT_SECRET=<secret de ce même client>
TRUSTED_PROXY=cloudflare
```

Ces paramètres d'authentification et le callback sont **à développer** ; renseigner la console
Google ne les crée pas dans l'application. Redémarrer le serveur après modification de `.env`.

### 3.6 Vérification et erreurs courantes

La correspondance de l'URI doit être exacte (protocole, hôte, port, chemin, slash final).
Le callback **n'a pas** de slash final. Ne pas renseigner `/api/auth/google/start` :
c'est le point de départ, pas le retour. Les paramètres `code` et `state` seront ajoutés par
Google ; ils ne font pas partie de l'URI à enregistrer.

| Erreur | À vérifier |
|---|---|
| `redirect_uri_mismatch` | Le callback enregistré correspond exactement au `PUBLIC_ORIGIN` de la paire de clients utilisée. Pas de `www`, pas de slash final ajouté. |
| `invalid_client` | Client ID et secret viennent du même client OAuth ; secret non révoqué. |
| `access_denied` | Connexion annulée, restriction du compte Google/Workspace, audience ou permissions demandées. |
| Page d'erreur/404 au callback | Authentification non implémentée, mauvais domaine ou tunnel inactif. |
| Connexion réussie mais synchronisation refusée | `PUBLIC_ORIGIN` correspond à l'adresse réellement utilisée dans le navigateur. |

Au début, tester le **build sur `http://localhost:3000`**, pas Vite sur `5173`.
Le port du navigateur détermine aussi l'origine et l'adresse de retour ; un support Vite séparé
nécessitera une configuration explicite, non couverte par ces deux clients.

Contraintes Google à respecter
([règles de validation](https://developers.google.com/identity/protocols/oauth2/web-server#uri-validation)) :

- HTTPS obligatoire, sauf `localhost` ;
- **pas d'adresse IP brute** : `http://192.168.1.22:3000` est refusé ;
- pas de fragment, pas de joker, correspondance exacte.

Conséquence : l'essai Wi-Fi HTTP actuel (`http://192.168.1.22:3000`) **ne permet pas** la
connexion Google. Sur téléphone, il faut le domaine HTTPS (Cloudflare Tunnel, section 4). Sur
le PC, `http://localhost:3000` suffit.

---

## 4. Préparation Cloudflare Tunnel

Référence : [créer un tunnel depuis le tableau de bord](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/get-started/create-remote-tunnel/).

1. Domaine acheté chez OVHcloud : **`dailyplanner.fr`**. L'ajouter comme zone à Cloudflare,
   vérifier les enregistrements importés (notamment MX/TXT si une messagerie existe), puis
   remplacer chez OVHcloud les **serveurs DNS** par les deux fournis par Cloudflare.
   Le domaine reste enregistré et renouvelé chez OVHcloud ; seul l'hébergement DNS change.
   Ne pas supprimer d'enregistrements de messagerie. Si DNSSEC est actif chez OVHcloud,
   suivre la procédure Cloudflare de changement de serveurs DNS pour éviter un ancien
   enregistrement DS incompatible ; réactiver DNSSEC avec les valeurs Cloudflare ensuite.
   Attendre que Cloudflare indique la zone active.
2. *Networking* → *Tunnels* → *Create a tunnel*, choisir Windows, exécuter la commande
   d'installation fournie dans un PowerShell administrateur : elle installe `cloudflared` comme
   **service Windows** (démarrage automatique). Ne pas copier le jeton dans le dépôt.
3. Ajouter une route *Published application* : sous-domaine **vide** (domaine racine),
   domaine `dailyplanner.fr`, soit le nom public **`dailyplanner.fr`** ;
   *Service URL* `http://127.0.0.1:3000`.
4. Dans `.env` : `HOST=127.0.0.1`, `PUBLIC_ORIGIN=https://dailyplanner.fr`,
   `TRUSTED_PROXY=cloudflare`. **Ne pas** ouvrir le port 3000 sur la box ni dans le pare-feu.
5. Réglages Cloudflare de la zone :
   - garder *Always Use HTTPS* ;
   - désactiver **Rocket Loader** (réécrit les scripts, incompatible avec la CSP) ;
   - ne pas activer de règle de cache sur `/api/*` ni sur le HTML ; les réponses API envoient
     déjà `Cache-Control: no-store` ;
   - si *Bot Fight Mode* provoque des défis sur `/api/sync`, le désactiver : un défi casse la
     synchronisation en arrière-plan ;
   - **ne pas** placer Cloudflare Access devant tout le site : cela interdirait le mode invité.
6. Caddy devient inutile dans ce montage (le tunnel fournit le HTTPS).

**Ne publier la route du tunnel qu'après implémentation et validation de l'authentification
avec `AUTH_ENABLED=true`.** L'application actuelle sans authentification expose les données
communes et les appels IA à quiconque accède à son adresse.
Une fois publié, le domaine du tunnel est accessible depuis Internet, même en phase d'essai.
Le mode *Testing* de Google n'est pas une restriction d'accès avec les seuls scopes d'identité.
Après implémentation, le mode invité n'envoie aucune donnée et les foyers sont protégés par
les contrôles d'accès de l'application.

---

## 5. Configuration serveur (`.env`)

À ajouter dans [config.ts](../server/config.ts) et [.env.example](../.env.example) :

```dotenv
# false (défaut) : fonctionnement historique, espace commun synchronisé sans compte.
AUTH_ENABLED=false
GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=
AUTH_SESSION_DAYS=30
# none (défaut) | cloudflare : utilise CF-Connecting-IP pour le débit, uniquement si la
# requête provient de 127.0.0.1/::1 (cloudflared local). Nécessite HOST=127.0.0.1.
TRUSTED_PROXY=none
```

Règles de validation (refuser le démarrage avec un message français clair) :

- `AUTH_ENABLED=true` exige `PUBLIC_ORIGIN`, `GOOGLE_CLIENT_ID` et `GOOGLE_CLIENT_SECRET` ;
  **jamais** de repli silencieux sur le mode sans authentification ;
- avec `AUTH_ENABLED=true`, `PUBLIC_ORIGIN` doit être en `https:` ou en
  `http://localhost:<port>` / `http://127.0.0.1:<port>` (règle Google) ;
- `TRUSTED_PROXY=cloudflare` exige `HOST` sur une adresse de bouclage ;
- `AUTH_SESSION_DAYS` entier de 1 à 365.

L'URI de retour est **calculée** : `${PUBLIC_ORIGIN}/api/auth/google/callback`.
Aucun `SESSION_SECRET` n'est nécessaire : sessions et transactions OAuth sont stockées côté
serveur, le cookie ne contient qu'un jeton aléatoire dont seul le hachage est conservé.

---

## 6. Vocabulaire et invariants

- **Espace** (`space`, `spaceId` dans le code) : conteneur de données synchronisées. Deux types :
  `common` (identifiant fixe `common`) et `household` (un foyer). En interface : « foyer ».
  Ne pas nommer le concept `household` dans le code : ce nom désigne déjà la composition des
  convives dans [model.ts](../shared/model.ts).
- Tous les enregistrements (`meal`, `dish`, `settings`), analyses, `resetId` et demandes
  d'évolution appartiennent à **un seul espace**.
- `AUTH_ENABLED=true` : seuls les espaces `household` sont accessibles, et uniquement à leurs
  membres. L'espace `common` est inaccessible.
- `AUTH_ENABLED=false` : seul l'espace `common` est accessible. Les foyers ne le sont jamais.
- Le serveur détermine l'espace **à partir de la session**, jamais d'un identifiant envoyé
  par le client.
- Les invariants de synchronisation existants restent valables à l'intérieur d'un espace
  (voir le skill `app-sync-offline`) : `compareVersions`, outbox acquittée seulement par une
  version au moins aussi récente, vidage par record vide daté, lots de 100.
- Une identité externe est reconnue par `(provider, subject)` — le `sub` Google — **jamais**
  par l'adresse e-mail. Aucune fusion automatique de comptes par e-mail (préparation d'Apple).

---

## 7. Base de données SQLite

### 7.1 Migration `user_version` 1 → 2

Exécutée au démarrage par [database.ts](../server/database.ts), dans une transaction, **après
une sauvegarde automatique** `VACUUM INTO data/backups/avant-auth-<horodatage>.sqlite`
(même procédé que [reset.ts](../server/reset.ts)), sauf base `:memory:`.

```sql
CREATE TABLE spaces (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('common', 'household')),
  name TEXT NOT NULL,
  reset_id TEXT,
  created_at INTEGER NOT NULL
);
CREATE TABLE users (
  id TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  email TEXT,
  email_verified INTEGER NOT NULL DEFAULT 0,
  picture_url TEXT,
  created_at INTEGER NOT NULL,
  last_login_at INTEGER NOT NULL
);
CREATE TABLE identities (
  provider TEXT NOT NULL,           -- 'google' ; 'apple' plus tard
  subject TEXT NOT NULL,            -- claim sub
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  email TEXT,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (provider, subject)
);
CREATE TABLE memberships (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,  -- un seul foyer par compte
  space_id TEXT NOT NULL REFERENCES spaces(id),
  joined_at INTEGER NOT NULL
);
CREATE INDEX memberships_space ON memberships(space_id);
CREATE TABLE sessions (
  token_hash TEXT PRIMARY KEY,      -- SHA-256 hexadécimal du jeton du cookie
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE TABLE auth_transactions (
  id_hash TEXT PRIMARY KEY,         -- SHA-256 du jeton du cookie temporaire
  provider TEXT NOT NULL,
  state TEXT NOT NULL,
  nonce TEXT NOT NULL,
  code_verifier TEXT NOT NULL,
  invitation_hash TEXT,
  expires_at INTEGER NOT NULL       -- 10 minutes
);
CREATE TABLE invitations (
  id TEXT PRIMARY KEY,
  space_id TEXT NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,      -- 7 jours
  accepted_by TEXT REFERENCES users(id),
  accepted_at INTEGER,
  revoked_at INTEGER
);
```

Tables existantes à rendre propres à un espace (recréation + copie, car SQLite ne modifie pas
une clé primaire) :

```sql
records   (space_id TEXT NOT NULL, key TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY (space_id, key))
analyses  (space_id TEXT NOT NULL, dish_id TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY (space_id, dish_id))
feature_requests : ajouter space_id TEXT NOT NULL DEFAULT 'common', user_id TEXT NULL
```

Copie de l'existant :

1. créer l'espace `('common', 'common', 'Espace commun', <meta.resetId ou NULL>, now)` ;
2. copier `records`, `analyses` et `feature_requests` avec `space_id = 'common'` ;
3. supprimer la clé `resetId` de `meta` (désormais `spaces.reset_id`) ;
4. `ai_usage` reste global pour l’historique administratif ;
5. `PRAGMA user_version = 2`.

La migration doit être idempotente et testée sur une copie de la base réelle.

La migration suivante (`user_version = 3`) ajoute `household_ai_usage`, avec une clé
`(space_id, day)`, et `ai_limit_exemptions`, accessible seulement par la commande
serveur `npm run admin -- ai-limit --space <identifiant> --mode unlimited|default`.
Les anciens compteurs globaux sont conservés et copiés dans `common` car leur foyer
d’origine ne peut pas être reconstitué. Les nouveaux appels et tokens sont comptés
à la fois globalement et dans leur foyer ; `/api/sync` n’expose que les compteurs
du foyer de la session. Le quota de 20 tentatives est réservé en transaction avant
l’appel, pour le worker comme pour la génération. Une analyse bloquée reste en
attente jusqu’au renouvellement ou à une exemption, sans perdre la fiche.

### 7.2 Classe `Store`

Toutes les méthodes de données prennent un `spaceId` :
`get`, `records`, `analyses`, `analysis`, `merge`, `settings`, `resetId`, `reset`,
`featureRequests`, `addFeatureRequest`.

- `ensureSpaceSettings(spaceId)` : crée le record `settings:global` initial (version 0, comme
  aujourd'hui) pour chaque nouvel espace.
- `claimAnalysis()` parcourt les analyses `pending` de **tous** les espaces (ordre stable) et
  renvoie `{ spaceId, dish, day }`. Le worker de [ai.ts](../server/ai.ts) utilise les
  paramètres (`model`, convives, aliments à éviter) **de l'espace du plat**, et
  `finishAnalysis` / `nameAnalysis` prennent le `spaceId`.
- Au démarrage, la remise en `error` des analyses `processing` s'applique à tous les espaces.
- `capabilities()` reste global (compteurs IA du serveur).
- Nouvelles méthodes d'authentification et de foyer (section 8), chacune transactionnelle.
- Purge périodique (au démarrage puis toutes les heures) : sessions expirées, transactions OAuth
  expirées, invitations expirées depuis plus de 30 jours.

---

## 8. API serveur

### 8.1 Dépendances

- [`openid-client`](https://github.com/panva/openid-client) (v6, certifié OpenID) : découverte
  `https://accounts.google.com`, PKCE S256, `state`, `nonce`, validation du jeton d'identité.
- [`@fastify/cookie`](https://github.com/fastify/fastify-cookie).

### 8.2 Abstraction des fournisseurs

`server/auth/provider.ts` :

```ts
export interface IdentityProvider {
  id: 'google';                                   // 'apple' ajouté plus tard
  authorizationUrl(input: { state: string; nonce: string; codeChallenge: string }): Promise<URL>;
  callback(input: { currentUrl: URL; state: string; nonce: string; codeVerifier: string }): Promise<{
    subject: string; email: string | null; emailVerified: boolean; name: string; picture: string | null;
  }>;
}
```

- `server/auth/google.ts` implémente cette interface avec `openid-client`, scopes
  `openid email profile`, `prompt=select_account`. Aucun jeton Google n'est conservé après
  le retour : seule l'identité est utilisée.
- `server/auth/fake.ts` (tests uniquement) : fournisseur simulé, activable **seulement** si
  `NODE_ENV=test` **et** `DATABASE_PATH=:memory:` ; refus de démarrer sinon.
- Les routes sont génériques (`/api/auth/:provider/...`) ; seul `google` est enregistré.

### 8.3 Cookies

| Cookie | Contenu | Attributs |
|---|---|---|
| Session | jeton aléatoire 32 octets base64url | `HttpOnly`, `SameSite=Lax`, `Path=/`, `Max-Age` = durée de session. En HTTPS : nom `__Host-atable_session` + `Secure`. Sur `http://localhost` : nom `atable_session`, sans `Secure`. |
| Transaction OAuth | jeton aléatoire | mêmes règles, nom `__Host-atable_oauth` / `atable_oauth`, `Max-Age=600`, supprimé au retour |

`SameSite=Lax` est nécessaire : le retour de Google est une navigation de premier niveau.
Le protocole est déduit de `PUBLIC_ORIGIN`, pas de la requête (le tunnel arrive en HTTP).

Session glissante : à chaque requête authentifiée, si `last_seen_at` date de plus de 24 h,
repousser `expires_at` à `now + AUTH_SESSION_DAYS` et renvoyer le cookie.

### 8.4 Résolution de l'accès (hook `onRequest` sur `/api/`)

Après la vérification d'origine existante :

- `AUTH_ENABLED=false` → `request.space = { id: 'common' }`, `request.user = null`.
- `AUTH_ENABLED=true` → lire le cookie, hacher, charger la session non expirée, l'utilisateur
  et son appartenance. `request.user` et `request.space` (ou `null`).

Protection des routes (helper `requireSpace`) :

| Cas | Réponse |
|---|---|
| Pas de session valide | `401 { error, code: 'auth_required' }` |
| Session valide mais aucun foyer (retiré du foyer) | `403 { error, code: 'membership_revoked' }` |

### 8.5 Routes

Toutes les routes acceptent/renvoient du JSON, avec schémas `zod` dans
[model.ts](../shared/model.ts). Les jetons ne passent **jamais** dans l'URL d'une requête vers
le serveur (journaux serveur et Cloudflare) : ils vont dans le corps des `POST`.

| Méthode et chemin | Accès | Rôle |
|---|---|---|
| `GET /api/auth/session` | public | `{ authEnabled, providers: ['google'], user: { id, name, email, picture } \| null, space: { id, name, kind } \| null, defaultModel, sessionExpiresAt \| null }`. Si l'utilisateur connecté n'a plus de foyer, en **crée** un automatiquement (même règle qu'une première connexion) et le renvoie. |
| `POST /api/auth/:provider/start` | public, débit 20/min | Corps `{ invitation?: string }`. Crée la transaction (state, nonce, PKCE, hachage de l'invitation), pose le cookie de transaction, renvoie `{ url }`. Le client navigue ensuite vers cette URL. 404 si l'authentification est désactivée. |
| `GET /api/auth/:provider/callback` | public, débit 20/min | Valide transaction + réponse fournisseur, supprime la transaction (usage unique), crée ou met à jour l'utilisateur, gère le foyer (8.6), crée la session, redirige (`303`) vers `/?auth=ok` ou `/?auth=error&reason=<code>` (`cancelled`, `expired`, `invalid`, `invitation_invalid`). Aucun détail technique dans l'URL. |
| `POST /api/auth/logout` | session | Supprime la session, efface le cookie. |
| `POST /api/sync` | `requireSpace` | Comportement actuel, restreint à l'espace. |
| `POST /api/meals/generate` | `requireSpace` | Comportement actuel avec les paramètres de l'espace. |
| `GET/POST /api/feature-requests` | `requireSpace` | Demandes de l'espace uniquement ; enregistre `user_id`. |
| `GET /api/space` | `requireSpace` + auth activée | `{ id, name, members: [{ id, name, email, picture, joinedAt, isMe }], invitations: [{ id, createdBy, createdAt, expiresAt }] }` (invitations actives seulement). |
| `PATCH /api/space` | idem | `{ name }` (1 à 60 caractères). |
| `POST /api/space/invitations` | idem, 10/min | Crée une invitation, renvoie `{ id, url, expiresAt }` avec `url = ${PUBLIC_ORIGIN}/#invitation=<jeton>`. Le jeton n'est affiché qu'une fois (seul son hachage est stocké). Maximum 10 invitations actives par foyer. |
| `POST /api/space/invitations/revoke` | idem | `{ id }`. |
| `POST /api/space/members/remove` | idem | `{ userId }`. Supprime l'appartenance ; les requêtes suivantes de ce membre reçoivent `403 membership_revoked`. Interdit sur soi-même (utiliser « quitter »). |
| `POST /api/space/leave` | idem | Quitte le foyer. Si c'était le dernier membre, le foyer et ses données sont **conservés** sans membre (récupérables par la commande d'administration). Un nouveau foyer vide est créé au prochain `GET /api/auth/session`. |
| `POST /api/invitations/preview` | public, 20/min | `{ token }` → `{ spaceName, invitedBy, expiresAt }` ou `404 invitation_invalid` (expirée, révoquée, déjà utilisée ou inconnue — même message). |
| `POST /api/invitations/accept` | session, 10/min | `{ token, leaveCurrent: boolean }`. Si l'utilisateur a déjà un foyer avec d'autres membres ou des données, exige `leaveCurrent: true` (sinon `409 confirmation_required`). Consommation **atomique** (`UPDATE ... WHERE accepted_at IS NULL AND revoked_at IS NULL AND expires_at > now`). Renvoie la nouvelle session (`space`). |

### 8.6 Logique du retour fournisseur

Dans une seule transaction SQLite :

1. Chercher l'identité `(provider, sub)`.
2. Absente → créer `users` + `identities` (nouvel utilisateur).
   Présente → mettre à jour nom, e-mail, photo, `last_login_at`.
3. Si l'utilisateur **n'a pas de foyer** :
   - invitation valide dans la transaction OAuth → la consommer et rejoindre ce foyer ;
   - sinon → créer un foyer nommé `Foyer de {prénom}` avec ses paramètres initiaux.
4. Si l'utilisateur **a déjà un foyer** et une invitation est présente : ne pas la consommer ;
   le client demandera une confirmation explicite (section 10.4).
5. Créer la session.

La notion de « compte nouvellement créé » n'est **pas** utilisée pour décider de l'import :
l'import est piloté par le client et repose sur la présence de données invitées (section 9.3),
ce qui le rend reprenable après une coupure.

### 8.7 Sécurité transversale

- Conserver la vérification d'origine actuelle pour toutes les méthodes non `GET`.
- `TRUSTED_PROXY=cloudflare` : `keyGenerator` du limiteur de débit = `CF-Connecting-IP` si et
  seulement si l'adresse source est `127.0.0.1` ou `::1` ; sinon l'adresse source. Sans cela,
  tous les utilisateurs du tunnel partagent la même limite.
- Jetons (session, transaction, invitation) : `randomBytes(32)`, stockage et comparaison par
  hachage SHA-256.
- Journaux : ne jamais journaliser cookies, jetons, codes OAuth (la query du retour Google
  contient `code` et `state` : masquer l'URL de cette route dans les journaux Fastify) ni corps
  de `/api/invitations/*`. Les requêtes réussies ne sont pas journalisées : seules les actions
  utilisateur (`server/audit.ts`, attribuées à l'e-mail du compte) et les requêtes d'API en échec.
- CSP : inchangée (la navigation vers Google n'est pas une requête `fetch`).
- Pas de jeton d'accès ni de rafraîchissement Google stocké.

### 8.8 Commandes d'administration

Nouveau script `npm run admin` (`tsx --env-file-if-exists=.env server/admin.ts`) :

| Commande | Rôle |
|---|---|
| `npm run admin -- users` | Liste utilisateurs, e-mail, foyer, dernière connexion. |
| `npm run admin -- spaces` | Liste espaces, type, nombre de membres et d'enregistrements (y compris foyers sans membre). |
| `npm run admin -- assign-common --email <adresse> --confirm` | Sauvegarde, puis **déplace** les données de l'espace commun vers le foyer de ce compte (fusion `compareVersions` record par record ; analyses déplacées si leur `analysisKey` correspond au plat retenu), vide l'espace commun et change son `reset_id` pour que d'éventuels appareils en mode commun abandonnent leurs copies. Refuse si l'e-mail est absent, non vérifié ou ambigu. |
| `npm run admin -- assign-space --space <id> --email <adresse> --confirm` | Rattache un foyer sans membre à un compte (qui quitte son foyer actuel, refusé si celui-ci contient d'autres membres ou des données sans `--force`). |
| `npm run admin -- revoke-sessions --email <adresse>` | Déconnecte toutes les sessions d'un compte. |

Adapter aussi :

- [reset.ts](../server/reset.ts) : option obligatoire `--space common|<id>` ou `--email <adresse>` ;
- [requests.ts](../server/requests.ts) : afficher le foyer de chaque demande.

---

## 9. Client : espaces locaux et synchronisation

### 9.1 Bases IndexedDB

[repository.ts](../src/repository.ts) est déjà paramétré par un nom de base. Utiliser :

| Base | Contenu |
|---|---|
| `a-table-v1` | **Espace commun** (nom historique conservé : les appareils actuels retrouvent leurs données en mode `AUTH_ENABLED=false`). |
| `a-table-guest` | Mode invité. |
| `a-table-u-<userId>-s-<spaceId>` | Cache d'un compte dans un foyer. |

Une même base n'est jamais partagée entre deux comptes ni entre deux foyers.

`localStorage` `a-table-auth` mémorise le dernier état connu non sensible
(`authEnabled`, `userId`, `spaceId`, nom, e-mail, nom du foyer, `signedIn`) pour ouvrir la bonne
base **au démarrage hors ligne**. Ce n'est pas une preuve d'authentification : seul le serveur
décide.

### 9.2 Machine d'état du store

Dans [store.ts](../src/store.ts), ajouter `auth` à l'état :

```ts
type AuthState =
  | { mode: 'unknown' }                 // premier lancement hors ligne sans état mémorisé
  | { mode: 'disabled' }                // AUTH_ENABLED=false : espace commun
  | { mode: 'guest' }
  | { mode: 'signed-in'; user; space }
  | { mode: 'expired'; user; space }    // 401 : cache lisible, envoi suspendu
  | { mode: 'revoked'; user; space };   // 403 membership_revoked
```

Règles :

- Démarrage : ouvrir immédiatement la base correspondant à `a-table-auth` (ou `a-table-guest`
  si rien n'est mémorisé), puis appeler `GET /api/auth/session` et basculer si nécessaire.
- `switchSpace(dbName)` : attendre la synchronisation en vol, incrémenter une **époque**
  (toute réponse d'une époque précédente est ignorée), fermer l'ancienne base, ouvrir la
  nouvelle, `refresh()`, puis prévenir les autres onglets via `BroadcastChannel`
  (`{ type: 'space-changed' }` → ils relisent la session et basculent eux aussi).
- `synchronize()` :
  - `guest` / `unknown` → aucune requête ; `connection: 'local'` ;
  - `disabled` / `signed-in` → comportement actuel ;
  - 401 → `expired` (outbox conservée) ; 403 `membership_revoked` → `revoked`.
- `generateMeal`, l'import d'URL et les demandes d'évolution : refus explicite hors
  `signed-in` / `disabled`, avec un message invitant à se connecter.
- Les réglages du mode invité (convives, aliments à éviter, niveau, modèle) doivent exister sans
  serveur : créer localement dans `a-table-guest` un `settings:global` de version 0
  (`modifiedAt: 0`, `mutationId` nul) **hors outbox**, avec `defaultModel` mémorisé (repli :
  valeur par défaut de `OPENAI_MODEL` dans [config.ts](../server/config.ts), exposée dans le
  modèle partagé). Les écrans de réglages ne doivent plus être désactivés faute de paramètres
  reçus du serveur.

### 9.3 Import des données invitées (première connexion ou reconnexion)

Déclenché après chaque connexion réussie (`?auth=ok`) ou acceptation d'invitation, si
`a-table-guest` contient au moins un enregistrement de version non nulle. Étapes, dans cet
ordre, chacune reprenable :

1. Ouvrir la base du compte et effectuer une **synchronisation sans mutation** pour obtenir le
   `resetId` et l'instantané du foyer. Sans cela, un `resetId` différent ferait supprimer les
   données importées par `merge()`.
2. **Dédoublonnage du carnet** : pour chaque plat invité dont `normalizedName` correspond à un
   plat non archivé du foyer, ne pas importer le plat invité et réécrire les repas invités qui
   le référencent vers le plat du foyer (nouveau `mutationId`, même `modifiedAt`).
3. Copier dans **une seule transaction** de la base du compte (`records` + `outbox`) tous les
   enregistrements invités restants **avec leurs versions d'origine**, en ne remplaçant un
   record local que si la version invitée est plus récente (`compareVersions`). Exclure le
   `settings:global` invité de version 0.
4. Marquer dans `meta` de la base invitée `importedInto: <dbName>`, puis la vider
   (`records`, `outbox`, `analyses`).
5. Lancer `synchronize()` : l'outbox existante envoie les lots de 100 et n'acquitte que ce que
   le serveur confirme. Une coupure laisse les mutations dans l'outbox : rien n'est perdu.

Si l'étape 3 a réussi mais pas l'étape 4 (fermeture brutale), la reprise recopie les mêmes
identifiants et versions : l'opération est idempotente.

Côté serveur, lors de la fusion d'un `settings` dont le modèle n'est pas autorisé, **remplacer**
le modèle par `OPENAI_MODEL` au lieu de rejeter tout le lot (aujourd'hui un modèle invalide
bloque la synchronisation entière, ce qui bloquerait l'import).

Conséquence assumée de la fusion automatique : un repas invité plus récent remplace le repas du
foyer sur le même créneau et la même position. Les plats importés sont analysés par l'IA (IA
inchangée).

### 9.4 Déconnexion, expiration, changement de compte

- **Déconnexion** (`POST /api/auth/logout`) : tenter une synchronisation si en ligne ; si des
  modifications restent en attente, prévenir qu'elles seront envoyées à la prochaine connexion
  de ce compte. Puis basculer vers `a-table-guest` (vide). La base du compte est conservée.
- **Expiration** : bandeau « Session expirée — reconnectez-vous pour envoyer vos N
  modifications ». Après reconnexion avec le **même** compte, reprise normale de l'outbox.
- **Autre compte sur l'appareil** : sa propre base ; les caches des autres comptes ne sont
  jamais affichés ni envoyés.
- **Retrait du foyer / départ** : prévenir que les N modifications non envoyées de ce foyer
  seront perdues, puis supprimer la base `a-table-u-<userId>-s-<ancienSpace>` et ouvrir celle
  du nouveau foyer. Les données du foyer quitté ne sont jamais importées ailleurs.
- **Ancienne base commune** : si `AUTH_ENABLED=true` et que `a-table-v1` contient des
  modifications non envoyées, proposer une fois, après connexion, « Importer les modifications
  non synchronisées de l'ancien carnet commun » (même procédure que 9.3) ou « Ignorer ».
  Jamais d'import implicite de cette base.

### 9.5 Service worker

[service-worker.js](../pwa/service-worker.js) ignore déjà `/api/` : la navigation vers
`/api/auth/google/callback` atteint le serveur. Le retour `/?auth=ok` est servi depuis le cache
comme toute navigation. Le client lit `auth`/`reason`, puis nettoie l'URL avec
`history.replaceState`. Le bouton de connexion est désactivé hors ligne.

---

## 10. Interface

Respecter le skill `app-interface` : dialogues natifs, focus, zones tactiles, thème sombre pour
toute nouvelle couleur, aucun débordement à 320 px, sept lignes du planning toujours visibles
sur Pixel.

### 10.1 Bandeau invité (bas de page)

Dans [App.tsx](../src/App.tsx), au-dessus du pied de page existant, en mode `guest` :

> **Vos repas restent sur cet appareil et peuvent être perdus.**
> [Se connecter avec Google]

- Bouton conforme aux [règles de marque Google](https://developers.google.com/identity/branding-guidelines)
  (logo « G », libellé « Se connecter avec Google »).
- Une ligne sur téléphone (texte raccourci si nécessaire : « Données sur cet appareil
  uniquement »), discret mais persistant ; pas de fermeture définitive.
- L'indicateur de connexion du pied de page affiche « Sur cet appareil uniquement ».

### 10.2 Connexion

Clic → `POST /api/auth/google/start` (avec l'invitation éventuelle) → `location.assign(url)`.
Avant de partir : attendre la fin de toute sauvegarde locale en cours.
Au retour : `?auth=ok` → notification « Connecté — synchronisation de vos repas… », puis
import (9.3). `?auth=error` → dialogue d'erreur en français selon `reason`, données intactes.

### 10.3 Paramètres : carte « Compte et foyer »

Dans [Settings.tsx](../src/Settings.tsx), en tête :

- **Invité** : explication du risque + bouton Google.
- **Connecté** : photo, nom, e-mail ; nom du foyer (modifiable) ; liste des membres (bouton
  « Retirer » sauf pour soi) ; bouton « Inviter quelqu'un » → génère le lien, le copie
  (`navigator.clipboard`, sinon champ sélectionnable) et affiche « Valable 7 jours, une seule
  utilisation » ; invitations actives avec « Révoquer » ; « Quitter le foyer » (confirmation) ;
  « Se déconnecter ».
- **Expiré / retiré** : message et action correspondante.
- **Authentification désactivée** : la carte n'apparaît pas.

### 10.4 Lien d'invitation

`https://dailyplanner.fr/#invitation=<jeton>` (fragment : jamais envoyé au serveur ni à Cloudflare).
Au chargement : lire le fragment, le mémoriser dans `sessionStorage` `a-table-invitation`,
nettoyer l'URL, appeler `POST /api/invitations/preview`, puis :

- **invité** : dialogue « {Nom} vous invite à rejoindre « {Foyer} ». Vos repas de cet appareil
  y seront ajoutés. » → [Se connecter avec Google pour accepter] ;
- **connecté sans autre membre ni donnée** : acceptation directe ;
- **connecté avec un foyer existant** : confirmation « Vous quitterez « {Foyer actuel} ». Ses
  données y restent et ne vous suivront pas. » → `accept` avec `leaveCurrent: true` ;
- **invalide** : « Cette invitation n'est plus valable. Demandez un nouveau lien. »

### 10.5 Fonctions serveur en mode invité

Les boutons IA (étincelles du planning, génération dans les dialogues et relance du carnet)
ouvrent une fenêtre « Connexion requise » : seules les personnes connectées peuvent utiliser
l’IA. Elle propose « Se connecter avec Google », désactivé sans réseau ou serveur joignable.
Aucune génération ni relance n’est lancée, et les saisies en cours sont conservées.
L’import de recette par URL et les demandes d’évolution restent réservés aux comptes connectés.
Le tirage au hasard, la saisie et le carnet restent actifs. Une URL saisie en invité est
conservée telle quelle comme nom de repas ; son analyse démarrera après import.

---

## 11. Fichiers concernés

| Fichier | Changement |
|---|---|
| [package.json](../package.json) | `openid-client`, `@fastify/cookie`, script `admin` |
| [.env.example](../.env.example), [config.ts](../server/config.ts) | Variables et validations (section 5) |
| [database.ts](../server/database.ts) | Migration v2, espaces, comptes, sessions, invitations |
| `server/auth/*.ts` (nouveaux) | Fournisseurs, sessions, cookies, routes d'authentification et de foyer |
| [app.ts](../server/app.ts) | Résolution de l'accès, routes protégées, limiteur derrière Cloudflare |
| [ai.ts](../server/ai.ts), [index.ts](../server/index.ts) | Worker par espace, purge périodique |
| [reset.ts](../server/reset.ts), [requests.ts](../server/requests.ts), `server/admin.ts` | Administration par espace |
| [model.ts](../shared/model.ts) | Schémas session, foyer, invitations, codes d'erreur, modèle par défaut |
| [repository.ts](../src/repository.ts) | Noms de bases, copie d'import, réglages invités |
| [store.ts](../src/store.ts) | Machine d'état, bascule d'espace, import, refus invité |
| [App.tsx](../src/App.tsx), [Settings.tsx](../src/Settings.tsx), [MealEditor.tsx](../src/MealEditor.tsx), [Planner.tsx](../src/Planner.tsx), [Library.tsx](../src/Library.tsx) | Bandeau, carte compte/foyer, invitations, fonctions désactivées |
| [styles.css](../src/styles.css) | Bandeau, bouton Google, carte foyer (clair et sombre) |
| [README.md](../README.md) | Remplacer « pas d'authentification », documenter Google, Cloudflare, administration |
| `.github/skills/*/SKILL.md` | Mettre à jour architecture, synchronisation, interface, déploiement |

---

## 12. Compatibilité et bascules

| Transition | Effet attendu |
|---|---|
| Mise à jour avec `AUTH_ENABLED=false` | Aucun changement visible ; données migrées dans l'espace commun ; appareils existants inchangés. |
| `false` → `true` | Espace commun inaccessible ; appareils en mode invité ; aucune exposition des données communes. Lancer `assign-common`. |
| `true` → `false` | Foyers inaccessibles mais conservés ; caches de comptes conservés sur les appareils mais non affichés ; retour à l'espace commun. Les données invitées ne sont pas importées automatiquement dans l'espace commun. |
| Changement d'origine (IP → domaine) | IndexedDB ne suit pas : synchroniser avant ; les données invitées de l'ancienne origine restent sur l'ancienne origine. |

---

## 13. Tests

### 13.1 Vitest (serveur et modèle)

Dans [tests/](../tests) — utiliser le fournisseur simulé, jamais Google réel :

- configuration : refus de démarrer sans identifiants, origine HTTP non locale, proxy invalide ;
- migration v1 → v2 : données copiées dans `common`, `resetId` repris, idempotence, sauvegarde ;
- isolation : un foyer ne lit ni n'écrit les données d'un autre ; `common` inaccessible avec
  authentification ; foyers inaccessibles sans ;
- `401` sans session, `403` après retrait, session expirée, renouvellement glissant ;
- retour OAuth : `state` invalide, transaction expirée ou rejouée refusés ;
- premier retour : création utilisateur + foyer ; avec invitation : rattachement ; identité
  existante : même utilisateur (même `sub`, e-mail changé) ;
- invitations : expirée, révoquée, déjà utilisée, acceptation concurrente (une seule réussit),
  confirmation exigée pour quitter un foyer ;
- dernier membre qui quitte : foyer conservé sans membre, nouveau foyer au prochain appel ;
- worker IA : paramètres de l'espace du plat ;
- modèle non autorisé dans un import : remplacé, lot accepté ;
- `assign-common` : fusion `compareVersions`, `reset_id` commun changé ;
- débit : clé `CF-Connecting-IP` uniquement depuis le bouclage.

### 13.2 Vitest (client, `fake-indexeddb`)

- import complet de plus de 100 enregistrements, interrompu puis repris, sans perte ni doublon ;
- import après réinitialisation du foyer (`resetId` non nul) : rien n'est supprimé ;
- dédoublonnage par nom normalisé et réécriture des `dishId` ;
- conflit : version la plus récente conservée ;
- réponse d'une ancienne époque ignorée après changement d'espace ;
- déconnexion puis reconnexion : cache retrouvé, base invitée vide ;
- deux comptes sur un même appareil : bases distinctes.

### 13.3 Playwright

Avec le fournisseur simulé sur la base mémoire de [playwright.config.ts](../playwright.config.ts) :

- arrivée invitée : bandeau visible, actions IA ouvrant la connexion Google sans lancer l’IA, tirage et saisie possibles, aucune requête
  `/api/sync` ;
- connexion : import puis données visibles sur un second contexte du même compte ;
- invitation entre deux comptes : partage réel des repas ;
- session expirée : saisie conservée, envoi après reconnexion ;
- formats Pixel et 320 px : sept lignes visibles avec le bandeau, aucun débordement, thème
  sombre ;
- les scénarios existants continuent de passer avec `AUTH_ENABLED=false`.

### 13.4 Validation finale

```powershell
npm run typecheck
npm test
npm run build
npm run test:e2e -- --project=pixel-chrome
```

Puis essai **réel** avec Google : PC sur `http://localhost:3000`, puis téléphone et PWA
installée sur le domaine Cloudflare.

---

## 14. Déploiement

### 14.1 Développement sur le PC

1. `npm run backup -- C:\Sauvegardes\planner-avant-auth.sqlite`
2. Implémenter (section 15), puis dans `.env` :
   `AUTH_ENABLED=true`, `PUBLIC_ORIGIN=http://localhost:3000`, identifiants du client **dev**.
3. `npm run build` puis `npm start`, ouvrir `http://localhost:3000` (pas l'IP LAN).
4. Se connecter, vérifier le foyer, puis
   `npm run admin -- assign-common --email <adresse> --confirm`.

### 14.2 Domaine et téléphone

1. Tunnel configuré (section 4), client OAuth **prod** avec l'URI de retour du domaine.
2. `.env` : `PUBLIC_ORIGIN=https://dailyplanner.fr`, `HOST=127.0.0.1`, `TRUSTED_PROXY=cloudflare`,
   identifiants **prod**. Redémarrer Node.
3. Sur chaque appareil : ancienne adresse → synchroniser ; nouvelle adresse → se connecter.
4. Supprimer la règle de pare-feu de l'essai Wi-Fi si elle existe (voir README).
5. Inviter les autres membres depuis les paramètres.

### 14.3 Ouverture publique

- Page d'accueil publique, **politique de confidentialité** (données stockées : nom, e-mail,
  photo Google, repas ; hébergement sur le PC ; IA OpenAI pour l'analyse des plats ; suppression
  sur demande) et conditions d'utilisation, accessibles sans connexion.
  URL retenues : `https://dailyplanner.fr`, `https://dailyplanner.fr/confidentialite` et
  `https://dailyplanner.fr/conditions-utilisation`. Ces deux dernières pages sont à créer
  avant la vérification publique (section 3.2).
- Vérifier le domaine dans Google Search Console, puis publier l'application (*In production*)
  et lancer la [vérification de marque](https://developers.google.com/identity/protocols/oauth2/production-readiness/brand-verification)
  si un logo ou un nom de marque est affiché.
- Rappel : le quota IA est de 20 tentatives par jour et par foyer, sauf exemption administrative ; ce n’est pas un plafond de dépenses OpenAI.
  Surveiller les compteurs des paramètres et l'usage OpenAI.
- Sauvegarde planifiée de SQLite (`npm run backup`) et démarrage automatique de Node
  ([start.ps1](../scripts/start.ps1)) et de `cloudflared` (service Windows).

---

## 15. Prompt de lancement

Une fois la section 2 complétée et les identifiants placés dans `.env`, envoyer à l'agent :

```text
Mets en œuvre docs/authentification-google.md dans son intégralité, sections 5 à 13.
Respecte les décisions de la section 1 sans les rediscuter, les invariants de la section 6
et les skills du dépôt. Commence par une sauvegarde de data/planner.sqlite.
Procède dans cet ordre : migration et espaces, authentification serveur, client et import,
interface, administration, documentation et skills, tests. Ne lis jamais .env en entier et
n'affiche aucun secret. Valide avec npm run typecheck, npm test, npm run build et
npm run test:e2e -- --project=pixel-chrome, puis donne-moi la procédure d'essai réel
de la section 14.1.
```
