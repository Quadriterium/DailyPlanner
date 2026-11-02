import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  analysisSchema, catalogEntrySchema, commonSpaceId, compareVersions, defaultCookingLevel, defaultHousehold, featureRequestSchema, normalizedName,
  parisDate, recordKey, recordSchema,
  type Analysis, type Capabilities, type CatalogEntry, type CatalogResponse, type Dish, type DishDetails, type FeatureRequest, type FeatureRequestStatus,
  type RecordData, type Settings,
} from '../shared/model.js';
import type { Config } from './config.js';

export const schemaVersion = 4;
export const dailyAiLimit = 20;
export class AiQuotaError extends Error {
  constructor() {
    super('Limite de 20 requêtes IA atteinte pour ce foyer aujourd’hui. Réessayez demain (heure de Paris). Les recettes existantes restent disponibles.');
  }
}
export type SpaceKind = 'common' | 'household';
export interface Space { id: string; kind: SpaceKind; name: string; resetId: string | null; createdAt: number }

const authSchema = `
  CREATE TABLE IF NOT EXISTS spaces (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL CHECK (kind IN ('common', 'household')),
    name TEXT NOT NULL,
    reset_id TEXT,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    display_name TEXT NOT NULL,
    email TEXT,
    email_verified INTEGER NOT NULL DEFAULT 0,
    picture_url TEXT,
    created_at INTEGER NOT NULL,
    last_login_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS identities (
    provider TEXT NOT NULL,
    subject TEXT NOT NULL,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    email TEXT,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (provider, subject)
  );
  CREATE TABLE IF NOT EXISTS memberships (
    user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    space_id TEXT NOT NULL REFERENCES spaces(id),
    joined_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS memberships_space ON memberships(space_id);
  CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at INTEGER NOT NULL,
    last_seen_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS auth_transactions (
    id_hash TEXT PRIMARY KEY,
    provider TEXT NOT NULL,
    state TEXT NOT NULL,
    nonce TEXT NOT NULL,
    code_verifier TEXT NOT NULL,
    invitation_hash TEXT,
    expires_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS invitations (
    id TEXT PRIMARY KEY,
    space_id TEXT NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
    token_hash TEXT NOT NULL UNIQUE,
    created_by TEXT NOT NULL REFERENCES users(id),
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    accepted_by TEXT REFERENCES users(id),
    accepted_at INTEGER,
    revoked_at INTEGER
  );
`;
const sharedSchema = `
  CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS ai_usage (
    day TEXT PRIMARY KEY, calls INTEGER NOT NULL DEFAULT 0,
    input_tokens INTEGER NOT NULL DEFAULT 0, output_tokens INTEGER NOT NULL DEFAULT 0
  );
`;
const spaceRecordsSchema = `
  CREATE TABLE records (space_id TEXT NOT NULL, key TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY (space_id, key));
  CREATE TABLE analyses (space_id TEXT NOT NULL, dish_id TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY (space_id, dish_id));
`;

export class Store {
  readonly db: DatabaseSync;
  private depth = 0;

