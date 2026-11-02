import { test, expect, type BrowserContext, type Locator, type Page, type Route } from '@playwright/test';
import { addDays, householdSummary, mealId, parisDate, type Household, type RecordData } from '../shared/model';
import { details, dish, meal, snapshot } from '../tests/fixtures';

const today = parisDate();
const household = { adults: 2, teenagers: 1, children: 3 };
const custom = { adults: 2, teenagers: 0, children: 0 };
const recipe = dish({ name: 'Poulet-frites', details });
const cell = (page: Page, slot = 'lunch') => page.locator(`[data-date="${today}"] .meal-cell`).nth(slot === 'lunch' ? 0 : 1);
const guests = (page: Page) => page.getByRole('region', { name: 'Convives du repas' });

async function setup(page: Page, context: BrowserContext, extra: RecordData[] = []) {
  const records = new Map<string, RecordData>();
  for (const record of [
    recipe,
    meal({ id: `${today}:lunch`, date: today, text: recipe.name, dishId: recipe.id }),
    meal({ id: `${today}:dinner`, date: today, slot: 'dinner', text: recipe.name, dishId: recipe.id }),
    { type: 'settings' as const, id: 'global' as const, model: 'gpt-6-luna', household, avoid: '',
      modifiedAt: Date.now(), mutationId: crypto.randomUUID() },
    ...extra,
  ]) records.set(`${record.type}:${record.id}`, record);
  await context.route('**/api/sync', async route => {
    const body = route.request().postDataJSON() as { mutations: RecordData[] };
    for (const record of body.mutations) records.set(`${record.type}:${record.id}`, record);
    await route.fulfill({ json: snapshot([...records.values()]) });
  });
  await page.goto('/');
  await expect(page.locator('.connection-indicator')).toHaveText('Carnet à jour');
  return records;
}

async function editGuests(page: Page) {
  await guests(page).getByRole('button', { name: /Adapter/ }).click();
  await expect(guests(page).getByRole('checkbox')).toBeFocused();
}

async function fillGuests(page: Page, value: Household) {
  await guests(page).getByRole('checkbox').uncheck();
  await guests(page).getByLabel('Adultes', { exact: true }).fill(String(value.adults));
  await guests(page).getByLabel('Adolescents', { exact: true }).fill(String(value.teenagers));
  await guests(page).getByLabel('Enfants', { exact: true }).fill(String(value.children));
}

async function saveGuests(page: Page) {
  await guests(page).getByRole('button', { name: 'Enregistrer les convives' }).click();
  await expect(guests(page).getByRole('status')).toHaveText('Convives enregistrés pour ce repas.');
  await expect(guests(page).getByRole('button', { name: /Adapter/ })).toBeFocused();
}

async function prepareOffline(page: Page) {
  await page.evaluate(() => navigator.serviceWorker.ready.then(() => true));
  await page.reload();
  await expect.poll(() => page.evaluate(() => Boolean(navigator.serviceWorker.controller))).toBe(true);
}

