import { test, expect, type Page } from '@playwright/test';
import { parisDate, syncResponseSchema, type Analysis, type CatalogEntry, type RecordData } from '../shared/model';
import { dish, snapshot } from '../tests/fixtures';

const steps = 'Ma méthode : cuire 1 kg de carottes pendant 30 minutes.\nServir comme chez moi !';
const ingredients = '1 kg de carottes\n2 oignons\nsel';

async function openLibrary(page: Page) {
  await page.getByRole('button', { name: 'Mon carnet', exact: true }).click();
}

async function fillRecipe(page: Page, name: string) {
  await page.getByRole('button', { name: 'Ajouter une recette', exact: true }).click();
  await page.getByLabel('Titre de votre recette', { exact: true }).fill(name);
  await page.getByLabel('Nombre de portions de votre recette', { exact: true }).fill('6');
  await page.getByLabel(/Ingrédients et quantités/).fill(ingredients);
  await page.getByLabel('Étapes de votre recette', { exact: true }).fill(steps);
}

test('recette personnelle : ajout sans planning, persistance, correction et relance sans perdre le texte', async ({ page }) => {
  const name = `Mes CAROTTES maison ! ${crypto.randomUUID().slice(0, 8)}`;
  await page.goto('/');
  await expect(page.locator('.connection-indicator')).toHaveText('Carnet à jour');
  await openLibrary(page);
  await fillRecipe(page, name);
  await expect(page.getByRole('dialog')).toContainText('L’IA n’est pas configurée');
  await page.getByLabel(/Ingrédients et quantités/).fill('a'.repeat(121));
  await page.getByRole('button', { name: 'Ajouter au carnet' }).click();
  await expect(page.getByRole('alert')).toContainText('120 caractères maximum par ligne');
  await expect(page.getByLabel('Étapes de votre recette')).toHaveValue(steps);
  await page.getByLabel(/Ingrédients et quantités/).fill(ingredients);
  await page.getByRole('button', { name: 'Ajouter au carnet' }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.locator('.recipe-card').filter({ hasText: name })).toContainText('Validation IA en attente');
  await expect(page.locator('.connection-indicator')).toHaveText('Carnet à jour');
  await page.reload();
  await openLibrary(page);
  await page.locator('.recipe-card').filter({ hasText: name }).click();
  await expect(page.getByLabel('Nom du repas', { exact: true })).toHaveValue(name);
  await expect(page.getByLabel('Une petite recette', { exact: true })).toHaveValue(steps);
  await expect(page.getByLabel('Nombre de portions de la recette d’origine')).toHaveValue('6');
  await expect(page.getByLabel(/Ingrédients et quantités/)).toHaveValue(ingredients);
  const changed = `${steps}\nC’est prêt.`;
  await page.getByLabel('Une petite recette', { exact: true }).fill(changed);
  await page.getByRole('button', { name: 'Enregistrer la fiche' }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.locator('.connection-indicator')).toHaveText('Carnet à jour');
  let records: RecordData[] = [];
  await expect.poll(async () => {
    const payload = await page.request.post('/api/sync', { data: { mutations: [] } });
    expect(payload.ok()).toBe(true);
    records = syncResponseSchema.parse(await payload.json()).records;
    const current = records.find(record => record.type === 'dish' && record.name === name);
    return current?.type === 'dish' ? current.sourceRecipe?.recipe : undefined;
  }).toBe(changed);
  const saved = records.find(record => record.type === 'dish' && record.name === name);
  expect(saved?.type === 'dish' && saved.sourceRecipe?.recipe).toBe(changed);
  expect(records.filter(record => record.type === 'meal' && record.dishId === saved?.id)).toHaveLength(0);
  await page.locator('.recipe-card').filter({ hasText: name }).click();
  await expect(page.getByLabel('Une petite recette', { exact: true })).toHaveValue(changed);
  await page.getByRole('button', { name: 'Fermer', exact: true }).click();
});

test('recette personnelle : ajout hors ligne conservé après rechargement puis synchronisé', async ({ page, context }) => {
  const name = `Ma recette hors ligne ${crypto.randomUUID().slice(0, 8)}`;
  await page.goto('/');
  await expect(page.locator('.connection-indicator')).toHaveText('Carnet à jour');
  await page.evaluate(() => navigator.serviceWorker.ready.then(() => true));
  await page.reload();
  await expect.poll(() => page.evaluate(() => Boolean(navigator.serviceWorker.controller))).toBe(true);
  await context.setOffline(true);
  await openLibrary(page);
  await fillRecipe(page, name);
  await page.getByRole('button', { name: 'Ajouter au carnet' }).click();
  await expect(page.locator('.recipe-card').filter({ hasText: name })).toBeVisible();
  await page.reload();
  await openLibrary(page);
  await page.locator('.recipe-card').filter({ hasText: name }).click();
  await expect(page.getByLabel('Une petite recette', { exact: true })).toHaveValue(steps);
  await page.getByRole('button', { name: 'Fermer', exact: true }).click();
  await context.setOffline(false);
  await page.getByRole('button', { name: 'Paramètres', exact: true }).click();
  await page.getByRole('button', { name: 'Synchroniser', exact: true }).click();
  await expect(page.locator('.connection-indicator')).toHaveText('Carnet à jour');
});

