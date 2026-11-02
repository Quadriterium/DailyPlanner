import { describe, expect, it } from 'vitest';
import { details } from './fixtures';
import { formatIngredient, recipeServings, scaleRecipe } from '../shared/recipe';
import { detailsSchema } from '../shared/model';

describe('Recalcul local des recettes', () => {
  const source = {
    ...details, servings: 6,
    ingredients: ['600 g de poulet', '1,5 kg de pommes de terre', '3 œufs', '2 boîtes de 400 g de tomates', 'Sel au goût'],
    recipe: 'Pour 6 personnes.\n1. Ajoutez 600g de poulet, 1,5 kg de pommes de terre et 3 œufs.\n2. Ouvrez 2 boîtes de 400 g de tomates. Cuire 30 minutes à 180 °C. Réservez 10 % de la sauce.',
  };
  it('adapte ingrédients et mentions reconnues des étapes, mais pas les étapes, durées, températures, pourcentages et tailles des boîtes', () => {
    const result = scaleRecipe(source, 2);
    expect(result.ingredients).toEqual(['200 g de poulet', '0,5 kg de pommes de terre', '1 œufs', '0,5 boîtes de 400 g de tomates', 'Sel au goût']);
    expect(result.recipe).toBe('Pour 2 personnes.\n1. Ajoutez 200 g de poulet, 0,5 kg de pommes de terre et 1 œufs.\n2. Ouvrez 0,5 boîtes de 400 g de tomates. Cuire 30 minutes à 180 °C. Réservez 10 % de la sauce.');
    expect(result.unscaled).toBe(1);
    expect(source.ingredients[0]).toBe('600 g de poulet');
    expect(source.recipe).toContain('Pour 6 personnes');
  });
  it('repart toujours des quantités d’origine, sans arrondis cumulés', () => {
    expect(scaleRecipe(source, 6).ingredients).toEqual(source.ingredients);
    expect(scaleRecipe(source, 3).ingredients[0]).toBe('300 g de poulet');
    expect(scaleRecipe(source, 9).ingredients[0]).toBe('900 g de poulet');
  });
  it('adapte le gratin de six à huit personnes sans toucher aux températures et aux temps de cuisson', () => {
    const gratin = { ...details, servings: 6, ingredients: ['1,2 kg de courge butternut', '250 g de lentilles vertes'],
      recipe: '1. Préchauffer le four à 200 °C.\n2. Enfourner 25 à 30 minutes.' };
    expect(scaleRecipe(gratin, 8).ingredients).toEqual(['1,6 kg de courge butternut', '330 g de lentilles vertes']);
    expect(scaleRecipe(gratin, 4).ingredients).toEqual(['0,8 kg de courge butternut', '170 g de lentilles vertes']);
    expect(scaleRecipe(gratin, 8).recipe).toBe(gratin.recipe);
  });
  it('arrondit la fiche réelle du gratin à des quantités de cuisine pour 4 adultes, 2 ados et 2 enfants', () => {
    const gratin = { ...details, servings: 6, ingredients: ['1,2 kg de courge butternut', '250 g de lentilles vertes', '2 oignons',
      '20 cl de crème fraîche', '150 g de comté râpé', '2 cuillères à soupe d’huile d’olive', '1 cuillère à café de thym', 'Sel et poivre, à convenance'] };
    expect(scaleRecipe(gratin, 8).ingredients).toEqual(['1,6 kg de courge butternut', '330 g de lentilles vertes', '3 oignons',
      '27 cl de crème fraîche', '200 g de comté râpé', '2,5 cuillères à soupe d’huile d’olive', '1,5 cuillère à café de thym', 'Sel et poivre, à convenance']);
  });
  it('protège les tailles des boîtes même si une autre quantité identique doit être adaptée', () => {
    const result = scaleRecipe({ ...details, servings: 4, ingredients: ['2 boîtes de 400 g de tomates', '400 g de poulet'],
      recipe: 'Verser 2 boîtes de 400 g de tomates et 400g de poulet.' }, 2);
    expect(result.ingredients).toEqual(['1 boîtes de 400 g de tomates', '200 g de poulet']);
    expect(result.recipe).toBe('Verser 1 boîtes de 400 g de tomates et 200 g de poulet.');
  });
  it('ne transforme pas une petite quantité positive en zéro et rejette un nombre de convives invalide', () => {
    expect(scaleRecipe({ ...details, servings: 6, ingredients: ['0,01 g de safran'] }, 1).ingredients).toEqual(['0,0017 g de safran']);
    for (const target of [0, -1, 0.25, 1.2, 61, NaN]) expect(() => scaleRecipe(source, target)).toThrow('entre 0,5 et 60');
    expect(scaleRecipe(source, 1.5).ingredients[0]).toBe('150 g de poulet');
  });
  it('accepte les fractions, décimales, intervalles, milliers et quantités après le nom', () => {
    const result = scaleRecipe({ ...details, servings: 4, ingredients: [
      '1/2 l de lait', '½ cuillère à café de sel', '1 1/2 c. à s. d’huile',
      '2 à 4 carottes', '1 200 g de farine', 'Lait : 200 ml', '0.5 kg de sucre',
    ] }, 2);
    expect(result.ingredients).toEqual([
      '0,25 l de lait', '0,25 cuillère à café de sel', '0,75 c. à s. d’huile',
      '1 à 2 carottes', '600 g de farine', 'Lait : 100 ml', '0,25 kg de sucre',
    ]);
  });
  it('détecte seulement les portions d’origine explicites et cohérentes, jamais le foyer actuel', () => {
    expect(recipeServings({ ...details, recipe: 'Recette pour 4 personnes. Cuire 30 minutes à 180 °C.' })).toBe(4);
    expect(recipeServings({ ...details, recipe: 'Pour 4 portions. Pour 6 personnes.' })).toBeUndefined();
    expect(recipeServings(details)).toBeUndefined();
    expect(scaleRecipe(details, 2)).toMatchObject({ ingredients: details.ingredients, recipe: details.recipe, base: undefined });
    expect(recipeServings({ ...details, servings: 8, recipe: 'Pour 4 personnes.' })).toBe(8);
  });
  it('laisse les quantités non interprétables intactes et les signale', () => {
    const result = scaleRecipe({ ...details, servings: 6, ingredients: ['Sel au goût', 'une pincée de cumin', '1/0 l de lait'] }, 2);
    expect(result.ingredients).toEqual(['Sel au goût', 'une pincée de cumin', '1/0 l de lait']);
    expect(result.unscaled).toBe(3);
  });
  it('conserve la compatibilité des anciennes fiches et valide les portions de référence', () => {
    expect(detailsSchema.safeParse(details).success).toBe(true);
    for (const servings of [0, -1, 0.25, 1.2, 61, NaN]) expect(detailsSchema.safeParse({ ...details, servings }).success).toBe(false);
    expect(detailsSchema.parse({ ...details, servings: 6 }).servings).toBe(6);
    expect(detailsSchema.parse({ ...details, servings: 1.5 }).servings).toBe(1.5);
  });
  it('recalcule exactement les ingrédients structurés sans toucher aux étapes', () => {
    const structured = {
      ...details, servings: 4, recipe: '1. Faites revenir les oignons dans l’huile.',
      ingredients: ['500 g de farine', '2 oignons', '2 c. à soupe d’huile d’olive', 'sel'],
      items: [
        { name: 'farine', quantity: 500, unit: 'g' }, { name: 'oignons', quantity: 2, unit: '' },
        { name: 'huile d’olive', quantity: 2, unit: 'c. à soupe' }, { name: 'sel', quantity: null, unit: '' },
      ],
    };
    const result = scaleRecipe(structured, 2.5);
    expect(result.ingredients).toEqual(['310 g de farine', '1,5 oignons', '1,5 c. à soupe d’huile d’olive', 'sel']);
    expect(result.recipe).toBe(structured.recipe);
    expect(result.unscaled).toBe(0);
    expect(formatIngredient({ name: 'eau', quantity: 20, unit: 'cl' })).toBe('20 cl d’eau');
    expect(formatIngredient({ name: 'œufs', quantity: 3, unit: '' })).toBe('3 œufs');
    expect(formatIngredient({ name: 'poivre', quantity: null, unit: '' })).toBe('poivre');
  });
  it('adapte un poulet-frites à cinq portions sans confondre poids, morceaux et animaux', () => {
    const chicken = { ...details, servings: 4,
      items: [{ name: 'poulet', quantity: 1.2, unit: 'kg' }, { name: 'pommes de terre', quantity: 1, unit: 'kg' }] };
    expect(scaleRecipe(chicken, 5).ingredients).toEqual(['1,5 kg de poulet', '1,25 kg de pommes de terre']);
    expect(scaleRecipe({ ...chicken, items: [{ name: 'cuisses de poulet', quantity: 4, unit: '' }] }, 5).ingredients)
      .toEqual(['5 cuisses de poulet']);
    expect(chicken.items[0].quantity).toBe(1.2);
  });
});
