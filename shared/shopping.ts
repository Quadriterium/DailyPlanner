import {
  addDays, dishDetails, formatDate, householdPortions, isoWeekday, mealDisplayName, mealHousehold,
  type Analysis, type Dish, type Household, type Ingredient, type Meal,
} from './model.js';
import { parseIngredient, recipeServings } from './recipe.js';
import { z } from 'zod';

export function nextShoppingWeek(today: string) {
  const start = addDays(today, 8 - isoWeekday(today));
  return { start, end: addDays(start, 6) };
}

export function shoppingMeals(meals: Meal[], start: string, end: string): Meal[] {
  return meals.filter(meal => meal.text.trim() && meal.date >= start && meal.date <= end)
    .sort((a, b) => a.date.localeCompare(b.date) ||
      (a.slot === b.slot ? 0 : a.slot === 'lunch' ? -1 : 1) || (a.index ?? 0) - (b.index ?? 0));
}

function normalized(text: string): string {
  return text.toLocaleLowerCase('fr-FR').normalize('NFD').replace(/\p{M}/gu, '')
    .replace(/œ/g, 'oe').replace(/['’]/g, '’').replace(/\s+/g, ' ').trim();
}

// Only known plurals: stripping every final "s" would corrupt names such as "maïs".
const plurals = new Map([
  ['oeufs', 'oeuf'], ['oignons', 'oignon'], ['tomates', 'tomate'], ['carottes', 'carotte'],
  ['pommes', 'pomme'], ['terres', 'terre'], ['courgettes', 'courgette'], ['poivrons', 'poivron'],
  ['citrons', 'citron'], ['echalotes', 'echalote'], ['gousses', 'gousse'],
]);

function ingredientKey(name: string): string {
  return normalized(name).split(' ').map(word => plurals.get(word) ?? word).join(' ');
}

function unitValue(unit: string): { unit: string; factor: number } {
  const name = normalized(unit);
  if (/^(kg|kilogrammes?)$/.test(name)) return { unit: 'g', factor: 1000 };
  if (/^(g|grammes?)$/.test(name)) return { unit: 'g', factor: 1 };
  if (/^(mg|milligrammes?)$/.test(name)) return { unit: 'g', factor: 0.001 };
  if (/^(l|litres?)$/.test(name)) return { unit: 'ml', factor: 1000 };
  if (/^(dl|decilitres?)$/.test(name)) return { unit: 'ml', factor: 100 };
  if (/^(cl|centilitres?)$/.test(name)) return { unit: 'ml', factor: 10 };
  if (/^(ml|millilitres?)$/.test(name)) return { unit: 'ml', factor: 1 };
  if (/^(?:c\.\s*a\s*s\.?|c\.\s*a\s*soupe|cuilleres? a soupe)$/.test(name)) return { unit: 'ml', factor: 15 };
  if (/^(?:c\.\s*a\s*c\.?|c\.\s*a\s*cafe|cuilleres? a cafe)$/.test(name)) return { unit: 'ml', factor: 5 };
  const singular = /^(boites|sachets|gousses|bottes|pincees)$/.test(name) ? name.slice(0, -1) : name;
  return { unit: singular, factor: 1 };
}

function quantityText(quantity: number, unit: string): string {
  if (unit === 'g' && quantity >= 1000) { quantity /= 1000; unit = 'kg'; }
  if (unit === 'ml' && quantity >= 1000) { quantity /= 1000; unit = 'l'; }
  const amount = new Intl.NumberFormat('fr-FR', { maximumSignificantDigits: 6, useGrouping: false }).format(quantity);
  return `${amount}${unit ? ` ${unit}` : ''}`;
}

export interface ShoppingList {
  lines: string[];
  warnings: string[];
}

export function generateShoppingList(
  meals: Meal[], dishes: Dish[], analyses: Analysis[], household?: Household,
): ShoppingList {
  const groups = new Map<string, { name: string; quantities: Map<string, number>; unspecified: boolean }>();
  const unparsed = new Map<string, string>();
  const warnings: string[] = [];
  const dishMap = new Map(dishes.map(dish => [dish.id, dish]));
  const analysisMap = new Map(analyses.map(analysis => [analysis.dishId, analysis]));
  function add(item: Ingredient, ratio: number) {
    const key = ingredientKey(item.name);
    let group = groups.get(key);
    if (!group) {
      group = { name: item.name, quantities: new Map(), unspecified: false };
      groups.set(key, group);
    }
    if (item.quantity === null) { group.unspecified = true; return; }
    const { unit, factor } = unitValue(item.unit);
    group.quantities.set(unit, (group.quantities.get(unit) ?? 0) + item.quantity * ratio * factor);
  }
  for (const meal of meals) {
    const dish = meal.dishId ? dishMap.get(meal.dishId) : undefined;
    const analysis = dish ? analysisMap.get(dish.id) : undefined;
    const label = `${formatDate(meal.date, { day: 'numeric', month: 'long' })} · ${meal.slot === 'lunch' ? 'Midi' : 'Soir'} · ${mealDisplayName(meal, dish, analysis)}`;
    const details = dish ? dishDetails(dish, analysis) : undefined;
    if (!details || !(details.items?.length || details.ingredients.length)) {
      warnings.push(`${label} : ingrédients indisponibles, à ajouter manuellement.`);
      continue;
    }
    const base = recipeServings(details);
    const ratio = base ? householdPortions(mealHousehold(meal, household)) / base : 1;
    if (!base) warnings.push(`${label} : portions de référence inconnues, quantités d’origine non adaptées aux convives.`);
    if (details.items?.length) {
      details.items.forEach(item => add(item, ratio));
    } else {
      let incomplete = false;
      for (const line of details.ingredients) {
        const item = parseIngredient(line);
        if (item) add(item, ratio);
        else {
          // Plain names (salt, pepper…) are safe to deduplicate without inventing a quantity.
          if (!/[\d¼½¾⅓⅔]/u.test(line)) add({ name: line, unit: '', quantity: null }, 1);
          else { unparsed.set(normalized(line), line); incomplete = true; }
        }
      }
      if (incomplete) warnings.push(`${label} : certaines quantités ne sont pas interprétables ; lignes d’origine conservées « à vérifier », sans addition ni recalcul.`);
    }
  }
  const lines = [...groups.values()].map(group => {
    const amounts = [...group.quantities].map(([unit, quantity]) => quantityText(quantity, unit));
    if (group.unspecified) amounts.push(amounts.length ? 'complément à prévoir (quantité non précisée)' : 'quantité non précisée');
    return `${group.name} — ${amounts.join(' + ')}`;
  });
  lines.push(...[...unparsed.values()].map(line => `${line} — à vérifier`));
  return { lines: lines.sort((a, b) => a.localeCompare(b, 'fr')), warnings };
}

function shoppingTitle(start: string, end: string): string {
  const date = (value: string) => formatDate(value, { day: 'numeric', month: 'long', year: 'numeric' });
  return `Liste de courses du ${date(start)} au ${date(end)}`;
}

function warningLines(warnings: string[]): string[] {
  return warnings.length ? ['', 'À vérifier', ...warnings.map(warning => `- ${warning}`)] : [];
}

export function shoppingListText(list: ShoppingList, start: string, end: string): string {
  return [shoppingTitle(start, end), ...list.lines.map(line => `- ${line}`), ...warningLines(list.warnings)].join('\n');
}

/** Exact lines sent to the AI; meal names and warnings stay on the device. */
export const refineShoppingRequestSchema = z.object({
  lines: z.array(z.string().trim().min(1).max(300)).min(1).max(300),
}).strict();

export const refinedShoppingListSchema = z.object({
  sections: z.array(z.object({
    name: z.string().trim().min(1).max(80),
    items: z.array(z.string().trim().min(1).max(200)).min(1).max(300),
  }).strict()).min(1).max(30),
}).strict();
export type RefinedShoppingList = z.infer<typeof refinedShoppingListSchema>;

export function refinedShoppingListText(list: RefinedShoppingList, warnings: string[], start: string, end: string): string {
  return [shoppingTitle(start, end), ...list.sections.flatMap(section => ['', section.name, ...section.items.map(item => `- ${item}`)]),
    ...warningLines(warnings)].join('\n');
}
