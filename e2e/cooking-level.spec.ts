import { test, expect, type Page } from '@playwright/test';
import { defaultHousehold, parisDate, seasonForDate, type CookingLevel, type RecordData } from '../shared/model';
import { details, dish, snapshot } from '../tests/fixtures';

const today = parisDate();
const byLevel = {
  1: dish({ name: 'Omelette express', details: { ...details, name: 'Omelette express', level: 1 } }),
  2: dish({ name: 'Gratin du quotidien', details: { ...details, name: 'Gratin du quotidien', level: 2 } }),
  3: dish({ name: 'Blanquette mijotée', details: { ...details, name: 'Blanquette mijotée', level: 3 } }),
} as const;
let sent: RecordData[] = [];

function slot(page: Page, time = 'lunch') {
  return page.locator(`[data-date="${today}"] .meal-slot`).nth(time === 'lunch' ? 0 : 1);
}
function longPress(page: Page, locator: ReturnType<Page['locator']>) {
  return locator.click({ delay: 800 });
}

test.beforeEach(async ({ page }) => {
  sent = [];
  const records = new Map<string, RecordData>([...Object.values(byLevel), {
    type: 'settings' as const, id: 'global' as const, model: 'gpt-6-luna', household: defaultHousehold, avoid: '',
    cookingLevel: 2 as const, modifiedAt: 1, mutationId: crypto.randomUUID(),
  }].map(record => [`${record.type}:${record.id}`, record]));
  await page.route('**/api/sync', async route => {
    const body = route.request().postDataJSON() as { mutations: RecordData[] };
    sent.push(...body.mutations);
    for (const record of body.mutations) records.set(`${record.type}:${record.id}`, record);
    await route.fulfill({ json: snapshot([...records.values()]) });
  });
  await page.goto('/');
  await expect(page.locator('.connection-indicator')).toHaveText('Carnet à jour');
});

test('niveau de cuisine : le tirage court suit le niveau des paramètres', async ({ page }) => {
  for (const time of ['lunch', 'dinner']) {
    await slot(page, time).getByRole('button', { name: /piocher/ }).click();
    await expect(slot(page, time).locator('.meal-cell')).toHaveText(byLevel[2].name);
  }
  await page.getByRole('button', { name: 'Paramètres', exact: true }).click();
  const level = page.getByRole('radio', { name: /Toque affûtée/ });
  await expect(page.getByRole('radio', { name: /Popote du quotidien/ })).toBeChecked();
  await level.check();
  await expect(page.getByRole('status').filter({ hasText: 'Niveau « Toque affûtée » enregistré' })).toBeVisible();
  await expect.poll(() => sent.some(record => record.type === 'settings' && record.cookingLevel === 3)).toBe(true);
  await page.reload();
  await page.getByRole('button', { name: 'Paramètres', exact: true }).click();
  await expect(page.getByRole('radio', { name: /Toque affûtée/ })).toBeChecked();
  await page.getByRole('button', { name: 'Mon planning', exact: true }).click();
  await page.locator(`[data-date="${today}"] .meal-cell`).first().click();
  await page.getByRole('button', { name: 'Vider', exact: true }).click();
  await slot(page).getByRole('button', { name: /piocher/ }).click();
  await expect(slot(page).locator('.meal-cell')).toHaveText(byLevel[3].name);
});

test('niveau de cuisine : appui long sur le tirage rapide pour choisir un autre niveau', async ({ page }) => {
  await longPress(page, slot(page).getByRole('button', { name: /piocher/ }));
  const menu = page.getByRole('dialog', { name: 'Piocher au hasard' });
  await expect(menu).toBeVisible();
  await expect(slot(page).locator('.meal-cell')).toContainText('Créer un repas');
  await expect(menu.getByRole('button', { name: /Popote du quotidien/ })).toContainText('Votre niveau');
  await expect(menu.getByRole('button', { name: /Tablier tout neuf/ })).toContainText('1 plat de saison');
  await expect(menu.getByRole('button', { name: /Haute voltige étoilée/ })).toBeDisabled();
  await page.keyboard.press('Escape');
  await expect(menu).toHaveCount(0);
  await expect(slot(page).locator('.meal-cell')).toContainText('Créer un repas');
  await longPress(page, slot(page).getByRole('button', { name: /piocher/ }));
  await menu.getByRole('button', { name: /Tablier tout neuf/ }).click();
  await expect(menu).toHaveCount(0);
  await expect(slot(page).locator('.meal-cell')).toHaveText(byLevel[1].name);
  await page.reload();
  await expect(slot(page).locator('.meal-cell')).toHaveText(byLevel[1].name);
});

test('niveau de cuisine : anciens paramètres locaux sans niveau et serveur inaccessible', async ({ page }) => {
  await page.route('**/api/sync', route => route.abort());
  await page.evaluate(defaultDishId => new Promise<void>((resolve, reject) => {
    const request = indexedDB.open('a-table-v1');
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const db = request.result;
      const transaction = db.transaction('records', 'readwrite');
      const records = transaction.objectStore('records');
      const settings = records.get('settings:global');
      settings.onsuccess = () => {
        const { cookingLevel: _level, ...legacy } = settings.result;
        records.put(legacy, 'settings:global');
      };
      records.delete(`dish:${defaultDishId}`);
      transaction.oncomplete = () => { db.close(); resolve(); };
      transaction.onabort = () => { db.close(); reject(transaction.error); };
    };
  }), byLevel[2].id);
  await page.reload();
  await slot(page).getByRole('button', { name: /piocher/ }).click();
  await expect(page.getByRole('alert')).toContainText('Aucun repas de saison de niveau « Popote du quotidien »');
  await expect(slot(page).locator('.meal-cell')).toContainText('Créer un repas');
});

