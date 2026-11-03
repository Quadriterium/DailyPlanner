import { describe, expect, it } from 'vitest';
import {
  generateShoppingList, nextShoppingWeek, refinedShoppingListSchema, refinedShoppingListText, refineShoppingRequestSchema,
  shoppingListText, shoppingMeals,
} from '../shared/shopping';
import { parseIngredient } from '../shared/recipe';
import { details, dish, meal } from './fixtures';
import type { Analysis, Ingredient } from '../shared/model';

const household = { adults: 2, teenagers: 1, children: 1 };
const source = (items: Ingredient[]) => dish({ details: { ...details, servings: 4, items } });

describe('Listes de courses', () => {
  it('choisit la prochaine semaine civile, y compris le lundi, le dimanche et au changement d’année', () => {
    expect(nextShoppingWeek('2026-11-03')).toEqual({ start: '2026-11-09', end: '2026-11-15' });
    expect(nextShoppingWeek('2026-11-09')).toEqual({ start: '2026-11-16', end: '2026-11-22' });
    expect(nextShoppingWeek('2026-11-15')).toEqual({ start: '2026-11-16', end: '2026-11-22' });
    expect(nextShoppingWeek('2026-12-31')).toEqual({ start: '2027-01-04', end: '2027-01-10' });
  });

  it('inclut les deux bornes et les deux plats, ignore les cases vides et trie par date, créneau et index', () => {
    const first = meal({ date: '2026-11-09' });
    const second = meal({ ...first, index: 1 });
    const evening = meal({ date: first.date, slot: 'dinner' });
    const last = meal({ date: '2026-11-15' });
    expect(shoppingMeals([
      last, second, evening, meal({ date: first.date, text: ' ' }), first,
      meal({ date: '2026-11-08' }), meal({ date: '2026-11-16' }),
    ], first.date, last.date)).toEqual([first, second, evening, last]);
  });

  it('additionne avant tout arrondi, convertit les unités et respecte les convives personnalisés', () => {
    const first = source([
      { name: 'Farine', quantity: 0.5, unit: 'kg' },
      { name: 'huile d’olive', quantity: 2, unit: 'c. à soupe' },
      { name: 'Oignons', quantity: 2, unit: '' },
      { name: 'sel', quantity: null, unit: '' },
    ]);
    const second = source([
      { name: 'farine', quantity: 250, unit: 'grammes' },
      { name: 'huile d\'olive', quantity: 5, unit: 'cl' },
      { name: 'oignon', quantity: 1, unit: '' },
      { name: 'Sel', quantity: null, unit: '' },
    ]);
    const records = [meal({ dishId: first.id }), meal({ dishId: second.id, household: { adults: 2, teenagers: 0, children: 0 } })];
    const list = generateShoppingList(records, [first, second], [], household);
    expect(list.lines).toEqual(['Farine — 562,5 g', 'huile d’olive — 51,25 ml', 'Oignons — 2,25', 'sel — quantité non précisée']);
    expect(list.warnings).toEqual([]);
    expect(first.details?.items?.[0].quantity).toBe(0.5);
  });

  it('ne confond pas les unités incompatibles ni les ingrédients différents et signale les quantités manquantes', () => {
    const recipe = source([
      { name: 'tomates', quantity: 200, unit: 'g' }, { name: 'tomate', quantity: 2, unit: '' },
      { name: 'tomates', quantity: null, unit: '' }, { name: 'tomates séchées', quantity: 50, unit: 'g' },
      { name: 'riz', quantity: 100, unit: 'g' }, { name: 'maïs', quantity: 100, unit: 'g' },
    ]);
    const list = generateShoppingList([meal({ dishId: recipe.id })], [recipe], [], { adults: 4, teenagers: 0, children: 0 });
    expect(list.lines).toContain('tomates — 200 g + 2 + complément à prévoir (quantité non précisée)');
    expect(list.lines).toContain('tomates séchées — 50 g');
    expect(list.lines).toHaveLength(4);
  });

  it('réutilise les analyses valides et les fiches archivées, avec priorité aux corrections manuelles', () => {
    const recipe = dish({ archived: true });
    const analysis: Analysis = {
      dishId: recipe.id, analysisKey: recipe.analysisKey, status: 'ready',
      details: { ...details, servings: 4, items: [{ name: 'riz', quantity: 400, unit: 'g' }] },
      updatedAt: 1,
    };
    const planned = meal({ dishId: recipe.id });
    expect(generateShoppingList([planned], [recipe], [analysis], household).lines).toEqual(['riz — 350 g']);
    const manual = { ...recipe, details: { ...analysis.details!, items: [{ name: 'pâtes', quantity: 200, unit: 'g' }] } };
    expect(generateShoppingList([planned], [manual], [analysis], household).lines).toEqual(['pâtes — 175 g']);
    expect(generateShoppingList([planned], [recipe], [{ ...analysis, analysisKey: crypto.randomUUID() }], household).lines).toEqual([]);
  });

  it('lit prudemment les anciennes lignes et additionne leurs quantités recalculées sans arrondi intermédiaire', () => {
    const recipe = dish({ details: { ...details, servings: 3, ingredients: ['500 g de farine', '½ litre de lait', '2 œufs', 'Lait : 200 ml', 'Sel'] } });
    const list = generateShoppingList([meal({ dishId: recipe.id }), meal({ dishId: recipe.id })], [recipe], [], { adults: 1, teenagers: 0, children: 0 });
    expect(list.lines).toEqual(['farine — 333,333 g', 'lait — 466,667 ml', 'œufs — 1,33333', 'Sel — quantité non précisée']);
    expect(list.warnings).toEqual([]);
    expect(parseIngredient('1 200 g de farine')).toEqual({ name: 'farine', quantity: 1200, unit: 'g' });
    expect(parseIngredient('1 1/2 c. à s. d’huile')).toEqual({ name: 'huile', quantity: 1.5, unit: 'c. à s.' });
    for (const line of ['2 à 4 carottes', '1/0 l de lait', '2 boîtes de 400 g de tomates', '0 g de farine']) {
      expect(parseIngredient(line)).toBeUndefined();
    }
  });

  it('rend les listes incomplètes explicites, y compris dans le presse-papiers', () => {
    const recipe = dish({ details: { ...details, ingredients: ['200 g de riz', '2 à 4 carottes'] } });
    const list = generateShoppingList([meal({ dishId: recipe.id }), meal({ text: 'Sans fiche' })], [recipe], []);
    expect(list.lines).toEqual(['2 à 4 carottes — à vérifier', 'riz — 200 g']);
    expect(list.warnings).toHaveLength(3);
    const text = shoppingListText(list, '2026-11-09', '2026-11-15');
    expect(text).toContain('Liste de courses du 9 novembre 2026 au 15 novembre 2026');
    expect(text).toContain('- riz — 200 g');
    expect(text).toContain('quantités d’origine non adaptées aux convives');
    expect(text).toContain('ingrédients indisponibles');
    expect(text).toContain('sans addition ni recalcul');
  });

  it('met en forme la liste affinée par rayon en conservant les avertissements locaux', () => {
    const text = refinedShoppingListText({ sections: [
      { name: 'Fruits et légumes', items: ['Carottes — 1,1 kg'] }, { name: 'Crèmerie et œufs', items: ['Lait — 700 ml', 'Œufs — 6'] },
    ] }, ['Repas : ingrédients indisponibles.'], '2026-11-09', '2026-11-15');
    expect(text).toBe([
      'Liste de courses du 9 novembre 2026 au 15 novembre 2026', '', 'Fruits et légumes', '- Carottes — 1,1 kg',
      '', 'Crèmerie et œufs', '- Lait — 700 ml', '- Œufs — 6', '', 'À vérifier', '- Repas : ingrédients indisponibles.',
    ].join('\n'));
    expect(refinedShoppingListSchema.safeParse({ sections: [] }).success).toBe(false);
    expect(refineShoppingRequestSchema.safeParse({ lines: ['lait — 1 l'], extra: true }).success).toBe(false);
  });
});
