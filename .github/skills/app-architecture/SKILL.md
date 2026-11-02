---
name: app-architecture
description: "Comprendre l'application À table !, son architecture React/Fastify/SQLite, le modèle de données et le parcours d'un repas. À utiliser pour expliquer le fonctionnement du projet, commencer une intervention ou identifier les fichiers et skills pertinents."
---

# Comprendre À table !

## Objectif

Donner une carte du projet et suivre une action utilisateur de bout en bout.
Pour une demande d'explication, rester en lecture seule : ne pas démarrer le serveur,
modifier la configuration ou appeler OpenAI sans nécessité.

## Parcours de lecture

1. Lire le [guide utilisateur et déploiement](../../../README.md) et les
   [commandes npm](../../../package.json).
2. Examiner les [contrats partagés](../../../shared/model.ts) avant de raisonner
   sur les données : ce code fait foi si une documentation devient obsolète.
3. Suivre une saisie dans [MealEditor](../../../src/MealEditor.tsx), puis
   [le store client](../../../src/store.ts) et [le repository IndexedDB](../../../src/repository.ts).
4. Suivre son envoi dans [l'API Fastify](../../../server/app.ts), puis
   [le stockage SQLite](../../../server/database.ts).
5. Pour l'enrichissement différé, suivre [le worker IA](../../../server/ai.ts)
   et son lancement dans [le point d'entrée serveur](../../../server/index.ts).

## Carte des responsabilités

| Surface | Rôle |
|---|---|
| [App](../../../src/App.tsx) | Navigation, synchronisations automatiques, quadruple tap, installation et notifications |
| [Planner](../../../src/Planner.tsx) | Grille chronologique glissante, midi/soir, défilement vertical |
| [Library](../../../src/Library.tsx) | Consultation, correction manuelle, archivage et relance IA |
| [Settings](../../../src/Settings.tsx) | Thème de l'appareil, modèle autorisé, compteurs IA, connexion et état PWA |
| [thème](../../../src/theme.ts) et [son script de démarrage](../../../public/theme.js) | Clair, sombre, selon l'heure ou comme le système, propre à l'appareil et appliqué avant React |
| [styles](../../../src/styles.css) | Interface responsive crème, terracotta et sauge, déclinée en thème sombre |
| [service worker](../../../pwa/service-worker.js) | Cache de l'application, jamais de l'API |
| [configuration serveur](../../../server/config.ts) | Réseau, origine autorisée, base, clé et modèles IA, comptes Google |
| [Account](../../../src/Account.tsx) et [authentification serveur](../../../server/auth/routes.ts) | Connexion Google (OIDC + PKCE), sessions par cookie, foyers, invitations, mode invité |
| [administration](../../../server/admin.ts) | `npm run admin` : comptes, espaces, rattachement à l'espace commun, révocation des sessions |

## Modèle mental

- `meal` : instantané d'un plat pour une date et un créneau `lunch` ou `dinner`.
  Deux plats maximum : `mealId()` conserve `date:slot` pour le premier et utilise
  `date:slot:2` avec `index: 1` pour le second. Chaque plat est un record indépendant.
  `dishId` le relie éventuellement au carnet. `household` nul ou absent suit les
  paramètres actuels ; une composition explicite personnalise ce plat uniquement.
  Les quantités de la fiche du carnet ne sont pas recalculées par ce réglage.
- `dish` : fiche réutilisable avec nom, saison de création, archivage et
  `analysisKey`. Des `details` non nuls représentent une correction manuelle.
- `settings` : un record `global` par foyer, contenant notamment le modèle IA choisi
  et le niveau de cuisine (`cookingLevel`, 1 à 4) ; `details.level` porte celui d'une fiche.
- `Analysis` : résultat ou état de travail IA séparé des records utilisateur.
  Pour un import URL, `dish.sourceUrl` conserve le lien et `Analysis.name` peut
  publier le nom avant la recette. `mealDisplayName` affiche ce nom à la place
  du lien d'origine, sans réécrire `meal.text`.
- Chaque record utilisateur porte `modifiedAt` et `mutationId`. Côté serveur, il
  appartient à un espace (`space_id`) : l'espace « common » (données d'avant les
  comptes) ou un foyer. Chaque utilisateur appartient à un seul foyer ; toutes les
  routes de données sont filtrées par l'espace de la session.
  Aucun menu ni plat n'est prérempli.
- Catalogue commun : table SQLite `catalog` hors espaces, alimentée par les
  fiches IA structurées, servie par `GET /api/catalog` (public, incrémental) et
  mise en cache dans IndexedDB `a-table-catalog`. Un plat choisi y est copié
  dans le carnet du foyer ; la génération y pioche dès 15 plats adaptés.
  Voir app-ai-library.

Chemin principal :

```text
Saisie -> transaction IndexedDB (records + outbox) -> confirmation locale
       -> POST /api/sync -> SQLite -> instantané partagé -> fusion IndexedDB
                        -> file IA -> fiche enrichie, sans réécrire meal.text
```

Le fonctionnement hors ligne n'implique pas que le serveur soit toujours disponible :
un client déjà mis en cache reste utilisable, mais le partage attend la reconnexion.
Avec `AUTH_ENABLED=true`, l'accès exige une session Google ; sans connexion, le
client fonctionne en mode invité dans une base IndexedDB locale (`a-table-guest`)
sans synchronisation ni IA. Avec `AUTH_ENABLED=false` (défaut), il n'y a pas
d'authentification et tout le monde partage l'espace « common ».
Conception détaillée : [authentification Google](../../../docs/authentification-google.md).

## Approfondir uniquement le sujet nécessaire

- [Interface et parcours](../app-interface/SKILL.md)
- [Synchronisation et PWA](../app-sync-offline/SKILL.md)
- [Bibliothèque et IA](../app-ai-library/SKILL.md)
- [Déploiement et diagnostic réseau](../app-deployment/SKILL.md)

## Restitution attendue

Expliquer le parcours demandé avec les fichiers concernés et les invariants à
préserver. Distinguer comportement vérifié, configuration par défaut et état réel
de l'installation ; ne pas présenter un test simulé comme un appel OpenAI réel.
