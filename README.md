# À table !

Un carnet de repas partagé, responsive et installable en PWA. Interface française, fond crème, terracotta et sauge, illustrations végétales originales. Aucune recette ni aucun menu prérempli.

## Skills de compréhension du projet

Les skills du dépôt sont chargés à la demande par les agents compatibles, ou
invocables depuis le menu `/` de Copilot :

- [app-architecture](.github/skills/app-architecture/SKILL.md) : carte du projet, modèle et parcours des données.
- [app-interface](.github/skills/app-interface/SKILL.md) : planning, saisie, carnet et interface responsive.
- [app-sync-offline](.github/skills/app-sync-offline/SKILL.md) : IndexedDB, conflits, synchronisation et cache PWA.
- [app-ai-library](.github/skills/app-ai-library/SKILL.md) : enrichissement OpenAI, saisons, corrections et quotas.
- [app-deployment](.github/skills/app-deployment/SKILL.md) : installation Windows, Wi-Fi, HTTP/HTTPS, sauvegarde et diagnostic.

Commencer par `app-architecture` pour une vue d'ensemble ; chaque skill renvoie aux
fichiers source et aux vérifications ciblées, sans imposer de charger les autres.

## Démarrer sur Windows, sans Docker

Prérequis : **Node.js 22.13 ou supérieur** (une version LTS récente recommandée), npm. SQLite est fourni par Node ; aucun serveur de base de données à installer. Node 22 peut afficher un avertissement `ExperimentalWarning` concernant SQLite.

Dans PowerShell, à la racine du dépôt :

```powershell
npm ci
Copy-Item .env.example .env
# Éditer .env, notamment OPENAI_API_KEY si l’analyse est souhaitée.
npm run build
npm start
```

Ouvrir **http://localhost:3000**. Cette adresse locale est un contexte sécurisé pour les PWA, même sans HTTPS. Sans clé OpenAI, les menus et le carnet fonctionnent ; les analyses restent en attente. Ne jamais placer la clé dans le client, dans une variable `VITE_*`, ni dans Git.

Le serveur écoute uniquement sur `127.0.0.1`. Une adresse `http://192.168…` sur le téléphone ne suffit **pas** pour installer correctement le mode hors ligne : utiliser HTTPS, comme expliqué ci-dessous.

### Essai temporaire sur le Wi-Fi en HTTP

Pour consulter et modifier les menus depuis le téléphone **sans installer la PWA hors ligne**, configurer les valeurs suivantes dans `.env`, en remplaçant l’adresse par l’IP locale du PC :

```dotenv
HOST=0.0.0.0
PORT=3000
PUBLIC_ORIGIN=http://192.168.1.22:3000
```

Reconstruire avec `npm run build`, puis arrêter le serveur existant avec `Ctrl+C` et le relancer avec `npm start`. Sur le téléphone connecté au même réseau, ouvrir **http://192.168.1.22:3000**. Cette origine exacte est autorisée pour la synchronisation ; utiliser aussi cette adresse sur le PC pendant l’essai. Si l’IP change, mettre à jour `PUBLIC_ORIGIN` et redémarrer.

Si le pare-feu Windows bloque les connexions, créer une règle entrante **limitée au sous-réseau local**, dans un PowerShell administrateur :

```powershell
New-NetFirewallRule -DisplayName 'À table - test Wi-Fi TCP 3000' -Direction Inbound -Action Allow -Protocol TCP -LocalPort 3000 -RemoteAddress LocalSubnet -Profile Any
```

Ne pas désactiver le pare-feu, ni rediriger le port 3000 sur la box. Cette règle couvre aussi un réseau Windows classé « Public » ; elle reste limitée au sous-réseau local. Une fois l’essai terminé, la supprimer :

```powershell
Remove-NetFirewallRule -DisplayName 'À table - test Wi-Fi TCP 3000'
```

