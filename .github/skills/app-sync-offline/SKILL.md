---
name: app-sync-offline
description: "Comprendre et diagnostiquer la synchronisation À table ! : IndexedDB, outbox, conflits last-write-wins, modifications datées, données perdues ou ressuscitées, plusieurs appareils, mode hors ligne, service worker, mises à jour PWA et synchronisation forcée."
---

# Synchronisation et disponibilité hors ligne

## Parcours de diagnostic

1. Distinguer la persistance des **données** dans IndexedDB du cache des
   **fichiers du client** dans le service worker.
2. Lire `recordSchema`, `recordKey` et `compareVersions` dans
   [le modèle partagé](../../../shared/model.ts).
3. Suivre `save`, `pending` et `merge` dans
   [le repository](../../../src/repository.ts), puis `synchronize` dans
   [le store](../../../src/store.ts).
4. Comparer avec `/api/sync` dans [l'API](../../../server/app.ts) et `Store.merge`
   dans [SQLite](../../../server/database.ts).
5. Pour un problème de chargement hors ligne, lire [l'enregistrement PWA](../../../src/pwa.ts),
   [la génération du cache](../../../vite.config.ts) et
   [le service worker](../../../pwa/service-worker.js).

## Invariants des données

- Une transaction IndexedDB sauvegarde ensemble `records` et `outbox`, y compris
  la fiche et le créneau créés par la même saisie.
- Les versions sont ordonnées par `modifiedAt`, puis lexicalement par
  `mutationId` en cas d'égalité. Le même comparateur s'applique des deux côtés.
- L'arbitrage est **par record**, pas par semaine ni par champ d'une fiche.
  Le timestamp local reste monotone par record.
  Les deux plats d'un créneau utilisent `mealId()` : `date:slot` et
  `date:slot:2` (`index: 1`), avec leurs propres versions et convives.
- Une réponse distante ne supprime une entrée d'outbox que si sa version est au
  moins aussi récente. Ne jamais acquitter tout le lot envoyé sans comparer :
  une saisie a pu survenir pendant la requête.
- Vider un plat crée un record vide daté, avec `dishId: null` et `household: null`,
  sans toucher à l'autre plat du créneau.
  Ne pas le supprimer physiquement : un appareil hors ligne pourrait restaurer
  l'ancienne valeur.
- Les analyses IA ne participent pas aux versions utilisateur ; voir
  [le skill IA](../app-ai-library/SKILL.md).

## Comptes et bases locales

- Une base IndexedDB par contexte : `a-table-v1` (carnet commun, `AUTH_ENABLED=false`),
  `a-table-guest` (mode invité, jamais synchronisée) et `a-table-u-<user>-s-<space>`
  (un compte dans un foyer). `a-table-catalog` est un cache du catalogue commun
  partagé par tous les contextes de l'appareil : lecture seule, sans outbox,
  synchronisé par curseur (`syncCatalog`, à l'initialisation et à chaque
  synchronisation), réinitialisé si `catalogId` change, erreurs ignorées. `localStorage` `a-table-auth` mémorise le dernier
  compte pour ouvrir sa base hors ligne avant la vérification de session.
- Changer de base passe par `switchSpace` (sérialisé, avec époque) : une réponse
  de synchronisation d'une ancienne base est ignorée. Les onglets suivent via
  `BroadcastChannel` (`space-changed`).
- 401 : session expirée, la base et l'outbox restent, bandeau de reconnexion.
  403 / autre foyer : accès retiré, pas d'envoi. La déconnexion conserve la base
  du compte et ses modifications en attente pour la prochaine connexion.
- Import invité → foyer : après une première synchronisation (pour connaître
  `resetId`), `importInto` copie les records avec leurs versions dans une seule
  transaction, rattache les plats de même nom normalisé, puis vide la base invité.
  Relancer l'import est idempotent. L'ancien `a-table-v1` non synchronisé est
  proposé à l'import une seule fois après connexion.

## Transport et erreurs

- Envoi d'au plus 100 mutations par requête ; réponse avec instantané complet,
  analyses, heure serveur et capacités. La boucle continue si l'outbox reste pleine.
- Une seule synchronisation en vol par instance client ; `BroadcastChannel`
  recharge les données entre onglets.
- Appels au lancement, après sauvegarde, au retour réseau/focus/visibilité et
  toutes les 20 secondes si l'application est visible.
- Timeout de requête : 8 secondes. `navigator.onLine` seul ne prouve pas que le
  serveur est disponible.
- Les erreurs sont affichées et la file reste persistée. Ne pas remplacer un
  échec par un faux succès ou effacer IndexedDB pour « réparer ».
- Le serveur refuse une date de modification en avance de plus de cinq minutes.
  Corriger l'horloge ne redatera pas les mutations déjà enregistrées.

## Cache PWA et rafraîchissement

- Le build précache HTML, JS, CSS, manifeste et icônes sous une version calculée.
  L'installation doit télécharger tous ces fichiers pour réussir.
- `/api/` n'est pas intercepté. Les navigations vers `/confidentialite` et
  `/conditions-utilisation` (rendues par le serveur depuis les mentions légales
  de l'admin) passent par le réseau d'abord, avec la dernière copie en cache
  hors ligne ; jamais le shell. Le shell est servi depuis le cache ; les données
  restent dans IndexedDB.
- Par défaut, une mise à jour attend la fermeture des anciens clients.
  Le bouton « Forcer la mise à jour » retélécharge le shell avec `cache: 'reload'`,
  puis demande explicitement `skipWaiting` et la prise de contrôle si une version
  attend. Le rechargement suit uniquement un succès ; IndexedDB reste intact.
  Une installation échouée ne remplace pas l'ancienne.
- Le signal serveur `forceClientUpdate` (`CLIENT_UPDATE_ID`) ne recharge que si la
  page n'exécute pas la version servie (`runningLatestBuild` dans `src/pwa.ts`) :
  première connexion et nouvel onglet déjà à jour ne rechargent pas.
- Le quadruple tap et le bouton de synchronisation ne suppriment aucun cache et ne
  rechargent pas la page. Fermer tous les onglets ou utiliser le bouton distinct
  de mise à jour pour activer une nouvelle version.
- HTTPS ou localhost est nécessaire au service worker. En développement Vite, il
  est désactivé ; en HTTP LAN, la saisie fonctionne mais pas le rechargement hors ligne.
- La première visite doit être en ligne ; éviction du stockage et navigation
  privée ne permettent pas de promettre une disponibilité permanente.

## Vérification ciblée

```powershell
npm test -- tests/repository.test.ts tests/server.test.ts tests/model.test.ts
npm run build
npm run test:e2e -- --project=pixel-chrome --grep='hors ligne|serveur indisponible|deux appareils'
```

Les [tests repository](../../../tests/repository.test.ts) vérifient les réponses
obsolètes, la réouverture et les écritures concurrentes ; les
[tests navigateur](../../../e2e/planner.spec.ts) vérifient la reconnexion réelle.
Toujours reproduire séparément « pas d'Internet » et « API inaccessible malgré Internet ».
