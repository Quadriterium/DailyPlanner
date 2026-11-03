import { test, expect, type Page } from '@playwright/test';
import { addDays, mealId, parisDate } from '../shared/model';
import { nextShoppingWeek } from '../shared/shopping';
import { details, dish, meal, snapshot } from '../tests/fixtures';

const week = nextShoppingWeek(parisDate());
const recipe = dish({
  name: 'Gratin de carottes',
  details: { ...details, name: 'Gratin de carottes', servings: 4, ingredients: ['400 g de carottes'],
    items: [{ name: 'carottes', quantity: 400, unit: 'g' }] },
});
const second = dish({
  name: 'Soupe de carottes',
  details: { ...details, name: 'Soupe de carottes', servings: 4, ingredients: ['0,5 kg de carottes'],
    items: [{ name: 'Carotte', quantity: 0.5, unit: 'kg' }] },
});
async function setup(page: Page, aiConfigured = false) {
  await page.route('**/api/sync', route => route.fulfill({ json: { ...snapshot([
    recipe, second,
    meal({ id: mealId(week.start, 'lunch'), date: week.start, text: recipe.name, dishId: recipe.id }),
    meal({ id: mealId(week.start, 'lunch', 1), date: week.start, index: 1, text: second.name, dishId: second.id,
      household: { adults: 2, teenagers: 0, children: 0 } }),
    meal({ id: mealId(week.end, 'dinner'), date: week.end, slot: 'dinner', text: recipe.name, dishId: recipe.id }),
    meal({ id: mealId(addDays(week.start, -1), 'lunch'), date: addDays(week.start, -1), text: 'Repas précédent' }),
    { type: 'settings', id: 'global', model: 'gpt-6-luna', household: { adults: 4, teenagers: 0, children: 0 },
      avoid: '', cookingLevel: 2, modifiedAt: Date.now(), mutationId: crypto.randomUUID() },
  ]), capabilities: { ...snapshot().capabilities, aiConfigured } } }));
  await page.goto('/');
  await expect(page.locator('.connection-indicator')).toHaveText('Carnet à jour');
  await page.getByRole('button', { name: 'Liste de courses', exact: true }).click();
}

test('courses : période, sélection des deux plats, somme, popin et copie', async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: {
      writeText: async (text: string) => { document.documentElement.dataset.copiedList = text; },
    } });
  });
  await setup(page);
  const nav = await page.getByRole('navigation', { name: 'Navigation principale' }).getByRole('button').allTextContents();
  expect(nav).toEqual(['Mon planning', 'Liste de courses', 'Mon carnet', 'Paramètres']);
  await expect(page.getByLabel('Du', { exact: true })).toHaveValue(week.start);
  await expect(page.getByLabel('Au', { exact: true })).toHaveValue(week.end);
  const checkboxes = page.locator('.shopping-meals input');
  await expect(checkboxes).toHaveCount(3);
  for (const checkbox of await checkboxes.all()) await expect(checkbox).toBeChecked();
  await checkboxes.nth(2).uncheck();
  await page.getByRole('button', { name: 'Générer la liste' }).click();
  const dialog = page.getByRole('dialog', { name: 'Votre liste de courses' });
  await expect(dialog.getByLabel('Liste à copier')).toHaveValue(/carottes — 650 g/);
  await dialog.getByRole('button', { name: 'Copier la liste' }).click();
  await expect(dialog.getByRole('status')).toHaveText('Liste copiée.');
  expect(await page.locator('html').getAttribute('data-copied-list')).toBe(await dialog.getByLabel('Liste à copier').inputValue());
  await dialog.getByRole('button', { name: 'Fermer' }).click();
  await expect(page.getByRole('button', { name: 'Générer la liste' })).toBeFocused();
  await page.getByRole('button', { name: 'Tout cocher', exact: true }).click();
  await page.getByRole('button', { name: 'Tout décocher', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Générer la liste' })).toBeDisabled();
  await page.getByLabel('Du', { exact: true }).fill(addDays(week.start, -1));
  await expect(page.locator('.shopping-meals input')).toHaveCount(4);
  await page.getByRole('button', { name: 'Générer la liste' }).click();
  await expect(dialog.getByLabel('Liste à copier')).toHaveValue(/carottes — 1,05 kg/);
  await expect(dialog.getByLabel('Liste à copier')).toHaveValue(/Repas précédent : ingrédients indisponibles/);
});

