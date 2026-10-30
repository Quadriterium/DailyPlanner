---
name: app-interface
description: "Comprendre ou faire évoluer l'interface À table ! : planning midi/soir, jours glissants, défilement et swipe vertical, saisie de repas, suggestions saisonnières, carnet, responsive Pixel/tablette, paramètres et quadruple tap."
---

# Comprendre les parcours et l'interface

## Procédure

1. Identifier le parcours dans [App](../../../src/App.tsx) : planning, carnet ou
   paramètres. Lire seulement les composants concernés.
2. Pour la grille, lire [Planner](../../../src/Planner.tsx) et les fonctions de
   date dans [le modèle partagé](../../../shared/model.ts).
3. Pour une saisie, suivre [MealEditor](../../../src/MealEditor.tsx) jusqu'à
   `save()` dans [le store](../../../src/store.ts).
4. Pour une fiche existante, lire [Library](../../../src/Library.tsx) et
   `dishDetails()` dans le modèle partagé.
5. Pour une intervention visuelle, lire [les styles](../../../src/styles.css),
   puis vérifier le résultat aux formats téléphone, tablette et grand écran.

## Planning

- L'accueil est centré sur aujourd'hui et les six jours suivants, en
  `Europe/Paris`. La plage rendue contient aussi des jours avant et après.
- Une ligne par date, deux cases `lunch` et `dinner`. La grille défile
  verticalement et s'étend par blocs de sept jours aux extrémités.
- Les flèches déplacent de sept jours ; « Aujourd'hui » recentre la grille.
- Préserver l'ancrage lors de l'ajout de jours précédents et lors d'un changement
  de largeur : la hauteur des lignes varie avec les media queries.
- Utiliser `parisDate`, `addDays`, `formatDate` et `seasonForDate` existants :
  ne pas déduire le jour métier du fuseau du navigateur.

## Choisir un repas

- Une case ouvre un dialogue : texte libre en haut, liste de suggestions en bas,
  pas de combobox native.
- Les suggestions viennent des fiches non archivées du carnet, sans catalogue
  de démonstration. Une case vide propose aussi deux boutons à droite :
  génération IA de saison et tirage au hasard dans le carnet de saison. Le
  dialogue d'une case vide reprend ces deux actions sous la saisie.
- Ces boutons enregistrent directement via `fillMeal()` dans le store.
  Le tirage évite si possible les noms et identifiants déjà prévus sur les
  **sept jours affichés**, puis accepte une répétition faute d'alternative.
  Le tirage reste local ; seule la génération nécessite le serveur.
- Le filtre de saison correspond à la **date du créneau** ; `all` convient à
  toutes les saisons. « Tous les repas » ignore ce filtre.
- Une nouvelle fiche reçoit provisoirement la saison de **création**.
  Les noms équivalents sont recherchés parmi les fiches actives avant sa création.
- Le texte du planning est un instantané de la saisie, non le nom calculé
  dynamiquement à partir de la fiche. Une sélection utilise le nom affiché au
  moment du choix.
- Ne fermer l'éditeur et n'afficher le succès qu'après la sauvegarde locale.
  Un échec de stockage doit être visible, sans perdre la saisie.

## Carnet, réglages et notifications

- Une correction de fiche ou un archivage ne réécrit pas les anciens menus.
- Le modèle se choisit parmi les valeurs autorisées par le serveur ; le changement
  affiche un état temporaire pendant l'enregistrement local.
- Le quadruple tap sur le titre nécessite moins de 650 ms entre taps.
  Il synchronise puis vérifie la mise à jour, sans rechargement brutal.
- Le bouton de synchronisation des paramètres est l'alternative accessible.
  Succès et erreur sont présentés dans un dialogue ; un échec laisse l'app utilisable.
- Conserver les dialogues natifs, labels, navigation clavier et zones tactiles.
  Pour les UUID client, utiliser [newId](../../../src/id.ts), compatible HTTP LAN.

## Vérification ciblée

Lire les scénarios dans [les tests navigateur](../../../e2e/planner.spec.ts) et
les [tests de choix rapide](../../../e2e/quick-meals.spec.ts), puis
les formats dans [la configuration Playwright](../../../playwright.config.ts).
Après une modification fonctionnelle :

```powershell
npm run build
npm run test:e2e -- --project=pixel-chrome --grep='grille responsive|bibliothèque modifiable|paramètres'
```

Ajouter Firefox ou la tablette si la surface modifiée le justifie. Contrôler aussi
visuellement l'absence de débordement horizontal, les sept lignes visibles, la
largeur des dialogues mobiles et la lisibilité des textes longs. Les formats
émulés ne remplacent pas un essai sur appareil physique.
