import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildApp } from '../server/app';
import { readConfig } from '../server/config';
import { Store } from '../server/database';
import { AiWorker } from '../server/ai';
import {
  addDays, avoidTerms, catalogCandidates, catalogDrawThreshold, catalogResponseSchema, containsAvoided, householdPortions,
  recentMealNames, type CatalogEntry, type DishDetails,
} from '../shared/model';
import { details, dish, meal } from './fixtures';

const config = readConfig({ DATABASE_PATH: ':memory:', OPENAI_API_KEY: 'test-key-not-real' });
const structured = (name: string, extra: Partial<DishDetails> = {}): DishDetails => ({
  ...details, name, seasons: ['autumn'], level: 2, servings: 4,
  ingredients: ['500 g de courge', '2 oignons', 'sel'],
  items: [{ name: 'courge', quantity: 500, unit: 'g' }, { name: 'oignons', quantity: 2, unit: '' }, { name: 'sel', quantity: null, unit: '' }],
  tags: ['courge', 'oignon'],
  ...extra,
});
const entry = (name: string, extra: Partial<DishDetails> = {}): CatalogEntry => ({ id: randomUUID(), details: structured(name, extra) });
const aiAnswer = (value: object) => new Response(JSON.stringify({
  status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify(value) }] }],
  usage: { input_tokens: 10, output_tokens: 5 },
}));
const aiStructured = (name: string) => ({
  name, seasons: ['autumn'], level: 2, recipe: '1. Cuire.', tags: ['courge'],
  ingredients: [{ name: 'courge', quantity: 800, unit: 'g' }, { name: 'poivre', quantity: null, unit: '' }],
});

describe('Règles du catalogue commun', () => {
  it('compte une demi-portion par enfant', () => {
    expect(householdPortions({ adults: 2, teenagers: 1, children: 3 })).toBe(4.5);
  });
  it('reconnaît les aliments à éviter malgré accents, pluriels et formulations', () => {
    const terms = avoidTerms('Pas de champignons ; sans œufs, crevettes et noix\nporc');
    expect(terms).toEqual(expect.arrayContaining(['champignon', 'oeuf', 'crevette', 'noix', 'porc']));
    expect(containsAvoided(structured('Velouté', { tags: ['Champignon de Paris'] }), terms)).toBe(true);
    expect(containsAvoided(structured('Omelette', { ingredients: ['3 œufs'] }), terms)).toBe(true);
    expect(containsAvoided(structured('Rôti de porc'), terms)).toBe(true);
    expect(containsAvoided(structured('Gratin de courge'), terms)).toBe(false);
    // Whole words only: "porc" must not exclude "porcelaine"; "noix" stays "noix" and still matches "noix de cajou".
    expect(containsAvoided(structured('Porcelaine de courge', { tags: [] }), avoidTerms('porc'))).toBe(false);
    expect(containsAvoided(structured('Poulet aux noix de cajou'), terms)).toBe(true);
    expect(avoidTerms('choux')).toEqual(['chou']);
    expect(avoidTerms('   ')).toEqual([]);
  });
  it('filtre par saison, niveau, repas récents et aliments à éviter', () => {
    const entries = [
      entry('Gratin de courge'), entry('Salade d’été', { seasons: ['summer'] }), entry('Soupe toute l’année', { seasons: ['all'] }),
      entry('Pot-au-feu', { level: 3 }), entry('Risotto aux champignons', { tags: ['champignon'] }), entry('Curry de courge'),
    ];
    const names = catalogCandidates(entries, { date: '2026-10-30', level: 2, avoid: 'champignons', excludedNames: ['  CURRY de courge '] })
      .map(candidate => candidate.details.name);
    expect(names).toEqual(['Gratin de courge', 'Soupe toute l’année']);
  });
  it('cherche les repas récents à plus ou moins 15 jours de la date du repas, avec les noms des fiches liées', () => {
    const recipe = dish({ name: 'nom brut', details: { ...details, name: 'Nom corrigé' } });
    const date = '2026-10-30';
    const names = recentMealNames([recipe, meal({ date: addDays(date, -15), text: 'Avant', dishId: recipe.id }),
      meal({ id: 'x', date: addDays(date, 16), text: 'Trop tard' })], [], date);
    expect(names).toEqual(['Avant', 'nom brut', 'Nom corrigé']);
  });
});

describe('Stockage du catalogue', () => {
  let store: Store;
  beforeEach(() => { store = new Store(config); });
  afterEach(() => store.close());
  it('n’accepte que les fiches structurées, sans doublon de nom, et publie les changements dans l’ordre', () => {
    expect(store.addToCatalog(details, undefined, 'common')).toBeUndefined();
    const first = store.addToCatalog(structured('Gratin de courge'), 'https://example.org/gratin', 'common')!;
    expect(store.addToCatalog(structured('  GRATIN de courge '), undefined, 'common')).toBeUndefined();
    store.addToCatalog(structured('Curry de courge'), undefined, null);
    const all = store.catalogChanges(0);
    expect(all).toMatchObject({ catalogId: store.catalogId(), more: false, removed: [] });
    expect(all.entries.map(item => item.details.name)).toEqual(['Gratin de courge', 'Curry de courge']);
    expect(all.entries[0].sourceUrl).toBe('https://example.org/gratin');
    expect(store.catalogChanges(0, 1)).toMatchObject({ more: true, cursor: 1 });
    store.setCatalogRemoved(first.id.slice(0, 8), true);
    const later = store.catalogChanges(all.cursor);
    expect(later).toMatchObject({ entries: [], removed: [first.id] });
    expect(store.catalog().map(item => item.details.name)).toEqual(['Curry de courge']);
    // The name becomes free again once the entry is removed.
    expect(store.addToCatalog(structured('Gratin de courge'), undefined, 'common')).toBeDefined();
    expect(() => store.setCatalogRemoved(first.id, false)).toThrow('déjà ce nom');
    const corrected = store.correctCatalogEntry(store.catalogEntries('curry')[0].id, structured('Curry doux de courge'));
    expect(store.catalogChanges(later.cursor).entries).toContainEqual(corrected);
  });
});

