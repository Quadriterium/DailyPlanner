# À table !

Un carnet de repas partagé, responsive et installable en PWA. Interface française, fond crème, terracotta et sauge, illustrations végétales originales. Aucune recette ni aucun menu prérempli.

## Skills de compréhension du projet

Les skills du dépôt sont chargés à la demande par les agents compatibles, ou
invocables depuis le menu `/` de Copilot :

- [app-architecture](.github/skills/app-architecture/SKILL.md) : carte du projet, modèle et parcours des données.
- [app-interface](.github/skills/app-interface/SKILL.md) : planning, saisie, carnet et interface responsive.
- [app-sync-offline](.github/skills/app-sync-offline/SKILL.md) : IndexedDB, conflits, synchronisation et cache PWA.
- [app-ai-library](.github/skills/app-ai-library/SKILL.md) : enrichissement OpenAI, saisons, corrections et suivi d’utilisation.
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

Client : http://localhost:5173 ; API : `PORT` de `.env` (3000 par défaut), via le proxy Vite. Les modifications sont rechargées automatiquement : remplacement à chaud pour l’interface (Vite), redémarrage de l’API (`tsx watch`). Arrêter d’abord `npm start` s’il occupe déjà ce port. Si `HOST=0.0.0.0`, le client de développement est aussi accessible sur le réseau local (http://192.168.1.22:5173, ouvrir le port 5173 dans le pare-feu). Le service worker est volontairement absent en développement ; tester le mode hors ligne avec le **build de production**.

## Utilisation

