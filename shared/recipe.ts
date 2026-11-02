import type { DishDetails, Ingredient } from './model.js';

const number = String.raw`(?:\d+\s+\d+\s*\/\s*\d+|\d+\s*\/\s*\d+|\d{1,3}(?:[ \u00a0\u202f]\d{3})+(?:[.,]\d+)?|\d+(?:[.,]\d+)?|[¼½¾⅓⅔])`;
const amount = `${number}(?:\\s*(?:à|[-–])\\s*${number})?`;
const units = String.raw`(?:kg|mg|g|ml|cl|dl|l|grammes?|kilogrammes?|millilitres?|centilitres?|litres?|c\.\s*à\s*[sc]\.|cuillères?\s+à\s+(?:soupe|café))`;
const fractions: Record<string, number> = { '¼': 1 / 4, '½': 1 / 2, '¾': 3 / 4, '⅓': 1 / 3, '⅔': 2 / 3 };
const format = new Intl.NumberFormat('fr-FR', { maximumFractionDigits: 2, useGrouping: false });
const portions = /\bpour\s+(\d+)\s+(?:personnes?|portions?|convives?|parts?)\b/gi;

export function recipeServings(details: DishDetails): number | undefined {
  if (details.servings) return details.servings;
  const found = [...details.recipe.matchAll(portions)].map(match => Number(match[1]));
  return found.length && found.every(value => value === found[0]) && found[0] >= 1 && found[0] <= 60 ? found[0] : undefined;
}

function value(text: string): number {
  if (text in fractions) return fractions[text];
  if (text.includes('/')) {
    const [whole, numerator, denominator] = text.trim().split(/[\s/]+/).map(Number);
    return denominator === undefined ? whole / numerator : whole + numerator / denominator;
  }
  return Number(text.replace(/\s/g, '').replace(',', '.'));
}

/** Kitchen-friendly precision: 330 g rather than 333,33 g, 3 oignons rather than 2,67. */
function kitchenStep(quantity: number, unit: string): number {
  const name = unit.trim().toLocaleLowerCase('fr-FR');
  if (!name) return quantity < 2 ? 0.5 : 1;
  if (/^(?:c\.|cuill)/.test(name)) return quantity < 1 ? 0.25 : 0.5;
  if (/^(?:kg|l|kilo|litre)/.test(name)) return quantity >= 10 ? 0.5 : 0.05;
  if (/^(?:cl|dl|centi)/.test(name)) return quantity >= 10 ? 1 : 0.5;
  return quantity >= 100 ? 10 : quantity >= 20 ? 5 : quantity >= 5 ? 1 : 0.5;
}

/** Kitchen-friendly rounding of a positive quantity, never down to zero. */
function kitchenQuantity(quantity: number, unit: string): string {
  const step = kitchenStep(quantity, unit);
  const rounded = Math.round(quantity / step) * step;
  return rounded > 0 ? format.format(rounded)
    : new Intl.NumberFormat('fr-FR', { maximumSignificantDigits: 2, useGrouping: false }).format(quantity);
}

/** « 200 g de farine », « 20 cl d’huile », « 3 oignons », « sel ». */
export function formatIngredient(item: Ingredient, ratio = 1): string {
  if (item.quantity === null) return item.unit ? `${item.name} (${item.unit})` : item.name;
  const quantity = kitchenQuantity(item.quantity * ratio, item.unit);
  if (!item.unit) return `${quantity} ${item.name}`;
  return `${quantity} ${item.unit} ${/^[aeiouyhâàéèêëîïôûœ]/i.test(item.name) ? 'd’' : 'de '}${item.name}`;
}

function scaledAmount(text: string, ratio: number, unit: string): string | undefined {
  let valid = true;
  const result = text.replace(new RegExp(number, 'g'), quantity => {
    const scaled = value(quantity) * ratio;
    if (!Number.isFinite(scaled) || scaled <= 0) { valid = false; return quantity; }
    return kitchenQuantity(scaled, unit);
  });
  return valid ? result : undefined;
}

function escaped(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s*');
}

/** Match primary ingredient quantities in the steps, not package sizes, times or temperatures. */
export function scaleRecipe(details: DishDetails, target: number) {
  if (!Number.isFinite(target) || target < 0.5 || target > 60 || !Number.isInteger(target * 2)) {
    throw new Error('Le repas doit compter entre 0,5 et 60 portions.');
  }
  const base = recipeServings(details);
  if (base && details.items?.length) {
    // Structured quantities scale exactly; the steps name the ingredients without repeating their quantities.
    return { ...details, ingredients: details.items.map(item => formatIngredient(item, target / base)), base, unscaled: 0 };
  }
  if (!base || base === target) return { ...details, base, unscaled: 0 };
  const replacements = new Map<string, { pattern: string; replacement: string }>();
  let unscaled = 0;
  const ingredients = details.ingredients.map(ingredient => {
    const measured = new RegExp(`(?<![\\d.,/])(${amount})(\\s*${units})(?![\\p{L}])`, 'iu').exec(ingredient);
    const counted = new RegExp(`^\\s*(${amount})(\\s+[\\p{L}œŒ][\\p{L}œŒ’-]*)`, 'u').exec(ingredient);
    const match = measured && (!counted || measured.index <= counted.index + ingredient.search(/\S/)) ? measured : counted;
    if (!match) { unscaled++; return ingredient; }
    const scaled = scaledAmount(match[1], target / base, match === measured ? match[2] : '');
    if (!scaled) { unscaled++; return ingredient; }
    const original = `${match[1]}${match[2]}`;
    const replacement = `${scaled}${match[2]}`;
    const start = match.index + match[0].indexOf(match[1]);
    if (measured && match !== measured) {
      const packageText = ingredient.slice(start, measured.index + measured[0].length);
      replacements.set(packageText.toLocaleLowerCase('fr-FR').replace(/\s/g, ''), {
        pattern: escaped(packageText), replacement: replacement + packageText.slice(original.length),
      });
    }
    replacements.set(original.toLocaleLowerCase('fr-FR').replace(/\s/g, ''), {
      pattern: escaped(original), replacement,
    });
    return ingredient.slice(0, start) + replacement + ingredient.slice(start + original.length);
  });
  const patterns = [...replacements.values()].map(item => item.pattern).sort((a, b) => b.length - a.length);
  const recipe = (patterns.length ? details.recipe.replace(
    new RegExp(`(?<![\\d.,/])(?:${patterns.join('|')})(?![\\p{L}\\d])`, 'giu'),
    text => replacements.get(text.toLocaleLowerCase('fr-FR').replace(/\s/g, ''))!.replacement,
  ) : details.recipe).replace(portions, text => text.replace(/\d+/, format.format(target)));
  return { ...details, ingredients, recipe, base, unscaled };
}