async function syncNow(page: Page) {
  await page.getByRole('button', { name: 'Paramètres', exact: true }).click();
  await page.getByRole('button', { name: 'Synchroniser', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Tout est à jour' })).toBeVisible();
  await page.getByRole('button', { name: 'Compris', exact: true }).click();
  await page.getByRole('button', { name: 'Mon planning', exact: true }).click();
}

async function addDish(page: Page, slot: Locator) {
  const shortcut = slot.getByRole('button', { name: /ajouter un deuxième plat/ });
  if (await shortcut.isVisible()) await shortcut.click();
  else {
    await slot.locator('.meal-cell').click();
    await page.getByRole('dialog').getByRole('button', { name: 'Ajouter un deuxième plat', exact: true }).click();
  }
}

test('convives : valeurs du foyer, personnalisation locale, annulation et retour aux paramètres', async ({ page, context }) => {
  const records = await setup(page, context);
  await cell(page).click();
  await expect(guests(page)).toContainText(householdSummary(household));
  await expect(guests(page)).toContainText('Selon vos paramètres');
  await editGuests(page);
  await fillGuests(page, custom);
  await guests(page).getByRole('button', { name: 'Annuler' }).click();
  await expect(guests(page)).toContainText(householdSummary(household));
  await editGuests(page);
  await fillGuests(page, custom);
  await saveGuests(page);
  await expect(guests(page)).toContainText('Personnalisé');
  await expect(guests(page)).toContainText('2 adultes');
  await expect(page.getByRole('region', { name: 'Recette du repas' })).toContainText('ne sont pas recalculées');
  await page.getByRole('button', { name: 'Fermer', exact: true }).click();
  await expect(cell(page)).toHaveAccessibleName(/convives personnalisés : 2 adultes/);
  await expect(cell(page).locator('.meal-guests-marker')).toHaveCount(1);
  await expect(cell(page, 'dinner').locator('.meal-guests-marker')).toHaveCount(0);
  await expect(page.locator('.connection-indicator')).toHaveText('Carnet à jour');
  expect(records.get('settings:global')).toMatchObject({ household });
  expect(records.get(`meal:${today}:dinner`)).not.toHaveProperty('household');
  expect(records.get(`dish:${recipe.id}`)).toEqual(recipe);
  await page.reload();
  await cell(page).click();
  await expect(guests(page)).toContainText('2 adultes');
  await editGuests(page);
  await guests(page).getByRole('checkbox').check();
  await saveGuests(page);
  await expect(guests(page)).toContainText(householdSummary(household));
  await expect(guests(page)).toContainText('Selon vos paramètres');
  await page.getByRole('button', { name: 'Fermer', exact: true }).click();
  await expect(cell(page).locator('.meal-guests-marker')).toHaveCount(0);
  await expect(page.locator('.connection-indicator')).toHaveText('Carnet à jour');
  expect(records.get(`meal:${today}:lunch`)).toMatchObject({ household: null });
  const changed = { adults: 1, teenagers: 2, children: 0 };
  const settings = records.get('settings:global');
  if (settings?.type !== 'settings') throw new Error('Paramètres attendus');
  records.set('settings:global', { ...settings, household: changed, modifiedAt: settings.modifiedAt + 100, mutationId: crypto.randomUUID() });
  await page.reload();
  await expect(page.locator('.connection-indicator')).toHaveText('Carnet à jour');
  await cell(page).click();
  await expect(guests(page)).toContainText(householdSummary(changed));
});

test('convives : validation, compteurs tactiles et affichage sans débordement en clair et sombre', async ({ page, context }) => {
  await setup(page, context);
  await cell(page).click();
  await editGuests(page);
  await fillGuests(page, { adults: 0, teenagers: 0, children: 0 });
  const adult = guests(page).getByLabel('Adultes', { exact: true });
  const save = guests(page).getByRole('button', { name: 'Enregistrer les convives' });
  await expect(guests(page).getByRole('button', { name: 'Retirer un adulte' })).toBeDisabled();
  await save.click();
  await expect(guests(page).getByRole('alert')).toContainText('au moins une personne');
  for (const value of ['', '21', '1.5', '-1']) {
    await adult.fill(value);
    await save.click();
    await expect(guests(page).getByRole('alert')).toContainText('entre 0 et 20');
  }
  await adult.fill('20');
  await expect(guests(page).getByRole('button', { name: 'Ajouter un adulte' })).toBeDisabled();
  await adult.fill('1');
  await guests(page).getByRole('button', { name: 'Ajouter un adulte' }).click();
  await expect(adult).toHaveValue('2');
  await guests(page).getByRole('button', { name: 'Retirer un adulte' }).click();
  await expect(adult).toHaveValue('1');
  for (const theme of ['light', 'dark']) {
    await page.evaluate(value => { document.documentElement.dataset.theme = value; }, theme);
    const bounds = await guests(page).evaluate(element => {
      const dialog = element.closest('dialog')!;
      return {
        overflow: dialog.scrollWidth > dialog.clientWidth,
        pageOverflow: document.documentElement.scrollWidth > innerWidth,
        targets: [...element.querySelectorAll('.meal-guest-stepper button')].map(button => {
          const rect = button.getBoundingClientRect();
          return { width: rect.width, height: rect.height };
        }),
      };
    });
    expect(bounds.overflow).toBe(false);
    expect(bounds.pageOverflow).toBe(false);
    for (const target of bounds.targets) {
      expect(target.width).toBeGreaterThanOrEqual(44);
      expect(target.height).toBeGreaterThanOrEqual(44);
    }
    await page.screenshot({ path: test.info().outputPath(`convives-${theme}.png`) });
  }
  await saveGuests(page);
  await expect(guests(page)).toContainText('1 adulte');
});

test('convives : serveur inaccessible, remplacement du plat et remise à zéro après vidage', async ({ page, context }) => {
  await setup(page, context);
  const unavailable = (route: Route) => route.abort('connectionrefused');
  await context.route('**/api/sync', unavailable);
  await cell(page).click();
  await editGuests(page);
  await fillGuests(page, custom);
  await saveGuests(page);
  await page.getByRole('button', { name: 'Fermer', exact: true }).click();
  await page.reload();
  await cell(page).click();
  await expect(guests(page)).toContainText('2 adultes');
  await page.getByRole('button', { name: 'Modifier le repas', exact: true }).click();
  await page.getByLabel('Votre idée du jour', { exact: true }).fill('Mon autre plat');
  await page.getByRole('button', { name: 'Créer le repas' }).click();
  await cell(page).click();
  await expect(guests(page)).toContainText('2 adultes');
  await page.getByRole('button', { name: 'Choisir au hasard', exact: true }).click();
  await cell(page).click();
  await expect(guests(page)).toContainText('2 adultes');
  await page.getByRole('button', { name: 'Vider', exact: true }).click();
  await cell(page).click();
  await page.getByLabel('Votre idée du jour', { exact: true }).fill(recipe.name);
  await page.getByRole('button', { name: 'Créer le repas' }).click();
  await cell(page).click();
  await expect(guests(page)).toContainText(householdSummary(household));
  await expect(guests(page)).toContainText('Selon vos paramètres');
  await page.getByRole('button', { name: 'Fermer', exact: true }).click();
  await context.unroute('**/api/sync', unavailable);
  await syncNow(page);
  await expect(page.locator('.connection-indicator')).toHaveText('Carnet à jour');
});

test('convives : une modification dans un autre onglet ne se fait pas écraser', async ({ page, context }) => {
  await setup(page, context);
  await cell(page).click();
  await editGuests(page);
  await fillGuests(page, custom);
  const other = await context.newPage();
  await other.goto('/');
  await cell(other).click();
  await other.getByRole('button', { name: 'Modifier le repas', exact: true }).click();
  await other.getByLabel('Votre idée du jour', { exact: true }).fill('Repas modifié ailleurs');
  await other.getByRole('button', { name: 'Créer le repas' }).click();
  await guests(page).getByRole('button', { name: 'Enregistrer les convives' }).click();
  await expect(guests(page).getByRole('alert')).toContainText('Ce créneau a été modifié');
  await expect(cell(page)).toHaveText('Repas modifié ailleurs');
  await guests(page).getByRole('button', { name: 'Annuler' }).click();
  await expect(guests(page)).toContainText(householdSummary(household));
});

test('deux plats : convives indépendants, case inchangée, choix rapide et vidage séparé', async ({ page, context }) => {
  const records = await setup(page, context);
  const slot = page.locator(`[data-date="${today}"] .meal-slot`).first();
  const first = slot.locator(`[data-meal-id="${mealId(today, 'lunch')}"]`);
  const second = slot.locator(`[data-meal-id="${mealId(today, 'lunch', 1)}"]`);
  const height = await page.locator('.is-today').evaluate(element => element.getBoundingClientRect().height);
  await first.click();
  await editGuests(page);
  await fillGuests(page, custom);
  await saveGuests(page);
  await page.getByRole('button', { name: 'Fermer', exact: true }).click();
  await addDish(page, slot);
  await expect(page.getByRole('dialog')).toContainText('Deuxième plat');
  await page.getByLabel('Votre idée du jour', { exact: true }).fill('Soupe de courge');
  await page.getByRole('button', { name: 'Créer le repas' }).click();
  await expect(slot.locator('.meal-cell')).toHaveCount(2);
  await expect(slot.getByRole('button', { name: /ajouter un deuxième plat/ })).toHaveCount(0);
  await second.click();
  await expect(page.getByRole('dialog').getByRole('button', { name: 'Ajouter un deuxième plat', exact: true })).toHaveCount(0);
  await expect(guests(page)).toContainText(householdSummary(household));
  await editGuests(page);
  await fillGuests(page, { adults: 0, teenagers: 0, children: 3 });
  await saveGuests(page);
  await page.getByRole('button', { name: 'Fermer', exact: true }).click();
  await expect(first).toHaveAccessibleName(/convives personnalisés : 2 adultes/);
  await expect(second).toHaveAccessibleName(/convives personnalisés : 3 enfants/);
  expect(await page.locator('.is-today').evaluate(element => element.getBoundingClientRect().height)).toBe(height);
  const layout = await slot.evaluate(element => {
    const bounds = element.getBoundingClientRect();
    return [...element.querySelectorAll('.meal-cell')].map(cell => {
      const rect = cell.getBoundingClientRect();
      return rect.top >= bounds.top - 1 && rect.bottom <= bounds.bottom + 1 && cell.scrollWidth <= cell.clientWidth;
    });
  });
  expect(layout).toEqual([true, true]);
  await page.screenshot({ path: test.info().outputPath('deux-plats.png') });
  const viewport = page.viewportSize();
  await page.setViewportSize({ width: 320, height: 568 });
  const compact = await slot.evaluate(element => {
    const bounds = element.getBoundingClientRect();
    const row = element.closest('.day-row')!;
    return {
      rowHeight: row.getBoundingClientRect().height,
      otherRowHeight: row.nextElementSibling!.getBoundingClientRect().height,
      overflow: document.documentElement.scrollWidth > innerWidth,
      contained: [...element.querySelectorAll('.meal-cell')].every(cell =>
        cell.getBoundingClientRect().bottom <= bounds.bottom + 1 && cell.scrollWidth <= cell.clientWidth),
    };
  });
  expect(compact.rowHeight).toBe(compact.otherRowHeight);
  expect(compact.overflow).toBe(false);
  expect(compact.contained).toBe(true);
  if (viewport) await page.setViewportSize(viewport);
  await page.reload();
  await expect(first).toHaveAccessibleName(/convives personnalisés : 2 adultes/);
  await expect(second).toHaveAccessibleName(/convives personnalisés : 3 enfants/);
  await second.click();
  await page.getByRole('button', { name: 'Choisir au hasard', exact: true }).click();
  await expect(second).toHaveAccessibleName(/convives personnalisés : 3 enfants/);
  await expect(first).toHaveAccessibleName(/convives personnalisés : 2 adultes/);
  const secondName = await second.locator('.meal-name').innerText();
  await first.click();
  await page.getByRole('button', { name: 'Vider', exact: true }).click();
  await expect(slot.locator('.meal-cell')).toHaveCount(1);
  await expect(second).toHaveText(secondName);
  await addDish(page, slot);
  await page.getByLabel('Votre idée du jour', { exact: true }).fill('Filet mignon sauce champignon');
  await page.getByRole('button', { name: 'Créer le repas' }).click();
  await first.click();
  await expect(guests(page)).toContainText(householdSummary(household));
  await page.getByRole('button', { name: 'Fermer', exact: true }).click();
  await expect(page.locator('.connection-indicator')).toHaveText('Carnet à jour');
  expect(records.get(`meal:${mealId(today, 'lunch', 1)}`)).toMatchObject({ index: 1, household: { adults: 0, teenagers: 0, children: 3 } });
});

test('deux plats : partage réel entre appareils et convives conservés hors ligne', async ({ page, context, browser, baseURL }) => {
  const date = addDays(today, 3);
  const id = mealId(date, 'dinner');
  const secondId = mealId(date, 'dinner', 1);
  const slot = (target: Page) => target.locator(`[data-date="${date}"] .meal-slot`).nth(1);
  const first = (target: Page) => slot(target).locator(`[data-meal-id="${id}"]`);
  const second = (target: Page) => slot(target).locator(`[data-meal-id="${secondId}"]`);
  const otherContext = await browser.newContext({ baseURL, viewport: { width: 1024, height: 1366 } });
  try {
    await page.goto('/');
    await expect(page.locator('.connection-indicator')).toHaveText('Carnet à jour');
    await slot(page).locator('.meal-cell').click();
    const modify = page.getByRole('button', { name: 'Modifier le repas', exact: true });
    if (await modify.isVisible()) await modify.click();
    await page.getByLabel('Votre idée du jour', { exact: true }).fill('Filet mignon sauce champignon');
    await page.getByRole('button', { name: 'Créer le repas' }).click();
    await first(page).click();
    await editGuests(page);
    await fillGuests(page, custom);
    await saveGuests(page);
    await page.getByRole('button', { name: 'Fermer', exact: true }).click();
    await addDish(page, slot(page));
    await page.getByLabel('Votre idée du jour', { exact: true }).fill('Soupe de courge');
    await page.getByRole('button', { name: 'Créer le repas' }).click();
    await second(page).click();
    await editGuests(page);
    await fillGuests(page, { adults: 0, teenagers: 0, children: 2 });
    await saveGuests(page);
    await page.getByRole('button', { name: 'Fermer', exact: true }).click();
    await expect(page.locator('.connection-indicator')).toHaveText('Carnet à jour');
    const other = await otherContext.newPage();
    await other.goto('/');
    await expect(first(other)).toHaveAccessibleName(/convives personnalisés : 2 adultes/);
    await expect(second(other)).toHaveAccessibleName(/convives personnalisés : 2 enfants/);
    await prepareOffline(page);
    await context.setOffline(true);
    await second(page).click();
    await editGuests(page);
    await fillGuests(page, { adults: 0, teenagers: 1, children: 2 });
    await saveGuests(page);
    await page.getByRole('button', { name: 'Fermer', exact: true }).click();
    await page.reload();
    await expect(second(page)).toHaveAccessibleName(/convives personnalisés : 1 adolescent · 2 enfants/);
    await context.setOffline(false);
    await syncNow(page);
    await expect(page.locator('.connection-indicator')).toHaveText('Carnet à jour');
    await other.reload();
    await expect(second(other)).toHaveAccessibleName(/convives personnalisés : 1 adolescent · 2 enfants/);
    await expect(first(other)).toHaveAccessibleName(/convives personnalisés : 2 adultes/);
  } finally {
    await context.setOffline(false);
    await otherContext.close();
    await context.request.post('/api/sync', { data: { mutations: [
      meal({ id, date, slot: 'dinner', text: '', dishId: null, household: null, modifiedAt: Date.now() + 100 }),
      meal({ id: secondId, date, slot: 'dinner', index: 1, text: '', dishId: null, household: null, modifiedAt: Date.now() + 100 }),
    ] } });
  }
});

test('deux plats : génération IA du deuxième plat sans remplacer le premier', async ({ page, context }) => {
  const records = await setup(page, context);
  const slot = page.locator(`[data-date="${today}"] .meal-slot`).first();
  await page.route('**/api/meals/generate', route => route.fulfill({
    json: { details: { ...details, name: 'Soupe de courge générée' } },
  }));
  await addDish(page, slot);
  await page.getByRole('dialog').getByRole('button', { name: 'Générer avec l’IA', exact: true }).click();
  const second = slot.locator(`[data-meal-id="${mealId(today, 'lunch', 1)}"]`);
  await expect(second).toContainText('Soupe de courge générée');
  await expect(slot.locator(`[data-meal-id="${mealId(today, 'lunch')}"]`)).toContainText(recipe.name);
  await expect(page.locator('.connection-indicator')).toHaveText('Carnet à jour');
  expect(records.get(`meal:${mealId(today, 'lunch', 1)}`)).toMatchObject({ index: 1, household: null });
});

test('ajout adaptatif : nom pleine largeur sur téléphone, raccourci intégré et fiche sur grand écran', async ({ page, context }) => {
  await setup(page, context);
  const slot = page.locator(`[data-date="${today}"] .meal-slot`).first();
  const shortcut = slot.getByRole('button', { name: /ajouter un deuxième plat/ });
  const viewport = page.viewportSize();
  for (const width of [320, 520, 521, 1024]) {
    await page.setViewportSize({ width, height: 915 });
    if (width <= 520) await expect(shortcut).toBeHidden();
    else await expect(shortcut).toBeVisible();
    const layout = await slot.evaluate(element => {
      const bounds = element.getBoundingClientRect();
      const cell = element.querySelector('.meal-cell')!.getBoundingClientRect();
      const plus = element.querySelector('.meal-add-second')!;
      const plusBounds = plus.getBoundingClientRect();
      return {
        widthDifference: Math.abs(cell.width - bounds.width),
        horizontalOverflow: document.documentElement.scrollWidth > innerWidth,
        shortcutHidden: getComputedStyle(plus).display === 'none',
        shortcutInside: plusBounds.left >= cell.left && plusBounds.right <= cell.right &&
          plusBounds.top >= cell.top && plusBounds.bottom <= cell.bottom + 1,
        shortcutWidth: plusBounds.width,
      };
    });
    expect(layout.widthDifference).toBeLessThan(1);
    expect(layout.horizontalOverflow).toBe(false);
    if (width > 520) {
      expect(layout.shortcutInside).toBe(true);
      expect(layout.shortcutWidth).toBeGreaterThanOrEqual(44);
    } else expect(layout.shortcutHidden).toBe(true);
    await page.screenshot({ path: test.info().outputPath(`ajout-${width}.png`) });
  }
  if (viewport) await page.setViewportSize(viewport);
  await slot.locator('.meal-cell').click();
  const add = page.getByRole('dialog').getByRole('button', { name: 'Ajouter un deuxième plat', exact: true });
  await expect(add).toBeEnabled();
  await editGuests(page);
  await expect(add).toBeDisabled();
  await guests(page).getByRole('button', { name: 'Annuler' }).click();
  await add.click();
  await expect(page.getByRole('dialog')).toHaveCount(1);
  await expect(page.getByRole('dialog')).toContainText('Deuxième plat');
  await expect(page.getByLabel('Votre idée du jour', { exact: true })).toHaveValue('');
  expect(await page.evaluate(() => document.body.style.overflow)).toBe('hidden');
  await page.getByLabel('Votre idée du jour', { exact: true }).fill('Soupe pour les enfants');
  await page.getByRole('button', { name: 'Créer le repas' }).click();
  await expect(slot.locator('.meal-cell')).toHaveCount(2);
  await expect(slot.locator('.meal-cell').first()).toContainText(recipe.name);
});

test('deux plats : noms lisibles sur deux lignes entières, sans convives dans le planning', async ({ page, context }) => {
  const short = 'Parmentier de potimarron';
  const long = 'Orge perlé aux champignons, noisettes grillées et persil';
  await setup(page, context, [
    meal({ id: mealId(today, 'lunch'), date: today, text: short, dishId: null, household: custom }),
    meal({ id: mealId(today, 'lunch', 1), date: today, index: 1, text: long, dishId: null }),
    meal({ id: mealId(today, 'dinner'), date: today, slot: 'dinner', text: short, dishId: null }),
    meal({ id: mealId(today, 'dinner', 1), date: today, slot: 'dinner', index: 1, text: long, dishId: null }),
  ]);
  const viewport = page.viewportSize();
  for (const [width, height] of [[320, 568], [412, 915], [1024, 1366]] as const) {
    await page.setViewportSize({ width, height });
    for (const theme of ['light', 'dark']) {
      await page.evaluate(value => { document.documentElement.dataset.theme = value; }, theme);
      for (const index of [0, 1]) {
        const slot = page.locator(`[data-date="${today}"] .meal-slot`).nth(index);
        await expect(slot).not.toContainText(/adulte|enfant|adolescent/);
        const layout = await slot.evaluate(element => {
          const row = element.closest('.day-row')!;
          const rowBounds = row.getBoundingClientRect();
          const slotBounds = element.getBoundingClientRect();
          return {
            rowHeight: rowBounds.height,
            otherRowHeight: row.nextElementSibling!.getBoundingClientRect().height,
            slotInsideRow: slotBounds.top >= rowBounds.top && slotBounds.bottom <= rowBounds.bottom + 1,
            pageOverflow: document.documentElement.scrollWidth > innerWidth,
            names: [...element.querySelectorAll<HTMLElement>('.meal-cell')].map(cell => {
              const name = cell.querySelector<HTMLElement>('.meal-name')!;
              const style = getComputedStyle(name);
              const box = cell.getBoundingClientRect();
              const text = name.getBoundingClientRect();
              return {
                fontSize: parseFloat(style.fontSize),
                lines: Math.round(text.height / parseFloat(style.lineHeight)),
                inside: text.top >= box.top - .5 && text.bottom <= box.bottom + .5,
                complete: name.scrollHeight <= name.clientHeight + 1,
                background: getComputedStyle(cell).backgroundColor,
              };
            }),
          };
        });
        expect(layout.rowHeight).toBe(layout.otherRowHeight);
        expect(layout.slotInsideRow).toBe(true);
        expect(layout.pageOverflow).toBe(false);
        for (const name of layout.names) {
          expect(name.fontSize).toBeGreaterThanOrEqual(11.5);
          expect(name.lines).toBeGreaterThanOrEqual(1);
          expect(name.lines).toBeLessThanOrEqual(2);
          expect(name.inside).toBe(true);
          expect(name.background).toBe('rgba(0, 0, 0, 0)');
        }
        expect(layout.names[0].complete).toBe(true);
      }
      await page.screenshot({ path: test.info().outputPath(`deux-plats-${width}-${theme}.png`) });
    }
  }
  if (viewport) await page.setViewportSize(viewport);
  const first = page.locator(`[data-meal-id="${mealId(today, 'lunch')}"]`);
  await expect(first).toHaveAccessibleName(/convives personnalisés : 2 adultes/);
  await expect(page.locator(`[data-meal-id="${mealId(today, 'lunch', 1)}"]`)).toHaveAttribute('title', long);
  await first.click();
  await expect(guests(page)).toContainText('2 adultes');
});
