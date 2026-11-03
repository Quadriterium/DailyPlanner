import { test, expect, type Page } from '@playwright/test';
import { parisDate, settingsSchema, type RecordData } from '../shared/model';
import { dish, details, snapshot } from '../tests/fixtures';

const today = parisDate();
const veggie = dish({ name: 'Omelette végétarienne', details: {
  ...details, name: 'Omelette végétarienne', ingredients: ['Œufs', 'Courge'], vegetarian: true,
} });
const meat = dish({ name: 'Poulet rôti', details: { ...details, name: 'Poulet rôti', vegetarian: false } });
const unknown = dish({ name: 'Ancien gratin', details: { ...details, name: 'Ancien gratin' } });

function slot(page: Page, time = 'lunch') {
  return page.locator(`[data-date="${today}"] .meal-slot`).nth(time === 'lunch' ? 0 : 1);
}
async function settings(page: Page) {
  await page.getByRole('button', { name: 'Paramètres', exact: true }).click();
}
async function planner(page: Page) {
  await page.getByRole('button', { name: 'Mon planning', exact: true }).click();
}
test.beforeEach(async ({ page }) => {
  const records = new Map<string, RecordData>([veggie, meat, unknown, settingsSchema.parse({
    type: 'settings', id: 'global', model: 'gpt-6-luna', modifiedAt: 1, mutationId: crypto.randomUUID(),
  })].map(record => [`${record.type}:${record.id}`, record]));
  await page.route('**/api/sync', async route => {
    for (const record of route.request().postDataJSON().mutations as RecordData[]) records.set(`${record.type}:${record.id}`, record);
    await route.fulfill({ json: snapshot([...records.values()]) });
  });
  await page.route('**/api/catalog?*', route => route.fulfill({
    json: { catalogId: '00000000-0000-4000-8000-000000000001', cursor: 0, more: false, entries: [], removed: [] },
  }));
  await page.goto('/');
  await expect(page.locator('.connection-indicator')).toHaveText('Carnet à jour');
});

test('végétarien : paramètres persistants, suggestions et tirage midi/soir cohérents', async ({ page }) => {
  await settings(page);
  await page.getByRole('checkbox', { name: 'Repas du soir végétariens', exact: true }).check();
  await expect(page.getByRole('status', { name: '' }).filter({ hasText: 'Préférences végétariennes enregistrées.' })).toBeVisible();
  await page.reload();
  await settings(page);
  await expect(page.getByRole('checkbox', { name: 'Repas du soir végétariens', exact: true })).toBeChecked();
  await planner(page);
  await slot(page).locator('.meal-cell').click();
  await expect(page.getByRole('button', { name: /Poulet rôti/ })).toBeVisible();
  await expect(page.getByRole('button', { name: /Ancien gratin/ })).toBeVisible();
  await page.keyboard.press('Escape');
  await slot(page, 'dinner').locator('.meal-cell').click();
  await expect(page.getByRole('button', { name: /Poulet rôti/ })).toHaveCount(0);
  await expect(page.getByRole('button', { name: /Ancien gratin/ })).toHaveCount(0);
  await page.getByRole('combobox').fill('Poulet');
  await expect(page.getByRole('option')).toHaveCount(0);
  await page.getByRole('button', { name: 'Choisir au hasard', exact: true }).click({ delay: 800 });
  const randomMenu = page.getByRole('dialog', { name: 'Choisir au hasard', exact: true });
  await expect(randomMenu.getByRole('button', { name: /Popote du quotidien/ })).toContainText('1 plat de saison');
  await randomMenu.getByRole('button', { name: /Popote du quotidien/ }).click();
  await expect(slot(page, 'dinner').locator('.meal-cell')).toHaveText(veggie.name);
  await settings(page);
  await page.getByRole('checkbox', { name: 'Je suis végétarien', exact: true }).check();
  await expect(page.getByRole('checkbox', { name: 'Repas du soir végétariens', exact: true })).toBeDisabled();
  await planner(page);
  await slot(page).locator('.meal-cell').click();
  await expect(page.getByRole('button', { name: /Poulet rôti/ })).toHaveCount(0);
  await page.getByRole('button', { name: 'Choisir au hasard', exact: true }).click();
  await expect(slot(page).locator('.meal-cell')).toHaveText(veggie.name);
});

