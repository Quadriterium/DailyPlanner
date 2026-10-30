import { test, expect, type Page, type Route } from '@playwright/test';
import { addDays, parisDate, seasonForDate, type RecordData } from '../shared/model';
import { details, dish, meal, snapshot } from '../tests/fixtures';

const today = parisDate();
const unused = dish({ name: 'Gratin de saison', details: { ...details, name: 'Gratin de saison' } });
const used = dish({ name: 'Soupe de saison', details: { ...details, name: 'Soupe de saison' } });

function slot(page: Page, date = today, time = 'lunch') {
  return page.locator(`[data-date="${date}"] .meal-slot`).nth(time === 'lunch' ? 0 : 1);
}

test.beforeEach(async ({ page }, testInfo) => {
  const initial = testInfo.title.includes('carnet vide') ? [] : [unused, used, meal({
    id: `${addDays(today, 6)}:dinner`, date: addDays(today, 6), slot: 'dinner', text: used.name, dishId: used.id,
  })];
  const records = new Map<string, RecordData>(initial.map(record => [`${record.type}:${record.id}`, record]));
  await page.route('**/api/sync', async route => {
    const body = route.request().postDataJSON() as { mutations: RecordData[] };
    for (const record of body.mutations) records.set(`${record.type}:${record.id}`, record);
    await route.fulfill({ json: snapshot([...records.values()]) });
  });
  await page.goto('/');
  await expect(page.locator('.connection-indicator')).toHaveText('Carnet à jour');
});

