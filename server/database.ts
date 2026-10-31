import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  analysisSchema, compareVersions, defaultHousehold, featureRequestSchema, parisDate, recordKey, recordSchema,
  type Analysis, type Capabilities, type Dish, type DishDetails, type FeatureRequest, type FeatureRequestStatus,
  type RecordData, type Settings,
} from '../shared/model.js';
import type { Config } from './config.js';

export class Store {
  readonly db: DatabaseSync;

  constructor(readonly config: Config) {
    if (config.DATABASE_PATH !== ':memory:') mkdirSync(dirname(config.DATABASE_PATH), { recursive: true });
    this.db = new DatabaseSync(config.DATABASE_PATH);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS records (key TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS analyses (dish_id TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS ai_usage (
        day TEXT PRIMARY KEY, calls INTEGER NOT NULL DEFAULT 0,
        input_tokens INTEGER NOT NULL DEFAULT 0, output_tokens INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS feature_requests (
        id TEXT PRIMARY KEY, text TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'received',
        note TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
      );
      PRAGMA user_version = 1;
    `);
    if (!this.get('settings:global')) {
      this.put({
        type: 'settings', id: 'global', model: config.OPENAI_MODEL,
        household: { ...defaultHousehold }, avoid: '',
        modifiedAt: 0, mutationId: '00000000-0000-0000-0000-000000000000',
      });
    }
    for (const analysis of this.analyses()) {
      if (analysis.status === 'processing') this.putAnalysis({
        ...analysis, status: 'error',
        error: 'Analyse interrompue au redémarrage du serveur. Vous pouvez la relancer.',
      });
    }
  }

  get(key: string): RecordData | undefined {
    const row = this.db.prepare('SELECT data FROM records WHERE key = ?').get(key);
    return row ? recordSchema.parse(JSON.parse(String(row.data))) : undefined;
  }

  records(): RecordData[] {
    return this.db.prepare('SELECT data FROM records ORDER BY key').all()
      .map(row => recordSchema.parse(JSON.parse(String(row.data))));
  }

  analyses(): Analysis[] {
    return this.db.prepare('SELECT data FROM analyses ORDER BY dish_id').all()
      .map(row => analysisSchema.parse(JSON.parse(String(row.data))));
  }

  analysis(id: string): Analysis | undefined {
    const row = this.db.prepare('SELECT data FROM analyses WHERE dish_id = ?').get(id);
    return row ? analysisSchema.parse(JSON.parse(String(row.data))) : undefined;
  }

  resetId(): string | null {
    const row = this.db.prepare("SELECT value FROM meta WHERE key = 'resetId'").get();
    return row ? String(row.value) : null;
  }

  /** Deletes planned meals and library dishes (with their analyses) and forces clients to drop their copies. */
  reset(): string {
    const resetId = randomUUID();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare("DELETE FROM records WHERE key LIKE 'meal:%' OR key LIKE 'dish:%'").run();
      this.db.prepare('DELETE FROM analyses').run();
      this.db.prepare("INSERT INTO meta (key, value) VALUES ('resetId', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
        .run(resetId);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    return resetId;
  }

  settings(): Settings {
    const record = this.get('settings:global');
    if (record?.type !== 'settings') throw new Error('Paramètres manquants dans la base.');
    return record;
  }

  private put(record: RecordData) {
    this.db.prepare('INSERT INTO records (key, data) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET data = excluded.data')
      .run(recordKey(record), JSON.stringify(record));
  }

  private putAnalysis(analysis: Omit<Analysis, 'updatedAt'>) {
    this.db.prepare('INSERT INTO analyses (dish_id, data) VALUES (?, ?) ON CONFLICT(dish_id) DO UPDATE SET data = excluded.data')
      .run(analysis.dishId, JSON.stringify({ ...analysis, updatedAt: Date.now() }));
  }

  merge(records: RecordData[]) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      for (const record of records) {
        const previous = this.get(recordKey(record));
        if (previous && compareVersions(record, previous) <= 0) continue;
        this.put(record);
        if (record.type === 'dish') {
          const current = this.analysis(record.id);
          if (!current || current.analysisKey !== record.analysisKey) this.putAnalysis({
            dishId: record.id, analysisKey: record.analysisKey,
            status: 'pending', details: null, error: null,
          });
        }
      }
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  capabilities(now = new Date()): Capabilities {
    const today = parisDate(now);
    const daily = this.db.prepare('SELECT calls FROM ai_usage WHERE day = ?').get(today);
    const monthly = this.db.prepare(`
      SELECT COALESCE(SUM(calls), 0) AS calls, COALESCE(SUM(input_tokens), 0) AS input_tokens,
      COALESCE(SUM(output_tokens), 0) AS output_tokens FROM ai_usage WHERE day LIKE ?
    `).get(`${today.slice(0, 7)}%`)!;
    return {
      aiConfigured: Boolean(this.config.OPENAI_API_KEY),
      allowedModels: this.config.allowedModels,
      callsToday: Number(daily?.calls ?? 0),
      callsThisMonth: Number(monthly.calls),
      inputTokens: Number(monthly.input_tokens),
      outputTokens: Number(monthly.output_tokens),
    };
  }

  claimAnalysis(): { dish: Dish; day: string } | undefined {
    if (!this.config.OPENAI_API_KEY || !this.config.allowedModels.includes(this.settings().model)) return;
    for (const analysis of this.analyses()) {
      if (analysis.status !== 'pending') continue;
      const dish = this.get(`dish:${analysis.dishId}`);
      if (dish?.type !== 'dish' || dish.archived || dish.details || dish.analysisKey !== analysis.analysisKey) continue;
      const day = parisDate();
      this.db.exec('BEGIN IMMEDIATE');
      try {
        this.putAnalysis({ ...analysis, status: 'processing', error: null });
        this.db.prepare('INSERT INTO ai_usage (day, calls) VALUES (?, 1) ON CONFLICT(day) DO UPDATE SET calls = calls + 1').run(day);
        this.db.exec('COMMIT');
      } catch (error) {
        this.db.exec('ROLLBACK');
        throw error;
      }

      return { dish, day };
    }
  }

  reserveGeneration(): string {
    if (!this.config.OPENAI_API_KEY) throw new Error('La génération IA nécessite une clé OpenAI configurée sur le serveur.');
    if (!this.config.allowedModels.includes(this.settings().model)) throw new Error('Choisissez un modèle IA autorisé dans les paramètres.');
    const day = parisDate();
    this.db.prepare('INSERT INTO ai_usage (day, calls) VALUES (?, 1) ON CONFLICT(day) DO UPDATE SET calls = calls + 1').run(day);
    return day;
  }

  finishAnalysis(dish: Dish, details: DishDetails | null, error: string | null) {
    const current = this.get(`dish:${dish.id}`);
    // An obsolete response must never replace a manual edit or a newer analysis.
    if (current?.type !== 'dish' || current.analysisKey !== dish.analysisKey || current.details) return;
    const name = this.analysis(dish.id)?.name;
    this.putAnalysis({
      dishId: dish.id, analysisKey: dish.analysisKey,
      status: error ? 'error' : 'ready', details, error,
      ...(name ? { name } : {}),
    });
  }

  nameAnalysis(dish: Dish, name: string) {
    const current = this.get(`dish:${dish.id}`);
    const analysis = this.analysis(dish.id);
    if (current?.type !== 'dish' || current.analysisKey !== dish.analysisKey || current.details || current.archived ||
      analysis?.analysisKey !== dish.analysisKey || analysis.status !== 'processing') return;
    this.putAnalysis({ ...analysis, name });
  }

  recordTokens(day: string, input: number, output: number) {
    this.db.prepare('UPDATE ai_usage SET input_tokens = input_tokens + ?, output_tokens = output_tokens + ? WHERE day = ?')
      .run(input, output, day);
  }

  featureRequests(): FeatureRequest[] {
    return this.db.prepare('SELECT * FROM feature_requests ORDER BY created_at DESC, id').all()
      .map(row => featureRequestSchema.parse({
        id: row.id, text: row.text, status: row.status, note: row.note ?? null,
        createdAt: Number(row.created_at), updatedAt: Number(row.updated_at),
      }));
  }

  addFeatureRequest(text: string): FeatureRequest {
    const now = Date.now();
    const request = featureRequestSchema.parse({ id: randomUUID(), text, status: 'received', note: null, createdAt: now, updatedAt: now });
    this.db.prepare('INSERT INTO feature_requests (id, text, status, note, created_at, updated_at) VALUES (?, ?, ?, NULL, ?, ?)')
      .run(request.id, request.text, request.status, now, now);
    return request;
  }

  /** Returns false when no request matches the id or its unique prefix. */
  updateFeatureRequest(idOrPrefix: string, status: FeatureRequestStatus, note: string | null): boolean {
    const matches = this.db.prepare('SELECT id FROM feature_requests WHERE id LIKE ?').all(`${idOrPrefix.replace(/[%_]/g, '')}%`);
    if (matches.length !== 1) return false;
    this.db.prepare('UPDATE feature_requests SET status = ?, note = ?, updated_at = ? WHERE id = ?')
      .run(status, note, Date.now(), String(matches[0].id));
    return true;
  }

  close() { this.db.close(); }
}
