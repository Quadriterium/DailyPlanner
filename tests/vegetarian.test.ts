import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  catalogCandidates, catalogDrawThreshold, matchesDiet, randomMealCandidates, settingsSchema, vegetarianForSlot,
  type CatalogEntry,
} from '../shared/model';
import { analyzeDish, generateMeal } from '../server/ai';
import { buildApp } from '../server/app';
import { readConfig } from '../server/config';
import { Store } from '../server/database';
import { details, dish, meal } from './fixtures';

const config = readConfig({ DATABASE_PATH: ':memory:', OPENAI_API_KEY: 'test-only' });
const legacySettings = { type: 'settings', id: 'global', model: config.OPENAI_MODEL, modifiedAt: 1, mutationId: randomUUID() };
const vegetarianDetails = {
  ...details, name: 'Omelette aux légumes', seasons: ['autumn' as const], vegetarian: true,
  ingredients: ['4 œufs', '400 g de courge'], items: [{ name: 'œufs', quantity: 4, unit: '' }],
  tags: ['œuf', 'courge'], servings: 4,
};
function answer(vegetarian?: boolean) {
  const { items, servings: _servings, ...value } = vegetarianDetails;
  return new Response(JSON.stringify({
    status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text',
      text: JSON.stringify({ ...value, ingredients: items, vegetarian, troll: false }),
    }] }], usage: { input_tokens: 10, output_tokens: 5 },
  }));
}

