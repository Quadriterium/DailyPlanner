import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildApp, loggedUrl, rateLimitKey } from '../server/app';
import { readConfig } from '../server/config';
import { Store, schemaVersion } from '../server/database';
import { Accounts } from '../server/auth/accounts';
import { cookieNames } from '../server/auth/routes';
import { hashToken } from '../server/auth/tokens';
import { assignCommon, assignSpace, listSpaces, userByEmail } from '../server/maintenance';
import { authSessionSchema, commonSpaceId, syncResponseSchema } from '../shared/model';
import { details, dish, meal } from './fixtures';

const baseEnv = {
  DATABASE_PATH: ':memory:', OPENAI_API_KEY: 'test-key-not-real', AUTH_ENABLED: 'true',
  AUTH_TEST_PROVIDER: 'true', NODE_ENV: 'test', PUBLIC_ORIGIN: 'http://localhost:3000',
};
const config = readConfig(baseEnv);
let clock = Date.now();
let store: Store;
let app: Awaited<ReturnType<typeof buildApp>>;
beforeEach(async () => {
  clock = Date.now();
  store = new Store(config);
  app = await buildApp(store, config, { logger: false, staticRoot: join(tmpdir(), randomUUID()), now: () => clock });
});
afterEach(async () => { await app.close(); store.close(); });

type Inject = Parameters<typeof app.inject>[0] & object;
const cookieOf = (response: Awaited<ReturnType<typeof app.inject>>, name: string) =>
  response.cookies.find(cookie => cookie.name === name);

async function startSignIn(invitation?: string) {
  const start = await app.inject({ method: 'POST', url: '/api/auth/google/start', payload: invitation ? { invitation } : {} });
  expect(start.statusCode).toBe(200);
  const oauth = cookieOf(start, 'atable_oauth')!;
  const authorize = new URL(start.json().url);
  return { oauth: oauth.value, params: Object.fromEntries(authorize.searchParams) };
}

async function callback(oauth: string | undefined, params: Record<string, string>) {
  const query = new URLSearchParams(params).toString();
  return app.inject({ method: 'GET', url: `/api/auth/google/callback?${query}`, cookies: oauth ? { atable_oauth: oauth } : {} });
}

async function signIn(sub: string, options: { name?: string; email?: string; invitation?: string } = {}) {
  const { oauth, params } = await startSignIn(options.invitation);
  const response = await callback(oauth, { ...params, sub, name: options.name ?? 'Camille Martin', email: options.email ?? `${sub}@example.org` });
  expect(response.statusCode).toBe(303);
  const session = cookieOf(response, 'atable_session');
  return { location: response.headers.location, cookies: session ? { atable_session: session.value } : {}, response };
}

const as = (cookies: Record<string, string>, request: Inject) => app.inject({ ...request, cookies });
const session = async (cookies: Record<string, string>) => authSessionSchema.parse((await as(cookies, { url: '/api/auth/session' })).json());

