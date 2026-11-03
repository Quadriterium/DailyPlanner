import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtempSync, rmSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { buildApp } from '../server/app';
import { readConfig } from '../server/config';
import { Store } from '../server/database';
import { Accounts } from '../server/auth/accounts';
import { hashToken } from '../server/auth/tokens';
import { backupDatabase } from '../server/maintenance';
import {
  adminAiSchema, adminAuditSchema, adminCatalogSchema, adminLifetime, adminOverviewSchema,
  adminRequestsSchema, adminSessionSchema, adminSpacesSchema, adminUsersSchema,
} from '../shared/admin';
import { commonSpaceId, parisDate, syncResponseSchema } from '../shared/model';
import { details, dish } from './fixtures';

const origin = 'http://localhost:3000';
const baseEnv = {
  DATABASE_PATH: ':memory:', OPENAI_API_KEY: 'test-key-not-real', AUTH_ENABLED: 'true',
  AUTH_TEST_PROVIDER: 'true', NODE_ENV: 'test', PUBLIC_ORIGIN: origin,
};
let config: ReturnType<typeof readConfig>;
let store: Store;
let accounts: Accounts;
let app: Awaited<ReturnType<typeof buildApp>>;
let adminId: string;
let otherId: string;
let clock: number;
let cookies: { atable_session: string };
let regularCookies: { atable_session: string };
let csrf: string;
const recipe = { ...details, servings: 4, items: [{ name: 'poulet', quantity: 400, unit: 'g' }] };

async function signIn(subject: string, admin = true) {
  const start = await app.inject({
    method: 'POST', url: '/api/auth/google/start', headers: { origin },
    payload: admin ? { returnTo: '/admin' } : {},
  });
  expect(start.statusCode).toBe(200);
  const oauth = start.cookies.find(cookie => cookie.name === 'atable_oauth')!.value;
  const authorize = new URL(start.json().url);
  const params = new URLSearchParams(authorize.searchParams);
  params.set('sub', subject);
  params.set('name', subject);
  params.set('email', `${subject}@example.org`);
  const result = await app.inject({
    url: `/api/auth/google/callback?${params}`, cookies: { atable_oauth: oauth },
  });
  expect(result.statusCode).toBe(303);
  return { cookies: { atable_session: result.cookies.find(cookie => cookie.name === 'atable_session')!.value }, result };
}
async function write(url: string, payload: object, method: 'PATCH' | 'POST' = 'POST') {
  return app.inject({ method, url, cookies, headers: { origin, 'x-admin-csrf': csrf }, payload });
}
beforeEach(async () => {
  clock = Date.now();
  store = new Store(readConfig(baseEnv));
  accounts = new Accounts(store, 30, () => clock);
  const profile = (subject: string) => ({ subject, name: subject, email: `${subject}@example.org`, emailVerified: true, picture: null });
  adminId = accounts.upsertUser('google', profile('admin'));
  otherId = accounts.upsertUser('google', profile('other'));
  accounts.ensureHousehold(adminId);
  accounts.ensureHousehold(otherId);
  regularCookies = { atable_session: accounts.createSession(adminId).token };
  config = readConfig({ ...baseEnv, ADMIN_USER_IDS: adminId });
  app = await buildApp(store, config, { logger: false, now: () => clock, staticRoot: join(tmpdir(), randomUUID()) });
  cookies = (await signIn('admin')).cookies;
  csrf = adminSessionSchema.parse((await app.inject({ url: '/api/admin/session', cookies })).json()).csrfToken!;
});
afterEach(async () => { await app.close(); store.close(); vi.useRealTimers(); vi.restoreAllMocks(); });