Sur HTTP LAN, les données restent sauvegardées dans IndexedDB et la saisie/synchronisation fonctionnent, mais **le rechargement sans serveur et l’installation PWA hors ligne ne sont pas disponibles**. Les échanges ne sont pas chiffrés : réserver cet essai à un réseau de confiance. Pour passer à Caddy/HTTPS, rétablir `HOST=127.0.0.1` et définir `PUBLIC_ORIGIN` avec l’adresse HTTPS.

### Développement

```powershell
npm run dev
```

Client : http://localhost:5173 ; API : http://127.0.0.1:3000. Le proxy Vite est configuré pour le port 3000. Le service worker est volontairement absent en développement ; tester le mode hors ligne avec le **build de production**.

## Utilisation

- À l’ouverture : **aujourd’hui et les six jours suivants**, selon `Europe/Paris`. Une ligne par jour, deux colonnes midi/soir. Le titre et la navigation forment une bannière compacte ; les sept lignes se partagent la hauteur disponible et le planning occupe toute la largeur de la page. Sur les écrans très courts, la page reste défilable pour préserver la lisibilité et les cibles tactiles.
- Faire défiler **verticalement la grille** : passé au-dessus, futur en dessous. Les flèches déplacent de sept jours ; « Aujourd’hui » recentre le planning. L’historique reste conservé.
- Toucher un créneau pour saisir un repas ou choisir dans une **liste de cartes**, sans combobox. Les suggestions sont exclusivement vos créations, classées selon la saison de la date sélectionnée. « Tous les repas » ignore la saison.
- Chaque case vide propose deux boutons à droite : **étincelles** pour générer un repas de saison avec l’IA, **flèches croisées** pour piocher au hasard dans le carnet de saison (y compris les plats « toute l’année », hors archives). Le choix est enregistré directement. Le tirage privilégie les repas absents des **sept jours affichés**, puis accepte une répétition si aucun autre choix n’existe. Il fonctionne aussi hors ligne ; un carnet sans repas de saison affiche une explication.
- La génération IA exige le serveur et une clé OpenAI. Elle utilise la saison de la date du créneau et les mêmes modèles et quotas que l’analyse ; les erreurs laissent la case vide. Le repas et sa fiche complète rejoignent le carnet sans second appel d’enrichissement.
- Avant une génération, l’application synchronise les dernières saisies et le modèle choisi. L’IA reçoit les noms de tous les plats créés (archives comprises) et des repas choisis **de J−15 à J+15 autour d’aujourd’hui à Paris**, bornes incluses (31 dates), indépendamment du créneau à remplir. Elle doit proposer un plat différent, éviter les repas récents et leurs variantes proches ; une vraie variante d’un plat ancien est possible si celui-ci n’a pas été choisi dans cette période. Un nom déjà présent est refusé avec une erreur, sans nouvel appel automatique.
- Une saisie nouvelle est sauvegardée immédiatement. Sa fiche reçoit provisoirement la saison de création. L’IA corrige ensuite le nom dans le carnet, propose une ou plusieurs saisons, des ingrédients et une recette courte. **Le texte déjà saisi dans le planning ne change jamais à cause de cette analyse.**
- Les saisons sont larges : mars–mai, juin–août, septembre–novembre, décembre–février, ou toute l’année.
- Le carnet permet de corriger les fiches, de les archiver et de les restaurer. Les anciens menus conservent leur texte. Une correction manuelle a priorité sur une analyse en cours ; « Relancer l’IA » remplace les informations de la fiche par une nouvelle analyse.
- **Quatre taps/clics rapides sur le titre** (moins de 650 ms entre chaque) forcent la synchronisation et la vérification des mises à jour. Une fenêtre confirme le succès ou explique l’erreur. Le bouton « Synchroniser » des paramètres offre une alternative accessible.

### Téléphone, tablette et installation

L’interface cible notamment les formats Pixel 9 et tablette Xiaomi, ainsi que Chrome et Firefox sur grand écran. Chrome Android/desktop propose l’installation ; Firefox Android permet l’ajout via son menu. Firefox desktop fonctionne comme un site classique, sans dépendre d’une fonction native d’installation.

