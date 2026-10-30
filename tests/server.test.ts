import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { buildApp } from '../server/app';
import { readConfig } from '../server/config';
import { Store } from '../server/database';
import { syncResponseSchema } from '../shared/model';
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
  it('conserve les menus, les tâches et les quotas après un redémarrage', () => {
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
