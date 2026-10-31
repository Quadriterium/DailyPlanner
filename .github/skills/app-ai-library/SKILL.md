---
name: app-ai-library
description: "Comprendre le carnet de repas et l'enrichissement OpenAI de À table ! : génération de repas de saison, niveau de cuisine (paramètre, niveau des fiches, tirage par niveau), correction différée du nom, saisons, ingrédients, recette, worker asynchrone, analysisKey, corrections manuelles, archivage, erreurs, modèles autorisés, compteurs et budget API."
---

# Bibliothèque de repas et analyse IA

## Procédure de lecture

1. Lire les schémas `dishSchema`, `detailsSchema`, `analysisSchema` et la fonction
   `dishDetails` dans [le modèle partagé](../../../shared/model.ts).
2. Suivre la création dans [MealEditor](../../../src/MealEditor.tsx) et les
   corrections/relances dans [Library](../../../src/Library.tsx).
3. Lire `merge`, `claimAnalysis`, `finishAnalysis`, `capabilities` et
   `recordTokens` dans [Store](../../../server/database.ts).
4. Suivre `analyzeDish` et `AiWorker` dans [le module IA](../../../server/ai.ts),
   puis leur cycle de vie dans [le serveur](../../../server/index.ts).
5. Pour le choix du modèle, relier [Settings](../../../src/Settings.tsx),
   [la validation API](../../../server/app.ts) et
   [la configuration serveur](../../../server/config.ts).

## Cycle d'une fiche

1. La saisie crée localement un `dish` avec nom brut, saison de création,
   `analysisKey` neuf et `details: null`, puis un `meal` contenant le texte saisi.
2. À la fusion serveur, une nouvelle clé d'analyse produit une tâche `pending`.
3. Le worker réclame une tâche admissible, la marque `processing` et comptabilise
   la tentative **avant** l'appel.
4. OpenAI propose un nom corrigé, les saisons, les ingrédients et une recette courte.
   Une réponse validée passe en `ready`, sinon en `error` avec une explication.
5. La synchronisation suivante récupère cette analyse séparée ; elle ne réécrit
   ni `meal.text` ni la version utilisateur de la fiche.

Priorité d'affichage : `dish.details` enregistré (manuel ou généré), sinon analyse `ready` correspondant
au même `analysisKey`, sinon nom brut et saison de création.
Pour un import URL, `analysis.name` fournit aussi un nom provisoire dès sa
découverte dans les métadonnées Recipe, y compris si la suite échoue.

## Niveau de cuisine

- `cookingLevels` (1 à 4), `cookingLevelLabels` et `cookingLevelHints` sont
  définis dans le modèle partagé. `settings.cookingLevel` vaut 2 par défaut
  (défaut Zod pour les anciens paramètres) ; `details.level` reste optionnel
  pour les anciennes fiches et analyses.
- L'IA doit toujours renvoyer `level` (schéma JSON strict, `aiDetailsSchema`) :
  elle l'évalue à l'analyse d'un nom ou d'un lien (1 pour un plat non identifié).
  La difficulté dépend des gestes, pas de la seule durée de cuisson passive.
  À la génération, `niveauDemande` est transmis et `generateMeal()` refuse
  une réponse de niveau différent, sans réétiquetage ni relance automatique.
- `POST /api/meals/generate` accepte `{ date, level? }` ; sans `level`, le
  serveur utilise `settings.cookingLevel`. Le client envoie toujours le niveau
  (paramètres, ou niveau choisi par appui long via `LevelButton`).
- `randomMealCandidates(..., level)` exclut les fiches sans niveau ou d'un
  autre niveau, et le repli sur une répétition reste limité à ce niveau.
- Une correction manuelle du niveau dans le carnet passe par `dish.details`.

## Import d'un lien

- `recipeUrl` reconnaît uniquement les URL HTTP(S) sans identifiants, jusqu'à
  2 048 caractères. `MealEditor` conserve `dish.sourceUrl` et le texte URL du menu.
- [recipe-page](../../../server/recipe-page.ts) récupère le HTML public : DNS
  contrôlé et épinglé, ports standards, adresses privées/locales refusées,
  redirections revérifiées (quatre maximum), 2 Mo et 15 secondes maximum.
- Les métadonnées JSON-LD Recipe fournissent nom, portions, ingrédients et étapes ;
  sinon le texte visible est envoyé à l'IA pour identifier le plat.
- `nameAnalysis` publie le nom structuré avant l'appel IA, sans écraser une
  correction manuelle ou une nouvelle clé. `finishAnalysis` conserve ce nom
  provisoire en cas d'erreur. Le worker alloue 60 secondes à l'import complet.
- L'IA utilise la recette source, adapte les quantités au foyer courant, reformule
  les étapes et signale les portions estimées ou une recette indicative absente
  de la page. Une URL comme nom final est refusée ; le booléen structuré
  `identified: false` signale explicitement qu'aucun plat n'est identifiable.