describe('configuration de l’authentification', () => {
  it('refuse les configurations dangereuses avec un message clair', () => {
    expect(() => readConfig({ AUTH_ENABLED: 'true' })).toThrow('PUBLIC_ORIGIN');
    expect(() => readConfig({ AUTH_ENABLED: 'true', PUBLIC_ORIGIN: 'https://dailyplanner.fr' })).toThrow('GOOGLE_CLIENT_ID');
    expect(() => readConfig({ AUTH_ENABLED: 'true', PUBLIC_ORIGIN: 'http://192.168.1.10:3000', GOOGLE_CLIENT_ID: 'x', GOOGLE_CLIENT_SECRET: 'y' })).toThrow('https');
    expect(() => readConfig({ AUTH_ENABLED: 'oui' })).toThrow('AUTH_ENABLED');
    expect(() => readConfig({ AUTH_SESSION_DAYS: '0' })).toThrow('AUTH_SESSION_DAYS');
    expect(() => readConfig({ AUTH_SESSION_DAYS: '400' })).toThrow('AUTH_SESSION_DAYS');
    expect(() => readConfig({ TRUSTED_PROXY: 'cloudflare', HOST: '0.0.0.0' })).toThrow('HOST=127.0.0.1');
    expect(() => readConfig({ AUTH_TEST_PROVIDER: 'true', DATABASE_PATH: './data/planner.sqlite', NODE_ENV: 'test' })).toThrow('réservé aux tests');
    expect(() => readConfig({ AUTH_TEST_PROVIDER: 'true', DATABASE_PATH: ':memory:' })).toThrow('réservé aux tests');
    const production = readConfig({
      AUTH_ENABLED: 'true', PUBLIC_ORIGIN: 'https://dailyplanner.fr', GOOGLE_CLIENT_ID: 'id', GOOGLE_CLIENT_SECRET: 'secret', TRUSTED_PROXY: 'cloudflare',
    });
    expect(production.redirectUri).toBe('https://dailyplanner.fr/api/auth/google/callback');
    expect(cookieNames(production)).toEqual({ session: '__Host-atable_session', oauth: '__Host-atable_oauth' });
    expect(cookieNames(config)).toEqual({ session: 'atable_session', oauth: 'atable_oauth' });
    expect(readConfig({}).authEnabled).toBe(false);
  });
  it('n’utilise CF-Connecting-IP que derrière cloudflared local et masque les URL OAuth des journaux', () => {
    const request = (remoteAddress: string) => ({ headers: { 'cf-connecting-ip': '203.0.113.7' }, ip: remoteAddress, socket: { remoteAddress } });
    expect(rateLimitKey({ TRUSTED_PROXY: 'cloudflare' })(request('127.0.0.1'))).toBe('203.0.113.7');
    expect(rateLimitKey({ TRUSTED_PROXY: 'cloudflare' })(request('::1'))).toBe('203.0.113.7');
    expect(rateLimitKey({ TRUSTED_PROXY: 'cloudflare' })(request('192.168.1.20'))).toBe('192.168.1.20');
    expect(rateLimitKey({ TRUSTED_PROXY: 'none' })(request('127.0.0.1'))).toBe('127.0.0.1');
    expect(loggedUrl('/api/auth/google/callback?code=secret&state=x')).toBe('/api/auth/google/callback');
    expect(loggedUrl('/api/sync?x=1')).toBe('/api/sync?x=1');
  });
});