test('végétarien : case ponctuelle cochable/décochable, clic court et contrainte des paramètres', async ({ page }) => {
  const requests: { slot: string; vegetarian: boolean; level: number }[] = [];
  await page.route('**/api/meals/generate', async route => {
    const body = route.request().postDataJSON();
    requests.push(body);
    await route.fulfill({ json: { details: { ...veggie.details, name: `Idée ${requests.length}`, level: body.level } } });
  });
  const quick = slot(page).getByRole('button', { name: /générer/ });
  await quick.click({ delay: 800 });
  let menu = page.getByRole('dialog', { name: 'Générer avec l’IA', exact: true });
  const checkbox = menu.getByRole('checkbox', { name: 'Menu végétarien', exact: true });
  await expect(checkbox).not.toBeChecked();
  await checkbox.check();
  await checkbox.uncheck();
  await checkbox.check();
  await menu.getByRole('button', { name: /Toque affûtée/ }).click();
  await expect(slot(page).locator('.meal-cell')).toHaveText('Idée 1');
  await slot(page, 'dinner').getByRole('button', { name: /générer/ }).click();
  await expect(slot(page, 'dinner').locator('.meal-cell')).toHaveText('Idée 2');
  expect(requests.map(({ slot, vegetarian, level }) => ({ slot, vegetarian, level }))).toEqual([
    { slot: 'lunch', vegetarian: true, level: 3 }, { slot: 'dinner', vegetarian: false, level: 2 },
  ]);
  await settings(page);
  await expect(page.getByRole('checkbox', { name: 'Je suis végétarien', exact: true })).not.toBeChecked();
  await page.getByRole('checkbox', { name: 'Repas du soir végétariens', exact: true }).check();
  await planner(page);
  await slot(page, 'dinner').locator('.meal-cell').click();
  await page.getByRole('button', { name: 'Modifier le repas', exact: true }).click();
  await page.getByRole('button', { name: 'Générer un nouveau plat', exact: true }).click({ delay: 800 });
  menu = page.getByRole('dialog', { name: 'Générer un nouveau plat', exact: true });
  await expect(menu.getByRole('checkbox', { name: 'Menu végétarien', exact: true })).toBeChecked();
  await expect(menu.getByRole('checkbox', { name: 'Menu végétarien', exact: true })).toBeDisabled();
  await menu.getByRole('button', { name: /Popote du quotidien/ }).click();
  await expect(slot(page, 'dinner').locator('.meal-cell')).toHaveText('Idée 3');
  expect(requests[2]).toMatchObject({ slot: 'dinner', vegetarian: true });
});

test('végétarien : classer une ancienne fiche dans le carnet', async ({ page }) => {
  await page.getByRole('button', { name: 'Mon carnet', exact: true }).click();
  await page.getByRole('button', { name: /Ancien gratin/ }).click();
  const editor = page.getByRole('dialog', { name: 'Une page du carnet' });
  await expect(editor).toContainText('pas encore classée');
  await editor.getByRole('checkbox', { name: 'Recette végétarienne', exact: true }).check();
  await editor.getByRole('button', { name: 'Enregistrer la fiche', exact: true }).click();
  await settings(page);
  await page.getByRole('checkbox', { name: 'Je suis végétarien', exact: true }).check();
  await planner(page);
  await slot(page).locator('.meal-cell').click();
  await expect(page.getByRole('button', { name: /Ancien gratin/ })).toBeVisible();
  await expect(page.getByRole('button', { name: /Poulet rôti/ })).toHaveCount(0);
});

test('végétarien : préférence et tirage conservés hors ligne', async ({ page }) => {
  await settings(page);
  await page.getByRole('checkbox', { name: 'Je suis végétarien', exact: true }).check();
  await expect(page.getByRole('status').filter({ hasText: 'Préférences végétariennes enregistrées.' })).toBeVisible();
  await expect(page.locator('.connection-indicator')).toHaveText('Carnet à jour');
  await page.route('**/api/sync', route => route.abort());
  await page.reload();
  await slot(page).locator('.meal-cell').click();
  await expect(page.getByRole('button', { name: /Poulet rôti/ })).toHaveCount(0);
  await page.getByRole('button', { name: 'Choisir au hasard', exact: true }).click();
  await expect(slot(page).locator('.meal-cell')).toHaveText(veggie.name);
});

test('végétarien : réponse incompatible refusée sans remplacer le repas', async ({ page }) => {
  await settings(page);
  await page.getByRole('checkbox', { name: 'Je suis végétarien', exact: true }).check();
  await expect(page.getByRole('status').filter({ hasText: 'Préférences végétariennes enregistrées.' })).toBeVisible();
  await planner(page);
  await slot(page).locator('.meal-cell').click();
  await page.getByRole('button', { name: 'Choisir au hasard', exact: true }).click();
  await expect(slot(page).locator('.meal-cell')).toHaveText(veggie.name);
  await page.route('**/api/meals/generate', async route => {
    expect(route.request().postDataJSON()).toMatchObject({ slot: 'lunch', vegetarian: true });
    await route.fulfill({ json: { details: meat.details } });
  });
  await slot(page).locator('.meal-cell').click();
  await page.getByRole('button', { name: 'Modifier le repas', exact: true }).click();
  await page.getByRole('button', { name: 'Générer un nouveau plat', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('pas classée végétarienne');
  await expect(slot(page).locator('.meal-cell')).toHaveText(veggie.name);
});
