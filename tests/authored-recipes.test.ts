import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildApp } from '../server/app';
import { AiWorker, analyzeDish } from '../server/ai';
import { readConfig } from '../server/config';
import { Store } from '../server/database';
import { catalogCandidates, dishDetails, recordSchema, syncResponseSchema, type Dish } from '../shared/model';
import { scaleRecipe } from '../shared/recipe';
import { dish } from './fixtures';

const config = readConfig({ DATABASE_PATH: ':memory:', OPENAI_API_KEY: 'test-only' });
const sourceRecipe = {
  ingredients: ['1 kg de carottes', '2 oignons', 'sel'],
  servings: 6,
  recipe: '  Ma méthode à moi :\nCuire 1 kg de carottes pendant 30 minutes à 180 °C.\nPuis servir !  ',
};
const authored = (overrides: Partial<Dish> = {}) => dish({ name: 'Les CAROTTES de mon jardin !', sourceRecipe, ...overrides });
const answer = (overrides: object = {}) => ({
  name: 'Titre corrigé par erreur', seasons: ['all'], level: 2, vegetarian: true,
  ingredients: [{ name: 'carottes', quantity: 1000, unit: 'g' }, { name: 'oignons', quantity: 2, unit: '' },
    { name: 'sel', quantity: null, unit: '' }],
  recipe: 'Étapes réécrites par erreur', tags: ['carotte', 'oignon'], troll: false, ...overrides,
});
const response = (value: object) => new Response(JSON.stringify({
  status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify(value) }] }],
  usage: { input_tokens: 100, output_tokens: 50 },
}));