describe('droits administrateur et connexion Google', () => {
  it('exige des UUID complets et interdit l’admin sans authentification', () => {
    expect(() => readConfig({ ADMIN_USER_IDS: adminId })).toThrow('AUTH_ENABLED');
    expect(() => readConfig({ ...baseEnv, ADMIN_USER_IDS: 'admin@example.org' })).toThrow('UUID');
    expect(() => readConfig({ ...baseEnv, ADMIN_USER_IDS: adminId.slice(0, 8) })).toThrow('UUID');
    expect(readConfig({ ...baseEnv, ADMIN_USER_IDS: `${adminId}, ${adminId}` }).adminUserIds).toEqual([adminId]);
  });
  it('ne transforme jamais une session normale en session admin', async () => {
    const session = adminSessionSchema.parse((await app.inject({ url: '/api/admin/session', cookies: regularCookies })).json());
    expect(session).toMatchObject({ allowed: true, csrfToken: null, expiresAt: null });
    expect(session.user!.id).toBe(adminId);
    const response = await app.inject({ url: '/api/admin/overview', cookies: regularCookies });
    expect(response.statusCode).toBe(401);
    expect(response.json().code).toBe('admin_reauth');
    const ordinary = await signIn('admin', false);
    expect(ordinary.result.headers.location).toBe('/?auth=ok');
    expect((await app.inject({ url: '/api/admin/users', cookies: ordinary.cookies })).statusCode).toBe(401);
  });
  it('refuse tous les appels protégés anonymes, ordinaires et non administrateurs', async () => {
    const otherCookies = { atable_session: accounts.createSession(otherId).token };
    for (const request of [
      ...['overview', 'users', 'spaces', 'ai', 'catalog', 'requests', 'audit'].map(path => ({ method: 'GET' as const, url: `/api/admin/${path}` })),
      { method: 'PATCH' as const, url: '/api/admin/ai', payload: { paused: true, dailyLimit: null, monthlyLimit: null, confirm: true } },
      { method: 'PATCH' as const, url: `/api/admin/spaces/${accounts.membership(otherId)!.id}/ai`, payload: {} },
      { method: 'PATCH' as const, url: `/api/admin/catalog/${randomUUID()}`, payload: {} },
      { method: 'POST' as const, url: `/api/admin/catalog/${randomUUID()}/removal`, payload: {} },
      { method: 'PATCH' as const, url: `/api/admin/requests/${randomUUID()}`, payload: {} },
      { method: 'POST' as const, url: `/api/admin/users/${otherId}/revoke-sessions`, payload: { confirm: true } },
      { method: 'POST' as const, url: '/api/admin/backup', payload: { confirm: true } },
      { method: 'POST' as const, url: '/api/admin/logout', payload: { confirm: true } },
    ]) {
      expect((await app.inject({ ...request, remoteAddress: '127.0.0.2' })).statusCode).toBe(401);
      expect((await app.inject({ ...request, remoteAddress: '127.0.0.3', cookies: regularCookies })).statusCode).toBe(401);
      expect((await app.inject({ ...request, remoteAddress: '127.0.0.4', cookies: otherCookies })).statusCode).toBe(403);
    }
    expect(store.globalAiPolicy().paused).toBe(false);
    const publicSession = (await app.inject({ url: '/api/admin/session', cookies: otherCookies })).json();
    expect(publicSession).toMatchObject({ allowed: false, csrfToken: null });
    expect(JSON.stringify(publicSession)).not.toContain(adminId);
  });
  it('refuse un autre compte, même si son e-mail imite celui de l’admin', async () => {
    const denied = await signIn('other');
    expect(denied.result.headers.location).toBe('/admin?auth=error&reason=forbidden');
    expect((await app.inject({ url: '/api/admin/overview', cookies: denied.cookies })).statusCode).toBe(403);
    const impostor = accounts.upsertUser('google', {
      subject: 'impostor', email: 'admin@example.org', emailVerified: true, name: 'Admin', picture: null,
    });
    expect((await app.inject({ url: '/api/admin/users', cookies: { atable_session: accounts.createSession(impostor).token } })).statusCode).toBe(403);
  });
  it('ouvre une session admin fixe, ne conserve pas le jeton en clair et expire sans toucher au planning', async () => {
    const current = adminSessionSchema.parse((await app.inject({ url: '/api/admin/session', cookies })).json());
    expect(current).toMatchObject({ allowed: true, expiresAt: clock + adminLifetime });
    expect(store.db.prepare('SELECT token_hash FROM admin_sessions').all()).toEqual([{ token_hash: hashToken(cookies.atable_session) }]);
    expect(JSON.stringify((await app.inject({ url: '/api/admin/overview', cookies })).json())).not.toContain(cookies.atable_session);
    clock += adminLifetime - 1;
    expect((await app.inject({ url: '/api/admin/overview', cookies })).statusCode).toBe(200);
    clock++;
    expect((await app.inject({ url: '/api/admin/overview', cookies })).statusCode).toBe(401);
    expect((await app.inject({ url: '/api/auth/session', cookies })).json().user.id).toBe(adminId);
  });
  it('retire immédiatement les droits désactivés ou non vérifiés, et refuse un cookie forgé', async () => {
    expect((await app.inject({ url: '/api/admin/users', cookies: { atable_session: 'forged' } })).statusCode).toBe(401);
    store.db.prepare('UPDATE users SET email_verified = 0 WHERE id = ?').run(adminId);
    expect((await app.inject({ url: '/api/admin/users', cookies })).statusCode).toBe(403);
    store.db.prepare('UPDATE users SET email_verified = 1 WHERE id = ?').run(adminId);
    config.adminUserIds.splice(0);
    expect((await app.inject({ url: '/api/admin/users', cookies })).statusCode).toBe(403);
    await app.close();
    app = await buildApp(store, readConfig({ DATABASE_PATH: ':memory:' }), { logger: false });
    expect((await app.inject({ url: '/api/admin/overview', cookies })).statusCode).toBe(403);
  });
  it('protège le lancement OAuth admin contre les origines absentes/étrangères et interdit les redirections libres', async () => {
    for (const headers of [{}, { origin: 'https://evil.example' }, { origin, 'sec-fetch-site': 'cross-site' }]) {
      expect((await app.inject({ method: 'POST', url: '/api/auth/google/start', headers, payload: { returnTo: '/admin' } })).statusCode).toBe(403);
    }
    expect((await app.inject({ method: 'POST', url: '/api/auth/google/start', headers: { origin }, payload: { returnTo: 'https://evil.example' } })).statusCode).toBe(400);
    const start = await app.inject({ method: 'POST', url: '/api/auth/google/start', headers: { origin }, payload: { returnTo: '/admin' } });
    const params = new URL(start.json().url).searchParams;
    params.set('state', 'tampered');
    params.set('sub', 'admin');
    const callback = await app.inject({
      url: `/api/auth/google/callback?${params}`,
      cookies: { atable_oauth: start.cookies.find(cookie => cookie.name === 'atable_oauth')!.value },
    });
    expect(callback.headers.location).toBe('/admin?auth=error&reason=invalid');
    expect(store.db.prepare('SELECT COUNT(*) AS n FROM admin_sessions').get()!.n).toBe(1);
  });
});