Le premier chargement doit être effectué en ligne. Attendre **« Application hors ligne : Prête sur cet appareil »** dans les paramètres avant de compter sur le cache. L’installation demande aussi au navigateur un stockage persistant, que celui-ci peut refuser.

## Hors ligne et synchronisation

React/TypeScript pour le client, IndexedDB pour les données locales et la file de modifications, Fastify pour l’API, SQLite en mode WAL pour le stockage partagé.

1. Une écriture locale est atomique : fiche du nouveau repas, créneau et file d’envoi sont sauvegardés ensemble dans IndexedDB, **avant** de fermer l’éditeur.
2. Chaque modification utilisateur possède `modifiedAt` (millisecondes UTC) et `mutationId` (UUID). La plus récente l’emporte **par créneau, par fiche et pour les paramètres**, jamais pour la semaine entière. Une égalité exacte est départagée par l’UUID, de façon déterministe.
3. La synchronisation transmet les modifications en attente et reçoit un instantané complet du serveur. Un accusé de réception ancien ne peut pas effacer une nouvelle modification effectuée pendant la requête.
4. Vider un créneau conserve un enregistrement vide daté, plutôt qu’une suppression physique. Un appareil resté hors ligne ne peut donc pas ressusciter l’ancien repas.
5. Les analyses IA sont séparées des versions utilisateur. Une réponse devenue obsolète ne remplace ni une correction manuelle ni une nouvelle demande d’analyse.
6. La synchronisation se déclenche au lancement, après une saisie, au retour au premier plan/réseau et toutes les 20 secondes lorsque l’application est visible. Elle vérifie réellement l’API, pas seulement `navigator.onLine`.

Hors ligne, saisie, sélection en cache, suppression, modification et archivage restent disponibles. Les analyses sont reportées ; choix du modèle et relance explicite de l’IA sont désactivés. Une erreur de stockage est affichée et ne produit jamais une fausse confirmation d’enregistrement.

Les appareils doivent avoir la date automatique activée. Une horloge en avance de plus de cinq minutes est refusée par le serveur avec une erreur explicite ; les changements restent locaux. Après correction de l’horloge, les écritures déjà datées dans le futur restent en attente jusqu’à ce que leur date soit admissible. Comme tout arbitrage par horodatage client, ce système ne garantit pas l’ordre réel des actions si les horloges sont incorrectes.

Le service worker conserve une version complète du client (HTML, JS, CSS, icônes), sans mettre en cache l’API. Une nouvelle version doit être intégralement téléchargée avant installation et attend la fermeture des anciens onglets pour s’activer. **La synchronisation forcée ne vide aucun cache, n’efface aucune file et ne recharge jamais brutalement la page.** Fermer toutes les fenêtres de l’application puis la rouvrir pour activer une mise à jour signalée dans les paramètres.

### Limites réelles de disponibilité

Une application **déjà chargée et mise en cache** reste utilisable si le PC ou Internet est arrêté. Les autres appareils ne recevront les changements qu’au retour du serveur. Une première visite hors ligne, l’effacement volontaire des données du navigateur, son éviction du stockage ou une panne matérielle ne peuvent pas être compensés par la PWA. Ne pas utiliser la navigation privée pour conserver le carnet.

## OpenAI et budget

API Responses, sorties JSON structurées, un appel asynchrone par création ou relance, sans outil externe. Pour l’analyse, seul le **nom du repas** est envoyé à OpenAI. Pour la génération d’une idée, sont envoyés la **saison du créneau**, les **noms du carnet complet** et ceux des **repas choisis de J−15 à J+15 autour d’aujourd’hui à Paris**, avec les noms bruts et affichés des fiches liées. Les listes sont dédupliquées, sans troncature ; les dates, identifiants, ingrédients et recettes existantes ne sont pas transmis. Ce contexte augmente les tokens d’entrée. `store: false` désactive le stockage de la réponse par l’API ; les politiques de conservation du fournisseur restent applicables.

