import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { buildApp } from '../server/app';
import { readConfig } from '../server/config';
import { hourlyAiWindow, Store } from '../server/database';
import { addDays, defaultHousehold, parisDate, seasonForDate, syncResponseSchema } from '../shared/model';
import { details, dish, meal } from './fixtures';

const config = readConfig({ DATABASE_PATH: ':memory:', OPENAI_API_KEY: 'test-key-not-real' });
let store: Store;
let app: Awaited<ReturnType<typeof buildApp>>;
beforeEach(async () => {
  store = new Store(config);
  app = await buildApp(store, config, { logger: false, staticRoot: join(tmpdir(), randomUUID()) });
});
afterEach(async () => { await app.close(); store.close(); });

describe('API et stockage partagé', () => {
  it('ne demande pas de mise à jour client par défaut', async () => {
    const response = await app.inject({ method: 'POST', url: '/api/sync', payload: { mutations: [] } });
    expect(response.statusCode).toBe(200);
    expect(response.json()).not.toHaveProperty('forceClientUpdate');
    expect(syncResponseSchema.safeParse(response.json()).success).toBe(true);
  });
  it('signale la mise à jour obligatoire sans réinitialiser les repas', async () => {
    await app.close();
    const updateConfig = readConfig({ DATABASE_PATH: ':memory:', CLIENT_UPDATE_ID: ' breaking-v2 ' });
    app = await buildApp(store, updateConfig, { logger: false, staticRoot: join(tmpdir(), randomUUID()) });
    const planned = meal();
    const response = await app.inject({ method: 'POST', url: '/api/sync', payload: { mutations: [planned] } });
    const result = syncResponseSchema.parse(response.json());
    expect(result.forceClientUpdate).toBe('breaking-v2');
    expect(result.resetId).toBeNull();
    expect(result.records).toContainEqual(planned);
    expect((await app.inject({ method: 'POST', url: '/api/sync', payload: { mutations: [] } })).json().forceClientUpdate).toBe('breaking-v2');
    expect(() => readConfig({ CLIENT_UPDATE_ID: 'x'.repeat(201) })).toThrow('Configuration invalide');
  });
  it('limite à exactement 20 appels par jour, même avec des générations concurrentes', async () => {
    await app.close();
    const aiRequest = vi.fn<typeof fetch>().mockImplementation(async () => new Response(JSON.stringify({
      status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify({ ...details, seasons: ['autumn'] }) }] }],
      usage: { input_tokens: 10, output_tokens: 5 },
    })));
    app = await buildApp(store, config, { logger: false, aiRequest });
    const responses = await Promise.all(Array.from({ length: 21 }, () =>
      app.inject({ method: 'POST', url: '/api/meals/generate', payload: { date: '2026-10-30' } })));
    expect(responses.filter(response => response.statusCode === 200)).toHaveLength(20);
    const refused = responses.filter(response => response.statusCode === 429);
    expect(refused).toHaveLength(1);
    expect(refused[0].json().error).toContain('20 requêtes');
    expect(aiRequest).toHaveBeenCalledTimes(20);
    const sync = await app.inject({ method: 'POST', url: '/api/sync', payload: { mutations: [] } });
    expect(sync.json().capabilities).toMatchObject({ dailyLimit: 20, callsToday: 20, inputTokens: 200, outputTokens: 100 });
  });
  it('applique le plafond horaire global aux appels directs et au worker', async () => {
    await app.close();
    const list = { sections: [{ name: 'Crèmerie et œufs', items: ['Lait — 700 ml'] }] };
    const aiRequest = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({
      status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify(list) }] }],
      usage: { input_tokens: 30, output_tokens: 12 },
    })));
    app = await buildApp(store, config, { logger: false, aiRequest });
    store.setGlobalAiPolicy({ paused: false, dailyLimit: null, monthlyLimit: null, hourlyLimit: 1 });

    const concurrent = await Promise.all(Array.from({ length: 3 }, () =>
      app.inject({ method: 'POST', url: '/api/shopping/refine', payload: { lines: ['Lait — 666 ml'] } })));
    expect(concurrent.filter(response => response.statusCode === 200)).toHaveLength(1);
    expect(concurrent.filter(response => response.statusCode === 429)).toHaveLength(2);
    const blocked = await app.inject({ method: 'POST', url: '/api/meals/generate', payload: { date: '2026-10-30' } });
    expect(blocked.statusCode).toBe(429);
    expect(blocked.json().error).toContain('Plafond horaire global');

    const pending = dish();
    store.merge('common', [pending]);
    expect(store.claimAnalysis()).toBeUndefined();
    expect(store.analysis('common', pending.id)).toMatchObject({
      status: 'pending', error: expect.stringContaining('Plafond horaire global'),
    });
    expect(aiRequest).toHaveBeenCalledTimes(1);
    expect(store.hourlyAiCalls()).toBe(1);
  });
  it('applique une fenêtre glissante de 60 minutes, pas une heure calendaire', () => {
    vi.useFakeTimers();
    try {
      const start = new Date('2026-11-05T12:00:00Z').getTime();
      vi.setSystemTime(start);
      store.setGlobalAiPolicy({ paused: false, dailyLimit: null, monthlyLimit: null, hourlyLimit: 1 });
      store.reserveGeneration('common');

      vi.setSystemTime(start + hourlyAiWindow - 1);
      expect(() => store.reserveGeneration('common')).toThrow('Plafond horaire global');
      vi.setSystemTime(start + hourlyAiWindow);
      expect(store.reserveGeneration('common')).toBe('2026-11-05');
      expect(store.hourlyAiCalls()).toBe(1);
    } finally { vi.useRealTimers(); }
  });
  it('affine une liste de courses en n’envoyant que les lignes, compte l’appel et signale les erreurs', async () => {
    await app.close();
    const list = { sections: [{ name: 'Crèmerie et œufs', items: ['Lait — 700 ml'] }] };
    const aiRequest = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response(JSON.stringify({
      status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify(list) }] }],
      usage: { input_tokens: 30, output_tokens: 12 },
    }))).mockResolvedValueOnce(new Response(JSON.stringify({
      status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: '{"sections":[]}' }] }],
      usage: { input_tokens: 1, output_tokens: 1 },
    })));
    app = await buildApp(store, config, { logger: false, aiRequest });
    const lines = ['lait — 666,667 ml'];
    const response = await app.inject({ method: 'POST', url: '/api/shopping/refine', payload: { lines } });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ list });
    const body = JSON.parse(String(aiRequest.mock.calls[0][1]?.body));
    expect(body.store).toBe(false);
    expect(JSON.parse(body.input)).toEqual({ lignes: lines });
    expect(body.instructions).toContain('rayon');
    const failed = await app.inject({ method: 'POST', url: '/api/shopping/refine', payload: { lines } });
    expect(failed.statusCode).toBe(502);
    expect((await app.inject({ method: 'POST', url: '/api/shopping/refine', payload: { lines: [] } })).statusCode).toBe(400);
    const sync = await app.inject({ method: 'POST', url: '/api/sync', payload: { mutations: [] } });
    expect(sync.json().capabilities).toMatchObject({ callsToday: 2, inputTokens: 30, outputTokens: 12 });
    for (let i = 0; i < 18; i++) store.reserveGeneration('common');
    const refused = await app.inject({ method: 'POST', url: '/api/shopping/refine', payload: { lines } });
    expect(refused.statusCode).toBe(429);
    expect(aiRequest).toHaveBeenCalledTimes(2);
  });
  it('partage le quota entre worker et génération, sans bloquer les autres foyers ou la synchronisation', async () => {
    for (let i = 0; i < 19; i++) store.reserveGeneration('common');
    const first = dish();
    store.merge('common', [first]);
    expect(store.claimAnalysis()?.dish.id).toBe(first.id);
    store.finishAnalysis('common', first, null, 'Échec simulé');
    expect(() => store.reserveGeneration('common')).toThrow('20 requêtes');
    const pending = dish();
    store.merge('common', [pending]);
    expect(store.claimAnalysis()).toBeUndefined();
    expect(store.analysis('common', pending.id)).toMatchObject({ status: 'pending', error: expect.stringContaining('20 requêtes') });
    const other = store.createSpace('household', 'Autre foyer');
    const otherDish = dish();
    store.merge(other.id, [otherDish]);
    expect(store.claimAnalysis()?.spaceId).toBe(other.id);
    expect(store.capabilities(new Date(), other.id)).toMatchObject({ callsToday: 1, dailyLimit: 20 });
    expect(store.capabilities(new Date(), 'common').callsToday).toBe(20);
    expect((await app.inject({ method: 'POST', url: '/api/sync', payload: { mutations: [] } })).statusCode).toBe(200);
    store.setAiLimitExempt('common', true);
    expect(store.claimAnalysis()?.dish.id).toBe(pending.id);
    expect(store.analysis('common', pending.id)?.error).toBeNull();
    expect(store.capabilities(new Date(), 'common')).toMatchObject({ dailyLimit: null, callsToday: 21 });
    store.setAiLimitExempt('common', false);
    expect(() => store.reserveGeneration('common')).toThrow('20 requêtes');
    expect(() => store.setAiLimitExempt('inconnu', true)).toThrow('introuvable');
  });
  it('renouvelle le quota à minuit à Paris et reprend les analyses en attente', () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-11-02T22:59:00Z'));
      for (let i = 0; i < 20; i++) store.reserveGeneration('common');
      const recipe = dish();
      store.merge('common', [recipe]);
      expect(store.claimAnalysis()).toBeUndefined();
      vi.setSystemTime(new Date('2026-11-02T23:01:00Z'));
      expect(store.claimAnalysis()?.dish.id).toBe(recipe.id);
      expect(store.capabilities(new Date(), 'common')).toMatchObject({ callsToday: 1, callsThisMonth: 21 });
      expect(store.analysis('common', recipe.id)).toMatchObject({ status: 'processing', error: null });
    } finally { vi.useRealTimers(); }
  });
  it('partage les convives par créneau, sans toucher au foyer ni à la fiche', async () => {
    const recipe = dish({ details });
    const planned = meal({ dishId: recipe.id, household: { adults: 2, teenagers: 0, children: 0 } });
    const dinner = meal({ id: `${planned.date}:dinner`, slot: 'dinner', dishId: recipe.id });
    const response = await app.inject({ method: 'POST', url: '/api/sync', payload: { mutations: [recipe, planned, dinner] } });
    expect(response.statusCode).toBe(200);
    const synchronized = await app.inject({ method: 'POST', url: '/api/sync', payload: { mutations: [] } });
    const records = syncResponseSchema.parse(synchronized.json()).records;
    expect(records).toContainEqual(planned);
    expect(records).toContainEqual(dinner);
    expect(records).toContainEqual(recipe);
    expect(store.settings('common').household).toEqual(defaultHousehold);
    const reset = { ...planned, household: null, modifiedAt: planned.modifiedAt + 1, mutationId: randomUUID() };
    const restored = await app.inject({ method: 'POST', url: '/api/sync', payload: { mutations: [reset] } });
    expect(restored.statusCode).toBe(200);
    expect(syncResponseSchema.parse(restored.json()).records).toContainEqual(reset);
  });
  it('stocke deux plats distincts et refuse un troisième plat', async () => {
    const first = meal({ text: 'Filet mignon', household: { adults: 2, teenagers: 0, children: 0 } });
    const second = meal({ id: `${first.id}:2`, index: 1, text: 'Soupe de courge', household: { adults: 0, teenagers: 0, children: 2 } });
    const response = await app.inject({ method: 'POST', url: '/api/sync', payload: { mutations: [first, second] } });
    expect(response.statusCode).toBe(200);
    expect(syncResponseSchema.parse(response.json()).records).toEqual(expect.arrayContaining([first, second]));
    const invalid = await app.inject({ method: 'POST', url: '/api/sync', payload: { mutations: [{ ...second, id: `${first.id}:3`, index: 2 }] } });
    expect(invalid.statusCode).toBe(400);
    expect(store.records('common').filter(record => record.type === 'meal')).toHaveLength(2);
  });
  it('synchronise les liens longs et le nom découvert sans réécrire les records utilisateur', async () => {
    const url = `https://example.org/gratin?source=${'a'.repeat(500)}`;
    const recipe = dish({ name: url, sourceUrl: url });
    const planned = meal({ text: url, dishId: recipe.id });
    const response = await app.inject({ method: 'POST', url: '/api/sync', payload: { mutations: [recipe, planned] } });
    expect(response.statusCode).toBe(200);
    expect(store.claimAnalysis()?.dish).toEqual(recipe);
    store.nameAnalysis('common', recipe, 'Gratin de courge');
    const synchronized = await app.inject({ method: 'POST', url: '/api/sync', payload: { mutations: [] } });
    const body = syncResponseSchema.parse(synchronized.json());
    expect(body.records).toContainEqual(recipe);
    expect(body.records).toContainEqual(planned);
    expect(body.analyses).toContainEqual(expect.objectContaining({
      dishId: recipe.id, analysisKey: recipe.analysisKey, status: 'processing', name: 'Gratin de courge', details: null,
    }));
  });
  it('propose les nouveaux modèles dans les capacités et accepte leur sélection partagée', async () => {
    let modifiedAt = Date.now();
    for (const model of ['gpt-5.6-terra', 'gpt-6-sol']) {
      const response = await app.inject({ method: 'POST', url: '/api/sync', payload: { mutations: [{
        type: 'settings', id: 'global', model, modifiedAt: modifiedAt++, mutationId: randomUUID(),
      }] } });
      expect(response.statusCode).toBe(200);
      const body = syncResponseSchema.parse(response.json());
      expect(body.capabilities.allowedModels).toContain(model);
      expect(store.settings('common').model).toBe(model);
    }
    expect(readConfig({ OPENAI_ALLOWED_MODELS: 'gpt-6-luna' }).allowedModels).toEqual(['gpt-6-luna']);
  });
  it('construit le contexte serveur autour de la date du repas, avec le modèle choisi', async () => {
    await app.close();
    const today = parisDate();
    const date = addDays(today, 90);
    const recipe = dish({ name: 'Soupe maison', details: { ...details, name: 'Soupe corrigée' } });
    const archived = dish({ name: 'Ancien gratin', archived: true });
    store.merge('common', [recipe, archived, ...[-16, -15, 15, 16].map(offset => meal({
      id: `${addDays(date, offset)}:lunch`, date: addDays(date, offset), text: `Choix ${offset}`,
      dishId: offset === -15 ? recipe.id : null,
    })), meal({ id: `${today}:lunch`, date: today, text: 'Repas d’aujourd’hui' }),
    { ...store.settings('common'), model: 'gpt-6-sol', modifiedAt: Date.now(), mutationId: randomUUID() }]);
    const aiRequest = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({
      status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text',
        text: JSON.stringify({ ...details, name: 'Nouvelle idée', seasons: [seasonForDate(date)] }),
      }] }],
      usage: { input_tokens: 123, output_tokens: 45 },
    })));
    app = await buildApp(store, config, { logger: false, aiRequest });
    const response = await app.inject({ method: 'POST', url: '/api/meals/generate', payload: { date } });
    expect(response.statusCode).toBe(200);
    const body = JSON.parse(String(aiRequest.mock.calls[0][1]?.body));
    expect(body.model).toBe('gpt-6-sol');
    expect(JSON.parse(body.input)).toEqual({
      saison: seasonForDate(date),
      niveauDemande: 2,
      repasChoisis: ['Choix -15', recipe.name, recipe.details!.name, 'Choix 15'],
      platsDejaCrees: expect.arrayContaining([recipe.name, recipe.details!.name, archived.name]),
    });
    expect(JSON.parse(body.input).platsDejaCrees).toHaveLength(3);
  });
  it('partage la composition du foyer sans la transmettre à la génération, qui reste sur 4 portions', async () => {
    await app.close();
    const household = { adults: 1, teenagers: 3, children: 0 };
    const aiRequest = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({
      status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text',
        text: JSON.stringify({ ...details, name: 'Nouvelle idée', seasons: ['autumn'] }),
      }] }], usage: { input_tokens: 123, output_tokens: 45 },
    })));
    store.merge('common', [{ ...store.settings('common'), household, modifiedAt: Date.now(), mutationId: randomUUID() }]);
    app = await buildApp(store, config, { logger: false, aiRequest });
    const response = await app.inject({ method: 'POST', url: '/api/meals/generate', payload: { date: '2026-10-30' } });
    expect(response.statusCode).toBe(200);
    const body = JSON.parse(String(aiRequest.mock.calls[0][1]?.body));
    expect(JSON.parse(body.input)).not.toHaveProperty('foyer');
    expect(store.settings('common').household).toEqual(household);
    expect(response.json().details.servings).toBe(4);
  });
  it('génère au niveau de cuisine partagé par défaut, ou au niveau choisi pour ce repas', async () => {
    const shared = await app.inject({ method: 'POST', url: '/api/sync', payload: { mutations: [{
      ...store.settings('common'), cookingLevel: 4, modifiedAt: Date.now(), mutationId: randomUUID(),
    }] } });
    expect(syncResponseSchema.parse(shared.json()).records).toContainEqual(expect.objectContaining({ type: 'settings', cookingLevel: 4 }));
    await app.close();
    const aiRequest = vi.fn<typeof fetch>().mockImplementation(async (_url, options) => {
      const level = JSON.parse(JSON.parse(String(options?.body)).input).niveauDemande;
      return new Response(JSON.stringify({
        status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text',
          text: JSON.stringify({ ...details, name: 'Nouvelle idée', seasons: ['autumn'], level }),
        }] }], usage: { input_tokens: 123, output_tokens: 45 },
      }));
    });
    app = await buildApp(store, config, { logger: false, aiRequest });
    for (const [payload, level] of [[{ date: '2026-10-30' }, 4], [{ date: '2026-10-30', level: 1 }, 1]] as const) {
      const response = await app.inject({ method: 'POST', url: '/api/meals/generate', payload });
      expect(response.statusCode).toBe(200);
      expect(response.json().details.level).toBe(level);
      expect(JSON.parse(JSON.parse(String(aiRequest.mock.lastCall?.[1]?.body)).input).niveauDemande).toBe(level);
    }
    expect(store.settings('common').cookingLevel).toBe(4);
  });
  it('réessaie un niveau incorrect puis conserve seulement le nom avec un avertissement court', async () => {
    await app.close();
    const aiRequest = vi.fn<typeof fetch>().mockImplementation(async () => new Response(JSON.stringify({
      status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text',
        text: JSON.stringify({ ...details, name: 'Nouvelle idée', seasons: ['autumn'], level: 2 }),
      }] }], usage: { input_tokens: 123, output_tokens: 45 },
    })));
    app = await buildApp(store, config, { logger: false, aiRequest });
    const response = await app.inject({ method: 'POST', url: '/api/meals/generate', payload: { date: '2026-10-30', level: 1 } });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      details: { name: 'Nouvelle idée', seasons: ['autumn'], ingredients: [], recipe: '' },
      source: 'ai', warning: 'Oups, problème dans la génération.',
    });
    expect(store.catalog()).toEqual([]);
    expect(store.records('common').map(record => record.type)).toEqual(['settings']);
    expect(store.analyses('common')).toEqual([]);
    expect(store.settings('common').cookingLevel).toBe(2);
    expect(store.capabilities().callsToday).toBe(2);
    expect(aiRequest).toHaveBeenCalledTimes(2);
  });
  it('réessaie un doublon sans jamais conserver ce nom comme proposition partielle', async () => {
    await app.close();
    const recipe = dish({ name: 'Gratin de courge' });
    store.merge('common', [recipe]);
    const aiRequest = vi.fn<typeof fetch>().mockImplementation(async () => new Response(JSON.stringify({
      status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text',
        text: JSON.stringify({ ...details, name: 'GRATIN  DE COURGE', seasons: ['autumn'] }),
      }] }],
      usage: { input_tokens: 123, output_tokens: 45 },
    })));
    app = await buildApp(store, config, { logger: false, aiRequest });
    const response = await app.inject({ method: 'POST', url: '/api/meals/generate', payload: { date: '2026-10-30' } });
    expect(response.statusCode).toBe(502);
    expect(response.json()).toEqual({ error: 'Oups, problème dans la génération.' });
    expect(store.records('common')).toHaveLength(2);
    expect(store.capabilities().callsToday).toBe(2);
    expect(aiRequest).toHaveBeenCalledTimes(2);
  });
  it('génère un repas avec les compteurs partagés et sans créer de seconde analyse', async () => {
    await app.close();
    const aiRequest = vi.fn<typeof fetch>().mockImplementation(async () => new Response(JSON.stringify({
      status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify({ ...details, seasons: ['autumn'] }) }] }],
      usage: { input_tokens: 123, output_tokens: 45 },
    })));
    app = await buildApp(store, config, { logger: false, aiRequest });
    const response = await app.inject({ method: 'POST', url: '/api/meals/generate', payload: { date: '2026-10-30' } });
    expect(response.statusCode).toBe(200);
    expect(response.json().details.name).toBe(details.name);
    expect(store.capabilities().callsToday).toBe(1);
    expect(store.capabilities().inputTokens).toBe(123);
    expect(store.records('common')).toHaveLength(1);
    expect(store.analyses('common')).toEqual([]);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(aiRequest).toHaveBeenCalledOnce();
  });
  it('refuse dates ou niveaux invalides et origines tierces avant de consommer un appel', async () => {
    for (const [payload, headers, status] of [
      [{ date: '2026-02-30' }, {}, 400],
      [{ date: '2026-10-30', level: 5 }, {}, 400],
      [{ date: '2026-10-30', level: '2' }, {}, 400],
      [{ date: '2026-10-30' }, { origin: 'https://other.invalid' }, 403],
    ] as const) {
      const response = await app.inject({ method: 'POST', url: '/api/meals/generate', payload, headers });
      expect(response.statusCode).toBe(status);
    }
    expect(store.capabilities().callsToday).toBe(0);
  });
  it('autorise les foyers exemptés à dépasser le quota, indépendamment des anciennes variables', async () => {
    await app.close();
    store.close();
    const legacyConfig = readConfig({
      DATABASE_PATH: ':memory:', OPENAI_API_KEY: 'test-only',
      AI_DAILY_LIMIT: '1', AI_MONTHLY_LIMIT: '1',
    });
    store = new Store(legacyConfig);
    store.db.prepare('INSERT INTO ai_usage (day, calls) VALUES (?, 200)').run(parisDate());
    store.db.prepare('INSERT INTO household_ai_usage (space_id, day, calls) VALUES (?, ?, 200)').run('common', parisDate());
    store.setAiLimitExempt('common', true);
    const generated = { ...details, seasons: ['autumn'] };
    const aiRequest = vi.fn<typeof fetch>().mockImplementation(async () => new Response(JSON.stringify({
      status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify(generated) }] }],
      usage: { input_tokens: 123, output_tokens: 45 },
    })));
    app = await buildApp(store, legacyConfig, { logger: false, aiRequest });
    for (let i = 0; i < 11; i++) {
      const response = await app.inject({ method: 'POST', url: '/api/meals/generate', payload: { date: '2026-10-30' } });
      expect(response.statusCode, response.body).toBe(200);
      expect(response.json().details).toEqual({ ...generated, servings: 4 });
    }
    expect(aiRequest).toHaveBeenCalledTimes(11);
    const response = await app.inject({ method: 'POST', url: '/api/sync', payload: { mutations: [] } });
    const { capabilities } = syncResponseSchema.parse(response.json());
    expect(capabilities).toMatchObject({ callsToday: 211, callsThisMonth: 211, inputTokens: 1353, outputTokens: 495 });
    expect(response.json().capabilities.dailyLimit).toBeNull();
    expect(response.json().capabilities.monthlyLimit).toBeNull();
  });
  it('compte les échecs de génération sans bloquer les appels suivants ni le worker', async () => {
    await app.close();
    const aiRequest = vi.fn<typeof fetch>().mockImplementation(async () => new Response('{}', { status: 503 }));
    app = await buildApp(store, config, { logger: false, aiRequest });
    const generate = () => app.inject({ method: 'POST', url: '/api/meals/generate', payload: { date: '2026-10-30' } });
    const failed = await generate();
    expect(failed.statusCode).toBe(502);
    expect(failed.json()).toEqual({ error: 'Oups, problème dans la génération.' });
    expect((await generate()).statusCode).toBe(502);
    store.merge('common', [dish()]);
    expect(store.claimAnalysis()).toBeDefined();
    expect(aiRequest).toHaveBeenCalledTimes(4);
    expect(store.capabilities().callsToday).toBe(5);
  });
  it('réessaie une fois un JSON invalide et ne publie que la recette valide du second appel', async () => {
    await app.close();
    const aiRequest = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text',
          text: `${JSON.stringify({ ...details, name: 'Premier essai' })}\nTexte supplémentaire`,
        }] }], usage: { input_tokens: 123, output_tokens: 45 },
      })))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text',
          text: JSON.stringify({ ...details, name: 'Second essai', seasons: ['autumn'] }),
        }] }], usage: { input_tokens: 100, output_tokens: 50 },
      })));
    app = await buildApp(store, config, { logger: false, aiRequest });
    const response = await app.inject({ method: 'POST', url: '/api/meals/generate', payload: { date: '2026-10-30' } });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ details: { ...details, name: 'Second essai', seasons: ['autumn'], servings: 4 }, source: 'ai' });
    expect(aiRequest).toHaveBeenCalledTimes(2);
    expect(store.capabilities()).toMatchObject({ callsToday: 2, inputTokens: 100, outputTokens: 50 });
  });
  it.each(['suffixe', 'tronquée'])('conserve le dernier nom exploitable après deux réponses invalides : %s', async shape => {
    await app.close();
    let attempt = 0;
    const aiRequest = vi.fn<typeof fetch>().mockImplementation(async () => {
      const name = ++attempt === 1 ? 'Première idée' : 'Dernière idée';
      return new Response(JSON.stringify({
        status: shape === 'tronquée' ? 'incomplete' : 'completed',
        output: [{ type: 'message', content: [{ type: 'output_text', text: shape === 'tronquée'
          ? `{"name":${JSON.stringify(name)},"recipe":"interrompue`
          : `${JSON.stringify({ ...details, name })}\nTexte supplémentaire`,
        }] }], usage: { input_tokens: 123, output_tokens: 45 },
      }));
    });
    app = await buildApp(store, config, { logger: false, aiRequest });
    const response = await app.inject({ method: 'POST', url: '/api/meals/generate', payload: { date: '2026-10-30' } });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      details: { name: 'Dernière idée', seasons: ['autumn'], ingredients: [], recipe: '' },
      source: 'ai', warning: 'Oups, problème dans la génération.',
    });
    expect(aiRequest).toHaveBeenCalledTimes(2);
    expect(store.capabilities()).toMatchObject({ callsToday: 2, inputTokens: 0, outputTokens: 0 });
    expect(store.catalog()).toEqual([]);
    expect(store.analyses('common')).toEqual([]);
    const partialDish = dish({ name: response.json().details.name, details: response.json().details });
    store.merge('common', [partialDish]);
    expect(store.claimAnalysis()).toBeUndefined();
    expect(store.capabilities().callsToday).toBe(2);
  });
  it('garde le nom du premier essai si le second échoue sans réponse exploitable', async () => {
    await app.close();
    const aiRequest = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: '{"name":"Idée conservée","ingredients":null}' }] }],
        usage: { input_tokens: 123, output_tokens: 45 },
      })))
      .mockRejectedValueOnce(new Error('Connexion interrompue'));
    app = await buildApp(store, config, { logger: false, aiRequest });
    const response = await app.inject({ method: 'POST', url: '/api/meals/generate', payload: { date: '2026-10-30' } });
    expect(response.json().details.name).toBe('Idée conservée');
    expect(response.json().warning).toBe('Oups, problème dans la génération.');
    expect(aiRequest).toHaveBeenCalledTimes(2);
  });
  it('ne dépasse pas le quota lors du réessai et garde le nom déjà reçu', async () => {
    for (let index = 0; index < 19; index++) store.reserveGeneration('common');
    await app.close();
    const aiRequest = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({
      status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: '{"name":"Dernière proposition","recipe":false}' }] }],
      usage: { input_tokens: 123, output_tokens: 45 },
    })));
    app = await buildApp(store, config, { logger: false, aiRequest });
    const response = await app.inject({ method: 'POST', url: '/api/meals/generate', payload: { date: '2026-10-30' } });
    expect(response.json().details.name).toBe('Dernière proposition');
    expect(response.json().warning).toBe('Oups, problème dans la génération.');
    expect(aiRequest).toHaveBeenCalledOnce();
    expect(store.capabilities().callsToday).toBe(20);
  });
  it('explique une clé absente ou un modèle retiré', () => {
    for (const [overrides, message] of [
      [{ OPENAI_API_KEY: '' }, 'clé OpenAI'],
      [{ allowedModels: [] }, 'modèle IA autorisé'],
    ] as const) {
      const isolated = new Store({ ...config, ...overrides, allowedModels: 'allowedModels' in overrides ? [] : config.allowedModels });
      try {
        expect(() => isolated.reserveGeneration('common')).toThrow(message);
      } finally { isolated.close(); }
    }
  });
  it('démarre sans aucun repas et fournit un contrat valide', async () => {
    const response = await app.inject({ method: 'POST', url: '/api/sync', payload: { mutations: [] } });
    const body = syncResponseSchema.parse(response.json());
    expect(response.statusCode).toBe(200);
    expect(body.records.map(record => record.type)).toEqual(['settings']);
    expect(body.capabilities.allowedModels).toContain('gpt-6-luna');
    expect(response.headers['cache-control']).toBe('no-store');
    expect(JSON.stringify(body)).not.toContain('test-key-not-real');
  });
  it('enregistre immédiatement le texte brut et crée une tâche IA séparée', async () => {
    const recipe = dish();
    const entry = meal({ dishId: recipe.id });
    const response = await app.inject({ method: 'POST', url: '/api/sync', payload: { mutations: [recipe, entry] } });
    expect(response.statusCode).toBe(200);
    expect(store.get('common', `meal:${entry.id}`)).toEqual(entry);
    expect(store.analysis('common', recipe.id)?.status).toBe('pending');
    expect(store.capabilities().callsToday).toBe(0);
  });
  it('résout les conflits par créneau et indépendamment de l’ordre d’arrivée', () => {
    const old = meal({ modifiedAt: 1, text: 'Ancien' });
    const newer = meal({ modifiedAt: 3, text: 'Nouveau' });
    const evening = meal({ modifiedAt: 2, id: '2026-10-30:dinner', slot: 'dinner', text: 'Soupe' });
    store.merge('common', [newer, evening, old]);
    expect(store.get('common', `meal:${old.id}`)).toEqual(newer);
    expect(store.get('common', `meal:${evening.id}`)).toEqual(evening);
    store.merge('common', [newer]);
    expect(store.records('common')).toHaveLength(3);
  });
  it('conserve les suppressions pour éviter la résurrection par un appareil hors ligne', () => {
    const old = meal({ modifiedAt: 1 });
    const cleared = { ...old, modifiedAt: 2, mutationId: randomUUID(), text: '', dishId: null };
    store.merge('common', [old, cleared]);
    store.merge('common', [old]);
    expect(store.get('common', `meal:${old.id}`)).toEqual(cleared);
  });
  it('ne modifie pas les menus lors du nettoyage IA ou de l’archivage', () => {
    const recipe = dish();
    const entry = meal({ dishId: recipe.id, text: 'poulet frite' });
    store.merge('common', [recipe, entry]);
    const job = store.claimAnalysis()!;
    store.finishAnalysis('common', job.dish, details, null);
    expect(store.analysis('common', recipe.id)?.details?.name).toBe('Poulet-frites');
    expect(store.get('common', `meal:${entry.id}`)).toEqual(entry);
    store.merge('common', [{ ...recipe, archived: true, modifiedAt: recipe.modifiedAt + 1, mutationId: randomUUID() }]);
    expect(store.get('common', `meal:${entry.id}`)).toEqual(entry);
  });
  it('ignore une analyse devenue obsolète ou concurrencée par une correction manuelle', () => {
    const recipe = dish();
    store.merge('common', [recipe]);
    store.claimAnalysis();
    const changed = { ...recipe, analysisKey: randomUUID(), modifiedAt: recipe.modifiedAt + 1, mutationId: randomUUID() };
    store.merge('common', [changed]);
    store.finishAnalysis('common', recipe, details, null);
    expect(store.analysis('common', recipe.id)?.status).toBe('pending');
    const job = store.claimAnalysis()!;
    store.merge('common', [{ ...changed, details: { ...details, name: 'Ma recette' }, modifiedAt: changed.modifiedAt + 1, mutationId: randomUUID() }]);
    store.finishAnalysis('common', job.dish, details, null);
    const result = store.get('common', `dish:${recipe.id}`);
    expect(result?.type === 'dish' && result.details?.name).toBe('Ma recette');
  });
  it('refuse atomiquement les lots invalides et les horloges trop avancées', async () => {
    for (const invalid of [
      meal({ text: 'a'.repeat(241) }),
      meal({ modifiedAt: Date.now() + 10 * 60_000 }),
    ]) {
      const response = await app.inject({ method: 'POST', url: '/api/sync', payload: { mutations: [dish(), invalid] } });
      expect(response.statusCode).toBe(400);
      expect(store.records('common')).toHaveLength(1);
    }
  });
  it('remplace un modèle qui n’est plus autorisé par le modèle par défaut du serveur', async () => {
    const settings = { ...store.settings('common'), model: 'not-allowed', cookingLevel: 3 as const, modifiedAt: Date.now(), mutationId: randomUUID() };
    const response = await app.inject({ method: 'POST', url: '/api/sync', payload: { mutations: [settings] } });
    expect(response.statusCode).toBe(200);
    expect(store.settings('common')).toEqual({ ...settings, model: config.OPENAI_MODEL });
  });
  it('réinitialise les repas et ignore ceux des appareils qui ne l’ont pas encore appliquée, sans bloquer les paramètres', async () => {
    const recipe = dish();
    store.merge('common', [recipe, meal({ dishId: recipe.id })]);
    const model = store.settings('common').model;
    const resetId = store.reset('common');
    expect(store.records('common').map(record => record.type)).toEqual(['settings']);
    expect(store.analyses('common')).toEqual([]);
    expect(store.settings('common').model).toBe(model);
    for (const payload of [{ mutations: [recipe] }, { mutations: [recipe], resetId: null }, { mutations: [recipe], resetId: randomUUID() }]) {
      const response = await app.inject({ method: 'POST', url: '/api/sync', payload });
      expect(response.statusCode).toBe(200);
      expect(syncResponseSchema.parse(response.json()).resetId).toBe(resetId);
      expect(store.records('common')).toHaveLength(1);
    }
    const household = { adults: 3, teenagers: 0, children: 1 };
    await app.inject({ method: 'POST', url: '/api/sync', payload: { mutations: [
      meal({ text: 'Ancien' }), { ...store.settings('common'), household, modifiedAt: Date.now(), mutationId: randomUUID() },
    ] } });
    expect(store.records('common').map(record => record.type)).toEqual(['settings']);
    expect(store.settings('common').household).toEqual(household);
    const accepted = await app.inject({ method: 'POST', url: '/api/sync', payload: { mutations: [dish()], resetId } });
    expect(accepted.json().records).toHaveLength(2);
  });
  it('enregistre les demandes d’évolution et expose leur statut', async () => {
    expect((await app.inject({ method: 'POST', url: '/api/feature-requests', payload: { text: ' ' } })).statusCode).toBe(400);
    const created = await app.inject({ method: 'POST', url: '/api/feature-requests', payload: { text: '  Noter les repas  ' } });
    expect(created.statusCode).toBe(201);
    const request = created.json().request;
    expect(request).toMatchObject({ text: 'Noter les repas', status: 'received', note: null });
    expect(store.updateFeatureRequest(request.id.slice(0, 8), 'added', 'Disponible dans le carnet.')).toBe(true);
    expect(store.updateFeatureRequest('ffffffff-none', 'added', null)).toBe(false);
    const list = await app.inject('/api/feature-requests');
    expect(list.json().requests).toEqual([expect.objectContaining({ id: request.id, status: 'added', note: 'Disponible dans le carnet.' })]);
    const foreign = await app.inject({
      method: 'POST', url: '/api/feature-requests', payload: { text: 'Spam' },
      headers: { origin: 'https://other.invalid', 'sec-fetch-site': 'cross-site' },
    });
    expect(foreign.statusCode).toBe(403);
  });
  it('rejette les écritures depuis un site tiers', async () => {
    const response = await app.inject({
      method: 'POST', url: '/api/sync', payload: { mutations: [dish()] },
      headers: { origin: 'https://other.invalid', 'sec-fetch-site': 'cross-site' },
    });
    expect(response.statusCode).toBe(403);
    expect(store.records('common')).toHaveLength(1);
  });
  it('limite la synchronisation sans bloquer la disponibilité des autres routes', async () => {
    for (let i = 0; i < 180; i++) {
      const response = await app.inject({ method: 'POST', url: '/api/sync', payload: { mutations: [] } });
      expect(response.statusCode).toBe(200);
    }
    const limited = await app.inject({ method: 'POST', url: '/api/sync', payload: { mutations: [] } });
    expect(limited.statusCode).toBe(429);
    expect(limited.json().error).toContain('Trop de requêtes');
    expect((await app.inject('/api/health')).statusCode).toBe(200);
  });
  it('conserve les menus, les tâches et les compteurs après un redémarrage', () => {
    const folder = mkdtempSync(join(tmpdir(), 'a-table-database-'));
    const persistentConfig = { ...config, DATABASE_PATH: join(folder, 'planner.sqlite') };
    const recipe = dish();
    const first = new Store(persistentConfig);
    first.merge('common', [recipe, meal()]);
    first.claimAnalysis();
    const exempt = first.createSpace('household', 'Sans limite');
    first.setAiLimitExempt(exempt.id, true);
    for (let i = 0; i < 20; i++) first.reserveGeneration(exempt.id);
    first.close();
    const second = new Store(persistentConfig);
    try {
      expect(second.records('common')).toHaveLength(3);
      expect(second.capabilities().callsToday).toBe(21);
      expect(second.hourlyAiCalls()).toBe(21);
      expect(second.capabilities(new Date(), 'common').callsToday).toBe(1);
      expect(second.capabilities(new Date(), exempt.id)).toMatchObject({ callsToday: 20, dailyLimit: null });
      expect(() => second.reserveGeneration(exempt.id)).not.toThrow();
      expect(second.analysis('common', recipe.id)?.status).toBe('error');
    } finally { second.close(); rmSync(folder, { recursive: true }); }
  });
  it('migre les compteurs v2 sans perte et ne les copie pas à nouveau au redémarrage', () => {
    const folder = mkdtempSync(join(tmpdir(), 'a-table-quota-migration-'));
    const persistentConfig = { ...config, DATABASE_PATH: join(folder, 'planner.sqlite') };
    const legacy = new Store(persistentConfig);
    legacy.merge('common', [meal()]);
    for (let i = 0; i < 20; i++) legacy.reserveGeneration('common');
    legacy.db.exec(`
      DROP TABLE household_ai_usage; DROP TABLE ai_limit_exemptions;
      DROP TABLE ai_hourly_calls; DROP TABLE admin_sessions; DROP TABLE admin_audit; DROP TABLE space_ai_policy; DROP TABLE global_ai_policy;
      ALTER TABLE auth_transactions DROP COLUMN return_to;
      PRAGMA user_version = 2;
    `);
    legacy.close();
    try {
      for (let i = 0; i < 2; i++) {
        const migrated = new Store(persistentConfig);
        try {
          expect(migrated.records('common').filter(record => record.type === 'meal')).toHaveLength(1);
          expect(migrated.capabilities(new Date(), 'common')).toMatchObject({ callsToday: 20, dailyLimit: 20 });
          expect(() => migrated.reserveGeneration('common')).toThrow('20 requêtes');
        } finally { migrated.close(); }
      }
    } finally { rmSync(folder, { recursive: true }); }
  });
  it('permet à la commande administrateur de désactiver puis de rétablir le quota d’un foyer', () => {
    const folder = mkdtempSync(join(tmpdir(), 'a-table-quota-admin-'));
    const path = join(folder, 'planner.sqlite');
    const admin = (...args: string[]) => spawnSync(process.execPath, ['--import', 'tsx', 'server/admin.ts', ...args], {
      env: { ...process.env, DATABASE_PATH: path, AUTH_ENABLED: 'false' }, encoding: 'utf8',
    });
    try {
      const unlimited = admin('ai-limit', '--space', 'common', '--mode', 'unlimited');
      expect(unlimited.status, unlimited.stderr).toBe(0);
      expect(unlimited.stdout).toContain('sans limite');
      const spaces = admin('spaces');
      expect(spaces.status, spaces.stderr).toBe(0);
      expect(spaces.stdout).toContain('IA : sans limite');
      const restored = admin('ai-limit', '--space', 'common', '--mode', 'default');
      expect(restored.status, restored.stderr).toBe(0);
      expect(restored.stdout).toContain('20 requêtes par jour');
      const invalid = admin('ai-limit', '--space', 'inconnu', '--mode', 'unlimited');
      expect(invalid.status).toBe(1);
      expect(invalid.stderr).toContain('Foyer introuvable');
    } finally { rmSync(folder, { recursive: true }); }
  });
  it('sauvegarde à chaud une base WAL et refuse d’écraser la sauvegarde', () => {
    const folder = mkdtempSync(join(tmpdir(), 'a-table-backup-'));
    const persistentConfig = { ...config, DATABASE_PATH: join(folder, 'planner.sqlite') };
    const running = new Store(persistentConfig);
    const target = join(folder, 'backup.sqlite');
    let restored: Store | undefined;
    try {
      running.merge('common', [dish(), meal()]);
      const options = { env: { ...process.env, DATABASE_PATH: persistentConfig.DATABASE_PATH }, encoding: 'utf8' as const };
      const backup = spawnSync(process.execPath, ['scripts/backup.mjs', target], options);
      expect(backup.status, backup.stderr).toBe(0);
      restored = new Store({ ...config, DATABASE_PATH: target });
      expect(restored.records('common')).toEqual(running.records('common'));
      const second = spawnSync(process.execPath, ['scripts/backup.mjs', target], options);
      expect(second.status).not.toBe(0);
      expect(second.stderr).toContain('existe déjà');
    } finally { restored?.close(); running.close(); rmSync(folder, { recursive: true }); }
  });
});