describe('écritures admin, CSRF et journal', () => {
  it('exige l’origine exacte, un jeton CSRF ASCII lié à la session et une confirmation', async () => {
    const payload = { paused: true, dailyLimit: null, monthlyLimit: null, confirm: true };
    for (const headers of [
      {}, { origin }, { 'x-admin-csrf': csrf }, { origin: 'https://evil.example', 'x-admin-csrf': csrf },
      { origin, 'x-admin-csrf': '0'.repeat(64) }, { origin, 'x-admin-csrf': 'é'.repeat(64) },
      { origin, 'x-admin-csrf': csrf, 'sec-fetch-site': 'cross-site' },
    ]) {
      expect((await app.inject({ method: 'PATCH', url: '/api/admin/ai', cookies, headers, payload })).statusCode).toBe(403);
    }
    expect((await write('/api/admin/ai', { ...payload, confirm: false }, 'PATCH')).statusCode).toBe(400);
    expect((await write('/api/admin/ai', { ...payload, dailyLimit: -1 }, 'PATCH')).statusCode).toBe(400);
    expect((await write('/api/admin/ai', { ...payload, dailyLimit: 1.5 }, 'PATCH')).statusCode).toBe(400);
    expect((await write('/api/admin/ai', { ...payload, ADMIN_USER_IDS: otherId }, 'PATCH')).statusCode).toBe(400);
    expect(store.globalAiPolicy().paused).toBe(false);
    expect((await write('/api/admin/ai', payload, 'PATCH')).statusCode).toBe(200);
    const journal = adminAuditSchema.parse((await app.inject({ url: '/api/admin/audit', cookies })).json());
    expect(journal.entries[0]).toMatchObject({ action: 'admin.ai-global', userId: adminId, target: 'global' });
    expect(JSON.stringify(journal)).not.toContain(csrf);
    expect(JSON.stringify(journal)).not.toContain(config.OPENAI_API_KEY);
  });
  it('un jeton CSRF d’une autre session admin ne fonctionne pas', async () => {
    const second = await signIn('admin');
    const result = await app.inject({
      method: 'PATCH', url: '/api/admin/ai', cookies: second.cookies,
      headers: { origin, 'x-admin-csrf': csrf }, payload: { paused: true, dailyLimit: null, monthlyLimit: null, confirm: true },
    });
    expect(result.statusCode).toBe(403);
  });
  it('limite effectivement les écritures admin', async () => {
    const payload = { paused: false, dailyLimit: null, monthlyLimit: null, confirm: true };
    for (let i = 0; i < 30; i++) expect((await write('/api/admin/ai', payload, 'PATCH')).statusCode).toBe(200);
    expect((await write('/api/admin/ai', payload, 'PATCH')).statusCode).toBe(429);
  });
  it('révoque les sessions et l’élévation admin sans supprimer le compte ni les données', async () => {
    const result = await write(`/api/admin/users/${adminId}/revoke-sessions`, { confirm: true });
    expect(result.statusCode).toBe(200);
    expect(result.json().revoked).toBe(2);
    expect((await app.inject({ url: '/api/admin/overview', cookies })).statusCode).toBe(401);
    expect(accounts.user(adminId)).toBeDefined();
    expect(accounts.membership(adminId)).toBeDefined();
    expect(store.db.prepare('SELECT COUNT(*) AS n FROM admin_sessions').get()!.n).toBe(0);
  });
  it('ferme seulement la session admin et signale les sauvegardes impossibles', async () => {
    expect((await write('/api/admin/backup', { confirm: true })).statusCode).toBe(409);
    expect((await write(`/api/admin/users/${randomUUID()}/revoke-sessions`, { confirm: true })).statusCode).toBe(404);
    expect((await write('/api/admin/logout', { confirm: true })).statusCode).toBe(200);
    expect((await app.inject({ url: '/api/admin/overview', cookies })).statusCode).toBe(401);
    expect((await app.inject({ url: '/api/auth/session', cookies })).json().user.id).toBe(adminId);
  });
});