Le modèle par défaut est **`gpt-6-luna`**. Les paramètres proposent par défaut **`gpt-6-luna`**, **`gpt-6-sol`**, **`gpt-5.6-luna`** et **`gpt-5.6-terra`**. Leur disponibilité effective dépend du compte et de l’API OpenAI ; la liste autorisée se configure côté serveur. Si `.env` définit déjà `OPENAI_ALLOWED_MODELS`, mettre aussi cette liste à jour : elle remplace les valeurs par défaut. Redémarrer le serveur puis synchroniser pour actualiser les paramètres.

Si un modèle déjà sélectionné est retiré de la liste autorisée, les analyses se mettent en attente sans consommer d’appel. Les paramètres demandent de choisir un modèle autorisé pour les reprendre.

| Variable serveur | Valeur par défaut | Rôle |
|---|---|---|
| `OPENAI_API_KEY` | vide | Clé serveur ; jamais renvoyée au navigateur |
| `OPENAI_MODEL` | `gpt-6-luna` | Modèle initial d’une nouvelle base |
| `OPENAI_ALLOWED_MODELS` | `gpt-6-luna,gpt-6-sol,gpt-5.6-luna,gpt-5.6-terra` | Liste autorisée dans les paramètres |
| `AI_DAILY_LIMIT` | `20` | Nombre maximal de tentatives par jour français |
| `AI_MONTHLY_LIMIT` | `200` | Nombre maximal de tentatives par mois français |

Une seule analyse à la fois, délai de 45 secondes, sortie plafonnée à 1 400 tokens. Les tentatives sont comptabilisées **avant** l’appel, y compris les échecs. Les quotas persistent après redémarrage. Les erreurs ne sont pas relancées automatiquement ; elles sont visibles dans le carnet. Une analyse interrompue au redémarrage doit également être relancée explicitement. Les tâches en attente de quota reprennent après son renouvellement.

Les paramètres montrent les appels et les tokens des réponses traitées avec succès. Ce compteur de tokens n’est pas une facture : une réponse interrompue/invalide peut aussi avoir été facturée. Les plafonds d’appels limitent l’usage, mais **ne garantissent pas un plafond en euros** (prix du modèle, taux de change, autres usages de la clé). Configurer également les alertes et limites disponibles sur le projet OpenAI. Il est possible de réduire les plafonds dans `.env`.

Les recettes/ingrédients IA sont des suggestions, pas une composition garantie, une certification allergène ou un conseil médical. Ils sont modifiables.

## HTTPS et exposition Internet

### Important : pas d’authentification

**Toute personne qui connaît ou trouve l’adresse peut lire et modifier les menus et déclencher des appels OpenAI. HTTPS chiffre les échanges mais ne restreint pas l’accès.** Le serveur vérifie les origines des requêtes navigateur, limite leur débit et impose les modèles/quotas côté serveur. Cela ne remplace pas un contrôle d’accès contre une personne déterminée. Ne pas y stocker d’informations sensibles.

Seul Caddy doit être exposé. Ne jamais ouvrir directement le port Node 3000 ni publier le dossier de données. Le serveur statique ne sert que `dist/client`.

### Avec un domaine ou un DNS dynamique

1. Choisir un domaine/sous-domaine pointant vers l’IP publique du domicile. En IP dynamique, configurer un DNS dynamique.
2. Vérifier que la box dispose d’une IP publique joignable (pas de CGNAT bloquant les connexions entrantes). Rediriger **TCP 80 et 443** vers le PC et les autoriser dans le pare-feu Windows pour Caddy.
3. Installer Caddy, par exemple `winget install CaddyServer.Caddy`.
4. Dans `.env`, configurer `PUBLIC_ORIGIN=https://repas.votre-domaine.fr`, sans slash final. Conserver `HOST=127.0.0.1` et `PORT=3000`.
5. Lancer l’application, puis Caddy dans un second PowerShell :

```powershell
$env:APP_DOMAIN = 'repas.votre-domaine.fr'
caddy run --config .\Caddyfile --adapter caddyfile
```

