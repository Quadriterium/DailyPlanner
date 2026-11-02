import { test, expect, type Page } from '@playwright/test';
import { addDays, formatDate, parisDate } from '../shared/model';

const today = parisDate();
function name(prefix: string) { return `${prefix} ${crypto.randomUUID().slice(0, 8)}`; }
function cell(page: Page, date = today, slot: 'lunch' | 'dinner' = 'lunch') {
  return page.locator(`[data-date="${date}"] .meal-cell`).nth(slot === 'lunch' ? 0 : 1);
}
async function openMealEditor(page: Page, date = today, slot: 'lunch' | 'dinner' = 'lunch') {
  await cell(page, date, slot).click();
  const modify = page.getByRole('button', { name: 'Modifier le repas', exact: true });
  if (await modify.isVisible()) await modify.click();
}
async function writeMeal(page: Page, text: string, date = today, slot: 'lunch' | 'dinner' = 'lunch') {
  await openMealEditor(page, date, slot);
  const missingWidth = await page.getByRole('dialog').evaluate(element =>
    innerWidth <= 520 ? document.documentElement.clientWidth - element.getBoundingClientRect().width : 0,
  );
  expect(Math.abs(missingWidth)).toBeLessThan(2);
  await page.getByLabel('Votre idée du jour', { exact: true }).fill(text);
  await page.getByRole('button', { name: 'Créer le repas' }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(cell(page, date, slot)).toHaveText(text);
}
async function forceSync(page: Page) {
  for (let i = 0; i < 4; i++) {
    const title = page.getByRole('button', { name: 'À table !', exact: true });
    if (test.info().project.use.hasTouch) await title.tap();
    else await title.click({ delay: 35 });
  }
}
async function awaitSynced(page: Page) {
  await expect(page.locator('.connection-indicator')).toHaveText('Carnet à jour');
}
test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await awaitSynced(page);
});

test('bannière compacte et sept jours occupant la page', async ({ page }) => {
  async function expectFullWeek() {
    const layout = await page.locator('.days-scroll').evaluate((element, lastDate) => {
      const bounds = element.getBoundingClientRect();
      const first = element.querySelector('.is-today')!.getBoundingClientRect();
      const last = element.querySelector(`[data-date="${lastDate}"]`)!.getBoundingClientRect();
      return {
        height: bounds.height,
        weekHeight: first.height * 7,
        firstTop: first.top - bounds.top,
        lastBottom: last.bottom,
        viewportHeight: innerHeight,
        width: bounds.width,
        viewportWidth: innerWidth,
        pageHeight: document.documentElement.scrollHeight,
        pageWidth: document.documentElement.scrollWidth,
        headerHeight: document.querySelector('.masthead')!.getBoundingClientRect().height,
      };
    }, addDays(today, 6));
    expect(layout.headerHeight).toBeLessThanOrEqual(layout.viewportWidth <= 520 ? 112 : 64);
    expect(layout.height).toBeGreaterThan(layout.viewportHeight * .65);
    expect(Math.abs(layout.height - layout.weekHeight)).toBeLessThan(1);
    expect(Math.abs(layout.firstTop)).toBeLessThan(2);
    expect(layout.lastBottom).toBeLessThanOrEqual(layout.viewportHeight);
    expect(layout.width).toBeGreaterThan(layout.viewportWidth * .9);
    expect(layout.pageHeight).toBeLessThanOrEqual(layout.viewportHeight + 1);
    expect(layout.pageWidth).toBeLessThanOrEqual(layout.viewportWidth);
  }

  await expectFullWeek();
  await page.setViewportSize({ width: 800, height: 1100 });
  await expect(async () => { await expectFullWeek(); }).toPass();
  await page.setViewportSize({ width: 800, height: 900 });
  await expect(async () => { await expectFullWeek(); }).toPass();
  await page.setViewportSize({ width: 320, height: 568 });
  const shortLayout = await page.locator('.menu-grid').evaluate(element => {
    const grid = element.getBoundingClientRect();
    const arrows = element.querySelector('.scroll-footer')!.getBoundingClientRect();
    return {
      gridBottom: grid.bottom,
      arrowsBottom: arrows.bottom,
      footerTop: document.querySelector('.app-footer')!.getBoundingClientRect().top,
      pageWidth: document.documentElement.scrollWidth,
    };
  });
  expect(shortLayout.arrowsBottom).toBeLessThanOrEqual(shortLayout.gridBottom);
  expect(shortLayout.footerTop).toBeGreaterThanOrEqual(shortLayout.arrowsBottom);
  expect(shortLayout.pageWidth).toBeLessThanOrEqual(320);
  await page.getByRole('button', { name: 'Voir les sept jours suivants' }).click();
  await expect(page.locator('.section-heading h2')).toContainText(formatDate(addDays(today, 7), { day: 'numeric', month: 'long' }));
});

