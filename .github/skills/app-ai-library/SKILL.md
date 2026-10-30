---
name: app-ai-library
description: "Comprendre le carnet de repas et l'enrichissement OpenAI de À table ! : correction différée du nom, saisons, ingrédients, recette, worker asynchrone, analysisKey, corrections manuelles, archivage, erreurs, modèles autorisés, quotas et budget API."
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

Priorité d'affichage : `dish.details` manuel, sinon analyse `ready` correspondant
au même `analysisKey`, sinon nom brut et saison de création.

Une correction manuelle est prioritaire sur une analyse en cours.
Une relance explicite crée un nouvel `analysisKey` et remet `details` à null :
elle remplace les informations de la fiche, sans modifier les menus existants.
Une ancienne réponse ne doit jamais écraser cette nouvelle demande.

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
- Sans clé, modèle autorisé, quota disponible ou fiche admissible, pas d'appel.
  Les fiches archivées et celles possédant des détails manuels sont ignorées.
- API Responses : uniquement le nom du repas, `store: false`, JSON structuré
  strict, validation Zod, 1 400 tokens de sortie maximum, timeout 45 secondes.
- Ne jamais afficher/lire une clé dans les réponses, logs ou fichiers client.
  `store: false` ne garantit pas l'absence de toute conservation par le fournisseur.
- Les quotas journaliers/mensuels utilisent `Europe/Paris` et persistent en SQLite.
  Ils limitent les tentatives, pas un montant garanti en euros.
- Un échec compte dans le quota et n'est pas relancé automatiquement.
  Une tâche interrompue au redémarrage devient une erreur à relancer explicitement.
- Les tokens affichés concernent les réponses comptabilisées avec succès ; ce
  compteur n'est pas une facture exhaustive.
- Ingrédients et recette sont indicatifs : ne pas garantir la composition réelle,
  l'absence d'allergènes ou une sécurité alimentaire sur cette seule base.

## Vérification ciblée

```powershell
npm test -- tests/ai.test.ts tests/server.test.ts tests/model.test.ts
```

Les [tests IA](../../../tests/ai.test.ts) simulent le fournisseur, sans clé ni coût.
Vérifier succès, refus, JSON invalide, quota, modèle retiré et réponse obsolète.
Ne pas déclencher un appel payant pour une simple explication ou un test unitaire.