describe('connexion Google et sessions', () => {
  it('refuse les données sans session et n’expose jamais l’espace commun', async () => {
    store.merge(commonSpaceId, [meal({ text: 'Commun' })]);
    const anonymous = await app.inject({ url: '/api/auth/session' });
    expect(authSessionSchema.parse(anonymous.json())).toMatchObject({ authEnabled: true, providers: ['google'], user: null, space: null });
    for (const request of [
      { method: 'POST' as const, url: '/api/sync', payload: { mutations: [] } },
      { method: 'GET' as const, url: '/api/feature-requests' },
      { method: 'POST' as const, url: '/api/meals/generate', payload: { date: '2026-11-03' } },
      { method: 'GET' as const, url: '/api/space' },
    ]) {
      const response = await app.inject(request);
      expect(response.statusCode).toBe(401);
      expect(response.json().code).toBe('auth_required');
    }
    const user = await signIn('alice');
    const synced = syncResponseSchema.parse((await as(user.cookies, { method: 'POST', url: '/api/sync', payload: { mutations: [] } })).json());
    expect(synced.records.map(record => record.type)).toEqual(['settings']);
    const forged = await as({ atable_session: 'not-a-token' }, { url: '/api/auth/session' });
    expect(forged.json().user).toBeNull();
  });
  it('crée le compte, son foyer et une session HttpOnly sans conserver le jeton en clair', async () => {
    const { location, cookies, response } = await signIn('alice', { name: '  Camille  Martin ' });
    expect(location).toBe('/?auth=ok');
    const cookie = cookieOf(response, 'atable_session')!;
    expect(cookie).toMatchObject({ httpOnly: true, sameSite: 'Lax', path: '/' });
    expect(cookie.secure).toBeFalsy();
    expect(cookie.maxAge).toBe(30 * 86_400);
    expect(cookieOf(response, 'atable_oauth')?.value).toBe('');
    const current = await session(cookies);
    expect(current.user).toMatchObject({ name: 'Camille  Martin', email: 'alice@example.org' });
    expect(current.space).toMatchObject({ name: 'Foyer de Camille', kind: 'household' });
    expect(current.defaultModel).toBe(config.OPENAI_MODEL);
    const stored = store.db.prepare('SELECT token_hash FROM sessions').all().map(row => row.token_hash);
    expect(stored).toEqual([hashToken(cookies.atable_session)]);
    expect(store.db.prepare('SELECT COUNT(*) AS n FROM auth_transactions').get()!.n).toBe(0);
    const again = await signIn('alice', { name: 'Camille Durand' });
    expect((await session(again.cookies)).space?.id).toBe(current.space?.id);
    expect((await session(again.cookies)).user?.name).toBe('Camille Durand');
    const other = await signIn('bob', { email: 'alice@example.org' });
    expect((await session(other.cookies)).space?.id).not.toBe(current.space?.id);
  });
  it('refuse le rejeu, un state falsifié, l’absence de cookie, l’annulation et une transaction expirée', async () => {
    const first = await startSignIn();
    const ok = await callback(first.oauth, { ...first.params, sub: 'alice', name: 'A', email: '' });
    expect(ok.headers.location).toBe('/?auth=ok');
    expect((await callback(first.oauth, { ...first.params, sub: 'alice' })).headers.location).toBe('/?auth=error&reason=expired');
    const forged = await startSignIn();
    expect((await callback(forged.oauth, { ...forged.params, state: 'forged', sub: 'eve' })).headers.location).toBe('/?auth=error&reason=invalid');
    expect((await callback(forged.oauth, { ...forged.params, sub: 'eve' })).headers.location).toBe('/?auth=error&reason=expired');
    const missing = await startSignIn();
    expect((await callback(undefined, { ...missing.params, sub: 'eve' })).headers.location).toBe('/?auth=error&reason=expired');
    const cancelled = await startSignIn();
    expect((await callback(cancelled.oauth, { ...cancelled.params, error: 'access_denied' })).headers.location).toBe('/?auth=error&reason=cancelled');
    const late = await startSignIn();
    clock += 11 * 60_000;
    expect((await callback(late.oauth, { ...late.params, sub: 'eve' })).headers.location).toBe('/?auth=error&reason=expired');
    expect(store.db.prepare('SELECT COUNT(*) AS n FROM users').get()!.n).toBe(1);
    expect((await app.inject({ method: 'POST', url: '/api/auth/apple/start', payload: {} })).statusCode).toBe(404);
  });
  it('prolonge la session glissante, la supprime à la déconnexion et la purge à expiration', async () => {
    const { cookies } = await signIn('alice');
    clock += 2 * 86_400_000;
    const refreshed = await as(cookies, { url: '/api/auth/session' });
    expect(cookieOf(refreshed, 'atable_session')?.value).toBe(cookies.atable_session);
    expect(refreshed.json().sessionExpiresAt).toBe(clock + 30 * 86_400_000);
    expect(cookieOf(await as(cookies, { url: '/api/auth/session' }), 'atable_session')).toBeUndefined();
    const logout = await as(cookies, { method: 'POST', url: '/api/auth/logout' });
    expect(logout.statusCode).toBe(200);
    expect(cookieOf(logout, 'atable_session')?.value).toBe('');
    expect((await session(cookies)).user).toBeNull();
    const expiring = await signIn('bob');
    clock += 31 * 86_400_000;
    expect((await session(expiring.cookies)).user).toBeNull();
    const accounts = new Accounts(store, 30, () => clock);
    accounts.purge();
    expect(store.db.prepare('SELECT COUNT(*) AS n FROM sessions').get()!.n).toBe(0);
  });
});