- `mealDisplayName` remplace uniquement l'affichage du lien d'origine lié à sa
  fiche ; aucun record utilisateur n'est réécrit. `App` synchronise toutes les
  deux secondes pendant un import visible avec IA configurée.
- Le lien est conservé lors des corrections et relances, pour recalculer les
  quantités depuis la source. Pas de navigateur JavaScript, cookies ou connexion.

Une correction manuelle est prioritaire sur une analyse en cours.
Une relance explicite crée un nouvel `analysisKey` et remet `details` à null :
elle remplace les informations de la fiche, sans modifier les menus existants.
Une ancienne réponse ne doit jamais écraser cette nouvelle demande.

## Génération depuis une case vide

- `fillMeal()` synchronise d'abord les saisies et le modèle, puis appelle
  `POST /api/meals/generate` avec la date du créneau et le niveau de cuisine.
- `mealGenerationContext()` construit le contexte depuis les données serveur :
  noms de toutes les fiches (archives comprises), noms des repas choisis de
  J−15 à J+15 autour d'aujourd'hui à Paris, bornes incluses. Les noms bruts et
  affichés des fiches liées sont inclus et les listes dédupliquées, sans troncature.
- `generateMeal()` transmet ces listes, la saison du créneau et le niveau demandé,
  sans dates, identifiants, ingrédients ni recettes existantes. La consigne exclut les plats
  existants à l'identique et les variantes proches de repas choisis dans la période ;
  une vraie variante d'un plat ancien non choisi reste possible.
- Un doublon de nom (casse et espaces normalisés) est refusé explicitement,
  sans relance automatique. La proximité sémantique dépend du modèle.
- `reserveGeneration()` vérifie la clé et le modèle autorisé, puis comptabilise
  la tentative avant l'appel (échecs compris), dans les mêmes compteurs que le worker.
- Le client valide la réponse et enregistre localement le créneau et la nouvelle
  fiche complète dans une transaction. Les détails générés occupent
  `dish.details` : pas de deuxième enrichissement automatique.
- Un nom équivalent réutilise une fiche active sans remplacer ses détails.
  Un créneau modifié pendant la requête n'est pas écrasé par la proposition.

## Saisons et archivage

- Les saisons sont météorologiques larges en France métropolitaine ; `all`
  représente toute l'année. L'IA peut proposer plusieurs saisons.
- La saison de création est une attente, pas une contrainte imposée à l'IA.
- Les suggestions du planning utilisent la saison de la date sélectionnée et
  uniquement les fiches actives du foyer.
- Une archive conserve la fiche et les textes des menus. Elle ne doit pas être
  traitée comme une suppression en cascade.

## Exécution et budget

- Worker déclenché au démarrage puis toutes les 5 secondes ; une analyse à la fois.
- Sans clé, modèle autorisé ou fiche admissible, pas d'appel.
  Les fiches archivées et celles possédant des détails manuels sont ignorées.
- API Responses : uniquement le nom, le foyer et le texte facultatif « à éviter »
  (`settings.avoid`, clé `aEviter`, omise si vide) pour l'analyse d'un nom ;
  URL et contenu extrait en plus pour l'import d'un lien ; en plus, saison,
  niveau demandé, noms du carnet et noms des repas choisis sur la période pour la génération,
  `store: false`, JSON structuré
  strict, validation Zod, 1 400 tokens de sortie maximum, timeout 45 secondes.
- Ne jamais afficher/lire une clé dans les réponses, logs ou fichiers client.
  `store: false` ne garantit pas l'absence de toute conservation par le fournisseur.
- Les compteurs journaliers/mensuels utilisent `Europe/Paris` et persistent en SQLite.
  Aucun quota d'appels ni plafond de dépenses n'est imposé par l'application ;
  la génération n'a pas de limite par minute. Les restrictions OpenAI restent applicables.
- Un échec compte comme tentative et n'est pas relancé automatiquement.
  Une tâche interrompue au redémarrage devient une erreur à relancer explicitement.
- Les tokens affichés concernent les réponses comptabilisées avec succès ; ce
  compteur n'est pas une facture exhaustive.
- Ingrédients et recette sont indicatifs : ne pas garantir la composition réelle,
  l'absence d'allergènes ou une sécurité alimentaire sur cette seule base.

## Vérification ciblée

```powershell
npm test -- tests/recipe-page.test.ts tests/ai.test.ts tests/server.test.ts tests/model.test.ts
```

Les [tests IA](../../../tests/ai.test.ts) simulent le fournisseur, sans clé ni coût.
Vérifier succès, refus, JSON invalide, appels au-delà des anciens plafonds, modèle retiré et réponse obsolète.
Ne pas déclencher un appel payant pour une simple explication ou un test unitaire.