test('niveau de cuisine : appui long au doigt, sans tap parasite au relâchement', async ({ page, context, browserName }, testInfo) => {
  test.skip(browserName !== 'chromium' || !testInfo.project.use.hasTouch, 'Nécessite un écran tactile émulé par Chromium.');
  const cdp = await context.newCDPSession(page);
  const center = async (locator: ReturnType<Page['locator']>) => {
    const box = (await locator.boundingBox())!;
    return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  };
  const touch = async (point: { x: number; y: number }, hold: number) => {
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [point] });
    await page.waitForTimeout(hold);
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  };
  const button = await center(slot(page).getByRole('button', { name: /piocher/ }));
  const menu = page.getByRole('dialog', { name: 'Piocher au hasard' });
  await touch(button, 1500);
  await page.waitForTimeout(300);
  await expect(menu).toBeVisible();
  await expect(slot(page).locator('.meal-cell')).toContainText('Créer un repas');
  await touch(await center(menu.getByRole('button', { name: /Toque affûtée/ })), 50);
  await expect(menu).toHaveCount(0);
  await expect(slot(page).locator('.meal-cell')).toHaveText(byLevel[3].name);
  await touch(await center(slot(page, 'dinner').getByRole('button', { name: /piocher/ })), 50);
  await expect(slot(page, 'dinner').locator('.meal-cell')).toHaveText(byLevel[2].name);
});

test('niveau de cuisine : appui long sur la génération rapide IA', async ({ page }) => {
  const levels: CookingLevel[] = [];
  await page.route('**/api/meals/generate', async route => {
    const body = route.request().postDataJSON() as { date: string; level: CookingLevel };
    expect(body.date).toBe(today);
    levels.push(body.level);
    await route.fulfill({ json: { details: { ...details, name: `Idée de niveau ${body.level}`, seasons: [seasonForDate(today)], level: body.level } } });
  });
  await longPress(page, slot(page).getByRole('button', { name: /générer/ }));
  const menu = page.getByRole('dialog', { name: 'Générer avec l’IA' });
  await menu.getByRole('button', { name: /Haute voltige étoilée/ }).click();
  await expect(slot(page).locator('.meal-cell')).toHaveText('Idée de niveau 4');
  await slot(page, 'dinner').getByRole('button', { name: /générer/ }).click();
  await expect(slot(page, 'dinner').locator('.meal-cell')).toHaveText('Idée de niveau 2');
  expect(levels).toEqual([4, 2]);
  await page.getByRole('button', { name: 'Mon carnet', exact: true }).click();
  await expect(page.getByRole('button', { name: /Idée de niveau 4/ })).toContainText('Haute voltige étoilée');
});

test('niveau de cuisine : menu par appui long ou clic droit dans le dialogue du repas', async ({ page }) => {
  let level: CookingLevel | undefined;
  await page.route('**/api/meals/generate', async route => {
    level = (route.request().postDataJSON() as { level: CookingLevel }).level;
    await route.fulfill({ json: { details: { ...details, name: 'Croque du soir', seasons: [seasonForDate(today)], level: 1 } } });
  });
  await slot(page).locator('.meal-cell').click();
  const editor = page.getByRole('dialog', { name: 'Qu’est-ce qu’on mange ?' });
  await expect(editor.getByRole('button', { name: 'Générer avec l’IA', exact: true })).toHaveAttribute('title', /Appui long/);
  await editor.getByRole('button', { name: 'Générer avec l’IA', exact: true }).click({ button: 'right' });
  await page.getByRole('dialog', { name: 'Générer avec l’IA' }).getByRole('button', { name: /Tablier tout neuf/ }).click();
  await expect(editor).toHaveCount(0);
  expect(level).toBe(1);
  await expect(slot(page).locator('.meal-cell')).toHaveText('Croque du soir');
  await slot(page).locator('.meal-cell').click();
  const meal = page.getByRole('dialog', { name: 'Votre repas' });
  await expect(meal.getByRole('region', { name: 'Recette du repas' })).toContainText('Tablier tout neuf');
  await longPress(page, meal.getByRole('button', { name: 'Choisir au hasard', exact: true }));
  await page.getByRole('dialog', { name: 'Choisir au hasard' }).getByRole('button', { name: /Toque affûtée/ }).click();
  await expect(meal).toHaveCount(0);
  await expect(slot(page).locator('.meal-cell')).toHaveText(byLevel[3].name);
});

test('niveau de cuisine : visible et modifiable dans le carnet', async ({ page }) => {
  await page.getByRole('button', { name: 'Mon carnet', exact: true }).click();
  const card = page.getByRole('button', { name: new RegExp(byLevel[1].name) });
  await expect(card).toContainText('Tablier tout neuf');
  await card.click();
  const editor = page.getByRole('dialog', { name: 'Une page du carnet' });
  await expect(editor.getByRole('button', { name: /Tablier tout neuf/ })).toHaveAttribute('aria-pressed', 'true');
  await editor.getByRole('button', { name: /Toque affûtée/ }).click();
  await editor.getByRole('button', { name: 'Enregistrer la fiche' }).click();
  await expect(card).toContainText('Toque affûtée');
  await expect.poll(() => sent.some(record => record.type === 'dish' && record.id === byLevel[1].id && record.details?.level === 3)).toBe(true);
});