describe('foyers et invitations', () => {
  async function invite(cookies: Record<string, string>) {
    const response = await as(cookies, { method: 'POST', url: '/api/space/invitations' });
    expect(response.statusCode).toBe(201);
    const body = response.json() as { id: string; url: string };
    expect(body.url).toMatch(/^http:\/\/localhost:3000\/#invitation=[A-Za-z0-9_-]{43}$/);
    return { id: body.id, token: body.url.split('#invitation=')[1] };
  }

  it('isole complètement les données de deux foyers', async () => {
    const alice = await signIn('alice');
    const bob = await signIn('bob');
    const aliceMeal = meal({ text: 'Chez Alice' });
    const bobMeal = meal({ text: 'Chez Bob' });
    await as(alice.cookies, { method: 'POST', url: '/api/sync', payload: { mutations: [aliceMeal, dish()] } });
    await as(bob.cookies, { method: 'POST', url: '/api/sync', payload: { mutations: [bobMeal] } });
    await as(bob.cookies, { method: 'POST', url: '/api/feature-requests', payload: { text: 'Demande de Bob' } });
    const aliceRecords = syncResponseSchema.parse((await as(alice.cookies, { method: 'POST', url: '/api/sync', payload: { mutations: [] } })).json()).records;
    expect(aliceRecords).toContainEqual(aliceMeal);
    expect(aliceRecords).not.toContainEqual(bobMeal);
    expect((await as(alice.cookies, { url: '/api/feature-requests' })).json().requests).toEqual([]);
    expect(store.records(commonSpaceId).map(record => record.type)).toEqual(['settings']);
    expect(store.db.prepare('SELECT user_id FROM feature_requests').get()!.user_id).toBe((await session(bob.cookies)).user?.id);
  });
  it('rejoint un foyer par invitation à la première connexion, une seule fois', async () => {
    const alice = await signIn('alice');
    const aliceSpace = (await session(alice.cookies)).space!;
    const { token } = await invite(alice.cookies);
    const preview = await app.inject({ method: 'POST', url: '/api/invitations/preview', payload: { token } });
    expect(preview.json()).toMatchObject({ spaceName: aliceSpace.name, invitedBy: 'Camille Martin' });
    clock += 1000;
    const bob = await signIn('bob', { invitation: token });
    expect(bob.location).toBe('/?auth=ok&joined=1');
    expect((await session(bob.cookies)).space?.id).toBe(aliceSpace.id);
    const carol = await signIn('carol', { invitation: token });
    expect(carol.location).toBe('/?auth=error&reason=invitation_invalid');
    expect((await session(carol.cookies)).space?.id).not.toBe(aliceSpace.id);
    expect((await app.inject({ method: 'POST', url: '/api/invitations/preview', payload: { token } })).statusCode).toBe(404);
    const details = (await as(alice.cookies, { url: '/api/space' })).json();
    expect(details.members.map((member: { isMe: boolean }) => member.isMe)).toEqual([true, false]);
    expect(details.invitations).toEqual([]);
  });
  it('n’accepte une invitation qu’une fois, même en concurrence, et demande confirmation avant de quitter un foyer utilisé', async () => {
    const alice = await signIn('alice');
    const target = (await session(alice.cookies)).space!;
    const { token } = await invite(alice.cookies);
    const bob = await signIn('bob', { invitation: undefined });
    const carol = await signIn('carol');
    const [first, second] = await Promise.all([bob, carol].map(user => as(user.cookies, {
      method: 'POST', url: '/api/invitations/accept', payload: { token, leaveCurrent: false },
    })));
    expect([first.statusCode, second.statusCode].sort()).toEqual([200, 404]);
    const dave = await signIn('dave');
    await as(dave.cookies, { method: 'POST', url: '/api/sync', payload: { mutations: [meal()] } });
    const next = await invite(alice.cookies);
    const refused = await as(dave.cookies, { method: 'POST', url: '/api/invitations/accept', payload: { token: next.token, leaveCurrent: false } });
    expect(refused.statusCode).toBe(409);
    expect(refused.json().code).toBe('confirmation_required');
    const daveSpace = (await session(dave.cookies)).space!;
    const accepted = await as(dave.cookies, { method: 'POST', url: '/api/invitations/accept', payload: { token: next.token, leaveCurrent: true } });
    expect(authSessionSchema.parse(accepted.json()).space?.id).toBe(target.id);
    expect(store.space(daveSpace.id)).toBeDefined();
    expect(store.records(daveSpace.id)).toHaveLength(2);
  });
  it('gère révocation, limite d’invitations, retrait d’un membre et départ du dernier membre', async () => {
    const alice = await signIn('alice');
    const space = (await session(alice.cookies)).space!;
    const first = await invite(alice.cookies);
    expect((await as(alice.cookies, { method: 'POST', url: '/api/space/invitations/revoke', payload: { id: first.id } })).statusCode).toBe(200);
    expect((await app.inject({ method: 'POST', url: '/api/invitations/preview', payload: { token: first.token } })).statusCode).toBe(404);
    const tokens = [(await invite(alice.cookies)).token];
    const aliceId = (await session(alice.cookies)).user!.id;
    const accounts = new Accounts(store, 30, () => clock);
    for (let index = 0; index < 9; index++) accounts.createInvitation(space.id, aliceId);
    expect((await as(alice.cookies, { method: 'POST', url: '/api/space/invitations' })).statusCode).toBe(409);
    const bob = await signIn('bob', { invitation: tokens[0] });
    const bobId = (await session(bob.cookies)).user!.id;
    expect((await as(alice.cookies, { method: 'PATCH', url: '/api/space', payload: { name: '  Les Martin ' } })).json().name).toBe('Les Martin');
    expect((await session(bob.cookies)).space?.name).toBe('Les Martin');
    expect((await as(alice.cookies, { method: 'POST', url: '/api/space/members/remove', payload: { userId: aliceId } })).statusCode).toBe(400);
    expect((await as(alice.cookies, { method: 'POST', url: '/api/space/members/remove', payload: { userId: bobId } })).statusCode).toBe(200);
    const revoked = await as(bob.cookies, { method: 'POST', url: '/api/sync', payload: { mutations: [] } });
    expect(revoked.statusCode).toBe(403);
    expect(revoked.json().code).toBe('membership_revoked');
    const fresh = await session(bob.cookies);
    expect(fresh.space?.id).not.toBe(space.id);
    await as(alice.cookies, { method: 'POST', url: '/api/sync', payload: { mutations: [meal()] } });
    expect((await as(alice.cookies, { method: 'POST', url: '/api/space/leave' })).statusCode).toBe(200);
    expect(listSpaces(store).find(item => item.id === space.id)).toMatchObject({ members: 0, records: 1 });
    const replacement = await session(alice.cookies);
    expect(replacement.space?.id).not.toBe(space.id);
    // An empty household left by its last member is dropped instead of piling up.
    expect((await as(alice.cookies, { method: 'POST', url: '/api/space/leave' })).statusCode).toBe(200);
    expect(store.space(replacement.space!.id)).toBeUndefined();
  });
});

describe('administration et analyses par espace', () => {
  it('expose uniquement le quota et les compteurs du foyer courant, sans permettre une exemption par synchronisation', async () => {
    const alice = await signIn('alice');
    const bob = await signIn('bob');
    const aliceSpace = (await session(alice.cookies)).space!;
    const day = store.reserveGeneration(aliceSpace.id);
    store.recordTokens(day, 100, 50, aliceSpace.id);
    store.setAiLimitExempt(aliceSpace.id, true);
    const sync = (cookies: Record<string, string>) => as(cookies, { method: 'POST', url: '/api/sync', payload: { mutations: [] } });
    expect((await sync(alice.cookies)).json().capabilities).toMatchObject({ callsToday: 1, inputTokens: 100, outputTokens: 50, dailyLimit: null });
    expect((await sync(bob.cookies)).json().capabilities).toMatchObject({ callsToday: 0, inputTokens: 0, outputTokens: 0, dailyLimit: 20 });
    const bobSpace = (await session(bob.cookies)).space!;
    const forged = await as(bob.cookies, { method: 'POST', url: '/api/sync', payload: { mutations: [{
      ...store.settings(bobSpace.id), dailyLimit: null, modifiedAt: Date.now(), mutationId: randomUUID(),
    }] } });
    expect(forged.statusCode).toBe(400);
    expect(store.dailyLimit(bobSpace.id)).toBe(20);
    // An empty household can still be removed after consuming AI or receiving an exemption.
    expect((await as(alice.cookies, { method: 'POST', url: '/api/space/leave' })).statusCode).toBe(200);
    expect(store.space(aliceSpace.id)).toBeUndefined();
    expect(store.db.prepare('SELECT 1 FROM ai_limit_exemptions WHERE space_id = ?').get(aliceSpace.id)).toBeUndefined();
  });
  it('utilise les paramètres de l’espace du plat et rattache l’espace commun à un compte', async () => {
    const accounts = new Accounts(store, 30);
    const alice = await signIn('alice', { email: 'Alice@Example.org' });
    const aliceUser = (await session(alice.cookies)).user!;
    const aliceSpace = (await session(alice.cookies)).space!;
    store.merge(aliceSpace.id, [{ ...store.settings(aliceSpace.id), model: 'retired', modifiedAt: Date.now(), mutationId: randomUUID() }]);
    store.merge(aliceSpace.id, [dish()]);
    expect(store.claimAnalysis()).toBeUndefined();
    const recipe = dish();
    const stale = dish({ name: 'ancien' });
    store.merge(commonSpaceId, [recipe, stale, meal({ dishId: recipe.id })]);
    store.addFeatureRequest(commonSpaceId, 'Demande historique');
    const job = store.claimAnalysis()!;
    expect(job.spaceId).toBe(commonSpaceId);
    store.finishAnalysis(commonSpaceId, job.dish, details, null);
    const resetBefore = store.resetId(commonSpaceId);
    expect(userByEmail(store, 'alice@example.org')).toBe(aliceUser.id);
    expect(() => userByEmail(store, 'nobody@example.org')).toThrow('Aucun compte');
    const result = assignCommon(store, aliceUser.id);
    expect(result).toMatchObject({ moved: 3, total: 4 });
    expect(store.get(aliceSpace.id, `dish:${recipe.id}`)).toEqual(recipe);
    expect(store.analysis(aliceSpace.id, job.dish.id)?.status).toBe('ready');
    // The household settings are newer than the common ones: compareVersions keeps them.
    expect(store.settings(aliceSpace.id).model).toBe('retired');
    expect(store.records(commonSpaceId).map(record => record.type)).toEqual(['settings']);
    expect(store.resetId(commonSpaceId)).not.toBe(resetBefore);
    expect(store.featureRequests(aliceSpace.id)).toHaveLength(1);
    expect(accounts.membership(aliceUser.id)?.id).toBe(aliceSpace.id);
  });
  it('rattache un foyer sans membre et refuse de quitter un foyer utilisé sans --force', async () => {
    const accounts = new Accounts(store, 30);
    const alice = await signIn('alice');
    const orphan = (await session(alice.cookies)).space!;
    await as(alice.cookies, { method: 'POST', url: '/api/sync', payload: { mutations: [meal()] } });
    await as(alice.cookies, { method: 'POST', url: '/api/space/leave' });
    const bob = await signIn('bob');
    const bobId = (await session(bob.cookies)).user!.id;
    await as(bob.cookies, { method: 'POST', url: '/api/sync', payload: { mutations: [meal({ text: 'Bob' })] } });
    expect(() => assignSpace(store, orphan.id, bobId, false)).toThrow('--force');
    expect(() => assignSpace(store, commonSpaceId, bobId, true)).toThrow('Foyer introuvable');
    assignSpace(store, orphan.id, bobId, true);
    expect(accounts.membership(bobId)?.id).toBe(orphan.id);
    expect(accounts.revokeSessions(bobId)).toBe(1);
  });
});

describe('migration de la base', () => {
  function legacyDatabase(path: string) {
    const db = new DatabaseSync(path);
    db.exec(`
      CREATE TABLE records (key TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE analyses (dish_id TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE ai_usage (day TEXT PRIMARY KEY, calls INTEGER NOT NULL DEFAULT 0, input_tokens INTEGER NOT NULL DEFAULT 0, output_tokens INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE feature_requests (id TEXT PRIMARY KEY, text TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'received',
        note TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
      PRAGMA user_version = 1;
    `);
    const recipe = dish();
    const planned = meal({ dishId: recipe.id });
    db.prepare('INSERT INTO records VALUES (?, ?)').run(`dish:${recipe.id}`, JSON.stringify(recipe));
    db.prepare('INSERT INTO records VALUES (?, ?)').run(`meal:${planned.id}`, JSON.stringify(planned));
    db.prepare('INSERT INTO analyses VALUES (?, ?)').run(recipe.id, JSON.stringify({
      dishId: recipe.id, analysisKey: recipe.analysisKey, status: 'ready', details, error: null, updatedAt: 1,
    }));
    db.prepare("INSERT INTO meta VALUES ('resetId', 'reset-1')").run();
    db.prepare("INSERT INTO ai_usage VALUES ('2026-11-01', 3, 10, 20)").run();
    db.prepare("INSERT INTO feature_requests VALUES ('11111111-1111-4111-8111-111111111111', 'Ancienne demande', 'received', NULL, 1, 1)").run();
    db.close();
    return { recipe, planned };
  }

  it('déplace les données v1 dans l’espace commun après sauvegarde, de façon idempotente', () => {
    const folder = mkdtempSync(join(tmpdir(), 'a-table-migration-'));
    const path = join(folder, 'planner.sqlite');
    try {
      const { recipe, planned } = legacyDatabase(path);
      const migrated = new Store({ ...config, DATABASE_PATH: path });
      try {
        expect(Number(migrated.db.prepare('PRAGMA user_version').get()!.user_version)).toBe(schemaVersion);
        expect(migrated.get(commonSpaceId, `dish:${recipe.id}`)).toEqual(recipe);
        expect(migrated.get(commonSpaceId, `meal:${planned.id}`)).toEqual(planned);
        expect(migrated.settings(commonSpaceId).model).toBe(config.OPENAI_MODEL);
        expect(migrated.analysis(commonSpaceId, recipe.id)?.status).toBe('ready');
        expect(migrated.resetId(commonSpaceId)).toBe('reset-1');
        expect(migrated.db.prepare("SELECT COUNT(*) AS n FROM meta WHERE key = 'resetId'").get()!.n).toBe(0);
        expect(migrated.featureRequests(commonSpaceId)).toHaveLength(1);
        expect(migrated.capabilities().inputTokens).toBeGreaterThanOrEqual(0);
        expect(migrated.capabilities(new Date('2026-11-01T12:00:00Z'), commonSpaceId))
          .toMatchObject({ callsToday: 3, inputTokens: 10, outputTokens: 20, dailyLimit: 20 });
      } finally { migrated.close(); }
      const backups = readdirSync(join(folder, 'backups'));
      expect(backups).toHaveLength(1);
      expect(backups[0]).toMatch(/^avant-auth-.*\.sqlite$/);
      const reopened = new Store({ ...config, DATABASE_PATH: path });
      try { expect(reopened.records(commonSpaceId)).toHaveLength(3); } finally { reopened.close(); }
      expect(readdirSync(join(folder, 'backups'))).toHaveLength(1);
    } finally { rmSync(folder, { recursive: true }); }
  });
  it.runIf(existsSync('data/planner.sqlite'))('migre une copie de la base réelle sans perte', () => {
    const folder = mkdtempSync(join(tmpdir(), 'a-table-real-'));
    const path = join(folder, 'planner.sqlite');
    try {
      const source = new DatabaseSync('data/planner.sqlite', { readOnly: true });
      let before: { records: number; analyses: number; requests: number; version: number };
      try {
        source.prepare('VACUUM INTO ?').run(path);
        const count = (table: string) => source.prepare(`SELECT COUNT(*) AS n FROM sqlite_master WHERE name = ?`).get(table)!.n
          ? Number(source.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()!.n) : 0;
        before = { records: count('records'), analyses: count('analyses'), requests: count('feature_requests'),
          version: Number(source.prepare('PRAGMA user_version').get()!.user_version) };
      } finally { source.close(); }
      const migrated = new Store({ ...config, DATABASE_PATH: path });
      try {
        if (before.version < 2) {
          // The initial settings record is added when the legacy base had none.
          expect(migrated.records(commonSpaceId).length - before.records).toBeGreaterThanOrEqual(0);
          expect(migrated.records(commonSpaceId).length - before.records).toBeLessThanOrEqual(1);
          expect(migrated.analyses(commonSpaceId).length).toBe(before.analyses);
          expect(migrated.featureRequests(commonSpaceId).length).toBe(before.requests);
        }
        expect(Number(migrated.db.prepare('PRAGMA user_version').get()!.user_version)).toBe(schemaVersion);
      } finally { migrated.close(); }
    } finally { rmSync(folder, { recursive: true }); }
  });
  it('refuse le fournisseur simulé hors des tests', () => {
    expect(() => readConfig({ ...baseEnv, NODE_ENV: 'production' })).toThrow('réservé aux tests');
  });
});
