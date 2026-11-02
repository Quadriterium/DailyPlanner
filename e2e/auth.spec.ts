import { test, expect, type Browser, type Page } from '@playwright/test';
import { parisDate } from '../shared/model';

// Server started by playwright.config.ts with AUTH_ENABLED=true and the simulated identity provider.
const authURL = `http://${process.env.E2E_HOST ?? '127.0.0.1'}:3198`;
test.use({ baseURL: authURL });

const today = parisDate();
const unique = (prefix: string) => `${prefix} ${crypto.randomUUID().slice(0, 8)}`;
const cell = (page: Page) => page.locator(`[data-date="${today}"] .meal-cell`).first();
const indicator = (page: Page) => page.locator('.connection-indicator');

async function writeMeal(page: Page, text: string) {
  await cell(page).click();
  const modify = page.getByRole('button', { name: 'Modifier le repas', exact: true });
  if (await modify.isVisible()) await modify.click();
  await page.getByLabel('Votre idée du jour', { exact: true }).fill(text);
  await page.getByRole('button', { name: 'Créer le repas' }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(cell(page)).toHaveText(text);
}

/** Completes the simulated Google page with the given identity. */
async function authorize(page: Page, subject: string, name: string) {
  await expect(page.getByRole('heading', { name: 'Connexion simulée' })).toBeVisible();
  await page.getByLabel('Identifiant').fill(subject);
  await page.getByLabel('Nom').fill(name);
  await page.getByLabel('E-mail').fill(`${subject}@example.org`);
  await page.getByRole('button', { name: 'Continuer' }).click();
}

async function closeNotice(page: Page, text: string | RegExp) {
  await expect(page.getByRole('dialog')).toContainText(text);
  await page.getByRole('button', { name: 'Compris' }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
}

async function signIn(page: Page, subject: string, name = 'Camille Test') {
  await page.getByRole('region', { name: 'Mode invité' }).getByRole('button', { name: 'Se connecter avec Google' }).click();
  await authorize(page, subject, name);
  await closeNotice(page, /Connecté/);
  await expect(indicator(page)).toHaveText('Carnet à jour');
}

async function guestPage(browser: Browser) {
  const context = await browser.newContext({ baseURL: authURL });
  const page = await context.newPage();
  return { context, page };
}

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await expect(indicator(page)).toHaveText('Sur cet appareil uniquement');
});

test('mode invité puis connexion : les repas saisis sont importés dans le foyer', async ({ page, browser }) => {
  await expect(page.getByRole('region', { name: 'Mode invité' })).toBeVisible();
  const text = unique('Tarte invitée');
  await writeMeal(page, text);
  const subject = unique('alice').replace(' ', '-');
  await signIn(page, subject);
  await expect(page.getByRole('region', { name: 'Mode invité' })).toHaveCount(0);
  await expect(cell(page)).toHaveText(text);

  // Same account on another device: the imported meal was sent to the server.
  const other = await guestPage(browser);
  await other.page.goto('/');
  await signIn(other.page, subject);
  await expect(cell(other.page)).toHaveText(text);
  await other.context.close();
});

test('connexion annulée : retour en mode invité avec un message clair', async ({ page }) => {
  await page.getByRole('region', { name: 'Mode invité' }).getByRole('button', { name: 'Se connecter avec Google' }).click();
  await expect(page.getByRole('heading', { name: 'Connexion simulée' })).toBeVisible();
  await page.getByRole('button', { name: 'Annuler' }).click();
  await closeNotice(page, 'Connexion annulée');
  await expect(indicator(page)).toHaveText('Sur cet appareil uniquement');
  await expect(page).toHaveURL(/\/$/);
});

test('invitation : un second compte rejoint le foyer et voit ses repas', async ({ page, browser }) => {
  await signIn(page, unique('hote').replace(' ', '-'), 'Hôte Test');
  const text = unique('Soupe partagée');
  await writeMeal(page, text);
  await expect(indicator(page)).toHaveText('Carnet à jour');
  await page.getByRole('button', { name: 'Paramètres' }).click();
  await page.getByRole('button', { name: 'Inviter quelqu’un' }).click();
  const link = await page.getByLabel('Lien d’invitation').inputValue();
  expect(link).toMatch(/#invitation=/);

  const guest = await guestPage(browser);
  await guest.page.goto(link);
  const dialog = guest.page.getByRole('dialog');
  await expect(dialog).toContainText('Hôte Test vous invite à rejoindre');
  await dialog.getByRole('button', { name: 'Se connecter avec Google pour accepter' }).click();
  await authorize(guest.page, unique('invite').replace(' ', '-'), 'Invité Test');
  await closeNotice(guest.page, 'Vous avez rejoint le foyer');
  await expect(cell(guest.page)).toHaveText(text);
  await guest.page.getByRole('button', { name: 'Paramètres' }).click();
  await expect(guest.page.locator('.member-list')).toContainText('Hôte Test');
  await guest.context.close();

  // The link is single-use.
  const late = await guestPage(browser);
  await late.page.goto(link);
  await closeNotice(late.page, 'n’est plus valable');
  await late.context.close();
});

test('session expirée : bandeau de reconnexion sans perte des saisies', async ({ page, context }) => {
  await signIn(page, unique('expire').replace(' ', '-'));
  await context.clearCookies();
  const text = unique('Gratin hors session');
  await writeMeal(page, text);
  await expect(page.getByRole('button', { name: 'Se reconnecter' })).toBeVisible();
  await expect(indicator(page)).toHaveText('Session expirée');
  await expect(cell(page)).toHaveText(text);
});

test('pages légales publiques servies sans l’application, même via le service worker', async ({ page }) => {
  await page.evaluate(() => navigator.serviceWorker?.ready);
  for (const [path, title] of [['/confidentialite', 'Politique de confidentialité'], ['/conditions-utilisation', 'Conditions d’utilisation']]) {
    await page.goto(path);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(title);
    await expect(page.locator('#root')).toHaveCount(0);
  }
});

test('bandeau invité lisible à 320 px en thème sombre', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.setViewportSize({ width: 320, height: 700 });
  await page.reload();
  const banner = page.getByRole('region', { name: 'Mode invité' });
  await expect(banner).toBeVisible();
  await expect(banner.getByRole('button', { name: 'Se connecter avec Google' })).toBeVisible();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
  const box = await banner.boundingBox();
  expect(box?.width).toBeLessThanOrEqual(320);
});