describe('rubriques et mutations', () => {
  it('retourne les contrats attendus sans cache ni secrets', async () => {
    for (const [path, schema] of [
      ['overview', adminOverviewSchema], ['users', adminUsersSchema], ['spaces', adminSpacesSchema],
      ['ai', adminAiSchema], ['catalog', adminCatalogSchema], ['requests', adminRequestsSchema], ['audit', adminAuditSchema],
    ] as const) {
      const response = await app.inject({ url: `/api/admin/${path}`, cookies });
      expect(response.statusCode).toBe(200);
      expect(schema.safeParse(response.json()).success).toBe(true);
      expect(response.headers['cache-control']).toBe('no-store');
      expect(response.headers['x-robots-tag']).toBe('noindex, nofollow');
      for (const secret of [config.OPENAI_API_KEY, cookies.atable_session, 'token_hash']) expect(response.body).not.toContain(secret);
    }
    expect((await app.inject({ url: '/api/admin/users?search=other', cookies })).json().users).toHaveLength(1);
    expect((await app.inject({ url: '/api/admin/users?offset=-1', cookies })).statusCode).toBe(400);
    for (let i = 0; i < 50; i++) accounts.upsertUser('google', { subject: `page-${i}`, name: `Page ${i}`, email: null, emailVerified: false, picture: null });
    expect((await app.inject({ url: '/api/admin/users', cookies })).json()).toMatchObject({ more: true });
    expect((await app.inject({ url: '/api/admin/users?offset=50', cookies })).json().users).toHaveLength(2);
  });
  it('corrige, retire et restaure le catalogue, sans modifier les copies privées', async () => {
    const entry = store.addToCatalog(recipe, undefined, commonSpaceId)!;
    const space = accounts.membership(otherId)!;
    const copy = dish({ name: recipe.name, details: recipe });
    store.merge(space.id, [copy]);
    const seq = store.catalogEntry(entry.id).seq;
    const correction = { details: { ...recipe, name: 'Poulet corrigé' }, sourceUrl: null, expectedSeq: seq, confirm: true };
    expect((await write(`/api/admin/catalog/${entry.id}`, correction, 'PATCH')).statusCode).toBe(200);
    expect(store.catalogEntry(entry.id).details.name).toBe('Poulet corrigé');
    expect(store.get(space.id, `dish:${copy.id}`)).toEqual(copy);
    expect((await write(`/api/admin/catalog/${entry.id}`, correction, 'PATCH')).statusCode).toBe(409);
    const duplicate = store.addToCatalog({ ...recipe, name: 'Autre poulet' }, undefined, commonSpaceId)!;
    expect((await write(`/api/admin/catalog/${entry.id}`, {
      ...correction, details: { ...recipe, name: '  AUTRE   POULET  ' }, expectedSeq: store.catalogEntry(entry.id).seq,
    }, 'PATCH')).statusCode).toBe(409);
    expect((await write(`/api/admin/catalog/${entry.id}/removal`, { removed: true, expectedSeq: store.catalogEntry(entry.id).seq, confirm: true })).statusCode).toBe(200);
    expect(store.catalog().map(item => item.id)).toEqual([duplicate.id]);
    expect((await write(`/api/admin/catalog/${entry.id}/removal`, { removed: false, expectedSeq: store.catalogEntry(entry.id).seq, confirm: true })).statusCode).toBe(200);
    expect(store.catalog()).toHaveLength(2);
  });
  it('met à jour les demandes, refuse les conflits et publie uniquement au foyer concerné', async () => {
    const space = accounts.membership(otherId)!;
    const item = store.addFeatureRequest(space.id, 'Ajouter une collation', otherId);
    const payload = { status: 'planned', note: 'Prévu prochainement', expectedUpdatedAt: item.updatedAt, confirm: true };
    vi.spyOn(Date, 'now').mockReturnValue(item.updatedAt);
    expect((await write(`/api/admin/requests/${item.id}`, payload, 'PATCH')).statusCode).toBe(200);
    expect(store.featureRequests(space.id)[0]).toMatchObject({ status: 'planned', note: 'Prévu prochainement' });
    expect(store.featureRequests(accounts.membership(adminId)!.id)).toHaveLength(0);
    expect((await write(`/api/admin/requests/${item.id}`, payload, 'PATCH')).statusCode).toBe(409);
  });
});