test('grille responsive, saisie brute et navigation verticale', async ({ page }) => {
  const text = name('poulet frite');
  await expect(page.getByRole('heading', { name: 'À table !' })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  const alignment = await page.locator('.days-scroll').evaluate(element => {
    const todayRow = element.querySelector<HTMLElement>('.is-today')!;
    return Math.abs(element.getBoundingClientRect().top - todayRow.getBoundingClientRect().top);
  });
  expect(alignment).toBeLessThan(2);
  await writeMeal(page, text);
  await awaitSynced(page);
  await page.getByRole('button', { name: 'Voir les sept jours suivants' }).click();
  await expect(page.locator('.section-heading h2')).toContainText(formatDate(addDays(today, 7), { day: 'numeric', month: 'long' }));
  await page.getByRole('button', { name: 'Aujourd’hui', exact: true }).click();
  await expect(cell(page)).toHaveText(text);
  await page.setViewportSize({ width: 800, height: 1100 });
  await expect.poll(() => page.locator('.days-scroll').evaluate(element =>
    Math.abs(element.getBoundingClientRect().top - element.querySelector('.is-today')!.getBoundingClientRect().top),
  )).toBeLessThan(2);
});

test('le titre À table ramène au planning', async ({ page }) => {
  await page.getByRole('button', { name: 'Mon carnet', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Mon carnet', exact: true })).toHaveAttribute('aria-current', 'page');
  await page.getByRole('button', { name: 'À table !', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Mon planning', exact: true })).toHaveAttribute('aria-current', 'page');
});

test('bibliothèque modifiable, suggestions et archivage sans effacer les menus', async ({ page }) => {
  const text = name('soupe du jardin');
  const corrected = `${text} maison`;
  await writeMeal(page, text);
  await awaitSynced(page);
  await page.getByRole('button', { name: 'Mon carnet', exact: true }).click();
  await page.getByRole('button', { name: new RegExp(text) }).click();
  await page.getByLabel('Nom du repas', { exact: true }).fill(corrected);
  await page.getByRole('button', { name: 'Toute l’année', exact: true }).click();
  await page.getByLabel(/Ingrédients et quantités/).fill('Carottes\nPommes de terre');
  await page.getByLabel('Une petite recette', { exact: true }).fill('Cuire les légumes, puis mixer.');
  await page.getByRole('button', { name: 'Enregistrer la fiche' }).click();
  await page.getByRole('button', { name: 'Mon planning', exact: true }).click();
  await expect(cell(page)).toHaveText(text);
  await openMealEditor(page, today, 'dinner');
  await page.getByLabel('Rechercher un repas', { exact: true }).fill(corrected);
  await page.getByRole('button', { name: new RegExp(corrected) }).click();
  await expect(cell(page, today, 'dinner')).toHaveText(corrected);
  await page.getByRole('button', { name: 'Mon carnet', exact: true }).click();
  await page.getByRole('button', { name: new RegExp(corrected) }).click();
  await page.getByRole('button', { name: 'Archiver ce repas' }).click();
  await expect(page.getByRole('button', { name: new RegExp(corrected) })).toHaveCount(0);
  await page.getByRole('button', { name: 'Mon planning', exact: true }).click();
  await expect(cell(page)).toHaveText(text);
  await expect(cell(page, today, 'dinner')).toHaveText(corrected);
});

test('rechargement hors ligne, quadruple clic en échec puis reconnexion sans perte', async ({ page, context }) => {
  const text = name('repas hors ligne');
  await page.evaluate(async () => { await navigator.serviceWorker.ready; });
  await page.reload();
  await awaitSynced(page);
  await expect.poll(() => page.evaluate(() => Boolean(navigator.serviceWorker.controller))).toBe(true);
  await context.setOffline(true);
  await writeMeal(page, text);
  await page.reload();
  await expect(cell(page)).toHaveText(text);
  await forceSync(page);
  await expect(page.getByRole('dialog', { name: 'Actualisation impossible' })).toBeVisible();
  await expect(page.getByRole('dialog')).toContainText('Serveur inaccessible');
  await page.getByRole('button', { name: 'Compris' }).click();
  await expect(cell(page)).toHaveText(text);
  await context.setOffline(false);
  await forceSync(page);
  await expect(page.getByRole('dialog', { name: 'Tout est à jour' })).toBeVisible();
  await page.getByRole('button', { name: 'Compris' }).click();
  await page.reload();
  await expect(cell(page)).toHaveText(text);
  await awaitSynced(page);
});

test('paramètres : mise à jour forcée du CSS et activation sans perte des saisies locales', async ({ page, context }) => {
  await page.evaluate(async () => { await navigator.serviceWorker.ready; });
  await page.reload();
  await awaitSynced(page);
  await page.getByRole('button', { name: 'Paramètres', exact: true }).click();
  await page.getByRole('radio', { name: 'Sombre', exact: true }).check();
  await page.getByRole('button', { name: 'Mon planning', exact: true }).click();
  await context.setOffline(true);
  const text = name('mise à jour CSS');
  await writeMeal(page, text);
  await page.getByRole('button', { name: 'Paramètres', exact: true }).click();
  await page.getByRole('button', { name: 'Forcer la mise à jour', exact: true }).click();
  await expect(page.getByRole('alert').filter({ hasText: 'Mise à jour impossible' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Forcer la mise à jour', exact: true })).toBeEnabled();

  await context.setOffline(false);
  await awaitSynced(page);
  await page.evaluate(async () => {
    await navigator.serviceWorker.register('/sw.js?forced-update-test', { updateViaCache: 'none' });
  });
  await expect.poll(() => page.evaluate(async () => Boolean((await navigator.serviceWorker.getRegistration())?.waiting))).toBe(true);
  const expectedCss = await page.evaluate(async () => {
    const stylesheet = document.querySelector<HTMLLinkElement>('link[rel="stylesheet"]')!;
    const css = new URL(stylesheet.href).pathname;
    const keys = (await caches.keys()).filter(key => key.startsWith('a-table-shell-'));
    const cache = await caches.open(keys[0]);
    const original = await (await cache.match(css))!.text();
    await cache.put(css, new Response(`${original}\nbody { --forced-update-test: obsolete; }`, { headers: { 'Content-Type': 'text/css' } }));
    stylesheet.href = `${css}?stale-css-test`;
    return { css, original };
  });
  await expect.poll(() => page.evaluate(() => getComputedStyle(document.body).getPropertyValue('--forced-update-test').trim())).toBe('obsolete');
  await page.getByRole('button', { name: 'Forcer la mise à jour', exact: true }).click();
  await expect(cell(page)).toHaveText(text);
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await expect.poll(() => page.evaluate(() => navigator.serviceWorker.controller?.scriptURL)).toContain('forced-update-test');
  expect(await page.evaluate(() => getComputedStyle(document.body).getPropertyValue('--forced-update-test').trim())).toBe('');
  expect(await page.evaluate(async css => {
    const keys = (await caches.keys()).filter(key => key.startsWith('a-table-shell-'));
    return (await (await caches.open(keys[0])).match(css))?.text();
  }, expectedCss.css)).toBe(expectedCss.original);
  await context.setOffline(true);
  await page.reload();
  await expect(cell(page)).toHaveText(text);
});

test('paramètres : mise à jour forcée sans service worker', async ({ browser, baseURL }) => {
  const context = await browser.newContext({ baseURL, serviceWorkers: 'block' });
  try {
    const page = await context.newPage();
    await page.goto('/');
    await awaitSynced(page);
    const text = name('mise à jour sans PWA');
    await writeMeal(page, text);
    await page.getByRole('button', { name: 'Paramètres', exact: true }).click();
    await page.getByRole('button', { name: 'Forcer la mise à jour', exact: true }).click();
    await expect(cell(page)).toHaveText(text);
    await awaitSynced(page);
    expect(await page.evaluate(() => navigator.serviceWorker.controller)).toBeNull();
  } finally { await context.close(); }
});

test('serveur indisponible malgré Internet, suppression hors ligne et réconciliation', async ({ page, context }) => {
  const text = name('a effacer');
  await writeMeal(page, text);
  await awaitSynced(page);
  await context.route('**/api/**', route => route.abort('connectionrefused'));
  expect(await page.evaluate(() => navigator.onLine)).toBe(true);
  await cell(page).click();
  await page.getByRole('button', { name: 'Vider', exact: true }).click();
  await expect(cell(page)).toContainText('Créer un repas');
  await forceSync(page);
  await expect(page.getByRole('dialog', { name: 'Actualisation impossible' })).toBeVisible();
  await page.getByRole('button', { name: 'Compris' }).click();
  await context.unroute('**/api/**');
  await forceSync(page);
  await expect(page.getByRole('dialog', { name: 'Tout est à jour' })).toBeVisible();
  await page.getByRole('button', { name: 'Compris' }).click();
  await page.reload();
  await awaitSynced(page);
  await expect(cell(page)).toContainText('Créer un repas');
});

test('deux appareils : le dernier changement gagne, les autres créneaux sont conservés', async ({ page, context, browser }) => {
  const otherContext = await browser.newContext({ baseURL: new URL(page.url()).origin, viewport: { width: 1024, height: 1366 } });
  const other = await otherContext.newPage();
  try {
    await other.goto('/');
    await awaitSynced(other);
    await context.setOffline(true);
    await writeMeal(page, name('ancien choix local'));
    const independent = name('diner local');
    await writeMeal(page, independent, today, 'dinner');
    const newest = name('dernier choix tablette');
    await writeMeal(other, newest);
    await awaitSynced(other);
    await context.setOffline(false);
    await forceSync(page);
    await expect(page.getByRole('dialog', { name: 'Tout est à jour' })).toBeVisible();
    await page.getByRole('button', { name: 'Compris' }).click();
    await expect(cell(page)).toHaveText(newest);
    await expect(cell(page, today, 'dinner')).toHaveText(independent);
    await forceSync(other);
    await expect(other.getByRole('dialog', { name: 'Tout est à jour' })).toBeVisible();
    await other.getByRole('button', { name: 'Compris' }).click();
    await expect(cell(other)).toHaveText(newest);
    await expect(cell(other, today, 'dinner')).toHaveText(independent);
  } finally { await otherContext.close(); }
});

test('paramètres : modèle partagé, conservé après rechargement et désactivé hors ligne', async ({ page, context }) => {
  await page.getByRole('button', { name: 'Paramètres', exact: true }).click();
  for (const model of ['gpt-6-sol', 'gpt-5.6-terra']) {
    await page.getByRole('radio', { name: model, exact: true }).check();
    await awaitSynced(page);
    await expect(page.getByRole('radio', { name: model, exact: true })).toBeChecked();
  }
  const firstModel = page.getByRole('radio', { name: 'gpt-6-luna', exact: true });
  const alternative = await firstModel.isChecked() ? 'gpt-5.6-luna' : 'gpt-6-luna';
  await page.getByRole('radio', { name: alternative, exact: true }).check();
  await expect(page.getByText('Choix enregistré localement', { exact: false })).toBeVisible();
  await awaitSynced(page);
  await page.reload();
  await awaitSynced(page);
  await page.getByRole('button', { name: 'Paramètres', exact: true }).click();
  await expect(page.getByRole('radio', { name: alternative, exact: true })).toBeChecked();
  await expect(page.getByText('L’analyse attend la configuration de la clé OpenAI sur le serveur.', { exact: false })).toBeVisible();
  await context.setOffline(true);
  await page.getByRole('button', { name: 'Synchroniser', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Actualisation impossible' })).toBeVisible();
  await page.getByRole('button', { name: 'Compris', exact: true }).click();
  await expect(firstModel).toBeDisabled();
});

test('paramètres : thème sombre, horaire ou système, propre à l’appareil et sans flash', async ({ page, browser, baseURL }) => {
  const html = page.locator('html');
  const settings = page.getByRole('button', { name: 'Paramètres', exact: true });
  const theme = (label: string) => page.getByRole('radio', { name: label, exact: true });
  await expect(html).toHaveAttribute('data-theme', 'light');
  await settings.click();
  await expect(theme('Clair')).toBeChecked();
  await theme('Sombre').check();
  await expect(html).toHaveAttribute('data-theme', 'dark');
  await expect(page.locator('meta[name="theme-color"]')).toHaveAttribute('content', '#1c1814');
  expect(await page.evaluate(() => getComputedStyle(document.documentElement).backgroundColor)).toBe('rgb(21, 18, 15)');

  const evening = new Date();
  evening.setHours(19, 58, 50, 0);
  await page.clock.install({ time: evening });
  await page.reload();
  await awaitSynced(page);
  await expect(html).toHaveAttribute('data-theme', 'dark');
  await page.clock.pauseAt(evening.getTime() + 60_000);
  await settings.click();
  await theme('Selon l’heure').check();
  await expect(html).toHaveAttribute('data-theme', 'light');
  await expect(page.getByText('Sombre de 20 h à 7 h, selon l’heure de cet appareil. En ce moment : clair.')).toBeVisible();
  await page.clock.runFor(10_100);
  await expect(html).toHaveAttribute('data-theme', 'dark');
  await page.getByLabel('Sombre à partir de', { exact: true }).fill('21:30');
  await expect(html).toHaveAttribute('data-theme', 'light');
  await expect(page.getByText('Sombre de 21 h 30 à 7 h', { exact: false })).toBeVisible();
  await page.clock.resume();

  await page.emulateMedia({ colorScheme: 'dark' });
  await theme('Comme le système').check();
  await expect(html).toHaveAttribute('data-theme', 'dark');
  await page.emulateMedia({ colorScheme: 'light' });
  await expect(html).toHaveAttribute('data-theme', 'light');
  await page.reload();
  await awaitSynced(page);
  await settings.click();
  await expect(theme('Comme le système')).toBeChecked();

  // Sans le code de l’application, public/theme.js applique déjà le thème mémorisé.
  const bare = await browser.newContext({ baseURL, serviceWorkers: 'block' });
  try {
    await bare.addInitScript(() => localStorage.setItem('a-table-theme', JSON.stringify({ mode: 'dark' })));
    const early = await bare.newPage();
    await early.route('**/assets/**', route => route.abort());
    await early.goto('/');
    await expect(early.locator('#root')).toBeEmpty();
    await expect(early.locator('html')).toHaveAttribute('data-theme', 'dark');
    await expect(early.locator('meta[name="theme-color"]')).toHaveAttribute('content', '#1c1814');
  } finally { await bare.close(); }
});

test('HTTP LAN : saisie, carnet et synchronisation sans contexte sécurisé', async ({ page }) => {
  test.skip(!process.env.E2E_HOST, 'Nécessite E2E_HOST avec une IP LAN, pas localhost.');
  expect(await page.evaluate(() => window.isSecureContext)).toBe(false);
  expect(await page.evaluate(() => typeof crypto.randomUUID)).toBe('undefined');
  const text = name('repas HTTP local');
  await writeMeal(page, text);
  await awaitSynced(page);
  await page.reload();
  await awaitSynced(page);
  await expect(cell(page)).toHaveText(text);
  await page.getByRole('button', { name: 'Mon carnet', exact: true }).click();
  await page.getByRole('button', { name: new RegExp(text) }).click();
  await page.getByLabel('Nom du repas', { exact: true }).fill(`${text} corrigé`);
  await page.getByRole('button', { name: 'Enregistrer la fiche' }).click();
  await awaitSynced(page);
  await expect(page.getByRole('button', { name: new RegExp(`${text} corrigé`) })).toBeVisible();
  await page.getByRole('button', { name: 'Paramètres', exact: true }).click();
  await expect(page.getByText('Indisponible sur cet appareil', { exact: true })).toBeVisible();
  await expect(page.getByText('Le mode hors ligne nécessite HTTPS (ou localhost).', { exact: true })).toBeVisible();
});

test('champs de saisie à 16 px pour éviter le zoom tactile', async ({ page }) => {
  await writeMeal(page, name('Zoom'));
  await openMealEditor(page, addDays(today, 1));
  const small = async () => page.locator('input:not([type=checkbox],[type=radio]), textarea').evaluateAll(fields =>
    fields.filter(field => (field as HTMLElement).offsetParent && parseFloat(getComputedStyle(field).fontSize) < 16).map(field => field.outerHTML.slice(0, 80)));
  await expect(page.getByRole('searchbox', { name: 'Rechercher un repas' })).toBeVisible();
  expect(await small()).toEqual([]);
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: /Paramètres/ }).first().click();
  expect(await small()).toEqual([]);
});

test('mode ordinateur sur tablette : champs agrandis selon la réduction de la page', async ({ browser }, testInfo) => {
  test.skip(testInfo.project.name !== 'tablette-chrome', 'Émulation Chrome Android en mode ordinateur');
  const context = await browser.newContext({ viewport: { width: 980, height: 1400 }, screen: { width: 700, height: 1000 }, hasTouch: true, baseURL: testInfo.project.use.baseURL });
  const page = await context.newPage();
  await page.goto('/');
  await awaitSynced(page);
  await openMealEditor(page, addDays(today, 2));
  const field = page.getByLabel('Votre idée du jour', { exact: true });
  expect(await field.evaluate(element => parseFloat(getComputedStyle(element).fontSize))).toBe(23);
  await context.close();
});