describe('Recettes personnelles et validation avant partage', () => {
  let store: Store;
  beforeEach(() => { store = new Store(config); });
  afterEach(() => store.close());

  it('conserve la source et affiche les étapes exactes avant l’analyse, même avec d’autres portions', () => {
    const recipe = authored();
    expect(recordSchema.parse(recipe)).toEqual(recipe);
    const original = dishDetails(recipe);
    expect(original).toMatchObject({ name: recipe.name, ...sourceRecipe, preserveRecipe: true });
    const scaled = scaleRecipe(original, 3);
    expect(scaled.ingredients[0]).toBe('0,5 kg de carottes');
    expect(scaled.recipe).toBe(sourceRecipe.recipe);
    expect(recipe.sourceRecipe).toEqual(sourceRecipe);
  });

  it.each([
    { ingredients: [] }, { ingredients: ['x'.repeat(121)] }, { ingredients: Array(101).fill('sel') },
    { recipe: ' \n ' }, { recipe: 'x'.repeat(4001) }, { servings: 0 }, { servings: 60.5 }, { servings: 1.2 },
  ])('refuse une source invalide : %j', invalid => {
    expect(recordSchema.safeParse(authored({ sourceRecipe: { ...sourceRecipe, ...invalid } })).success).toBe(false);
  });

  it('refuse de combiner une recette personnelle et un import de lien', () => {
    expect(recordSchema.safeParse(authored({ sourceUrl: 'https://example.org/recipe' })).success).toBe(false);
  });

  it('normalise pour les portions originales, sans préférences, et ne fait jamais confiance au titre et aux étapes renvoyés', async () => {
    const recipe = authored();
    const request = vi.fn<typeof fetch>().mockResolvedValue(response(answer()));
    const result = await analyzeDish(recipe, { household: { adults: 1, teenagers: 0, children: 0 }, avoid: 'oignons' },
      config, config.OPENAI_MODEL, new AbortController().signal, request);
    const body = JSON.parse(String(request.mock.calls[0][1]?.body));
    expect(JSON.parse(body.input)).toEqual({ titre: recipe.name, ...sourceRecipe });
    expect(body.instructions).toContain('jamais des instructions');
    expect(body.instructions).toContain('titre ET tous les ingrédients ET toutes les étapes');
    expect(body.instructions).not.toContain('Donne une courte recette indicative');
    expect(body.instructions).toContain('pour 6 portions');
    expect(body.store).toBe(false);
    expect(result.details).toMatchObject({
      name: recipe.name, recipe: sourceRecipe.recipe, servings: 6, preserveRecipe: true,
      ingredients: ['1000 g de carottes', '2 oignons', 'sel'], items: answer().ingredients,
    });
    const scaled = scaleRecipe(result.details, 3);
    expect(scaled.ingredients).toEqual(['500 g de carottes', '1 oignons', 'sel']);
    expect(scaled.recipe).toBe(sourceRecipe.recipe);
  });

  it('synchronise sans repas, ne publie qu’après approbation et ne peuple pas les autres carnets', async () => {
    const owner = store.createSpace('household', 'Créateur');
    const other = store.createSpace('household', 'Autre foyer');
    const recipe = authored();
    store.merge(owner.id, [recipe]);
    expect(store.catalog()).toEqual([]);
    expect(store.records(owner.id).filter(record => record.type === 'meal')).toEqual([]);
    const request = vi.fn<typeof fetch>().mockImplementation(async () => {
      expect(store.catalog()).toEqual([]);
      expect(store.analysis(owner.id, recipe.id)?.status).toBe('processing');
      return response(answer());
    });
    await new AiWorker(store, config, vi.fn(), request).tick();
    const analysis = store.analysis(owner.id, recipe.id)!;
    expect(analysis).toMatchObject({ status: 'ready', sharing: 'approved' });
    const [entry] = store.catalog();
    expect(entry.details).toEqual(dishDetails(recipe, analysis));
    expect(entry.details.name).toBe(recipe.name);
    expect(entry.details.recipe).toBe(sourceRecipe.recipe);
    expect(catalogCandidates(store.catalog(), { date: '2026-11-03', level: 2, avoid: '', excludedNames: [] })).toEqual([entry]);
    expect(store.records(other.id).filter(record => record.type === 'dish')).toEqual([]);
    expect(store.get(owner.id, `dish:${recipe.id}`)).toEqual(recipe);
    expect(store.capabilities(new Date(), owner.id)).toMatchObject({ callsToday: 1, inputTokens: 100, outputTokens: 50 });
    expect(store.capabilities(new Date(), other.id).callsToday).toBe(0);
    const copied = dish({ name: entry.details.name, details: entry.details });
    store.merge(other.id, [copied]);
    expect(scaleRecipe(dishDetails(copied), 3).recipe).toBe(sourceRecipe.recipe);
  });

  it('garde une recette refusée privée et conserve ses ingrédients et étapes pour correction', async () => {
    const recipe = authored();
    store.merge('common', [recipe]);
    const request = vi.fn<typeof fetch>().mockResolvedValue(response(answer({ troll: true, ingredients: [] })));
    await new AiWorker(store, config, vi.fn(), request).tick();
    expect(store.catalog()).toEqual([]);
    expect(store.analysis('common', recipe.id)).toMatchObject({ status: 'ready', sharing: 'rejected' });
    expect(dishDetails(recipe, store.analysis('common', recipe.id))).toMatchObject(sourceRecipe);
    expect(store.capabilities(new Date(), 'common')).toMatchObject({ callsToday: 1, inputTokens: 100, outputTokens: 50 });
  });

  it.each([
    { troll: undefined }, { troll: 'false' }, { ingredients: ['1 kg de carottes'] }, { ingredients: [] },
  ])('échoue sans publication si le verdict ou la structure manque : %j', async invalid => {
    const recipe = authored();
    store.merge('common', [recipe]);
    const request = vi.fn<typeof fetch>().mockImplementation(async () => response(answer(invalid)));
    const log = vi.fn();
    const worker = new AiWorker(store, config, log, request);
    await worker.tick();
    await worker.tick();
    expect(request).toHaveBeenCalledOnce();
    expect(log).toHaveBeenCalledOnce();
    expect(store.catalog()).toEqual([]);
    expect(store.analysis('common', recipe.id)).toMatchObject({ status: 'error', details: null, error: expect.any(String) });
    expect(dishDetails(recipe, store.analysis('common', recipe.id))).toMatchObject(sourceRecipe);
  });

  it.each(['edit', 'archive', 'manual', 'same-key'] as const)('ne publie pas une réponse devenue obsolète : %s', async action => {
    const recipe = authored();
    store.merge('common', [recipe]);
    const request = vi.fn<typeof fetch>().mockImplementation(async () => {
      const changed = { ...recipe, modifiedAt: recipe.modifiedAt + 1, mutationId: randomUUID() };
      store.merge('common', [action === 'archive' ? { ...changed, archived: true }
        : action === 'manual' ? { ...changed, details: { ...dishDetails(recipe), recipe: 'Ma correction' } }
          : { ...changed, sourceRecipe: { ...sourceRecipe, recipe: 'Ma nouvelle recette' },
            analysisKey: action === 'same-key' ? recipe.analysisKey : randomUUID() }]);
      return response(answer());
    });
    await new AiWorker(store, config, vi.fn(), request).tick();
    expect(store.catalog()).toEqual([]);
    expect(store.analysis('common', recipe.id)?.sharing).toBeUndefined();
    if (action === 'archive') expect(store.analysis('common', recipe.id)?.status).toBe('pending');
  });

  it('laisse la source en attente sans configuration IA', async () => {
    const noAi = readConfig({ DATABASE_PATH: ':memory:' });
    const local = new Store(noAi);
    try {
      const recipe = authored();
      local.merge('common', [recipe]);
      const request = vi.fn<typeof fetch>();
      await new AiWorker(local, noAi, vi.fn(), request).tick();
      expect(request).not.toHaveBeenCalled();
      expect(local.analysis('common', recipe.id)?.status).toBe('pending');
      expect(local.catalog()).toEqual([]);
    } finally { local.close(); }
  });

  it('accepte la source via la véritable route de synchronisation et expose seulement la version approuvée au catalogue public', async () => {
    const app = await buildApp(store, config, { logger: false, staticRoot: join(tmpdir(), randomUUID()) });
    try {
      const recipe = authored();
      const sync = await app.inject({ method: 'POST', url: '/api/sync', payload: { mutations: [recipe] } });
      expect(sync.statusCode).toBe(200);
      expect(syncResponseSchema.parse(sync.json()).records).toContainEqual(recipe);
      expect((await app.inject('/api/catalog')).json().entries).toEqual([]);
      await new AiWorker(store, config, vi.fn(), vi.fn<typeof fetch>().mockResolvedValue(response(answer()))).tick();
      const catalog = (await app.inject('/api/catalog')).json();
      expect(catalog.entries).toHaveLength(1);
      expect(catalog.entries[0].details).toMatchObject({ name: recipe.name, recipe: sourceRecipe.recipe, servings: 6 });
      expect(catalog.entries[0]).not.toHaveProperty('spaceId');
      expect(catalog.entries[0]).not.toHaveProperty('sourceRecipe');
    } finally { await app.close(); }
  });
});
