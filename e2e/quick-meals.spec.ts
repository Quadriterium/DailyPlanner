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

test('paramètres : compteurs IA sans plafond applicatif', async ({ page }) => {
  await page.getByRole('button', { name: 'Paramètres', exact: true }).click();
  for (const label of ['Appels IA aujourd’hui', 'Appels IA ce mois-ci']) {
    await expect(page.locator('dl > div').filter({ has: page.getByText(label, { exact: true }) }).locator('dd')).toHaveText('0');
  }
  await expect(page.getByText('L’application ne limite pas le nombre d’appels IA.', { exact: false })).toBeVisible();
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

test('repas choisi : recette, modification du nom et suppression sans effacer la fiche', async ({ page }) => {
  await slot(page).getByRole('button', { name: /piocher/ }).click();
  await slot(page).locator('.meal-cell').click();
  const dialog = page.getByRole('dialog', { name: 'Votre repas', exact: true });
  await expect(dialog.getByRole('heading', { name: unused.name, exact: true })).toBeVisible();
  await expect(dialog.getByRole('region', { name: 'Recette du repas' })).toContainText(details.recipe);
  for (const ingredient of details.ingredients) await expect(dialog.getByRole('list')).toContainText(ingredient);
  expect(await dialog.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
  await dialog.getByRole('button', { name: 'Modifier le repas', exact: true }).click();
  await page.getByLabel('Votre idée du jour', { exact: true }).fill('Mon repas renommé');
  await page.getByRole('button', { name: 'Garder ce repas' }).click();
  await expect(slot(page).locator('.meal-cell')).toHaveText('Mon repas renommé');
  await page.reload();
  await slot(page).locator('.meal-cell').click();
  await expect(page.getByRole('dialog')).toContainText('La recette n’est pas encore disponible');
  await page.getByRole('button', { name: 'Vider', exact: true }).click();
  await expect(slot(page).locator('.meal-cell')).toContainText('À imaginer');
  await page.getByRole('button', { name: 'Mon carnet', exact: true }).click();
  await expect(page.getByRole('button', { name: /Mon repas renommé/ })).toBeVisible();
});

test('repas choisi : remplacement au hasard hors ligne et conservation au rechargement', async ({ page }) => {
  await slot(page).getByRole('button', { name: /piocher/ }).click();
  await page.route('**/api/sync', route => route.abort());
  await slot(page).locator('.meal-cell').click();
  await page.getByRole('button', { name: 'Choisir au hasard', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(slot(page).locator('.meal-cell')).toHaveText(/Gratin de saison|Soupe de saison/);
  const chosen = await slot(page).locator('.meal-cell').textContent();
  await page.reload();
  await expect(slot(page).locator('.meal-cell')).toHaveText(chosen!);
});

test('repas choisi : proposition IA, attente et recette persistante', async ({ page }) => {
  await slot(page).getByRole('button', { name: /piocher/ }).click();
  let pending: Route | undefined;
  await page.route('**/api/meals/generate', route => { pending = route; });
  await slot(page).locator('.meal-cell').click();
  await page.getByRole('button', { name: 'Demander une proposition à l’IA', exact: true }).click();
  await expect.poll(() => Boolean(pending)).toBe(true);
  await expect(page.getByRole('button', { name: 'Proposition en cours…', exact: true })).toBeDisabled();
  await expect(slot(page).locator('.meal-cell')).toHaveText(unused.name);
  await pending!.fulfill({ json: { details: { ...details, name: 'Nouvelle proposition' } } });
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(slot(page).locator('.meal-cell')).toHaveText('Nouvelle proposition');
  await page.reload();
  await slot(page).locator('.meal-cell').click();
  await expect(page.getByRole('region', { name: 'Recette du repas' })).toContainText(details.recipe);
});

test('repas choisi : erreur IA sans perte du repas ni de la recette', async ({ page }) => {
  await slot(page).getByRole('button', { name: /piocher/ }).click();
  await page.route('**/api/meals/generate', route => route.fulfill({ status: 502, json: { error: 'Service IA indisponible.' } }));
  await slot(page).locator('.meal-cell').click();
  await page.getByRole('button', { name: 'Demander une proposition à l’IA', exact: true }).click();
  await expect(page.getByRole('dialog').getByRole('alert')).toHaveText('Service IA indisponible.');
  await expect(page.getByRole('region', { name: 'Recette du repas' })).toContainText(details.recipe);
  await expect(page.getByRole('button', { name: 'Choisir au hasard', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: 'Fermer', exact: true }).click();
  await page.reload();
  await expect(slot(page).locator('.meal-cell')).toHaveText(unused.name);
});

test('repas choisi : une proposition IA ne remplace pas une modification dans un autre onglet', async ({ page, context }) => {
  await slot(page).getByRole('button', { name: /piocher/ }).click();
  let pending: Route | undefined;
  await page.route('**/api/meals/generate', route => { pending = route; });
  await slot(page).locator('.meal-cell').click();
  await page.getByRole('button', { name: 'Demander une proposition à l’IA', exact: true }).click();
  await expect.poll(() => Boolean(pending)).toBe(true);
  const other = await context.newPage();
  await other.route('**/api/sync', route => route.abort());
  await other.goto('/');
  await slot(other).locator('.meal-cell').click();
  await other.getByRole('button', { name: 'Modifier le repas', exact: true }).click();
  await other.getByLabel('Votre idée du jour', { exact: true }).fill('Un autre choix');
  await other.getByRole('button', { name: 'Garder ce repas' }).click();
  await expect(slot(other).locator('.meal-cell')).toHaveText('Un autre choix');
  await pending!.fulfill({ json: { details: { ...details, name: 'Proposition obsolète' } } });
  await expect(page.getByRole('dialog').getByRole('alert')).toContainText('modifié pendant la génération');
  await page.getByRole('button', { name: 'Fermer', exact: true }).click();
  await expect(slot(page).locator('.meal-cell')).toHaveText('Un autre choix');
  await other.close();
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

test('créneau vide : tirage et génération IA depuis le dialogue', async ({ page }) => {
  await slot(page).locator('.meal-cell').click();
  await page.getByRole('dialog').getByRole('button', { name: 'Choisir au hasard', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(slot(page).locator('.meal-cell')).toHaveText(unused.name);
  const generated = { ...details, name: 'Velouté du dialogue', seasons: [seasonForDate(today)] };
  let pending: Route | undefined;
  await page.route('**/api/meals/generate', route => { pending = route; });
  await slot(page, today, 'dinner').locator('.meal-cell').click();
  await page.getByRole('dialog').getByRole('button', { name: 'Générer avec l’IA', exact: true }).click();
  await expect.poll(() => Boolean(pending)).toBe(true);
  await expect(page.getByRole('button', { name: 'Proposition en cours…', exact: true })).toBeDisabled();
  await pending!.fulfill({ json: { details: generated } });
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(slot(page, today, 'dinner').locator('.meal-cell')).toHaveText(generated.name);
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
  await page.route('**/api/meals/generate', route => route.fulfill({ status: 502, json: { error: 'Service IA indisponible.' } }));
  await slot(page).getByRole('button', { name: /générer/ }).click();
  await expect(page.getByRole('dialog')).toContainText('Service IA indisponible');
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