describe('Génération à partir du catalogue', () => {
  let store: Store;
  let app: Awaited<ReturnType<typeof buildApp>>;
  const aiRequest = vi.fn<typeof fetch>();
  beforeEach(async () => {
    aiRequest.mockReset();
    store = new Store(config);
    app = await buildApp(store, config, { logger: false, aiRequest, staticRoot: join(tmpdir(), randomUUID()) });
  });
  afterEach(async () => { await app.close(); store.close(); });
  const fill = (count: number, extra: Partial<DishDetails> = {}) => {
    for (let i = 0; i < count; i++) store.addToCatalog(structured(`Plat ${i}`, extra), undefined, null);
  };

  it(`pioche dans le catalogue sans appel IA ni quota dès ${catalogDrawThreshold} fiches adaptées`, async () => {
    fill(catalogDrawThreshold);
    const response = await app.inject({ method: 'POST', url: '/api/meals/generate', payload: { date: '2026-10-30', level: 2 } });
    expect(response.statusCode).toBe(200);
    expect(response.json().source).toBe('catalog');
    expect(response.json().details.name).toMatch(/^Plat \d+$/);
    expect(aiRequest).not.toHaveBeenCalled();
    expect(store.capabilities(new Date(), 'common').callsToday).toBe(0);
  });
  it('appelle l’IA et enrichit le catalogue quand les fiches adaptées sont insuffisantes', async () => {
    fill(catalogDrawThreshold - 1);
    fill(5, { level: 3 });
    store.merge('common', [meal({ id: '2026-11-10:lunch', date: '2026-11-10', text: 'Plat 0' })]);
    aiRequest.mockResolvedValue(aiAnswer(aiStructured('Velouté de courge')));
    const response = await app.inject({ method: 'POST', url: '/api/meals/generate', payload: { date: '2026-10-30', level: 2 } });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toMatchObject({ source: 'ai', details: { name: 'Velouté de courge', servings: 4, ingredients: ['800 g de courge', 'poivre'] } });
    const input = JSON.parse(JSON.parse(String(aiRequest.mock.calls[0][1]?.body)).input);
    expect(input.platsDejaCrees).toContain('Plat 13');
    expect(input.repasChoisis).toEqual(['Plat 0']);
    expect(store.catalog().map(item => item.details.name)).toContain('Velouté de courge');
  });
  it('ignore les fiches contenant un aliment à éviter et les repas choisis autour de la date', async () => {
    fill(catalogDrawThreshold);
    store.merge('common', [{ ...store.settings('common'), avoid: 'oignons', modifiedAt: Date.now(), mutationId: randomUUID() }]);
    aiRequest.mockResolvedValue(aiAnswer(aiStructured('Courge rôtie')));
    const response = await app.inject({ method: 'POST', url: '/api/meals/generate', payload: { date: '2026-10-30', level: 2 } });
    expect(response.json().source).toBe('ai');
    expect(aiRequest).toHaveBeenCalledOnce();
  });
  it('expose le catalogue sans session, par pages, et refuse une position invalide', async () => {
    fill(3);
    const response = await app.inject({ method: 'GET', url: '/api/catalog?after=1' });
    expect(response.statusCode).toBe(200);
    const body = catalogResponseSchema.parse(response.json());
    expect(body.entries.map(item => item.details.name)).toEqual(['Plat 1', 'Plat 2']);
    expect((await app.inject({ method: 'GET', url: '/api/catalog?after=-1' })).statusCode).toBe(400);
  });
  it('ajoute au catalogue les fiches enrichies par le worker', async () => {
    const recipe = dish({ name: 'velouté courge' });
    store.merge('common', [recipe]);
    const request = vi.fn<typeof fetch>().mockResolvedValue(aiAnswer({ ...aiStructured('Velouté de courge'), seasons: ['autumn'] }));
    await new AiWorker(store, config, vi.fn(), request).tick();
    expect(store.analysis('common', recipe.id)?.status).toBe('ready');
    expect(store.catalog()).toEqual([expect.objectContaining({ details: expect.objectContaining({ name: 'Velouté de courge' }) })]);
  });
  it('demande le drapeau troll à l’IA et garde une fiche troll dans le seul carnet de son créateur', async () => {
    const recipe = dish({ name: 'gratin de chaussettes' });
    store.merge('common', [recipe]);
    const request = vi.fn<typeof fetch>().mockResolvedValue(aiAnswer({ ...aiStructured('Gratin de chaussettes'), troll: true }));
    await new AiWorker(store, config, vi.fn(), request).tick();
    const body = JSON.parse(String(request.mock.calls[0][1]?.body));
    expect(body.text.format.schema.required).toContain('troll');
    expect(body.instructions).toContain('troll');
    expect(store.analysis('common', recipe.id)).toMatchObject({ status: 'ready', details: { name: 'Gratin de chaussettes' } });
    expect(store.catalog()).toEqual([]);
  });
  it('n’ajoute pas au catalogue une proposition générée marquée troll', async () => {
    aiRequest.mockResolvedValue(aiAnswer({ ...aiStructured('Soupe de cailloux'), troll: true }));
    const response = await app.inject({ method: 'POST', url: '/api/meals/generate', payload: { date: '2026-10-30', level: 2 } });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toMatchObject({ source: 'ai', details: { name: 'Soupe de cailloux' } });
    expect(store.catalog()).toEqual([]);
  });
});
