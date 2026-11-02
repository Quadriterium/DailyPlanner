---
name: app-interface
description: "Comprendre ou faire évoluer l'interface À table ! : planning midi/soir, deux plats par créneau, convives par plat, jours glissants, défilement et swipe vertical, saisie de repas, suggestions saisonnières, niveau de cuisine et menus par appui long, carnet, responsive Pixel/tablette, paramètres, thème clair/sombre et quadruple tap."
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
- Deux plats maximum par case, sans agrandir la ligne : toucher un plat puis
  « Ajouter un deuxième plat » ouvre l'autre choix dans un éditeur réinitialisé.
  Jusqu'à 520 px, l'ajout n'est proposé que dans la fiche et le nom prend toute
  la largeur ; au-delà, un + intégré visuellement à la carte sert de raccourci.
  Le nom et le + restent deux boutons frères, jamais des boutons imbriqués.
  Avec deux plats, aucun ajout n'est proposé : une seule carte (`.meal-slot.multiple`,
  `contain: size`) est séparée en deux moitiés, en sans-serif, deux lignes par nom
  au plus. Ne pas y afficher les convives : la hauteur ne le permet pas sur téléphone.
  Vider un plat ne supprime pas le record de l'autre.
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
- Génération et tirage utilisent le niveau de cuisine des paramètres ; le tirage
  ne pioche que les fiches de ce niveau. [LevelButton](../../../src/CookingLevel.tsx)
  ouvre, par appui long (500 ms, 10 px de tolérance) ou clic droit, un menu
  natif de choix du niveau pour cette action seulement (avec le nombre de plats
  de saison par niveau pour le tirage). Le clic qui suit un appui long est
  ignoré, sauf au clavier (`detail === 0`), et `touchend` est annulé après
  l'ouverture pour qu'un tap au relâcher ne ferme pas le menu ni n'y choisisse
  un niveau. Garder les noms accessibles des boutons ; l'appui long est décrit
  dans `title` et dans l'astuce sous les actions du dialogue.
- Le filtre de saison correspond à la **date du créneau** ; `all` convient à
  toutes les saisons. « Tous les repas » ignore ce filtre.
- Une nouvelle fiche reçoit provisoirement la saison de **création**.
  Les noms équivalents sont recherchés parmi les fiches actives avant sa création.
- Le texte du planning est un instantané de la saisie, non le nom calculé
  dynamiquement à partir de la fiche. Une sélection utilise le nom affiché au
  moment du choix.
- Exception pour une URL HTTP(S) : `mealDisplayName` affiche le nom de la fiche
  dès identification, sans réécrire `meal.text`. Le lien d'origine reste dans
  `dish.sourceUrl` ; pendant l'import, la synchronisation visible passe à 2 secondes.
- Ne fermer l'éditeur et n'afficher le succès qu'après la sauvegarde locale.
  Un échec de stockage doit être visible, sans perdre la saisie.
- Un plat choisi ouvre aussi « À table pour ce repas ». « Adapter » permet
  d'utiliser les paramètres actuels ou de personnaliser adultes/adolescents/enfants
  (0 à 20 par catégorie, au moins une personne). Enregistrement explicite,
  annulation et retour du focus ; une modification concurrente est signalée.
  Remplacer le plat conserve ses convives ; le vider les réinitialise.
  Ce réglage ne recalcule pas les ingrédients de la fiche partagée.

## Compte et foyer

- [Account](../../../src/Account.tsx) : bouton Google (désactivé hors ligne),
  carte « Compte et foyer » en tête des paramètres (renommer, membres, inviter,
  révoquer, quitter, se déconnecter) et liens vers les pages légales publiques.
- Mode invité : bandeau `.account-banner` au-dessus du pied de page (texte court
  sous 520 px), indicateur « Sur cet appareil uniquement ». Les boutons IA restent
  visibles mais désactivés, avec `signInHint` en infobulle.
- Bandeaux « Session expirée » (Se reconnecter) et « Vous ne faites plus partie de
  ce foyer ». Le retour OAuth `?auth=…` et le fragment `#invitation=…` sont lus
  puis retirés de l'URL au démarrage de [App](../../../src/App.tsx).

## Carnet, réglages et notifications

- Une correction de fiche ou un archivage ne réécrit pas les anciens menus.
- Les cartes du carnet et la recette d'un repas affichent le niveau (`LevelTag`) ;
  l'éditeur de fiche permet de le choisir ou de le retirer (second appui).
- Le niveau de cuisine des paramètres est partagé entre appareils (radios
  désactivées pendant l'enregistrement local ou sans paramètres reçus).
- Le modèle se choisit parmi les valeurs autorisées par le serveur ; le changement
  affiche un état temporaire pendant l'enregistrement local.
- Le quadruple tap sur le titre nécessite moins de 650 ms entre taps.
  Il synchronise puis vérifie la mise à jour, sans rechargement brutal.
- Le bouton de synchronisation des paramètres est l'alternative accessible.
  Succès et erreur sont présentés dans un dialogue ; un échec laisse l'app utilisable.
- Conserver les dialogues natifs, labels, navigation clavier et zones tactiles.
  Pour les UUID client, utiliser [newId](../../../src/id.ts), compatible HTTP LAN.
- Le thème (clair, sombre, selon l'heure, comme le système) est propre à
  l'appareil : `localStorage` `a-table-theme`, jamais synchronisé. Le mode
  horaire suit l'heure locale de l'appareil, pas `Europe/Paris`.
  [public/theme.js](../../../public/theme.js) l'applique avant React (CSP sans
  script inline) : garder son calcul identique à `resolveTheme()` dans
  [theme](../../../src/theme.ts), ce que vérifie le test de parité.
- Le thème sombre surcharge les couleurs via `[data-theme=dark]` dans les
  styles : toute nouvelle couleur claire doit recevoir son équivalent sombre.
  Les jours vont du marron pastel (lundi) au doré pastel (dimanche).

## Vérification ciblée

Lire les scénarios dans [les tests navigateur](../../../e2e/planner.spec.ts) et
les [tests de choix rapide](../../../e2e/quick-meals.spec.ts), puis
les formats dans [la configuration Playwright](../../../playwright.config.ts).
Les [tests des convives et des deux plats](../../../e2e/meal-guests.spec.ts)
vérifient aussi la hauteur inchangée, le format 320 px, les thèmes et le partage réel.
Les [tests du niveau de cuisine](../../../e2e/cooking-level.spec.ts) couvrent
paramètres, appui long souris/clic droit, appui long tactile (CDP) et carnet.
Après une modification fonctionnelle :

```powershell
npm run build
npm run test:e2e -- --project=pixel-chrome --grep='grille responsive|bibliothèque modifiable|paramètres'
```

Ajouter Firefox ou la tablette si la surface modifiée le justifie. Contrôler aussi
visuellement l'absence de débordement horizontal, les sept lignes visibles, la
largeur des dialogues mobiles et la lisibilité des textes longs. Les formats
émulés ne remplacent pas un essai sur appareil physique.