- À l’ouverture : **aujourd’hui et les six jours suivants**, selon `Europe/Paris`. Une ligne par jour, deux colonnes midi/soir. Le titre et la navigation forment une bannière compacte ; les sept lignes se partagent la hauteur disponible et le planning occupe toute la largeur de la page. Sur les écrans très courts, la page reste défilable pour préserver la lisibilité et les cibles tactiles.
- Faire défiler **verticalement la grille** : passé au-dessus, futur en dessous. Les flèches déplacent de sept jours ; « Aujourd’hui » recentre le planning. L’historique reste conservé.
- Toucher un créneau pour saisir un repas ou choisir dans une **liste de cartes**, sans combobox. Les suggestions sont exclusivement vos créations, classées selon la saison de la date sélectionnée. « Tous les repas » ignore la saison. Sur un créneau vide, le dialogue propose aussi **Générer avec l’IA** et **Choisir au hasard**.
- Toucher un repas déjà choisi ouvre sa recette et ses ingrédients, lorsqu’ils sont disponibles. « Modifier le repas » permet de changer le nom ou de choisir une autre fiche ; « Vider » supprime uniquement ce choix du planning. On peut aussi le remplacer au hasard dans le carnet de saison ou demander une proposition à l’IA. En cas d’échec, le repas initial reste conservé.
- Un créneau **midi ou soir peut contenir deux plats maximum**. Touchez le plat choisi, puis **Ajouter un deuxième plat** dans sa fiche : saisie, sélection du carnet, tirage ou génération IA. Sur téléphone (jusqu’à 520 px), le nom conserve toute la largeur de la carte, sans bouton d’ajout dans le planning. Sur tablette et ordinateur, un raccourci **+** est intégré au bord droit de la carte ; toucher le nom ouvre toujours sa fiche. L’ajout n’est proposé que s’il reste une place. Les deux plats se partagent la case existante, sans agrandir les jours : une carte séparée en deux, chaque nom sur deux lignes au plus (le nom complet reste visible dans la fiche). Les convives n’y sont pas affichés pour préserver la lisibilité. Touchez chaque plat pour sa recette ou ses convives (par exemple soupe pour les enfants et filet mignon pour les adultes). Modifier ou vider l’un ne touche pas l’autre.
- Chaque case vide propose deux boutons à droite : **étincelles** pour générer un repas de saison avec l’IA, **flèches croisées** pour piocher au hasard dans le carnet de saison (y compris les plats « toute l’année », hors archives). Le choix est enregistré directement. Le tirage privilégie les repas absents des **sept jours affichés**, puis accepte une répétition si aucun autre choix n’existe. Il fonctionne aussi hors ligne ; un carnet sans repas de saison affiche une explication.
- Les paramètres définissent un **niveau de cuisine** partagé entre les appareils, sur quatre crans : **Tablier tout neuf** (express et sans technique), **Popote du quotidien** (classiques familiaux faciles, par défaut), **Toque affûtée** (plusieurs préparations et un vrai coup de main) et **Haute voltige étoilée** (techniques fines, temps long, dressage soigné). La génération IA propose un plat de ce niveau, et le tirage au hasard ne pioche que parmi les plats du carnet ayant ce niveau.
- Pour un repas ponctuel, un **appui long** (ou un clic droit) sur un bouton de génération ou de tirage, dans le planning comme dans la fiche d’un repas, ouvre un menu de choix du niveau, sans modifier celui des paramètres. Pour le tirage, ce menu indique le nombre de plats de saison par niveau ; les niveaux sans plat sont grisés.
- Chaque fiche affiche son niveau dans le carnet et dans la recette du repas. L’IA l’évalue selon les gestes de la recette, pas la seule durée de cuisson. À la génération, une réponse annonçant un autre niveau que celui demandé est refusée avec une erreur, sans être réétiquetée ni relancée automatiquement. On peut corriger le niveau dans **Mon carnet**, et le retirer en touchant à nouveau le niveau sélectionné. Une fiche sans niveau (saisie sans IA, ancienne analyse) n’est jamais piochée au hasard tant qu’aucun niveau ne lui est attribué ou qu’elle n’est pas réanalysée.
- La génération IA exige le serveur et une clé OpenAI. Elle utilise la saison de la date du créneau, le niveau de cuisine demandé, la composition du foyer définie dans les paramètres et les mêmes modèles que l’analyse ; les erreurs laissent la case vide. Le repas et sa fiche complète rejoignent le carnet sans second appel d’enrichissement.
- Avant une génération, l’application synchronise les dernières saisies et le modèle choisi. L’IA reçoit les noms de tous les plats créés (archives comprises) et des repas choisis **de J−15 à J+15 autour d’aujourd’hui à Paris**, bornes incluses (31 dates), indépendamment du créneau à remplir. Elle doit proposer un plat différent, éviter les repas récents et leurs variantes proches ; une vraie variante d’un plat ancien est possible si celui-ci n’a pas été choisi dans cette période. Un nom déjà présent est refusé avec une erreur, sans nouvel appel automatique.
- Une saisie nouvelle est sauvegardée immédiatement. Sa fiche reçoit provisoirement la saison de création. L’IA corrige ensuite le nom dans le carnet, propose une ou plusieurs saisons, des ingrédients avec quantités adaptées au foyer et une recette courte. **Les noms saisis normalement dans le planning restent inchangés à cause de cette analyse.**
- Dans **Qu’est-ce qu’on mange ?**, on peut aussi coller une **URL HTTP ou HTTPS** (2 048 caractères maximum, contre 240 pour un nom). Après synchronisation, le serveur récupère la page publique et transmet son contenu à l’IA. Le planning et le carnet affichent le vrai nom du plat dès son identification : immédiatement après récupération si la page fournit un nom de recette structuré, sinon à la fin de l’analyse IA. L’application synchronise toutes les 2 secondes pendant un import visible ; le lien d’origine reste conservé et consultable dans la fiche.
- L’IA utilise les ingrédients, étapes et portions de la recette source, reformule les étapes et adapte les quantités à la composition du foyer et aux préférences des paramètres. Si les portions manquent, les quantités sont signalées comme estimées ; si le plat est identifiable mais sans recette, la recette proposée est explicitement indicative et non issue de la page. **Sans clé IA, hors ligne ou si le site bloque la récupération, l’import ne peut pas aboutir** : le lien reste sauvegardé et les erreurs permettent une relance depuis le carnet. Les sites nécessitant JavaScript, connexion ou captcha ne sont pas parcourus comme un navigateur.
- Les adresses privées/locales, les liens avec identifiants et les ports non standards sont refusés à la récupération. Les redirections sont revérifiées, avec au maximum quatre redirections et 2 Mo de HTML. L’import reste différé et ne réécrit pas les versions des saisies : seuls les repas dont le texte est le lien d’origine affichent dynamiquement le nom de leur fiche.
- Les paramètres du foyer commencent à **2 adultes, 2 adolescents et 2 enfants**. Ils sont partagés entre les appareils et s’appliquent aux prochaines analyses et générations ; relancer l’IA sur une fiche existante recalcule ses quantités.
- Chaque plat utilise par défaut le foyer des paramètres, y compris ses changements ultérieurs. Touchez un plat choisi, puis **Adapter** dans **À table pour ce repas** : décochez **Utiliser le foyer des paramètres** et ajustez les adultes, adolescents et enfants avec les boutons −/+ ou la saisie numérique. **Enregistrer les convives** ne modifie que ce plat (0 à 20 par catégorie, au moins une personne au total). Une icône signale les repas personnalisés dans le planning lorsqu’un seul plat est prévu ; avec deux plats, les convives se consultent dans la fiche de chaque plat. Le réglage est conservé hors ligne et partagé entre appareils ; remplacer le plat le conserve, vider le plat le réinitialise. Recochez l’option pour revenir au foyer par défaut. Les quantités et la recette du carnet restent inchangées : ce réglage ne recalcule pas les ingrédients.
- Les paramètres contiennent aussi une zone libre **Repas et ingrédients à éviter** (1 000 caractères maximum), partagée entre les appareils. La génération ne propose pas de repas correspondant ou contenant ces ingrédients, et l’analyse les retire si possible des recettes sans changer le repas. Ce n’est pas une garantie en cas d’allergie.
- Les saisons sont larges : mars–mai, juin–août, septembre–novembre, décembre–février, ou toute l’année.
- Les paramètres proposent un thème **Clair**, **Sombre**, **Selon l’heure** (sombre de 20 h à 7 h par défaut, horaires modifiables, selon l’heure de l’appareil) ou **Comme le système**. Ce choix est propre à chaque appareil, n’est pas synchronisé, et s’applique dès l’ouverture, sans flash clair. Les jours du planning vont du marron pastel (lundi) au doré pastel (dimanche).
- Le carnet permet de corriger les fiches, de les archiver et de les restaurer. Les anciens menus conservent leur texte. Une correction manuelle a priorité sur une analyse en cours ; « Relancer l’IA » remplace les informations de la fiche par une nouvelle analyse.
- **Quatre taps/clics rapides sur le titre** (moins de 650 ms entre chaque) forcent la synchronisation et la vérification des mises à jour. Une fenêtre confirme le succès ou explique l’erreur. Le bouton « Synchroniser » des paramètres offre une alternative accessible.
- **Forcer la mise à jour**, dans les paramètres, retélécharge les fichiers de l’application (CSS compris), active une éventuelle nouvelle version puis recharge la page. Le serveur doit être accessible et une nouvelle version doit avoir été construite et déployée (`npm run build`). Les repas, la file d’envoi et le thème restent conservés ; enregistrez les champs en cours avant de cliquer. En cas d’échec du téléchargement, la page n’est pas rechargée. Sans cache PWA (HTTP LAN ou développement), le bouton recharge le site après vérification de son accès.
- Les paramètres permettent d’envoyer des **demandes d’évolution** (1 000 caractères maximum, serveur requis). Elles sont stockées dans SQLite et visibles depuis tous les appareils avec leur statut : **Reçue**, **Prévue**, **Ajoutée** ou **Non retenue**, accompagné d’une éventuelle réponse. Le statut se gère sur le serveur :

  ```powershell
  npm run requests                                   # liste les demandes et leurs identifiants courts
  npm run requests -- set 1a2b3c4d added "Disponible dans le carnet."
  ```

  Statuts acceptés : `received`, `planned`, `added`, `declined`. Fonctionne serveur démarré.

