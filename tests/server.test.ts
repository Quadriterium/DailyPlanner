import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { buildApp } from '../server/app';
import { readConfig } from '../server/config';
import { Store } from '../server/database';
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
  it('propose les nouveaux modèles dans les capacités et accepte leur sélection partagée', async () => {
    let modifiedAt = Date.now();
    for (const model of ['gpt-5.6-terra', 'gpt-6-sol']) {
      const response = await app.inject({ method: 'POST', url: '/api/sync', payload: { mutations: [{
        type: 'settings', id: 'global', model, modifiedAt: modifiedAt++, mutationId: randomUUID(),
      }] } });
      expect(response.statusCode).toBe(200);
      const body = syncResponseSchema.parse(response.json());
      expect(body.capabilities.allowedModels).toContain(model);
      expect(store.settings().model).toBe(model);
    }
    expect(readConfig({ OPENAI_ALLOWED_MODELS: 'gpt-6-luna' }).allowedModels).toEqual(['gpt-6-luna']);
  });
  it('construit le contexte serveur autour d’aujourd’hui même pour un créneau lointain, avec le modèle choisi', async () => {
    await app.close();
    const today = parisDate();
    const date = addDays(today, 90);
    const recipe = dish({ name: 'Soupe maison', details: { ...details, name: 'Soupe corrigée' } });
    const archived = dish({ name: 'Ancien gratin', archived: true });
    store.merge([recipe, archived, ...[-16, -15, 15, 16].map(offset => meal({
      id: `${addDays(today, offset)}:lunch`, date: addDays(today, offset), text: `Choix ${offset}`,
      dishId: offset === -15 ? recipe.id : null,
    })), { ...store.settings(), model: 'gpt-6-sol', modifiedAt: Date.now(), mutationId: randomUUID() }]);
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
      foyer: defaultHousehold,
      repasChoisis: ['Choix -15', recipe.name, recipe.details!.name, 'Choix 15'],
      platsDejaCrees: expect.arrayContaining([recipe.name, recipe.details!.name, archived.name]),
    });
    expect(JSON.parse(body.input).platsDejaCrees).toHaveLength(3);
  });
  it('partage la composition du foyer et la transmet à la génération', async () => {
    await app.close();
    const household = { adults: 1, teenagers: 3, children: 0 };
    const aiRequest = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({
      status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text',
        text: JSON.stringify({ ...details, name: 'Nouvelle idée', seasons: ['autumn'] }),
      }] }], usage: { input_tokens: 123, output_tokens: 45 },
    })));
    store.merge([{ ...store.settings(), household, modifiedAt: Date.now(), mutationId: randomUUID() }]);
    app = await buildApp(store, config, { logger: false, aiRequest });
    const response = await app.inject({ method: 'POST', url: '/api/meals/generate', payload: { date: '2026-10-30' } });
    expect(response.statusCode).toBe(200);
    const body = JSON.parse(String(aiRequest.mock.calls[0][1]?.body));
    expect(JSON.parse(body.input).foyer).toEqual(household);
  });
  it('refuse un doublon proposé par l’IA sans sauvegarder ni relancer automatiquement', async () => {
    await app.close();
    const recipe = dish({ name: 'Gratin de courge' });
    store.merge([recipe]);
    const aiRequest = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({
      status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text',
        text: JSON.stringify({ ...details, name: 'GRATIN  DE COURGE', seasons: ['autumn'] }),
      }] }],
      usage: { input_tokens: 123, output_tokens: 45 },
    })));
    app = await buildApp(store, config, { logger: false, aiRequest });
    const response = await app.inject({ method: 'POST', url: '/api/meals/generate', payload: { date: '2026-10-30' } });
    expect(response.statusCode).toBe(502);
    expect(response.json().error).toContain('déjà créé ou déjà choisi');
    expect(store.records()).toHaveLength(2);
    expect(store.capabilities().callsToday).toBe(1);
    expect(aiRequest).toHaveBeenCalledOnce();
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
    expect(store.records()).toHaveLength(1);
    expect(store.analyses()).toEqual([]);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(aiRequest).toHaveBeenCalledOnce();
  });
  it('refuse dates invalides et origines tierces avant de consommer un appel', async () => {
    for (const [payload, headers, status] of [
      [{ date: '2026-02-30' }, {}, 400],
      [{ date: '2026-10-30' }, { origin: 'https://other.invalid' }, 403],
    ] as const) {
      const response = await app.inject({ method: 'POST', url: '/api/meals/generate', payload, headers });
      expect(response.statusCode).toBe(status);
    }
    expect(store.capabilities().callsToday).toBe(0);
  });
  it('génère au-delà des anciens plafonds sans limite par minute, même avec les anciennes variables', async () => {
    await app.close();
    store.close();
    const legacyConfig = readConfig({
      DATABASE_PATH: ':memory:', OPENAI_API_KEY: 'test-only',
      AI_DAILY_LIMIT: '1', AI_MONTHLY_LIMIT: '1',
    });
    store = new Store(legacyConfig);
    store.db.prepare('INSERT INTO ai_usage (day, calls) VALUES (?, 200)').run(parisDate());
    const generated = { ...details, seasons: ['autumn'] };
    const aiRequest = vi.fn<typeof fetch>().mockImplementation(async () => new Response(JSON.stringify({
      status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify(generated) }] }],
      usage: { input_tokens: 123, output_tokens: 45 },
    })));
    app = await buildApp(store, legacyConfig, { logger: false, aiRequest });
    for (let i = 0; i < 11; i++) {
      const response = await app.inject({ method: 'POST', url: '/api/meals/generate', payload: { date: '2026-10-30' } });
      expect(response.statusCode, response.body).toBe(200);
      expect(response.json().details).toEqual(generated);
    }
    expect(aiRequest).toHaveBeenCalledTimes(11);
    const response = await app.inject({ method: 'POST', url: '/api/sync', payload: { mutations: [] } });
    const { capabilities } = syncResponseSchema.parse(response.json());
    expect(capabilities).toMatchObject({ callsToday: 211, callsThisMonth: 211, inputTokens: 1353, outputTokens: 495 });
    expect(response.json().capabilities).not.toHaveProperty('dailyLimit');
    expect(response.json().capabilities).not.toHaveProperty('monthlyLimit');
  });
  it('compte les échecs de génération sans bloquer les appels suivants ni le worker', async () => {
    await app.close();
    const aiRequest = vi.fn<typeof fetch>().mockResolvedValue(new Response('{}', { status: 503 }));
    app = await buildApp(store, config, { logger: false, aiRequest });
    const generate = () => app.inject({ method: 'POST', url: '/api/meals/generate', payload: { date: '2026-10-30' } });
    const failed = await generate();
    expect(failed.statusCode).toBe(502);
    expect(failed.json().error).toContain('503');
    expect((await generate()).statusCode).toBe(502);
    store.merge([dish()]);
    expect(store.claimAnalysis()).toBeDefined();
    expect(aiRequest).toHaveBeenCalledTimes(2);
    expect(store.capabilities().callsToday).toBe(3);
  });
  it('explique une clé absente ou un modèle retiré', () => {
    for (const [overrides, message] of [
      [{ OPENAI_API_KEY: '' }, 'clé OpenAI'],
      [{ allowedModels: [] }, 'modèle IA autorisé'],
    ] as const) {
      const isolated = new Store({ ...config, ...overrides, allowedModels: 'allowedModels' in overrides ? [] : config.allowedModels });
      try {
        expect(() => isolated.reserveGeneration()).toThrow(message);
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
    expect(store.get(`meal:${entry.id}`)).toEqual(entry);
    expect(store.analysis(recipe.id)?.status).toBe('pending');
    expect(store.capabilities().callsToday).toBe(0);
  });
  it('résout les conflits par créneau et indépendamment de l’ordre d’arrivée', () => {
    const old = meal({ modifiedAt: 1, text: 'Ancien' });
    const newer = meal({ modifiedAt: 3, text: 'Nouveau' });
    const evening = meal({ modifiedAt: 2, id: '2026-10-30:dinner', slot: 'dinner', text: 'Soupe' });
    store.merge([newer, evening, old]);
    expect(store.get(`meal:${old.id}`)).toEqual(newer);
    expect(store.get(`meal:${evening.id}`)).toEqual(evening);
    store.merge([newer]);
    expect(store.records()).toHaveLength(3);
  });
  it('conserve les suppressions pour éviter la résurrection par un appareil hors ligne', () => {
    const old = meal({ modifiedAt: 1 });
    const cleared = { ...old, modifiedAt: 2, mutationId: randomUUID(), text: '', dishId: null };
    store.merge([old, cleared]);
    store.merge([old]);
    expect(store.get(`meal:${old.id}`)).toEqual(cleared);
  });
  it('ne modifie pas les menus lors du nettoyage IA ou de l’archivage', () => {
    const recipe = dish();
    const entry = meal({ dishId: recipe.id, text: 'poulet frite' });
    store.merge([recipe, entry]);
    const job = store.claimAnalysis()!;
    store.finishAnalysis(job.dish, details, null);
    expect(store.analysis(recipe.id)?.details?.name).toBe('Poulet-frites');
    expect(store.get(`meal:${entry.id}`)).toEqual(entry);
    store.merge([{ ...recipe, archived: true, modifiedAt: recipe.modifiedAt + 1, mutationId: randomUUID() }]);
    expect(store.get(`meal:${entry.id}`)).toEqual(entry);
  });
  it('ignore une analyse devenue obsolète ou concurrencée par une correction manuelle', () => {
    const recipe = dish();
    store.merge([recipe]);
    store.claimAnalysis();
    const changed = { ...recipe, analysisKey: randomUUID(), modifiedAt: recipe.modifiedAt + 1, mutationId: randomUUID() };
    store.merge([changed]);
    store.finishAnalysis(recipe, details, null);
    expect(store.analysis(recipe.id)?.status).toBe('pending');
    const job = store.claimAnalysis()!;
    store.merge([{ ...changed, details: { ...details, name: 'Ma recette' }, modifiedAt: changed.modifiedAt + 1, mutationId: randomUUID() }]);
    store.finishAnalysis(job.dish, details, null);
    const result = store.get(`dish:${recipe.id}`);
    expect(result?.type === 'dish' && result.details?.name).toBe('Ma recette');
  });
  it('refuse atomiquement les lots invalides et les horloges trop avancées', async () => {
    for (const invalid of [
      meal({ text: 'a'.repeat(241) }),
      meal({ modifiedAt: Date.now() + 10 * 60_000 }),
      { type: 'settings', id: 'global', model: 'not-allowed', modifiedAt: Date.now(), mutationId: randomUUID() },
    ]) {
      const response = await app.inject({ method: 'POST', url: '/api/sync', payload: { mutations: [dish(), invalid] } });
      expect(response.statusCode).toBe(400);
      expect(store.records()).toHaveLength(1);
    }
  });
  it('réinitialise les repas et ignore ceux des appareils qui ne l’ont pas encore appliquée, sans bloquer les paramètres', async () => {
    const recipe = dish();
    store.merge([recipe, meal({ dishId: recipe.id })]);
    const model = store.settings().model;
    const resetId = store.reset();
    expect(store.records().map(record => record.type)).toEqual(['settings']);
    expect(store.analyses()).toEqual([]);
    expect(store.settings().model).toBe(model);
    for (const payload of [{ mutations: [recipe] }, { mutations: [recipe], resetId: null }, { mutations: [recipe], resetId: randomUUID() }]) {
      const response = await app.inject({ method: 'POST', url: '/api/sync', payload });
      expect(response.statusCode).toBe(200);
      expect(syncResponseSchema.parse(response.json()).resetId).toBe(resetId);
      expect(store.records()).toHaveLength(1);
    }
    const household = { adults: 3, teenagers: 0, children: 1 };
    await app.inject({ method: 'POST', url: '/api/sync', payload: { mutations: [
      meal({ text: 'Ancien' }), { ...store.settings(), household, modifiedAt: Date.now(), mutationId: randomUUID() },
    ] } });
    expect(store.records().map(record => record.type)).toEqual(['settings']);
    expect(store.settings().household).toEqual(household);
    const accepted = await app.inject({ method: 'POST', url: '/api/sync', payload: { mutations: [dish()], resetId } });
    expect(accepted.json().records).toHaveLength(2);
  });
  it('rejette les écritures depuis un site tiers', async () => {
    const response = await app.inject({
      method: 'POST', url: '/api/sync', payload: { mutations: [dish()] },
      headers: { origin: 'https://other.invalid', 'sec-fetch-site': 'cross-site' },
    });
    expect(response.statusCode).toBe(403);
    expect(store.records()).toHaveLength(1);
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
    first.merge([recipe, meal()]);
    first.claimAnalysis();
    first.close();
    const second = new Store(persistentConfig);
    try {
      expect(second.records()).toHaveLength(3);
      expect(second.capabilities().callsToday).toBe(1);
      expect(second.analysis(recipe.id)?.status).toBe('error');
    } finally { second.close(); rmSync(folder, { recursive: true }); }
  });
  it('sauvegarde à chaud une base WAL et refuse d’écraser la sauvegarde', () => {
    const folder = mkdtempSync(join(tmpdir(), 'a-table-backup-'));
    const persistentConfig = { ...config, DATABASE_PATH: join(folder, 'planner.sqlite') };
    const running = new Store(persistentConfig);
    const target = join(folder, 'backup.sqlite');
    let restored: Store | undefined;
    try {
      running.merge([dish(), meal()]);
      const options = { env: { ...process.env, DATABASE_PATH: persistentConfig.DATABASE_PATH }, encoding: 'utf8' as const };
      const backup = spawnSync(process.execPath, ['scripts/backup.mjs', target], options);
      expect(backup.status, backup.stderr).toBe(0);
      restored = new Store({ ...config, DATABASE_PATH: target });
      expect(restored.records()).toEqual(running.records());
      const second = spawnSync(process.execPath, ['scripts/backup.mjs', target], options);
      expect(second.status).not.toBe(0);
      expect(second.stderr).toContain('existe déjà');
    } finally { restored?.close(); running.close(); rmSync(folder, { recursive: true }); }
  });
});
