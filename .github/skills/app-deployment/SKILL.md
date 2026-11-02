---
name: app-deployment
description: "Installer ou diagnostiquer À table ! sur Windows sans Docker : Node, SQLite, accès téléphone Wi-Fi/LAN, HOST et PUBLIC_ORIGIN, HTTP temporaire, HTTPS Caddy, pare-feu, serveur inaccessible, build PWA, sauvegarde et migration."
---

# Déploiement et diagnostic d'accès

## Sources à consulter

- [README](../../../README.md) : installation, LAN, HTTPS et sauvegardes.
- [Scripts npm](../../../package.json), [variables exemple](../../../.env.example)
  et [validation de configuration](../../../server/config.ts).
- [API](../../../server/app.ts) : origines, débit et fichiers servis.
- [Caddy public](../../../Caddyfile), [Caddy local](../../../Caddyfile.local),
  [lancement Windows](../../../scripts/start.ps1) et
  [sauvegarde](../../../scripts/backup.mjs).

## Comprendre les trois modes

| Mode | Écoute Node | Origine navigateur | PWA hors ligne |
|---|---|---|---|
| PC local par défaut | `127.0.0.1:3000` | `http://localhost:3000` | Oui, après build et mise en cache |
| Essai Wi-Fi HTTP | `0.0.0.0:3000` | `http://IP_LOCALE:3000` | Non ; saisie et synchronisation possibles |
| HTTPS via Caddy | `127.0.0.1:3000` | Origine HTTPS publique ou locale approuvée | Oui, après mise en cache |

Les valeurs sont les valeurs par défaut ou exemples, pas une preuve de l'état réel.
Le serveur lit `.env` au démarrage ; reconstruire le code ne modifie pas l'écoute
d'un processus déjà lancé.

## Procédure de diagnostic téléphone/Wi-Fi

1. Vérifier l'adresse du PC et l'écoute, sans arrêter un processus non identifié :

   ```powershell
   Get-NetIPAddress -AddressFamily IPv4
   Get-NetTCPConnection -LocalPort 3000 -State Listen
   ```

2. Tester `/api/health` sur localhost, puis sur l'IP locale. Une écoute uniquement
   sur `127.0.0.1` ne peut pas répondre au téléphone.
3. Contrôler seulement les paramètres non secrets `HOST`, `PORT` et `PUBLIC_ORIGIN`.
   Ne pas afficher tout `.env`, qui peut contenir la clé OpenAI.
4. Si la page charge mais pas la synchronisation, vérifier l'origine :
   `PUBLIC_ORIGIN` est une origine exacte sans slash final, pas une URL avec chemin.
   Lorsqu'elle est définie, elle remplace la liste d'origines par défaut.
5. Si le test LAN depuis le PC réussit mais pas depuis le téléphone, vérifier le
   pare-feu, l'isolation des clients Wi-Fi et le réseau invité. Un succès depuis
   le PC ne prouve pas l'accessibilité depuis un autre appareil.
6. Ne pas désactiver le pare-feu ni ouvrir des ports largement. Le README donne une
   règle temporaire restreinte à `LocalSubnet`, à exécuter volontairement en
   administrateur, puis à supprimer après l'essai.

## Installer et vérifier

Node fournit SQLite ; aucune base externe ni Docker n'est nécessaire.

```powershell
npm ci
# Copier .env.example uniquement si .env n'existe pas déjà.
npm run build
npm start
```

Ne pas écraser un `.env` existant. Ne pas installer les dépendances pour une simple
lecture ; utiliser le lockfile pour une installation reproductible.

`npm run dev` sert le client sur 5173 avec un proxy vers 3000, sans service worker.
Le build produit `dist/client` et `dist/server`; le serveur ne publie que le client.

Pour HTTPS public, il faut un domaine/DNS, une IP joignable et les ports TCP 80/443
vers Caddy. `APP_DOMAIN` appartient à l'environnement de Caddy et `PUBLIC_ORIGIN`
à celui de Node. Ne pas exposer directement le port 3000 sur Internet.
HTTPS local utilise une autorité à approuver sur chaque appareil ; ne pas installer
de certificat de confiance ni modifier DNS/routeur sans accord.

## Sauvegarde, migration et limites

- Utiliser `npm run backup -- C:\Sauvegardes\planner.sqlite` :
  `VACUUM INTO` donne une sauvegarde cohérente à chaud et refuse l'écrasement.
- Ne pas copier seulement le fichier SQLite principal à chaud : le WAL peut
  contenir des changements non encore intégrés.
- Arrêter le serveur avant restauration et conserver la base précédente à part.
- Avant migration, synchroniser chaque appareil ; les écritures locales non
  envoyées ne sont pas dans la sauvegarde.
- Conserver si possible la même origine HTTPS : IndexedDB et le cache sont liés
  à l'origine. Un changement d'adresse ne transporte pas les données locales.
- Avec `AUTH_ENABLED=false`, toute personne ayant accès peut consulter/modifier et
  déclencher des appels IA sans plafond applicatif. HTTPS chiffre les échanges sans contrôler l'accès.
- Avec `AUTH_ENABLED=true`, `.env` doit contenir `PUBLIC_ORIGIN` (https, ou
  `http://localhost:<port>`), `GOOGLE_CLIENT_ID` et `GOOGLE_CLIENT_SECRET` ; le
  serveur refuse sinon de démarrer. L'URI de redirection Google est
  `<PUBLIC_ORIGIN>/api/auth/google/callback`. Derrière le tunnel Cloudflare :
  `HOST=127.0.0.1` et `TRUSTED_PROXY=cloudflare`. Ne jamais afficher ces secrets.
- La migration v2 du schéma sauvegarde la base dans `data/backups/` avant de
  s'appliquer ; ensuite `npm run admin -- assign-common --email <adresse> --confirm`
  rattache le premier compte aux données existantes.
- Ne promettre ni disponibilité serveur permanente ni mode hors ligne avant sa
  mise en cache effective ; vérifier la santé d'un service réellement démarré.

## Validation proportionnée

Pour une modification de code : `npm run typecheck`, puis les tests ciblés.
Pour le réseau HTTP, utiliser `E2E_HOST` avec l'IP réelle et le scénario `HTTP LAN`
de [Playwright](../../../e2e/planner.spec.ts) ; les
[réglages E2E](../../../playwright.config.ts) utilisent une base mémoire sur 3199
(sans comptes) et sur 3198 (comptes, fournisseur Google simulé, [scénarios](../../../e2e/auth.spec.ts)).
Pour une configuration Caddy, utiliser `caddy validate` avant son lancement.
Un changement documentaire seul ne nécessite pas de démarrer ces services.