test('courses : dates invalides, période vide et erreur explicite de copie', async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: {
      writeText: async () => { throw new Error('Permission refusée'); },
    } });
  });
  await setup(page);
  await page.getByLabel('Au', { exact: true }).fill(addDays(week.start, -1));
  await expect(page.getByRole('alert')).toContainText('Choisissez deux dates valides');
  await expect(page.getByRole('button', { name: 'Générer la liste' })).toBeDisabled();
  await page.getByLabel('Du', { exact: true }).fill(addDays(week.start, -2));
  await page.getByLabel('Au', { exact: true }).fill(addDays(week.start, -2));
  await expect(page.getByRole('heading', { name: 'Aucun repas prévu' })).toBeVisible();
  await page.getByRole('button', { name: 'Semaine prochaine', exact: true }).click();
  await page.getByRole('button', { name: 'Générer la liste' }).click();
  await page.getByRole('button', { name: 'Copier la liste' }).click();
  await expect(page.getByRole('alert')).toContainText('Permission refusée');
  await expect(page.getByLabel('Liste à copier')).toBeVisible();
  await page.getByRole('button', { name: 'Fermer' }).click();
  await page.setViewportSize({ width: 320, height: 740 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test('courses : génération hors ligne après rechargement de la PWA', async ({ page, context }) => {
  await setup(page);
  await page.evaluate(() => navigator.serviceWorker.ready.then(() => true));
  await page.reload();
  await expect(page.locator('.connection-indicator')).toHaveText('Carnet à jour');
  await expect.poll(() => page.evaluate(() => Boolean(navigator.serviceWorker.controller))).toBe(true);
  // Firefox cannot reload from its service worker offline while test routing is active.
  await page.unroute('**/api/sync');
  await context.setOffline(true);
  await page.reload();
  await page.getByRole('button', { name: 'Liste de courses', exact: true }).click();
  await expect(page.locator('.shopping-meals input')).toHaveCount(3);
  await page.getByRole('button', { name: 'Générer la liste' }).click();
  await expect(page.getByLabel('Liste à copier')).toHaveValue(/carottes — 1,05 kg/);
});

test('courses : affinage IA par rayon, copie de la version affinée et retour à la liste exacte', async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: {
      writeText: async (text: string) => { document.documentElement.dataset.copiedList = text; },
    } });
  });
  let sent: unknown;
  await page.route('**/api/shopping/refine', async route => {
    sent = route.request().postDataJSON();
    await route.fulfill({ json: { list: { sections: [{ name: 'Fruits et légumes', items: ['Carottes — 1,1 kg'] }] } } });
  });
  await setup(page, true);
  await page.getByRole('button', { name: 'Générer la liste' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('button', { name: 'Affiner avec l’IA' }).click();
  const refined = dialog.getByLabel('Liste affinée par l’IA, à copier');
  await expect(refined).toHaveValue(/Fruits et légumes\n- Carottes — 1,1 kg/);
  expect(sent).toEqual({ lines: ['carottes — 1,05 kg'] });
  await dialog.getByRole('button', { name: 'Copier la liste' }).click();
  expect(await page.locator('html').getAttribute('data-copied-list')).toBe(await refined.inputValue());
  await dialog.getByRole('button', { name: 'Revenir à la liste exacte' }).click();
  await expect(dialog.getByLabel('Liste à copier')).toHaveValue(/carottes — 1,05 kg/);
  await page.unroute('**/api/shopping/refine');
  await page.route('**/api/shopping/refine', route => route.fulfill({ status: 429, json: { error: 'Limite de 20 requêtes IA atteinte.' } }));
  await dialog.getByRole('button', { name: 'Affiner avec l’IA' }).click();
  await expect(dialog.getByRole('alert')).toContainText('Limite de 20 requêtes');
  await expect(dialog.getByLabel('Liste à copier')).toHaveValue(/carottes — 1,05 kg/);
});
