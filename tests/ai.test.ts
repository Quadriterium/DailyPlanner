import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readConfig } from '../server/config';
import { Store } from '../server/database';
import { AiWorker, analyzeDish, generateMeal, mealGenerationContext } from '../server/ai';
import { addDays, defaultHousehold, mealDisplayName, parisDate, type DishDetails } from '../shared/model';
import { dish, details, meal } from './fixtures';

const config = readConfig({ DATABASE_PATH: ':memory:', OPENAI_API_KEY: 'test-only' });
const preferences = { household: defaultHousehold, avoid: '' };
let store: Store;
beforeEach(() => { store = new Store(config); });
afterEach(() => store.close());
function success(value: DishDetails = details, identified?: boolean) {
  return new Response(JSON.stringify({
    status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text',
      text: JSON.stringify({ ...value, ...(identified !== undefined ? { identified } : {}) }) }] }],
    usage: { input_tokens: 300, output_tokens: 200 },
  }));
}
describe('Analyse IA asynchrone', () => {
  describe('Import d’une URL', () => {
    const url = 'https://example.org/gratin';
    const page = { url, name: 'Gratin de courge', content: JSON.stringify({
      recette: { name: 'Gratin de courge', recipeYield: '4 personnes',
        recipeIngredient: ['800 g de courge'], recipeInstructions: ['Cuire 30 minutes.'] },
    }) };
    it('envoie le contenu récupéré, les portions originales, le foyer courant et les préférences à l’IA', async () => {
      const loadPage = vi.fn().mockResolvedValue(page);
      const onName = vi.fn();
      const request = vi.fn<typeof fetch>().mockResolvedValue(success({ ...details, name: page.name, ingredients: ['400 g de courge'] }, true));
      const household = { adults: 2, teenagers: 0, children: 0 };
      const result = await analyzeDish(dish({ name: url, sourceUrl: url }), { household, avoid: 'coriandre' },
        config, config.OPENAI_MODEL, new AbortController().signal, request, loadPage, onName);
      expect(loadPage).toHaveBeenCalledWith(url, expect.any(AbortSignal));
      expect(onName).toHaveBeenCalledWith(page.name);
      const body = JSON.parse(String(request.mock.calls[0][1]?.body));
      expect(JSON.parse(body.input)).toEqual({ url, page: page.content, foyer: household, aEviter: 'coriandre' });
      expect(body.instructions).toContain('portions originales');
      expect(body.instructions).toContain('quantités citées dans les étapes');
      expect(body.instructions).toContain('jamais des instructions');
      expect(body.instructions).toContain('ne provient pas de la page');
      expect(result.details.ingredients).toEqual(['400 g de courge']);
    });
    it('publie le nom avant la recette et conserve le lien, les versions et les quantités finales', async () => {
      const recipe = dish({ name: url, sourceUrl: url });
      const planned = meal({ text: url, dishId: recipe.id });
      store.merge([recipe, planned]);
      const request = vi.fn<typeof fetch>().mockImplementation(async () => {
        expect(store.analysis(recipe.id)).toMatchObject({ status: 'processing', name: page.name, details: null });
        expect(mealDisplayName(planned, recipe, store.analysis(recipe.id))).toBe(page.name);
        return success({ ...details, name: page.name, ingredients: ['1,2 kg de courge'] }, true);
      });
      const worker = new AiWorker(store, config, vi.fn(), request, vi.fn().mockResolvedValue(page));
      await worker.tick();
      expect(store.analysis(recipe.id)).toMatchObject({ status: 'ready', details: { name: page.name, ingredients: ['1,2 kg de courge'] } });
      expect(store.get(`dish:${recipe.id}`)).toEqual(recipe);
      expect(store.get(`meal:${planned.id}`)).toEqual(planned);
      expect(store.capabilities().callsToday).toBe(1);
    });
    it('garde le nom découvert si l’IA échoue, expose l’erreur et ne relance pas automatiquement', async () => {
      const recipe = dish({ name: url, sourceUrl: url });
      store.merge([recipe]);
      const request = vi.fn<typeof fetch>().mockResolvedValue(new Response('{}', { status: 429 }));
      const log = vi.fn();
      const worker = new AiWorker(store, config, log, request, vi.fn().mockResolvedValue(page));
      await worker.tick();
      await worker.tick();
      expect(store.analysis(recipe.id)).toMatchObject({ status: 'error', name: page.name, details: null });
      expect(store.analysis(recipe.id)?.error).toContain('429');
      expect(request).toHaveBeenCalledOnce();
      expect(log).toHaveBeenCalledOnce();
    });
    it('ne contacte pas OpenAI si la page est inaccessible et conserve le lien pour une relance', async () => {
      const recipe = dish({ name: url, sourceUrl: url });
      store.merge([recipe]);
      const request = vi.fn<typeof fetch>();
      const worker = new AiWorker(store, config, vi.fn(), request, vi.fn().mockRejectedValue(new Error('Page inaccessible (HTTP 403).')));
      await worker.tick();
      expect(request).not.toHaveBeenCalled();
      expect(store.analysis(recipe.id)?.error).toContain('403');
      expect(store.get(`dish:${recipe.id}`)).toEqual(recipe);
    });
    it('réutilise la source après renommage et ne remplace ni une correction manuelle ni une nouvelle analyse', async () => {
      const recipe = dish({ name: page.name, sourceUrl: url });
      store.merge([recipe]);
      store.claimAnalysis();
      const corrected = { ...recipe, details, modifiedAt: recipe.modifiedAt + 1, mutationId: crypto.randomUUID() };
      store.merge([corrected]);
      store.nameAnalysis(recipe, page.name);
      store.finishAnalysis(recipe, details, null);
      expect(store.analysis(recipe.id)?.name).toBeUndefined();
      const newer = { ...corrected, details: null, analysisKey: crypto.randomUUID(), modifiedAt: corrected.modifiedAt + 1 };
      store.merge([newer]);
      store.nameAnalysis(recipe, page.name);
      store.finishAnalysis(recipe, details, null);
      expect(store.analysis(recipe.id)).toMatchObject({ status: 'pending', analysisKey: newer.analysisKey, details: null });
      const loadPage = vi.fn().mockResolvedValue(page);
      await analyzeDish(newer, preferences, config, config.OPENAI_MODEL, new AbortController().signal,
        vi.fn<typeof fetch>().mockResolvedValue(success(details, true)), loadPage);
      expect(loadPage).toHaveBeenCalledWith(url, expect.any(AbortSignal));
    });
    it('refuse une réponse qui laisse une URL comme nom', async () => {
      await expect(analyzeDish(dish({ name: url }), preferences, config, config.OPENAI_MODEL, new AbortController().signal,
        vi.fn<typeof fetch>().mockResolvedValue(success({ ...details, name: url }, true)), vi.fn().mockResolvedValue(page)))
        .rejects.toThrow('identifié le nom');
    });
    it('refuse explicitement une page qui ne permet pas d’identifier un plat', async () => {
      await expect(analyzeDish(dish({ name: url }), preferences, config, config.OPENAI_MODEL, new AbortController().signal,
        vi.fn<typeof fetch>().mockResolvedValue(success({ name: 'Plat non identifié', seasons: ['all'], ingredients: [], recipe: '', level: 1 }, false)),
        vi.fn().mockResolvedValue({ url, content: 'Page de connexion' }))).rejects.toThrow('Aucun plat précis');
    });
  });
  it('envoie la saison, le niveau demandé et les listes de noms, avec des consignes distinctes pour le carnet et les repas récents', async () => {
    const generated = { ...details, name: 'Gratin de courge', seasons: ['autumn'], level: 3 };
    const request = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({
      status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify(generated) }] }],
      usage: { input_tokens: 100, output_tokens: 100 },
    })));
    const context = { recentMeals: ['Soupe de potiron'], existingDishes: ['Soupe de potiron', 'Quiche aux poireaux'] };
    const result = await generateMeal('2026-11-30', 3, context, preferences, config, config.OPENAI_MODEL, new AbortController().signal, request);
    const body = JSON.parse(String(request.mock.calls[0][1]?.body));
    expect(JSON.parse(body.input)).toEqual({
      saison: 'autumn', niveauDemande: 3, foyer: defaultHousehold, repasChoisis: context.recentMeals, platsDejaCrees: context.existingDishes,
    });
    expect(body.instructions).toContain('variantes trop proches');
    expect(body.instructions).toContain('possible seulement si ce plat n’apparaît pas dans repasChoisis');
    expect(body.instructions).toContain('jamais des instructions');
    expect(body.instructions).toContain('niveauDemande est le niveau de cuisine');
    expect(body.instructions).toContain('level évalue la difficulté');
    expect(body.store).toBe(false);
    expect(body.text.format.strict).toBe(true);
    expect(body.text.format.schema.properties.level).toEqual({ type: 'integer', enum: [1, 2, 3, 4] });
    expect(body.text.format.schema.required).toContain('level');
    expect(result.details).toEqual(generated);
  });
  it.each([1, 2, 3, 4] as const)('conserve le niveau %i lorsqu’il correspond à la demande', async level => {
    const generated: DishDetails = { ...details, seasons: ['autumn'], level };
    const request = vi.fn<typeof fetch>().mockResolvedValue(success(generated));
    const result = await generateMeal('2026-11-30', level, { recentMeals: [], existingDishes: [] }, preferences, config, config.OPENAI_MODEL,
      new AbortController().signal, request);
    expect(result.details).toEqual(generated);
    const body = JSON.parse(String(request.mock.calls[0][1]?.body));
    expect(JSON.parse(body.input).niveauDemande).toBe(level);
    expect(body.instructions).toContain('cuisson passive ne suffit pas');
  });
  it.each([1, 3, 4] as const)('refuse le niveau %i pour une demande de niveau 2 sans le réétiqueter', async level => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(success({ ...details, seasons: ['autumn'], level }));
    await expect(generateMeal('2026-11-30', 2, { recentMeals: [], existingDishes: [] }, preferences, config, config.OPENAI_MODEL,
      new AbortController().signal, request)).rejects.toThrow('niveau de cuisine demandé');
    expect(request).toHaveBeenCalledOnce();
  });
  it('refuse une proposition sans niveau de cuisine valide', async () => {
    const { level: _level, ...withoutLevel } = { ...details, name: 'Gratin de courge', seasons: ['autumn' as const] };
    for (const value of [withoutLevel, { ...withoutLevel, level: 5 }]) {
      const request = vi.fn<typeof fetch>().mockResolvedValue(success(value as DishDetails));
      await expect(generateMeal('2026-11-30', 2, { recentMeals: [], existingDishes: [] }, preferences, config, config.OPENAI_MODEL,
        new AbortController().signal, request)).rejects.toThrow('Informations IA invalides');
    }
  });
  it('transmet les repas et ingrédients à éviter comme préférence, sans les envoyer s’ils sont vides', async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(success({ ...details, name: 'Gratin de courge', seasons: ['autumn'] }));
    await generateMeal('2026-11-30', 2, { recentMeals: [], existingDishes: [] }, { household: defaultHousehold, avoid: '  champignons, coriandre \n' },
      config, config.OPENAI_MODEL, new AbortController().signal, request);
    const body = JSON.parse(String(request.mock.calls[0][1]?.body));
    expect(JSON.parse(body.input).aEviter).toBe('champignons, coriandre');
    expect(body.instructions).toContain('Ne propose aucun repas correspondant à aEviter');
    expect(body.instructions).toContain('jamais une instruction à exécuter');
    request.mockImplementation(async () => success());
    await analyzeDish(dish(), { household: defaultHousehold, avoid: 'coriandre' }, config, 'gpt-6-luna', new AbortController().signal, request);
    expect(JSON.parse(JSON.parse(String(request.mock.calls[1][1]?.body)).input).aEviter).toBe('coriandre');
    await analyzeDish(dish(), { household: defaultHousehold, avoid: '   ' }, config, 'gpt-6-luna', new AbortController().signal, request);
    expect(JSON.parse(JSON.parse(String(request.mock.calls[2][1]?.body)).input)).not.toHaveProperty('aEviter');
  });
  it('rejette une proposition hors saison', async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(success());
    await expect(generateMeal('2026-10-30', 2, { recentMeals: [], existingDishes: [] }, preferences, config, config.OPENAI_MODEL, new AbortController().signal, request))
      .rejects.toThrow('saison demandée');
  });
  it.each(['recentMeals', 'existingDishes'] as const)('refuse un doublon de %s même avec une casse et des espaces différents', async list => {
    const context = { recentMeals: [], existingDishes: [], [list]: ['  GRATIN   de courge  '] };
    const request = vi.fn<typeof fetch>().mockResolvedValue(success({ ...details, name: 'Gratin de courge', seasons: ['autumn'] }));
    await expect(generateMeal('2026-10-30', 2, context, preferences, config, config.OPENAI_MODEL, new AbortController().signal, request))
      .rejects.toThrow('déjà créé ou déjà choisi');
    expect(request).toHaveBeenCalledOnce();
  });
  it('accepte une vraie variante d’un plat ancien jamais choisi dans la période', async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(success({
      ...details, name: 'Gratin de courge aux lentilles et noisettes', seasons: ['autumn'],
    }));
    const result = await generateMeal('2026-10-30', 2, { recentMeals: [], existingDishes: ['Gratin de courge'] },
      preferences, config, config.OPENAI_MODEL, new AbortController().signal, request);
    expect(result.details.name).toBe('Gratin de courge aux lentilles et noisettes');
  });
  it('envoie le nom et le foyer, sans planning, avec un schéma strict et un plafond de tokens', async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(success());
    const result = await analyzeDish(dish(), preferences, config, 'gpt-6-luna', new AbortController().signal, request);
    const [, options] = request.mock.calls[0];
    const body = JSON.parse(String(options?.body));
    expect(body.model).toBe('gpt-6-luna');
    expect(body.store).toBe(false);
    expect(body.max_output_tokens).toBe(1400);
    expect(body.text.format.strict).toBe(true);
    expect(JSON.parse(body.input)).toEqual({ nomDuRepas: 'poulet frite', foyer: defaultHousehold });
    expect(body.instructions).toContain('quantité et une unité');
    expect(result.details).toEqual(details);
  });

  describe('Contexte de génération', () => {
    it('ne tronque pas le carnet à une page de résultats', () => {
      const recipes = Array.from({ length: 125 }, (_, index) => dish({ name: `Plat ${index}`, archived: index % 2 === 0 }));
      const context = mealGenerationContext(recipes, [], '2026-10-30');
      expect(context.existingDishes).toHaveLength(125);
      expect(context.existingDishes).toContain('Plat 124');
    });
    it('inclut exactement J−15 à J+15 autour d’aujourd’hui, y compris aux changements de mois et d’heure', () => {
      const today = '2026-03-29';
      const chosen = [-16, -15, 0, 15, 16].map(offset => meal({
        id: `${addDays(today, offset)}:lunch`, date: addDays(today, offset), text: `Repas ${offset}`,
      }));
      const context = mealGenerationContext([...chosen, meal({ date: today, text: '   ', dishId: null })], [], today);
      expect(context.recentMeals).toEqual(['Repas -15', 'Repas 0', 'Repas 15']);
      expect(context.existingDishes).toEqual([]);
    });
    it('inclut toutes les fiches, leurs noms bruts et affichés, les archives et les noms liés aux repas choisis', () => {
      const manual = dish({ name: 'nom brut', details: { ...details, name: 'Nom corrigé' } });
      const analyzed = dish({ name: 'Nom initial' });
      const archived = dish({ name: 'Repas archivé', archived: true });
      const obsolete = dish({ name: 'Sans analyse courante' });
      const analysis = {
        dishId: analyzed.id, analysisKey: analyzed.analysisKey, details: { ...details, name: 'Nom enrichi' },
        status: 'ready' as const, error: null, updatedAt: 1,
      };
      const context = mealGenerationContext([
        manual, analyzed, archived, obsolete, dish({ name: ' NOM BRUT ' }),
        meal({ text: 'Ancien nom du menu', dishId: manual.id }),
        meal({ text: 'nom corrigé', dishId: manual.id }),
      ], [analysis, { ...analysis, dishId: obsolete.id }], '2026-10-30');
      expect(context.existingDishes.map(name => name.toLocaleLowerCase('fr-FR'))).toEqual([
        'nom brut', 'nom corrigé', 'nom initial', 'nom enrichi', 'repas archivé', 'sans analyse courante',
      ]);
      expect(context.recentMeals.map(name => name.toLocaleLowerCase('fr-FR'))).toEqual(['ancien nom du menu', 'nom brut', 'nom corrigé']);
      expect(JSON.stringify(context)).not.toContain(manual.id);
      expect(JSON.stringify(context)).not.toContain(details.recipe);
    });
    it('utilise aujourd’hui à Paris par défaut, pas le jour UTC', () => {
      vi.useFakeTimers();
      try {
        vi.setSystemTime(new Date('2026-12-31T23:30:00Z'));
        expect(mealGenerationContext([
          meal({ date: '2026-12-17', text: 'Borne française' }),
          meal({ date: '2026-12-16', text: 'Hors période française' }),
        ], []).recentMeals).toEqual(['Borne française']);
      } finally { vi.useRealTimers(); }
    });
  });
  it('analyse au-delà des anciens plafonds sans concurrence ni nouvel appel pour une analyse terminée', async () => {
    const request = vi.fn<typeof fetch>().mockImplementation(async () => success());
    const log = vi.fn();
    const worker = new AiWorker(store, config, log, request);
    store.db.prepare('INSERT INTO ai_usage (day, calls) VALUES (?, 200)').run(parisDate());
    store.merge([dish(), dish()]);
    await Promise.all([worker.tick(), worker.tick()]);
    expect(request).toHaveBeenCalledTimes(1);
    await worker.tick();
    await worker.tick();
    expect(request).toHaveBeenCalledTimes(2);
    expect(store.capabilities().callsToday).toBe(202);
    expect(store.capabilities().callsThisMonth).toBe(202);
    expect(store.capabilities().inputTokens).toBe(600);
    expect(store.analyses().filter(item => item.status === 'ready')).toHaveLength(2);
    expect(store.analyses().filter(item => item.status === 'pending')).toHaveLength(0);
    expect(log).not.toHaveBeenCalled();
  });
  it('expose les erreurs et ne boucle pas automatiquement sur une requête échouée', async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(new Response('{}', { status: 429 }));
    const log = vi.fn();
    const worker = new AiWorker(store, config, log, request);
    const recipe = dish();
    store.merge([recipe]);
    await worker.tick();
    await worker.tick();
    expect(request).toHaveBeenCalledTimes(1);
    expect(store.analysis(recipe.id)?.status).toBe('error');
    expect(store.analysis(recipe.id)?.error).toContain('429');
    expect(store.get(`dish:${recipe.id}`)).toEqual(recipe);
    expect(log).toHaveBeenCalledOnce();
  });
  it('refuse une sortie malformée au lieu de l’utiliser', async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({
      status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: '{"name": "Seulement un nom"}' }] }],
      usage: { input_tokens: 300, output_tokens: 30 },
    })));
    await expect(analyzeDish(dish(), preferences, config, 'gpt-6-luna', new AbortController().signal, request)).rejects.toThrow('invalides');
  });
  it('laisse les analyses en attente sans clé et ignore les fiches archivées ou manuelles', async () => {
    const noKey = new Store({ ...config, OPENAI_API_KEY: '' });
    noKey.merge([dish()]);
    expect(noKey.claimAnalysis()).toBeUndefined();
    noKey.close();
    store.merge([dish({ archived: true }), dish({ details })]);
    expect(store.claimAnalysis()).toBeUndefined();
    expect(store.capabilities().callsToday).toBe(0);
  });
  it('n’utilise jamais un modèle enregistré qui a été retiré de la liste autorisée', () => {
    store.merge([dish(), {
      type: 'settings', id: 'global', model: 'retired-model',
      modifiedAt: 1, mutationId: crypto.randomUUID(),
    }]);
    expect(store.claimAnalysis()).toBeUndefined();
    expect(store.capabilities().callsToday).toBe(0);
    store.merge([{
      type: 'settings', id: 'global', model: 'gpt-6-luna',
      modifiedAt: 2, mutationId: crypto.randomUUID(),
    }]);
    expect(store.claimAnalysis()).toBeDefined();
  });
});