describe('quotas appliqués à tous les appels IA', () => {
  it('personnalise le quota, accepte zéro, conserve les réglages mensuels via la CLI et bloque le worker', async () => {
    const space = accounts.membership(otherId)!;
    expect((await write(`/api/admin/spaces/${space.id}/ai`, { dailyLimit: 1, monthlyLimit: 2, confirm: true }, 'PATCH')).statusCode).toBe(200);
    store.reserveGeneration(space.id);
    expect(() => store.reserveGeneration(space.id)).toThrow('1 requêtes');
    store.setAiLimitExempt(space.id, true);
    expect(store.spaceAiPolicy(space.id)).toEqual({ dailyLimit: null, monthlyLimit: 2 });
    store.reserveGeneration(space.id);
    expect(() => store.reserveGeneration(space.id)).toThrow('ce mois-ci');
    store.setSpaceAiPolicy(space.id, { dailyLimit: 0, monthlyLimit: null });
    store.merge(space.id, [dish()]);
    expect(store.claimAnalysis()).toBeUndefined();
    expect(store.analyses(space.id)[0].error).toContain('0 requêtes');
    const snapshot = syncResponseSchema.parse((await app.inject({
      method: 'POST', url: '/api/sync', cookies: { atable_session: accounts.createSession(otherId).token }, payload: { mutations: [] },
    })).json());
    expect(snapshot.capabilities.dailyLimit).toBe(0);
    store.setAiLimitExempt(space.id, false);
    expect(store.spaceAiPolicy(space.id)).toEqual({ dailyLimit: 20, monthlyLimit: null });
    expect(store.claimAnalysis()?.spaceId).toBe(space.id);
  });
  it('bloque les réservations concurrentes globales même pour les foyers exemptés', async () => {
    const first = accounts.membership(adminId)!.id;
    const second = accounts.membership(otherId)!.id;
    store.setAiLimitExempt(first, true);
    store.setAiLimitExempt(second, true);
    store.setGlobalAiPolicy({ paused: false, dailyLimit: 2, monthlyLimit: null });
    const jobs = await Promise.allSettled([first, second, first].map(async id => store.reserveGeneration(id)));
    expect(jobs.filter(result => result.status === 'fulfilled')).toHaveLength(2);
    expect(jobs.filter(result => result.status === 'rejected')).toHaveLength(1);
    expect(store.capabilities().callsToday).toBe(2);
    store.setGlobalAiPolicy({ paused: false, dailyLimit: null, monthlyLimit: 2 });
    expect(() => store.reserveGeneration(first)).toThrow('mensuel global');
    store.setGlobalAiPolicy({ paused: false, dailyLimit: null, monthlyLimit: null });
    expect(store.reserveGeneration(first)).toBe(parisDate());
  });
  it('la pause bloque génération, affinage et worker avant l’appel HTTP, sans bloquer la synchronisation', async () => {
    await app.close();
    const aiRequest = vi.fn<typeof fetch>();
    app = await buildApp(store, config, { logger: false, aiRequest, now: () => clock });
    store.setGlobalAiPolicy({ paused: true, dailyLimit: null, monthlyLimit: null });
    const space = accounts.membership(adminId)!;
    store.merge(space.id, [dish()]);
    expect(store.claimAnalysis()).toBeUndefined();
    for (const [url, payload] of [
      ['/api/meals/generate', { date: parisDate() }],
      ['/api/shopping/refine', { lines: ['Poulet — 400 g'] }],
    ] as const) {
      const response = await app.inject({ method: 'POST', url, cookies, payload });
      expect(response.statusCode).toBe(429);
      expect(response.json().error).toContain('suspendus');
    }
    expect(aiRequest).not.toHaveBeenCalled();
    expect(store.capabilities().callsToday).toBe(0);
    const sync = await app.inject({ method: 'POST', url: '/api/sync', cookies, payload: { mutations: [] } });
    expect(sync.statusCode).toBe(200);
    expect(sync.json().capabilities.aiPaused).toBe(true);
    store.setGlobalAiPolicy({ paused: false, dailyLimit: null, monthlyLimit: null });
    expect(store.claimAnalysis()?.spaceId).toBe(space.id);
  });
  it('renouvelle les limites quotidiennes et mensuelles à minuit à Paris, pas à minuit UTC', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-31T21:59:59Z'));
    store.setGlobalAiPolicy({ paused: false, dailyLimit: 1, monthlyLimit: 1 });
    expect(store.reserveGeneration(commonSpaceId)).toBe('2026-03-31');
    expect(() => store.reserveGeneration(commonSpaceId)).toThrow('quotidien global');
    vi.setSystemTime(new Date('2026-03-31T22:00:00Z'));
    expect(store.reserveGeneration(commonSpaceId)).toBe('2026-04-01');
    expect(store.capabilities().callsThisMonth).toBe(1);
    expect(store.capabilities().callsToday).toBe(1);
  });
  it('migre le schéma v4 puis conserve politiques, compteurs, journal et sauvegarde après redémarrage', () => {
    const folder = mkdtempSync(join(tmpdir(), 'a-table-admin-persistence-'));
    const persistentConfig = readConfig({ ...baseEnv, DATABASE_PATH: join(folder, 'planner.sqlite'), AUTH_TEST_PROVIDER: 'false',
      GOOGLE_CLIENT_ID: 'test-client', GOOGLE_CLIENT_SECRET: 'test-secret' });
    try {
      const legacy = new Store(persistentConfig);
      try {
        legacy.setAiLimitExempt(commonSpaceId, true);
        legacy.reserveGeneration(commonSpaceId);
        legacy.db.exec(`DROP TABLE admin_sessions; DROP TABLE admin_audit; DROP TABLE space_ai_policy; DROP TABLE global_ai_policy;
          ALTER TABLE auth_transactions DROP COLUMN return_to; PRAGMA user_version = 4;`);
      } finally { legacy.close(); }
      const migrated = new Store(persistentConfig);
      try {
        expect(migrated.spaceAiPolicy(commonSpaceId)).toEqual({ dailyLimit: null, monthlyLimit: null });
        migrated.setSpaceAiPolicy(commonSpaceId, { dailyLimit: 3, monthlyLimit: 10 });
        migrated.setGlobalAiPolicy({ paused: false, dailyLimit: 4, monthlyLimit: 100 });
        migrated.reserveGeneration(commonSpaceId);
        migrated.db.prepare('INSERT INTO admin_audit (user_id, action, target, details, created_at) VALUES (?, ?, ?, ?, ?)')
          .run(adminId, 'admin.ai-space', commonSpaceId, '{}', clock);
      } finally { migrated.close(); }
      const reopened = new Store(persistentConfig);
      try {
        expect(reopened.spaceAiPolicy(commonSpaceId)).toEqual({ dailyLimit: 3, monthlyLimit: 10 });
        expect(reopened.globalAiPolicy()).toEqual({ paused: false, dailyLimit: 4, monthlyLimit: 100 });
        expect(reopened.capabilities().callsToday).toBe(2);
        expect(reopened.db.prepare('SELECT COUNT(*) AS n FROM admin_audit').get()!.n).toBe(1);
        const backup = new DatabaseSync(backupDatabase(persistentConfig, 'admin-test'), { readOnly: true });
        try {
          expect(backup.prepare('SELECT COUNT(*) AS n FROM admin_audit').get()!.n).toBe(1);
          expect(backup.prepare('SELECT monthly_limit FROM global_ai_policy').get()!.monthly_limit).toBe(100);
        } finally { backup.close(); }
      } finally { reopened.close(); }
    } finally { rmSync(folder, { recursive: true }); }
  });
});