test('tirage rapide sans doublon sur les sept jours affichés, puis repli et sauvegarde hors ligne', async ({ page }) => {
  await slot(page).getByRole('button', { name: /piocher/ }).click();
  await expect(slot(page).locator('.meal-cell')).toHaveText(unused.name);
  await expect(slot(page).locator('.meal-quick-actions')).toHaveCount(0);
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.route('**/api/sync', route => route.abort());
  await slot(page, today, 'dinner').getByRole('button', { name: /piocher/ }).click();
  await expect(slot(page, today, 'dinner').locator('.meal-cell')).toHaveText(/Gratin de saison|Soupe de saison/);
  await page.reload();
  await expect(slot(page).locator('.meal-cell')).toHaveText(unused.name);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test('génération rapide IA avec attente, sauvegarde de la fiche et rechargement', async ({ page }) => {
  const generated = { ...details, name: 'Poêlée surprise', seasons: [seasonForDate(today)] };
  await page.route('**/api/meals/generate', async route => {
    expect(route.request().postDataJSON()).toEqual({ date: today });
    await new Promise(resolve => setTimeout(resolve, 300));
    await route.fulfill({ json: { details: generated } });
  });
  await slot(page).getByRole('button', { name: /générer/ }).click();
  await expect(slot(page).locator('.meal-cell')).toBeDisabled();
  await expect(slot(page).locator('.meal-cell')).toHaveText(generated.name);
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.reload();
  await expect(slot(page).locator('.meal-cell')).toHaveText(generated.name);
  await page.getByRole('button', { name: 'Mon carnet', exact: true }).click();
  await expect(page.getByRole('button', { name: new RegExp(generated.name) })).toBeVisible();
});

test('la génération attend l’envoi des choix locaux et du modèle au serveur', async ({ page }) => {
  const offline = (route: Route) => route.abort();
  await page.route('**/api/sync', offline);
  await page.getByRole('button', { name: 'Paramètres', exact: true }).click();
  await page.getByRole('radio', { name: 'gpt-5.6-terra', exact: true }).check();
  await expect(page.locator('.connection-indicator')).toContainText('Hors ligne');
  await page.getByRole('button', { name: 'Mon planning', exact: true }).click();
  await slot(page, today, 'dinner').locator('.meal-cell').click();
  await page.getByLabel('Votre idée du jour', { exact: true }).fill('Repas local en attente');
  await page.getByRole('button', { name: 'Garder ce repas' }).click();
  await expect(slot(page, today, 'dinner').locator('.meal-cell')).toHaveText('Repas local en attente');
  await expect(page.locator('.connection-indicator')).toContainText('Hors ligne');
  await page.unroute('**/api/sync', offline);
  let sent: RecordData[] = [];
  page.on('request', request => {
    if (request.url().endsWith('/api/sync')) sent = (request.postDataJSON() as { mutations: RecordData[] }).mutations;
  });
  await page.route('**/api/meals/generate', async route => {
    expect(sent.some(record => record.type === 'meal' && record.text === 'Repas local en attente')).toBe(true);
    expect(sent.some(record => record.type === 'dish' && record.name === 'Repas local en attente')).toBe(true);
    expect(sent.some(record => record.type === 'settings' && record.model === 'gpt-5.6-terra')).toBe(true);
    await route.fulfill({ json: { details: { ...details, name: 'Nouvelle idée après synchronisation', seasons: [seasonForDate(today)] } } });
  });
  await slot(page).getByRole('button', { name: /générer/ }).click();
  await expect(slot(page).locator('.meal-cell')).toHaveText('Nouvelle idée après synchronisation');
});

test('la génération ne démarre pas si le contexte ne peut pas être synchronisé', async ({ page }) => {
  let calls = 0;
  await page.route('**/api/sync', route => route.abort());
  await page.route('**/api/meals/generate', route => { calls++; return route.abort(); });
  await slot(page).getByRole('button', { name: /générer/ }).click();
  await expect(page.getByRole('dialog')).toContainText('Serveur inaccessible');
  expect(calls).toBe(0);
});

test('erreur IA visible et créneau inchangé', async ({ page }) => {
  await page.route('**/api/meals/generate', route => route.fulfill({ status: 409, json: { error: 'Quota IA atteint.' } }));
  await slot(page).getByRole('button', { name: /générer/ }).click();
  await expect(page.getByRole('dialog')).toContainText('Quota IA atteint');
  await page.getByRole('button', { name: 'Fermer', exact: true }).click();
  await expect(slot(page).locator('.meal-cell')).toContainText('À imaginer');
  await expect(slot(page).getByRole('button', { name: /générer/ })).toBeEnabled();
});

test('carnet vide : explication et boutons accessibles sur petit écran', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 568 });
  const contained = await slot(page).evaluate(element => {
    const bounds = element.getBoundingClientRect();
    return [...element.querySelectorAll('button')].every(button => {
      const box = button.getBoundingClientRect();
      return box.top >= bounds.top && box.bottom <= bounds.bottom && box.left >= bounds.left && box.right <= bounds.right;
    });
  });
  expect(contained).toBe(true);
  await slot(page).getByRole('button', { name: /piocher/ }).click();
  await expect(page.getByRole('dialog')).toContainText('Aucun repas de saison');
  await page.getByRole('button', { name: 'Fermer', exact: true }).click();
  await expect(slot(page).locator('.meal-cell')).toContainText('À imaginer');
});

test('une génération en cours ne remplace pas un choix fait dans un autre onglet', async ({ page, context }) => {
  let pending: Route | undefined;
  await page.route('**/api/meals/generate', route => { pending = route; });
  await slot(page).getByRole('button', { name: /générer/ }).click();
  await expect.poll(() => Boolean(pending)).toBe(true);
  const other = await context.newPage();
  await other.route('**/api/sync', route => route.abort());
  await other.goto('/');
  await slot(other).locator('.meal-cell').click();
  await other.getByLabel('Votre idée du jour', { exact: true }).fill('Mon choix manuel');
  await other.getByRole('button', { name: 'Garder ce repas' }).click();
  await expect(slot(other).locator('.meal-cell')).toHaveText('Mon choix manuel');
  await pending!.fulfill({ json: { details: { ...details, name: 'Idée IA devenue obsolète' } } });
  await expect(page.getByRole('dialog')).toContainText('modifié pendant la génération');
  await page.getByRole('button', { name: 'Fermer', exact: true }).click();
  await expect(slot(page).locator('.meal-cell')).toHaveText('Mon choix manuel');
  await other.close();
});