### Téléphone, tablette et installation

L’interface cible notamment les formats Pixel 9 et tablette Xiaomi, ainsi que Chrome et Firefox sur grand écran. Chrome Android/desktop propose l’installation ; Firefox Android permet l’ajout via son menu. Firefox desktop fonctionne comme un site classique, sans dépendre d’une fonction native d’installation.

Le premier chargement doit être effectué en ligne. Attendre **« Application hors ligne : Prête sur cet appareil »** dans les paramètres avant de compter sur le cache. L’installation demande aussi au navigateur un stockage persistant, que celui-ci peut refuser.

## Hors ligne et synchronisation

React/TypeScript pour le client, IndexedDB pour les données locales et la file de modifications, Fastify pour l’API, SQLite en mode WAL pour le stockage partagé.

1. Une écriture locale est atomique : fiche du nouveau repas, créneau et file d’envoi sont sauvegardés ensemble dans IndexedDB, **avant** de fermer l’éditeur.
2. Chaque modification utilisateur possède `modifiedAt` (millisecondes UTC) et `mutationId` (UUID). La plus récente l’emporte **par plat du planning, par fiche et pour les paramètres**, jamais pour la semaine entière. Les deux plats d’un créneau sont des enregistrements indépendants, identifiés par `date:slot` et `date:slot:2` (avec `index: 1` pour le second) ; les anciens repas restent compatibles. Une égalité exacte est départagée par l’UUID, de façon déterministe.
3. La synchronisation transmet les modifications en attente et reçoit un instantané complet du serveur. Un accusé de réception ancien ne peut pas effacer une nouvelle modification effectuée pendant la requête.
4. Vider un plat conserve un enregistrement vide daté, sans convives personnalisés, plutôt qu’une suppression physique. Un appareil resté hors ligne ne peut donc pas ressusciter l’ancien repas ; l’autre plat du créneau reste intact.
5. Les analyses IA sont séparées des versions utilisateur. Une réponse devenue obsolète ne remplace ni une correction manuelle ni une nouvelle demande d’analyse.
6. La synchronisation se déclenche au lancement, après une saisie, au retour au premier plan/réseau et toutes les 20 secondes lorsque l’application est visible. Elle vérifie réellement l’API, pas seulement `navigator.onLine`.