Caddy obtient et renouvelle automatiquement le certificat et redirige HTTP vers HTTPS. La variable `APP_DOMAIN` appartient à l’environnement de Caddy ; Node lit séparément `.env`. Adapter le port du reverse proxy si `PORT` change.

Le domaine et la connectivité de la box doivent être renseignés avant de pouvoir **valider** le HTTPS public. Aucune configuration DNS, redirection de ports ou émission de certificat public n’est effectuée automatiquement par ce dépôt.

### HTTPS local de développement

Pour tester avec Caddy sur le PC :

```powershell
# Dans .env, utiliser PUBLIC_ORIGIN=https://localhost:8443, puis redémarrer Node.
caddy run --config .\Caddyfile.local --adapter caddyfile
```

Ouvrir https://localhost:8443. Caddy utilise une autorité locale, qui doit être approuvée par le navigateur (`caddy trust`, si nécessaire et volontairement exécuté avec les droits adaptés). Cette confiance n’est pas automatiquement transférée au téléphone. Pour un usage familial sur plusieurs appareils, privilégier un domaine et un certificat public.

### Maintien du service et migration

Configurer le Planificateur de tâches Windows pour lancer au démarrage :

- `powershell.exe -NoProfile -File C:\sources\DailyPlanner\scripts\start.ps1`, avec un compte dédié disposant des droits nécessaires ;
- Caddy, avec un répertoire de travail dans le dépôt et `APP_DOMAIN` défini pour son compte.

Activer le redémarrage des tâches en cas d’échec ; empêcher la mise en veille du PC si une synchronisation permanente est souhaitée. Un redémarrage serveur n’interrompt pas la consultation/saisie des clients déjà mis en cache.

Pour migrer : installer Node et Caddy sur la nouvelle machine, copier le code et une sauvegarde cohérente de SQLite, recréer `.env`, exécuter `npm ci` puis `npm run build`, et déplacer le DNS. Garder si possible **la même origine HTTPS** : IndexedDB et le cache sont propres à chaque origine. Avant de changer d’adresse, synchroniser chaque appareil sur l’ancien serveur.

## Sauvegardes

Les données sont dans `data/planner.sqlite` par défaut, réglable avec `DATABASE_PATH`. Les fichiers `-wal` et `-shm` peuvent exister pendant le fonctionnement. Ne pas copier uniquement le fichier principal à chaud.

Créer une sauvegarde cohérente, même serveur démarré :

```powershell
npm run backup -- C:\Sauvegardes\a-table-2026-10-30.sqlite
```

La commande utilise `VACUUM INTO` et refuse d’écraser une destination existante. Pour restaurer, arrêter Node, conserver l’ancienne base et ses éventuels fichiers WAL/SHM à part, puis placer la sauvegarde à l’emplacement `DATABASE_PATH` avant de redémarrer. Les changements jamais synchronisés n’existent que sur les appareils concernés ; les synchroniser avant toute migration/restauration si possible.

## Vérification

```powershell
npm run typecheck
npm test
npm run build
# À la première exécution des tests navigateur, si les exécutables manquent :
npx playwright install chromium firefox
npm run test:e2e
# Vérification HTTP sur une véritable origine non sécurisée (IP locale du PC) :
$env:E2E_HOST = '192.168.1.22'
npm run test:e2e -- --project=pixel-chrome --grep='HTTP LAN'
Remove-Item Env:E2E_HOST
```

Les tests unitaires couvrent dates françaises/DST, contrats, conflits, effacements persistants, synchronisation en vol, concurrence des onglets, redémarrage SQLite, quotas et erreurs OpenAI. Les tests navigateur couvrent les formats téléphone/tablette/desktop, Chrome et Firefox, le rechargement réellement hors ligne, le serveur inaccessible malgré Internet, le quadruple clic, l’archivage et les conflits entre deux appareils.

Les appels OpenAI sont **simulés dans les tests** : aucune clé ni dépense n’est nécessaire. Un essai réel avec votre clé et une vérification sur les appareils physiques restent nécessaires après le déploiement.