  constructor(readonly config: Config, options: { now?: () => Date } = {}) {
    if (config.DATABASE_PATH !== ':memory:') mkdirSync(dirname(config.DATABASE_PATH), { recursive: true });
    this.db = new DatabaseSync(config.DATABASE_PATH);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA busy_timeout = 5000;
      PRAGMA foreign_keys = ON;
    `);
    this.migrate(options.now?.() ?? new Date());
    this.transaction(() => {
      if (Number(this.db.prepare('PRAGMA user_version').get()?.user_version) >= 3) return;
      this.db.exec(`
        CREATE TABLE household_ai_usage (
          space_id TEXT NOT NULL REFERENCES spaces(id) ON DELETE CASCADE, day TEXT NOT NULL,
          calls INTEGER NOT NULL DEFAULT 0, input_tokens INTEGER NOT NULL DEFAULT 0,
          output_tokens INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (space_id, day)
        );
        INSERT INTO household_ai_usage SELECT 'common', day, calls, input_tokens, output_tokens FROM ai_usage;
        CREATE TABLE ai_limit_exemptions (space_id TEXT PRIMARY KEY REFERENCES spaces(id) ON DELETE CASCADE);
        PRAGMA user_version = 3;
      `);
    });
    this.transaction(() => {
      if (Number(this.db.prepare('PRAGMA user_version').get()?.user_version) >= 4) return;
      // Catalogue commun : seq croît à chaque ajout, correction ou retrait pour la synchronisation incrémentale des clients.
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS catalog (
          id TEXT PRIMARY KEY, seq INTEGER NOT NULL UNIQUE, name_key TEXT NOT NULL,
          deleted INTEGER NOT NULL DEFAULT 0, data TEXT NOT NULL, space_id TEXT, created_at INTEGER NOT NULL
        );
        CREATE UNIQUE INDEX IF NOT EXISTS catalog_name ON catalog(name_key) WHERE deleted = 0;
      `);
      this.db.prepare("INSERT OR IGNORE INTO meta (key, value) VALUES ('catalogId', ?)").run(randomUUID());
      this.db.exec('PRAGMA user_version = 4;');
    });
    this.ensureSpaceSettings(commonSpaceId);
    for (const row of this.db.prepare('SELECT space_id, data FROM analyses').all()) {
      const analysis = analysisSchema.parse(JSON.parse(String(row.data)));
      if (analysis.status === 'processing') this.putAnalysis(String(row.space_id), {
        ...analysis, status: 'error',
        error: 'Analyse interrompue au redémarrage du serveur. Vous pouvez la relancer.',
      });
    }
  }

  /** Runs `work` in a single SQLite transaction; nested calls join the outer transaction. */
  transaction<T>(work: () => T): T {
    if (this.depth > 0) return work();
    this.db.exec('BEGIN IMMEDIATE');
    this.depth++;
    try {
      const result = work();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    } finally { this.depth--; }
  }

  private tableExists(name: string) {
    return Boolean(this.db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name));
  }

  /** Migration 1 → 2 : données par espace, comptes, sessions et invitations. Idempotente grâce à user_version. */
  private migrate(now: Date) {
    const version = Number(this.db.prepare('PRAGMA user_version').get()?.user_version ?? 0);
    if (version >= 2) return;
    const legacy = version === 1 || this.tableExists('records');
    if (legacy && this.config.DATABASE_PATH !== ':memory:') {
      const backup = join(dirname(resolve(this.config.DATABASE_PATH)), 'backups', `avant-auth-${now.toISOString().replace(/[:.]/g, '-')}.sqlite`);
      mkdirSync(dirname(backup), { recursive: true });
      this.db.prepare('VACUUM INTO ?').run(backup);
    }
    this.transaction(() => {
      this.db.exec(sharedSchema);
      this.db.exec(authSchema);
      if (legacy) {
        const resetId = this.db.prepare("SELECT value FROM meta WHERE key = 'resetId'").get();
        this.db.exec(`
          ALTER TABLE records RENAME TO records_v1;
          ${this.tableExists('analyses') ? 'ALTER TABLE analyses RENAME TO analyses_v1;' : 'CREATE TABLE analyses_v1 (dish_id TEXT PRIMARY KEY, data TEXT NOT NULL);'}
          ${spaceRecordsSchema}
          INSERT INTO records (space_id, key, data) SELECT 'common', key, data FROM records_v1;
          INSERT INTO analyses (space_id, dish_id, data) SELECT 'common', dish_id, data FROM analyses_v1;
          DROP TABLE records_v1;
          DROP TABLE analyses_v1;
        `);
        if (this.tableExists('feature_requests')) {
          this.db.exec(`
            ALTER TABLE feature_requests ADD COLUMN space_id TEXT NOT NULL DEFAULT 'common';
            ALTER TABLE feature_requests ADD COLUMN user_id TEXT;
          `);
        }
        this.db.prepare("INSERT INTO spaces (id, kind, name, reset_id, created_at) VALUES ('common', 'common', 'Espace commun', ?, ?)")
          .run(resetId ? String(resetId.value) : null, now.getTime());
        this.db.prepare("DELETE FROM meta WHERE key = 'resetId'").run();
      } else {
        this.db.exec(spaceRecordsSchema);
        this.db.prepare("INSERT INTO spaces (id, kind, name, reset_id, created_at) VALUES ('common', 'common', 'Espace commun', NULL, ?)")
          .run(now.getTime());
      }
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS feature_requests (
          id TEXT PRIMARY KEY, text TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'received',
          note TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
          space_id TEXT NOT NULL DEFAULT 'common', user_id TEXT
        );
        PRAGMA user_version = 2;
      `);
    });
  }

  space(id: string): Space | undefined {
    const row = this.db.prepare('SELECT * FROM spaces WHERE id = ?').get(id);
    return row ? {
      id: String(row.id), kind: row.kind as SpaceKind, name: String(row.name),
      resetId: row.reset_id === null ? null : String(row.reset_id), createdAt: Number(row.created_at),
    } : undefined;
  }

  createSpace(kind: SpaceKind, name: string): Space {
    const space: Space = { id: randomUUID(), kind, name, resetId: null, createdAt: Date.now() };
    this.transaction(() => {
      this.db.prepare('INSERT INTO spaces (id, kind, name, reset_id, created_at) VALUES (?, ?, ?, NULL, ?)')
        .run(space.id, kind, name, space.createdAt);
      this.ensureSpaceSettings(space.id);
    });
    return space;
  }

  /** Creates the initial shared settings (version 0) of a space. */
  ensureSpaceSettings(spaceId: string) {
    if (this.get(spaceId, 'settings:global')) return;
    this.put(spaceId, {
      type: 'settings', id: 'global', model: this.config.OPENAI_MODEL,
      household: { ...defaultHousehold }, avoid: '', cookingLevel: defaultCookingLevel,
      modifiedAt: 0, mutationId: '00000000-0000-0000-0000-000000000000',
    });
  }

  get(spaceId: string, key: string): RecordData | undefined {
    const row = this.db.prepare('SELECT data FROM records WHERE space_id = ? AND key = ?').get(spaceId, key);
    return row ? recordSchema.parse(JSON.parse(String(row.data))) : undefined;
  }

  records(spaceId: string): RecordData[] {
    return this.db.prepare('SELECT data FROM records WHERE space_id = ? ORDER BY key').all(spaceId)
      .map(row => recordSchema.parse(JSON.parse(String(row.data))));
  }

  analyses(spaceId: string): Analysis[] {
    return this.db.prepare('SELECT data FROM analyses WHERE space_id = ? ORDER BY dish_id').all(spaceId)
      .map(row => analysisSchema.parse(JSON.parse(String(row.data))));
  }

  analysis(spaceId: string, id: string): Analysis | undefined {
    const row = this.db.prepare('SELECT data FROM analyses WHERE space_id = ? AND dish_id = ?').get(spaceId, id);
    return row ? analysisSchema.parse(JSON.parse(String(row.data))) : undefined;
  }

  resetId(spaceId: string): string | null {
    return this.space(spaceId)?.resetId ?? null;
  }

  /** Deletes planned meals and library dishes (with their analyses) of a space and forces its clients to drop their copies. */
  reset(spaceId: string): string {
    const resetId = randomUUID();
    this.transaction(() => {
      if (!this.space(spaceId)) throw new Error('Espace introuvable.');
      this.db.prepare("DELETE FROM records WHERE space_id = ? AND (key LIKE 'meal:%' OR key LIKE 'dish:%')").run(spaceId);
      this.db.prepare('DELETE FROM analyses WHERE space_id = ?').run(spaceId);
      this.db.prepare('UPDATE spaces SET reset_id = ? WHERE id = ?').run(resetId, spaceId);
    });
    return resetId;
  }

  settings(spaceId: string): Settings {
    const record = this.get(spaceId, 'settings:global');
    if (record?.type !== 'settings') throw new Error('Paramètres manquants dans la base.');
    return record;
  }

  private put(spaceId: string, record: RecordData) {
    this.db.prepare('INSERT INTO records (space_id, key, data) VALUES (?, ?, ?) ON CONFLICT(space_id, key) DO UPDATE SET data = excluded.data')
      .run(spaceId, recordKey(record), JSON.stringify(record));
  }

  private putAnalysis(spaceId: string, analysis: Omit<Analysis, 'updatedAt'>) {
    this.db.prepare('INSERT INTO analyses (space_id, dish_id, data) VALUES (?, ?, ?) ON CONFLICT(space_id, dish_id) DO UPDATE SET data = excluded.data')
      .run(spaceId, analysis.dishId, JSON.stringify({ ...analysis, updatedAt: Date.now() }));
  }

  /** Copies an analysis as is (administration: moving data between spaces). */
  copyAnalysis(spaceId: string, analysis: Analysis) {
    this.db.prepare('INSERT INTO analyses (space_id, dish_id, data) VALUES (?, ?, ?) ON CONFLICT(space_id, dish_id) DO UPDATE SET data = excluded.data')
      .run(spaceId, analysis.dishId, JSON.stringify(analysis));
  }

  merge(spaceId: string, records: RecordData[]) {
    this.transaction(() => {
      for (const record of records) {
        const previous = this.get(spaceId, recordKey(record));
        if (previous && compareVersions(record, previous) <= 0) continue;
        this.put(spaceId, record);
        if (record.type === 'dish') {
          const current = this.analysis(spaceId, record.id);
          if (!current || current.analysisKey !== record.analysisKey) this.putAnalysis(spaceId, {
            dishId: record.id, analysisKey: record.analysisKey,
            status: 'pending', details: null, error: null,
          });
        }
      }
    });
  }

  dailyLimit(spaceId: string): number | null {
    return this.db.prepare('SELECT 1 FROM ai_limit_exemptions WHERE space_id = ?').get(spaceId) ? null : dailyAiLimit;
  }

  setAiLimitExempt(spaceId: string, exempt: boolean) {
    if (!this.space(spaceId)) throw new Error('Foyer introuvable.');
    if (exempt) this.db.prepare('INSERT OR IGNORE INTO ai_limit_exemptions (space_id) VALUES (?)').run(spaceId);
    else this.db.prepare('DELETE FROM ai_limit_exemptions WHERE space_id = ?').run(spaceId);
  }

  private quotaReached(spaceId: string, day: string) {
    const calls = Number(this.db.prepare('SELECT calls FROM household_ai_usage WHERE space_id = ? AND day = ?').get(spaceId, day)?.calls ?? 0);
    const limit = this.dailyLimit(spaceId);
    return limit !== null && calls >= limit;
  }

  private recordCall(spaceId: string, day: string) {
    this.db.prepare('INSERT INTO household_ai_usage (space_id, day, calls) VALUES (?, ?, 1) ON CONFLICT(space_id, day) DO UPDATE SET calls = calls + 1').run(spaceId, day);
    this.db.prepare('INSERT INTO ai_usage (day, calls) VALUES (?, 1) ON CONFLICT(day) DO UPDATE SET calls = calls + 1').run(day);
  }

  capabilities(now = new Date(), spaceId?: string): Capabilities {
    const today = parisDate(now);
    const table = spaceId ? 'household_ai_usage' : 'ai_usage';
    const filter = spaceId ? ' AND space_id = ?' : '';
    const params = spaceId ? [spaceId] : [];
    const daily = this.db.prepare(`SELECT calls FROM ${table} WHERE day = ?${filter}`).get(today, ...params);
    const monthly = this.db.prepare(`
      SELECT COALESCE(SUM(calls), 0) AS calls, COALESCE(SUM(input_tokens), 0) AS input_tokens,
      COALESCE(SUM(output_tokens), 0) AS output_tokens FROM ${table} WHERE day LIKE ?${filter}
    `).get(`${today.slice(0, 7)}%`, ...params)!;
    return {
      aiConfigured: Boolean(this.config.OPENAI_API_KEY),
      allowedModels: this.config.allowedModels,
      callsToday: Number(daily?.calls ?? 0),
      callsThisMonth: Number(monthly.calls),
      inputTokens: Number(monthly.input_tokens),
      outputTokens: Number(monthly.output_tokens),
      dailyLimit: this.dailyLimit(spaceId ?? commonSpaceId),
    };
  }

  /** Next pending analysis across all spaces, in a stable order; the worker uses the settings of the dish's space. */
  claimAnalysis(): { spaceId: string; dish: Dish; day: string } | undefined {
    if (!this.config.OPENAI_API_KEY) return;
    return this.transaction(() => {
      const allowed = new Map<string, boolean>();
      for (const row of this.db.prepare('SELECT space_id, data FROM analyses ORDER BY space_id, dish_id').all()) {
        const spaceId = String(row.space_id);
        const analysis = analysisSchema.parse(JSON.parse(String(row.data)));
        if (analysis.status !== 'pending') continue;
        if (!allowed.has(spaceId)) {
          const settings = this.get(spaceId, 'settings:global');
          allowed.set(spaceId, settings?.type === 'settings' && this.config.allowedModels.includes(settings.model));
        }
        if (!allowed.get(spaceId)) continue;
        const dish = this.get(spaceId, `dish:${analysis.dishId}`);
        if (dish?.type !== 'dish' || dish.archived || dish.details || dish.analysisKey !== analysis.analysisKey) continue;
        const day = parisDate();
        if (this.quotaReached(spaceId, day)) {
          if (!analysis.error) this.putAnalysis(spaceId, { ...analysis, error: new AiQuotaError().message });
          continue;
        }
        this.putAnalysis(spaceId, { ...analysis, status: 'processing', error: null });
        this.recordCall(spaceId, day);
        return { spaceId, dish, day };
      }
    });
  }

  reserveGeneration(spaceId: string): string {
    if (!this.config.OPENAI_API_KEY) throw new Error('La génération IA nécessite une clé OpenAI configurée sur le serveur.');
    if (!this.config.allowedModels.includes(this.settings(spaceId).model)) throw new Error('Choisissez un modèle IA autorisé dans les paramètres.');
    return this.transaction(() => {
      const day = parisDate();
      if (this.quotaReached(spaceId, day)) throw new AiQuotaError();
      this.recordCall(spaceId, day);
      return day;
    });
  }

  finishAnalysis(spaceId: string, dish: Dish, details: DishDetails | null, error: string | null) {
    const current = this.get(spaceId, `dish:${dish.id}`);
    // An obsolete response must never replace a manual edit or a newer analysis.
    if (current?.type !== 'dish' || current.analysisKey !== dish.analysisKey || current.details) return;
    const name = this.analysis(spaceId, dish.id)?.name;
    this.putAnalysis(spaceId, {
      dishId: dish.id, analysisKey: dish.analysisKey,
      status: error ? 'error' : 'ready', details, error,
      ...(name ? { name } : {}),
    });
  }

  nameAnalysis(spaceId: string, dish: Dish, name: string) {
    const current = this.get(spaceId, `dish:${dish.id}`);
    const analysis = this.analysis(spaceId, dish.id);
    if (current?.type !== 'dish' || current.analysisKey !== dish.analysisKey || current.details || current.archived ||
      analysis?.analysisKey !== dish.analysisKey || analysis.status !== 'processing') return;
    this.putAnalysis(spaceId, { ...analysis, name });
  }

  recordTokens(day: string, input: number, output: number, spaceId: string) {
    this.transaction(() => {
      this.db.prepare('UPDATE ai_usage SET input_tokens = input_tokens + ?, output_tokens = output_tokens + ? WHERE day = ?')
        .run(input, output, day);
      this.db.prepare('UPDATE household_ai_usage SET input_tokens = input_tokens + ?, output_tokens = output_tokens + ? WHERE space_id = ? AND day = ?')
        .run(input, output, spaceId, day);
    });
  }

  catalogId(): string {
    return String(this.db.prepare("SELECT value FROM meta WHERE key = 'catalogId'").get()!.value);
  }

  private nextCatalogSeq(): number {
    return Number(this.db.prepare('SELECT COALESCE(MAX(seq), 0) + 1 AS seq FROM catalog').get()!.seq);
  }

  private catalogRow(row: Record<string, unknown>): CatalogEntry & { deleted: boolean; seq: number; spaceId: string | null; createdAt: number } {
    return {
      ...catalogEntrySchema.parse(JSON.parse(String(row.data))), deleted: Boolean(row.deleted), seq: Number(row.seq),
      spaceId: row.space_id === null ? null : String(row.space_id), createdAt: Number(row.created_at),
    };
  }

  /**
   * Adds an AI recipe to the shared catalogue. Only structured recipes (ingredient quantities and level) are accepted,
   * and an existing entry with the same normalized name is kept as is.
   */
  addToCatalog(details: DishDetails, sourceUrl: string | undefined, spaceId: string | null): CatalogEntry | undefined {
    if (!details.items?.length || !details.level || !details.servings) return;
    return this.transaction(() => {
      const nameKey = normalizedName(details.name);
      if (this.db.prepare('SELECT 1 FROM catalog WHERE name_key = ? AND deleted = 0').get(nameKey)) return;
      const entry = catalogEntrySchema.parse({ id: randomUUID(), details, ...(sourceUrl ? { sourceUrl } : {}) });
      this.db.prepare('INSERT INTO catalog (id, seq, name_key, deleted, data, space_id, created_at) VALUES (?, ?, ?, 0, ?, ?, ?)')
        .run(entry.id, this.nextCatalogSeq(), nameKey, JSON.stringify(entry), spaceId, Date.now());
      return entry;
    });
  }

  /** Active entries of the shared catalogue, oldest first. */
  catalog(): CatalogEntry[] {
    return this.db.prepare('SELECT data FROM catalog WHERE deleted = 0 ORDER BY seq').all()
      .map(row => catalogEntrySchema.parse(JSON.parse(String(row.data))));
  }

  /** Changes after `cursor`, in order: new or corrected entries, and identifiers removed by the administrator. */
  catalogChanges(cursor: number, limit = 200): CatalogResponse {
    const rows = this.db.prepare('SELECT * FROM catalog WHERE seq > ? ORDER BY seq LIMIT ?').all(cursor, limit + 1);
    const page = rows.slice(0, limit).map(row => this.catalogRow(row));
    return {
      catalogId: this.catalogId(),
      cursor: page.at(-1)?.seq ?? cursor,
      more: rows.length > limit,
      entries: page.filter(entry => !entry.deleted).map(({ id, details, sourceUrl }) => ({ id, details, ...(sourceUrl ? { sourceUrl } : {}) })),
      removed: page.filter(entry => entry.deleted).map(entry => entry.id),
    };
  }

  /** Administration: entries whose name contains `search` (all when empty), including removed ones if asked. */
  catalogEntries(search = '', withRemoved = false) {
    return this.db.prepare(`SELECT * FROM catalog${withRemoved ? '' : ' WHERE deleted = 0'} ORDER BY seq`).all()
      .map(row => this.catalogRow(row))
      .filter(entry => normalizedName(entry.details.name).includes(normalizedName(search)));
  }

  /** Finds a single catalogue entry from its identifier or a unique prefix of it. */
  catalogEntry(idOrPrefix: string) {
    const matches = this.db.prepare('SELECT * FROM catalog WHERE id LIKE ?').all(`${idOrPrefix.replace(/[%_]/g, '')}%`);
    if (matches.length !== 1) throw new Error(matches.length ? 'Plusieurs fiches correspondent : précisez l’identifiant.' : 'Fiche du catalogue introuvable.');
    return this.catalogRow(matches[0]);
  }

  /** Administration: removes an entry (or restores it) for every client at their next catalogue synchronization. */
  setCatalogRemoved(idOrPrefix: string, removed: boolean): CatalogEntry {
    return this.transaction(() => {
      const entry = this.catalogEntry(idOrPrefix);
      if (!removed && this.db.prepare('SELECT 1 FROM catalog WHERE name_key = ? AND deleted = 0 AND id != ?')
        .get(normalizedName(entry.details.name), entry.id)) throw new Error('Une autre fiche active porte déjà ce nom.');
      this.db.prepare('UPDATE catalog SET deleted = ?, seq = ? WHERE id = ?').run(removed ? 1 : 0, this.nextCatalogSeq(), entry.id);
      return entry;
    });
  }

  /** Administration: replaces the details of an entry, keeping its identifier. */
  correctCatalogEntry(idOrPrefix: string, details: DishDetails, sourceUrl?: string | null): CatalogEntry {
    return this.transaction(() => {
      const current = this.catalogEntry(idOrPrefix);
      const nameKey = normalizedName(details.name);
      if (this.db.prepare('SELECT 1 FROM catalog WHERE name_key = ? AND deleted = 0 AND id != ?').get(nameKey, current.id)) {
        throw new Error('Une autre fiche active porte déjà ce nom.');
      }
      const url = sourceUrl === null ? undefined : sourceUrl ?? current.sourceUrl;
      const entry = catalogEntrySchema.parse({ id: current.id, details, ...(url ? { sourceUrl: url } : {}) });
      this.db.prepare('UPDATE catalog SET data = ?, name_key = ?, seq = ? WHERE id = ?')
        .run(JSON.stringify(entry), nameKey, this.nextCatalogSeq(), entry.id);
      return entry;
    });
  }

  private featureRequest(row: Record<string, unknown>): FeatureRequest {
    return featureRequestSchema.parse({
      id: row.id, text: row.text, status: row.status, note: row.note ?? null,
      createdAt: Number(row.created_at), updatedAt: Number(row.updated_at),
    });
  }

  featureRequests(spaceId: string): FeatureRequest[] {
    return this.db.prepare('SELECT * FROM feature_requests WHERE space_id = ? ORDER BY created_at DESC, id').all(spaceId)
      .map(row => this.featureRequest(row));
  }

  /** Every request with the name of its space, for the administration command. */
  allFeatureRequests(): { request: FeatureRequest; spaceId: string; spaceName: string | null }[] {
    return this.db.prepare(`
      SELECT feature_requests.*, spaces.name AS space_name FROM feature_requests
      LEFT JOIN spaces ON spaces.id = feature_requests.space_id ORDER BY created_at DESC, feature_requests.id
    `).all().map(row => ({
      request: this.featureRequest(row), spaceId: String(row.space_id),
      spaceName: row.space_name === null ? null : String(row.space_name),
    }));
  }

  addFeatureRequest(spaceId: string, text: string, userId: string | null = null): FeatureRequest {
    const now = Date.now();
    const request = featureRequestSchema.parse({ id: randomUUID(), text, status: 'received', note: null, createdAt: now, updatedAt: now });
    this.db.prepare('INSERT INTO feature_requests (id, text, status, note, created_at, updated_at, space_id, user_id) VALUES (?, ?, ?, NULL, ?, ?, ?, ?)')
      .run(request.id, request.text, request.status, now, now, spaceId, userId);
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