describe('Préférences végétariennes', () => {
  it('migre les anciens paramètres sans activer de régime et compose les préférences midi/soir', () => {
    const settings = settingsSchema.parse(legacySettings);
    expect(settings).toMatchObject({ vegetarian: false, vegetarianDinners: false });
    for (const vegetarian of [false, true]) for (const vegetarianDinners of [false, true]) {
      expect(vegetarianForSlot({ vegetarian, vegetarianDinners }, 'lunch')).toBe(vegetarian);
      expect(vegetarianForSlot({ vegetarian, vegetarianDinners }, 'dinner')).toBe(vegetarian || vegetarianDinners);
    }
    expect(matchesDiet(details, true)).toBe(false);
    expect(matchesDiet({ ...details, vegetarian: false }, true)).toBe(false);
    expect(matchesDiet(vegetarianDetails, true)).toBe(true);
    expect(matchesDiet(details)).toBe(true);
  });

  it('filtre carnet, analyses et catalogue sans repli sur un plat non classé ou non végétarien', () => {
    const veggie = dish({ name: vegetarianDetails.name, details: vegetarianDetails });
    const meat = dish({ details: { ...details, vegetarian: false } });
    const unknown = dish({ details });
    const analyzed = dish({ name: 'Gratin végétarien' });
    const analyses = [{ dishId: analyzed.id, analysisKey: analyzed.analysisKey, status: 'ready' as const,
      details: { ...vegetarianDetails, name: analyzed.name }, error: null, updatedAt: 1 }];
    const recipes = [veggie, meat, unknown, analyzed];
    expect(randomMealCandidates(recipes, analyses, [], '2026-10-30', '2026-10-30', 2, true)).toEqual([veggie, analyzed]);
    expect(randomMealCandidates([veggie, meat], [], [meal({ text: veggie.name, dishId: veggie.id })],
      '2026-10-30', '2026-10-30', 2, true)).toEqual([veggie]);
    expect(randomMealCandidates([meat, unknown], [], [], '2026-10-30', '2026-10-30', 2, true)).toEqual([]);
    const entries: CatalogEntry[] = recipes.slice(0, 3).map(recipe => ({ id: recipe.id, details: recipe.details! }));
    expect(catalogCandidates(entries, { date: '2026-10-30', level: 2, avoid: '', excludedNames: [], vegetarian: true }))
      .toEqual([entries[0]]);
  });

  it('demande et conserve le classement lors de l’analyse sans transformer un nom saisi', async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(answer(true));
    const result = await analyzeDish(dish({ name: vegetarianDetails.name }), settingsSchema.parse(legacySettings),
      config, config.OPENAI_MODEL, new AbortController().signal, request);
    expect(result.details.vegetarian).toBe(true);
    const body = JSON.parse(String(request.mock.calls[0][1]?.body));
    expect(body.text.format.schema.required).toContain('vegetarian');
    expect(body.instructions).toContain('bouillon de viande');
  });

  it.each([false, undefined])('refuse une génération non confirmée végétarienne (%s), même comme nom de secours', async vegetarian => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(answer(vegetarian));
    const onName = vi.fn();
    await expect(generateMeal('2026-10-30', 2, { recentMeals: [], existingDishes: [] },
      { ...settingsSchema.parse(legacySettings), vegetarian: true }, config, config.OPENAI_MODEL,
      new AbortController().signal, request, onName)).rejects.toThrow('pas végétarienne');
    expect(onName).not.toHaveBeenCalled();
    const body = JSON.parse(String(request.mock.calls[0][1]?.body));
    expect(JSON.parse(body.input).menuVegetarien).toBe(true);
  });

  it.each([
    [true, false, 'lunch', false, true],
    [true, false, 'dinner', false, true],
    [false, true, 'dinner', false, true],
    [false, true, 'lunch', false, false],
    [false, false, 'lunch', true, true],
  ] as const)('applique les contraintes côté API : global %s, soirs %s, %s, ponctuel %s', async (vegetarian, vegetarianDinners, slot, requested, required) => {
    const store = new Store(config);
    const aiRequest = vi.fn<typeof fetch>().mockImplementation(async () => answer(true));
    const app = await buildApp(store, config, { logger: false, aiRequest, staticRoot: join(tmpdir(), randomUUID()) });
    try {
      store.merge('common', [{ ...settingsSchema.parse(legacySettings), vegetarian, vegetarianDinners }]);
      const response = await app.inject({ method: 'POST', url: '/api/meals/generate',
        payload: { date: '2026-10-30', slot, vegetarian: requested } });
      expect(response.statusCode, response.body).toBe(200);
      expect(response.json().details.vegetarian).toBe(true);
      expect(Boolean(JSON.parse(JSON.parse(String(aiRequest.mock.calls[0][1]?.body)).input).menuVegetarien)).toBe(required);
    } finally { await app.close(); store.close(); }
  });

  it('applique le seuil du catalogue aux seuls plats végétariens et refuse un créneau manquant ou invalide', async () => {
    const store = new Store(config);
    const aiRequest = vi.fn<typeof fetch>().mockImplementation(async () => answer(true));
    const app = await buildApp(store, config, { logger: false, aiRequest, staticRoot: join(tmpdir(), randomUUID()) });
    try {
      store.merge('common', [{ ...settingsSchema.parse(legacySettings), vegetarianDinners: true }]);
      for (let i = 0; i < catalogDrawThreshold; i++) {
        store.addToCatalog({ ...vegetarianDetails, name: `Viande ${i}`, vegetarian: false }, undefined, null);
      }
      const generate = (slot?: string, vegetarian?: unknown) => app.inject({ method: 'POST', url: '/api/meals/generate',
        payload: { date: '2026-10-30', ...(slot ? { slot } : {}), ...(vegetarian !== undefined ? { vegetarian } : {}) } });
      expect((await generate()).statusCode).toBe(400);
      expect((await generate('snack')).statusCode).toBe(400);
      expect((await generate('dinner', 'true')).statusCode).toBe(400);
      expect(aiRequest).not.toHaveBeenCalled();
      expect((await generate('dinner', false)).json().source).toBe('ai');
      expect(aiRequest).toHaveBeenCalledOnce();
      for (let i = 0; i < catalogDrawThreshold; i++) {
        store.addToCatalog({ ...vegetarianDetails, name: `Végétarien ${i}` }, undefined, null);
      }
      const result = await generate('dinner', false);
      expect(result.json()).toMatchObject({ source: 'catalog', details: { vegetarian: true } });
      expect(aiRequest).toHaveBeenCalledOnce();
    } finally { await app.close(); store.close(); }
  });

  it('ne publie ni nom de secours ni fiche après deux réponses non végétariennes', async () => {
    const store = new Store(config);
    const aiRequest = vi.fn<typeof fetch>().mockImplementation(async () => answer(false));
    const app = await buildApp(store, config, { logger: false, aiRequest, staticRoot: join(tmpdir(), randomUUID()) });
    try {
      const response = await app.inject({ method: 'POST', url: '/api/meals/generate',
        payload: { date: '2026-10-30', slot: 'dinner', vegetarian: true } });
      expect(response.statusCode).toBe(502);
      expect(aiRequest).toHaveBeenCalledTimes(2);
      expect(store.catalog()).toEqual([]);
      expect(store.records('common').filter(record => record.type !== 'settings')).toEqual([]);
    } finally { await app.close(); store.close(); }
  });
});