Hors ligne, saisie, sélection en cache, suppression, modification et archivage restent disponibles. Les analyses sont reportées ; choix du modèle et relance explicite de l’IA sont désactivés. Une erreur de stockage est affichée et ne produit jamais une fausse confirmation d’enregistrement.

Les appareils doivent avoir la date automatique activée. Une horloge en avance de plus de cinq minutes est refusée par le serveur avec une erreur explicite ; les changements restent locaux. Après correction de l’horloge, les écritures déjà datées dans le futur restent en attente jusqu’à ce que leur date soit admissible. Comme tout arbitrage par horodatage client, ce système ne garantit pas l’ordre réel des actions si les horloges sont incorrectes.

Le service worker conserve une version complète du client (HTML, JS, CSS, icônes), sans mettre en cache l’API. Une nouvelle version doit être intégralement téléchargée avant installation et attend normalement la fermeture des anciens onglets pour s’activer. **La synchronisation forcée ne vide aucun cache, n’efface aucune file et ne recharge jamais brutalement la page.** Le bouton distinct **Forcer la mise à jour** permet d’activer explicitement une nouvelle version sans fermer les fenêtres. Un simple rechargement peut encore afficher l’ancien CSS depuis le cache, même lorsque le serveur est accessible.

### Limites réelles de disponibilité

Une application **déjà chargée et mise en cache** reste utilisable si le PC ou Internet est arrêté. Les autres appareils ne recevront les changements qu’au retour du serveur. Une première visite hors ligne, l’effacement volontaire des données du navigateur, son éviction du stockage ou une panne matérielle ne peuvent pas être compensés par la PWA. Ne pas utiliser la navigation privée pour conserver le carnet.

## OpenAI et budget

API Responses, sorties JSON structurées, un appel asynchrone par création ou relance, sans outil externe. Pour l’analyse, seul le **nom du repas** est envoyé à OpenAI. Pour la génération d’une idée, sont envoyés la **saison du créneau**, le **niveau de cuisine demandé**, les **noms du carnet complet** et ceux des **repas choisis de J−15 à J+15 autour d’aujourd’hui à Paris**, avec les noms bruts et affichés des fiches liées. Les listes sont dédupliquées, sans troncature ; les dates, identifiants, ingrédients et recettes existantes ne sont pas transmis. Ce contexte augmente les tokens d’entrée. `store: false` désactive le stockage de la réponse par l’API ; les politiques de conservation du fournisseur restent applicables.

Le modèle par défaut est **`gpt-6-luna`**. Les paramètres proposent par défaut **`gpt-6-luna`**, **`gpt-6-sol`**, **`gpt-5.6-luna`** et **`gpt-5.6-terra`**. Leur disponibilité effective dépend du compte et de l’API OpenAI ; la liste autorisée se configure côté serveur. Si `.env` définit déjà `OPENAI_ALLOWED_MODELS`, mettre aussi cette liste à jour : elle remplace les valeurs par défaut. Redémarrer le serveur puis synchroniser pour actualiser les paramètres.

