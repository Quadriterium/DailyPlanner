import { test, expect, type Page } from '@playwright/test';

const adminURL = `http://${process.env.E2E_HOST ?? '127.0.0.1'}:3197`;
test.use({ baseURL: adminURL });

async function login(page: Page, subject = 'admin-e2e') {
  await page.goto('/admin');
  await page.getByRole('button', { name: 'Connexion admin avec Google' }).click();
  await expect(page.getByRole('heading', { name: 'Connexion simulée' })).toBeVisible();
  await page.getByLabel('Identifiant').fill(subject);
  await page.getByLabel('Nom', { exact: true }).fill(subject === 'admin-e2e' ? 'Admin Test' : 'Autre Test');
  await page.getByLabel('E-mail').fill(`${subject}@example.org`);
  await page.getByRole('button', { name: 'Continuer' }).click();
}
async function confirm(page: Page) {
  await page.getByRole('button', { name: 'Confirmer', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
}
async function fits(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
}

test('admin : cinq rubriques responsive, quotas, catalogue, demandes et déconnexion', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await login(page);
  const navigation = page.getByRole('navigation', { name: 'Administration', exact: true });
  await expect(navigation).toBeVisible();
  await expect(page.getByText('Comptes inscrits', { exact: true })).toBeVisible();
  await fits(page);
  await navigation.getByRole('button', { name: 'Utilisateurs / foyers' }).click();
  await expect(page.getByRole('heading', { name: 'Comptes inscrits' })).toBeVisible();
  await expect(page.getByText('admin-e2e@example.org', { exact: true }).last()).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Foyers et espaces' })).toBeVisible();
  await fits(page);

  await navigation.getByRole('button', { name: 'OpenAI', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Budget d’appels OpenAI' })).toBeVisible();
  await expect(page.getByText('Appels sur la dernière heure')).toBeVisible();
  await page.getByLabel('Activer le plafond horaire global').check();
  await page.getByLabel('Plafond horaire global (période glissante de 60 minutes)').fill('12');
  await page.getByLabel('Plafond quotidien global').fill('25');
  await page.getByLabel('Plafond mensuel global').fill('300');
  await page.getByLabel('Suspendre tous les nouveaux appels IA').check();
  await page.getByRole('button', { name: 'Enregistrer les limites', exact: true }).click();
  await confirm(page);
  await expect(page.getByText('Limites globales enregistrées.', { exact: true })).toBeVisible();
  await expect(page.getByLabel('Plafond horaire global (période glissante de 60 minutes)')).toHaveValue('12');
  await expect(page.getByLabel('Plafond quotidien global')).toHaveValue('25');
  await page.getByRole('button', { name: 'Modifier les quotas de Foyer de Admin' }).click();
  await page.getByLabel('Quota quotidien', { exact: true }).fill('7');
  await page.getByLabel('Quota mensuel', { exact: true }).fill('50');
  await page.getByRole('dialog').getByRole('button', { name: 'Enregistrer les limites' }).click();
  await confirm(page);
  await expect(page.getByText('Quota quotidien : 7 · mensuel : 50')).toBeVisible();
  await fits(page);

  await navigation.getByRole('button', { name: 'Administration', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Catalogue commun' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Demandes des utilisateurs' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Journal d’administration' })).toBeVisible();
  const name = `Soupe admin ${crypto.randomUUID().slice(0, 8)}`;
  await page.getByRole('button', { name: /^Corriger Soupe admin/ }).click();
  await page.getByLabel('Nom de la recette').fill(name);
  await page.getByLabel('Quantité 1', { exact: true }).fill('600');
  await page.getByRole('button', { name: 'Enregistrer la correction' }).click();
  await confirm(page);
  await expect(page.getByRole('heading', { name, exact: true })).toBeVisible();
  await page.getByRole('button', { name: `Retirer ${name}`, exact: true }).click();
  await confirm(page);
  await expect(page.getByRole('heading', { name: `${name} · retirée` })).toBeVisible();
  await page.getByRole('button', { name: `Restaurer ${name}`, exact: true }).click();
  await confirm(page);
  await page.getByLabel('Réponse au foyer').fill('Merci, demande étudiée.');
  await page.getByRole('combobox', { name: 'Statut', exact: true }).selectOption('planned');
  await page.getByRole('button', { name: 'Enregistrer la réponse' }).click();
  await confirm(page);
  await expect(page.getByLabel('Réponse au foyer')).toHaveValue('Merci, demande étudiée.');
  await expect(page.getByText('admin.request-update', { exact: true }).first()).toBeVisible();
  await fits(page);

  const persistence = await page.evaluate(async () => ({
    local: Object.keys(localStorage).filter(key => /admin/i.test(key)),
    session: Object.keys(sessionStorage).filter(key => /admin/i.test(key)),
    databases: (await indexedDB.databases()).map(database => database.name),
  }));
  expect(persistence).toEqual({ local: [], session: [], databases: [] });
  expect(errors).toEqual([]);
  await page.getByRole('button', { name: 'Quitter l’admin' }).click();
  await confirm(page);
  await expect(navigation).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'Accès administrateur' })).toBeVisible();
  const session = await page.request.get('/api/auth/session');
  expect((await session.json()).user.id).toBe('11111111-1111-4111-8111-111111111111');
  expect((await page.request.get('/api/admin/users')).status()).toBe(401);
});

test('admin : mentions légales publiées sur les pages publiques', async ({ page }) => {
  await login(page);
  const navigation = page.getByRole('navigation', { name: 'Administration', exact: true });
  await navigation.getByRole('button', { name: 'Mentions légales' }).click();
  await page.getByLabel('Prénom', { exact: true }).fill('Jeanne');
  await page.getByLabel('Nom', { exact: true }).fill('Durand');
  await page.getByLabel('Adresse (numéro et voie)').fill('1 rue des Lilas');
  await page.getByLabel('Code postal').fill('75001');
  await page.getByLabel('Ville').fill('Paris');
  await page.getByLabel('Lieu d’hébergement du serveur').fill('en France');
  await fits(page);
  await page.getByRole('button', { name: 'Enregistrer les mentions légales' }).click();
  await confirm(page);
  await expect(page.getByText('Mentions légales publiées.', { exact: true })).toBeVisible();
  await expect(page.getByLabel('Ville')).toHaveValue('Paris');
  await page.goto('/conditions-utilisation');
  await expect(page.getByText('édité par Jeanne Durand, 1 rue des Lilas, 75001 Paris, France')).toBeVisible();
  await page.goto('/confidentialite');
  await expect(page.getByText('Le serveur de l’application est hébergé en France.')).toBeVisible();
});

test('admin : messages ciblés et globaux, fermeture persistante entre appareils', async ({ page, context, browser }) => {
  await login(page);
  const navigation = page.getByRole('navigation', { name: 'Administration', exact: true });
  await navigation.getByRole('button', { name: 'Utilisateurs / foyers' }).click();
  await page.getByRole('button', { name: 'Envoyer un message à Admin Test', exact: true }).click();
  const text = `Bienvenue !\nMessage ciblé ${crypto.randomUUID()}\n<script>alert("texte brut")</script>`;
  await page.getByLabel('Message', { exact: true }).fill(text);
  await page.getByRole('button', { name: 'Envoyer le message', exact: true }).click();
  await confirm(page);
  await expect(page.getByText('Message envoyé à 1 utilisateur(s).', { exact: true })).toBeVisible();
  await fits(page);

  const device = await browser.newContext({ baseURL: adminURL, viewport: page.viewportSize()! });
  try {
    await device.addCookies(await context.cookies());
    const reader = await device.newPage();
    await reader.goto('/');
    const dialog = reader.getByRole('dialog', { name: 'Message de l’administration' });
    const message = dialog.getByRole('button', { name: /Cliquer pour ne plus afficher/ });
    await expect(message).toContainText(text);
    await fits(reader);
    await reader.reload();
    await expect(message).toBeVisible();

    await reader.route('**/api/messages/*/dismiss', route => route.fulfill({
      status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'Serveur temporairement indisponible.' }),
    }));
    await message.click();
    await expect(dialog.getByRole('alert')).toContainText('Serveur temporairement indisponible');
    await expect(message).toBeVisible();
    await reader.unroute('**/api/messages/*/dismiss');
    await message.click();
    await expect(dialog).toHaveCount(0);
    await reader.reload();
    await expect(reader.getByRole('navigation', { name: 'Navigation principale' })).toBeVisible();
    await expect.poll(async () => (await (await reader.request.get('/api/messages')).json()).messages).toEqual([]);
    await expect(dialog).toHaveCount(0);

    await page.goto('/');
    await expect(page.getByRole('navigation', { name: 'Navigation principale' })).toBeVisible();
    await expect(page.getByRole('dialog', { name: 'Message de l’administration' })).toHaveCount(0);

    await page.goto('/admin');
    await page.getByRole('navigation', { name: 'Administration', exact: true }).getByRole('button', { name: 'Utilisateurs / foyers' }).click();
    await page.getByRole('button', { name: 'Envoyer un message à tous', exact: true }).click();
    const broadcast = `Annonce générale ${crypto.randomUUID()}`;
    await page.getByLabel('Message', { exact: true }).fill(broadcast);
    await page.getByRole('button', { name: 'Envoyer le message', exact: true }).click();
    await confirm(page);
    await reader.reload();
    await expect(message).toContainText(broadcast);
    await reader.evaluate(() => document.documentElement.dataset.theme = 'dark');
    await fits(reader);
    await message.focus();
    await reader.keyboard.press('Enter');
    await expect(dialog).toHaveCount(0);
  } finally { await device.close(); }
});

test('admin : refus des comptes ordinaires, absence de cache et retrait des données hors ligne', async ({ page, context }) => {
  const response = await page.goto('/admin');
  expect(response!.headers()['cache-control']).toBe('no-store');
  await login(page, `nonadmin-${crypto.randomUUID().slice(0, 8)}`);
  await expect(page.getByText('Ce compte n’est pas autorisé à administrer le serveur.')).toBeVisible();
  await expect(page.getByRole('navigation', { name: 'Administration', exact: true })).toHaveCount(0);
  expect((await page.request.get('/api/admin/users')).status()).toBe(403);
  await login(page);
  await expect(page.getByRole('navigation', { name: 'Administration', exact: true })).toBeVisible();
  await page.getByRole('navigation').getByRole('button', { name: 'Utilisateurs / foyers' }).click();
  await expect(page.getByRole('heading', { name: 'Comptes inscrits' })).toBeVisible();
  await context.setOffline(true);
  await expect(page.getByRole('navigation', { name: 'Administration', exact: true })).toHaveCount(0);
  await expect(page.getByRole('alert')).toContainText('hors ligne');
  await expect(page.getByRole('heading', { name: 'Comptes inscrits' })).toHaveCount(0);
  await context.setOffline(false);
});
