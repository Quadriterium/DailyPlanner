import { test, expect } from '@playwright/test';
import { parisDate, type Analysis, type RecordData } from '../shared/model';
import { details, snapshot } from '../tests/fixtures';

test('URL de recette : nom précoce, quantités, source, relance et conservation hors ligne', async ({ page }) => {
  const today = parisDate();
  const url = `https://example.org/gratin?source=${'a'.repeat(500)}`;
  const records = new Map<string, RecordData>();
  let phase: 'pending' | 'processing' | 'ready' = 'pending';
  const imported = { ...details, name: 'Gratin de courge', ingredients: ['1,2 kg de courge', '300 ml de crème'],
    recipe: '1. Préparez 1,2 kg de courge.\n2. Ajoutez la crème et faites cuire 30 minutes.' };
  await page.route('**/api/sync', async route => {
    const body = route.request().postDataJSON() as { mutations: RecordData[] };
    for (const record of body.mutations) records.set(`${record.type}:${record.id}`, record);
    const analyses: Analysis[] = [...records.values()].filter(record => record.type === 'dish').map(dish => ({
      dishId: dish.id, analysisKey: dish.analysisKey, status: phase, details: phase === 'ready' ? imported : null,
      ...(phase !== 'pending' ? { name: imported.name } : {}), error: null, updatedAt: Date.now(),
    }));
    await route.fulfill({ json: { ...snapshot([...records.values()]), analyses,
      capabilities: { ...snapshot().capabilities, aiConfigured: true } } });
  });
  await page.goto('/');
  await expect(page.locator('.connection-indicator')).toHaveText('Carnet à jour');
  const cell = page.locator(`[data-date="${today}"] .meal-cell`).first();
  await cell.click();
  await page.getByLabel('Votre idée du jour', { exact: true }).fill(url);
  await page.getByRole('button', { name: 'Garder ce repas' }).click();
  await expect(cell).toHaveText(url);
  await expect.poll(() => records.get(`meal:${today}:lunch`)).toMatchObject({ text: url });
  const dish = [...records.values()].find(record => record.type === 'dish');
  expect(dish).toMatchObject({ name: url, sourceUrl: url });
  await page.getByRole('button', { name: 'Mon carnet', exact: true }).click();
  await page.getByRole('button', { name: /example.org/ }).click();
  await expect(page.getByLabel('Nom du repas', { exact: true })).toHaveValue(url);
  phase = 'processing';
  await expect(page.getByLabel('Nom du repas', { exact: true })).toHaveValue(imported.name);
  await page.getByLabel('Nom du repas', { exact: true }).fill('Ma correction en cours');
  phase = 'ready';
  await expect(page.locator('.recipe-card').filter({ hasText: imported.name })).toContainText('Recette enrichie');
  await expect(page.getByLabel('Nom du repas', { exact: true })).toHaveValue('Ma correction en cours');
  await page.getByRole('button', { name: 'Fermer', exact: true }).click();
  await page.getByRole('button', { name: 'Mon planning', exact: true }).click();
  await expect(cell).toHaveText(imported.name);
  await cell.click();
  await expect(page.getByRole('heading', { name: imported.name, exact: true })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Voir la recette d’origine' })).toHaveAttribute('href', url);
  phase = 'ready';
  await expect(page.getByRole('region', { name: 'Recette du repas' })).toContainText('1,2 kg de courge');
  await expect(page.getByRole('region', { name: 'Recette du repas' })).toContainText('300 ml de crème');
  await page.getByRole('button', { name: 'Fermer', exact: true }).click();
  await page.getByRole('button', { name: 'Mon carnet', exact: true }).click();
  await page.getByRole('button', { name: /Gratin de courge/ }).click();
  await expect(page.getByLabel('Nom du repas', { exact: true })).toHaveValue(imported.name);
  phase = 'pending';
  await page.getByRole('button', { name: 'Relancer l’IA', exact: true }).click();
  await expect.poll(() => {
    const current = dish ? records.get(`dish:${dish.id}`) : undefined;
    return current?.type === 'dish' ? current.analysisKey : undefined;
  }).not.toBe(dish?.type === 'dish' ? dish.analysisKey : undefined);
  expect(dish ? records.get(`dish:${dish.id}`) : undefined).toMatchObject({ name: imported.name, sourceUrl: url });
  phase = 'ready';
  await page.getByRole('button', { name: 'Mon planning', exact: true }).click();
  await cell.click();
  await expect(page.getByRole('region', { name: 'Recette du repas' })).toContainText('300 ml de crème');
  await page.getByRole('button', { name: 'Fermer', exact: true }).click();
  await page.route('**/api/sync', route => route.abort());
  await page.reload();
  await expect(cell).toHaveText(imported.name);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});