Si un modèle déjà sélectionné est retiré de la liste autorisée, les analyses se mettent en attente sans consommer d’appel. Les paramètres demandent de choisir un modèle autorisé pour les reprendre.

| Variable serveur | Valeur par défaut | Rôle |
|---|---|---|
| `OPENAI_API_KEY` | vide | Clé serveur ; jamais renvoyée au navigateur |
| `OPENAI_MODEL` | `gpt-6-luna` | Modèle initial d’une nouvelle base |
| `OPENAI_ALLOWED_MODELS` | `gpt-6-luna,gpt-6-sol,gpt-5.6-luna,gpt-5.6-terra` | Liste autorisée dans les paramètres |

L’application n’impose aucun quota journalier ou mensuel d’appels IA, ni de limite de génération par minute. Les anciennes variables `AI_DAILY_LIMIT` et `AI_MONTHLY_LIMIT` sont ignorées et peuvent être supprimées de `.env`.

Une seule analyse à la fois, délai de 45 secondes, sortie plafonnée à 1 400 tokens. Les tentatives sont comptabilisées **avant** l’appel, y compris les échecs. Les compteurs journaliers et mensuels utilisent `Europe/Paris` et persistent après redémarrage. Les erreurs ne sont pas relancées automatiquement ; elles sont visibles dans le carnet. Une analyse interrompue au redémarrage doit également être relancée explicitement.

Les paramètres montrent les tentatives d’appel et les tokens des réponses traitées avec succès. Ce compteur de tokens n’est pas une facture : une réponse interrompue/invalide peut aussi avoir été facturée. **L’application ne plafonne pas les dépenses OpenAI.** Configurer les alertes et limites disponibles sur le projet OpenAI ; les restrictions du fournisseur restent applicables.

Les recettes/ingrédients IA sont des suggestions, pas une composition garantie, une certification allergène ou un conseil médical. Ils sont modifiables.

## HTTPS et exposition Internet

### Important : pas d’authentification

**Toute personne qui connaît ou trouve l’adresse peut lire et modifier les menus et déclencher des appels OpenAI. HTTPS chiffre les échanges mais ne restreint pas l’accès.** Le serveur vérifie les origines des requêtes navigateur, limite le débit de synchronisation et impose les modèles autorisés côté serveur, mais ne plafonne pas les appels IA. Cela ne remplace pas un contrôle d’accès contre une personne déterminée. Ne pas y stocker d’informations sensibles.

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

### Repartir de zéro

```powershell
npm run reset -- --confirm
```

Supprime les repas du planning et les fiches du carnet, avec leurs analyses IA ; les paramètres (modèle, foyer) et les compteurs IA sont conservés. Une sauvegarde est d’abord créée dans `data/backups/`. Fonctionne serveur démarré.

Le serveur change alors son identifiant de réinitialisation : à leur prochaine synchronisation, toutes les applications (PWA, navigateurs) **effacent leurs repas et fiches locaux, y compris ceux pas encore envoyés**. Les paramètres locaux et leurs modifications en attente sont conservés. Tant qu’un appareil n’a pas appliqué la réinitialisation, ses envois de repas et de fiches sont ignorés (ses paramètres restent acceptés), pour qu’il ne fasse pas réapparaître les données supprimées. Une PWA installée doit d’abord avoir reçu la version de l’application qui gère ce mécanisme.

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

Les tests unitaires couvrent dates françaises/DST, contrats, conflits, effacements persistants, synchronisation en vol, concurrence des onglets, redémarrage SQLite, comptabilisation des appels sans plafond et erreurs OpenAI. Les tests navigateur couvrent les formats téléphone/tablette/desktop, Chrome et Firefox, le rechargement réellement hors ligne, le serveur inaccessible malgré Internet, le quadruple clic, l’archivage et les conflits entre deux appareils.

Les appels OpenAI sont **simulés dans les tests** : aucune clé ni dépense n’est nécessaire. Un essai réel avec votre clé et une vérification sur les appareils physiques restent nécessaires après le déploiement.