test('recette personnelle : refus visible, correction conservée et nouvelle validation demandée', async ({ page }) => {
  const recipe = dish({
    name: 'Ma recette à corriger',
    sourceRecipe: { ingredients: ingredients.split('\n'), servings: 6, recipe: steps },
  });
  const records = new Map<string, RecordData>([[`dish:${recipe.id}`, recipe]]);
  const rejected: Analysis = {
    dishId: recipe.id, analysisKey: recipe.analysisKey, status: 'ready',
    details: null, sharing: 'rejected', error: null, updatedAt: Date.now(),
  };
  await page.route('**/api/sync', async route => {
    for (const record of route.request().postDataJSON().mutations as RecordData[]) records.set(`${record.type}:${record.id}`, record);
    await route.fulfill({ json: { ...snapshot([...records.values()]), analyses: [rejected] } });
  });
  await page.goto('/');
  await openLibrary(page);
  await page.locator('.recipe-card').filter({ hasText: recipe.name }).click();
  await expect(page.getByRole('dialog')).toContainText('L’IA n’a pas validé cette recette');
  await expect(page.getByLabel('Une petite recette', { exact: true })).toHaveValue(steps);
  await page.getByRole('button', { name: 'Enregistrer la fiche' }).click();
  await expect.poll(() => {
    const changed = records.get(`dish:${recipe.id}`);
    return changed?.type === 'dish' ? changed.analysisKey : recipe.analysisKey;
  }).not.toBe(recipe.analysisKey);
  await expect(page.locator('.recipe-card').filter({ hasText: recipe.name })).toContainText('Validation IA en attente');
});

test('recette partagée : absente du carnet par défaut, trouvable par saisie ou hasard et copiée sans appel IA', async ({ page }) => {
  const entry: CatalogEntry = {
    id: crypto.randomUUID(),
    details: {
      name: 'Les CAROTTES de mon jardin !', seasons: ['all'], level: 2, servings: 6, vegetarian: true,
      ingredients: ['1000 g de carottes'], items: [{ name: 'carottes', quantity: 1000, unit: 'g' }],
      recipe: steps, preserveRecipe: true,
    },
  };
  const records = new Map<string, RecordData>();
  const catalogId = crypto.randomUUID();
  await page.route('**/api/catalog?*', route => route.fulfill({
    json: { catalogId, cursor: 1, more: false, removed: [], entries: [entry] },
  }));
  await page.route('**/api/sync', async route => {
    for (const record of route.request().postDataJSON().mutations as RecordData[]) records.set(`${record.type}:${record.id}`, record);
    await route.fulfill({ json: snapshot([...records.values()]) });
  });
  let generationCalls = 0;
  await page.route('**/api/meals/generate', route => { generationCalls++; return route.abort(); });
  await page.goto('/');
  await expect(page.locator('.connection-indicator')).toHaveText('Carnet à jour');
  await openLibrary(page);
  await expect(page.locator('.recipe-card')).toHaveCount(0);
  await page.getByRole('button', { name: 'Mon planning', exact: true }).click();
  const cell = page.locator(`[data-date="${parisDate()}"] .meal-cell`).first();
  await cell.click();
  await page.getByLabel('Votre idée du jour', { exact: true }).fill('carottes');
  await expect(page.getByRole('option')).toContainText(entry.details.name);
  await expect(page.getByRole('option')).toContainText('Catalogue commun');
  await page.getByRole('button', { name: 'Fermer', exact: true }).click();
  await cell.click();
  await page.getByRole('button', { name: 'Choisir au hasard', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(cell).toHaveText(entry.details.name);
  await cell.click();
  await expect(page.locator('.recipe-text')).toHaveText(steps);
  expect(generationCalls).toBe(0);
  await page.getByRole('button', { name: 'Fermer', exact: true }).click();
  await openLibrary(page);
  await expect(page.locator('.recipe-card')).toHaveCount(1);
});

test('recette personnelle : formulaire lisible en 320 px et thème sombre', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 740 });
  await page.goto('/');
  await expect(page.locator('.connection-indicator')).toHaveText('Carnet à jour');
  await openLibrary(page);
  await fillRecipe(page, 'Ma recette sur téléphone');
  for (const theme of ['light', 'dark']) {
    await page.locator('html').evaluate((element, value) => element.setAttribute('data-theme', value), theme);
    const geometry = await page.getByRole('dialog').evaluate(element => ({
      width: element.getBoundingClientRect().width, viewport: innerWidth, pageWidth: document.documentElement.scrollWidth,
      overflow: element.scrollWidth > element.clientWidth,
    }));
    expect(geometry.width).toBeLessThanOrEqual(geometry.viewport);
    expect(geometry.pageWidth).toBeLessThanOrEqual(geometry.viewport);
    expect(geometry.overflow).toBe(false);
    await expect(page.getByLabel('Titre de votre recette')).toBeVisible();
    await page.getByRole('button', { name: 'Ajouter au carnet' }).scrollIntoViewIfNeeded();
    await expect(page.getByRole('button', { name: 'Ajouter au carnet' })).toBeVisible();
  }
});
