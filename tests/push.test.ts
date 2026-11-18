import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import webpush from 'web-push';
import { buildApp } from '../server/app';
import { readConfig } from '../server/config';
import { AiQuotaError, Store } from '../server/database';
import { Accounts } from '../server/auth/accounts';
import { allowedPushEndpoint, Notifier, type PushSender } from '../server/push';
import { pushStatusSchema } from '../shared/push';
import { dish, meal } from './fixtures';

const origin = 'http://localhost:3000';
const keys = webpush.generateVAPIDKeys();
const baseEnv = {
  DATABASE_PATH: ':memory:', AUTH_ENABLED: 'true', AUTH_TEST_PROVIDER: 'true', NODE_ENV: 'test', PUBLIC_ORIGIN: origin, OPENAI_API_KEY: 'test-key-not-real',
  VAPID_PUBLIC_KEY: keys.publicKey, VAPID_PRIVATE_KEY: keys.privateKey, VAPID_SUBJECT: 'mailto:admin@example.org',
};
// 2026-01-15 16:00 in Paris (UTC+1).
const start = Date.parse('2026-01-15T15:00:00Z');
const profile = (subject: string) => ({ subject, name: subject, email: `${subject}@example.org`, emailVerified: true, picture: null });
const subscription = (id: string, host = 'fcm.googleapis.com') => ({
  endpoint: `https://${host}/fcm/send/${id}`, keys: { p256dh: `B${'x'.repeat(86)}`, auth: 'a'.repeat(22) },
});

let clock: number;
let store: Store;
let accounts: Accounts;
let app: Awaited<ReturnType<typeof buildApp>>;
let config: ReturnType<typeof readConfig>;
let adminId: string;
let userId: string;
let sent: { endpoint: string; payload: Record<string, unknown>; ttl: number }[];
let failures: Map<string, number>;
let notifier: Notifier;

const sender: PushSender = async (target, payload, options) => {
  const status = failures.get(target.endpoint);
  if (status) throw Object.assign(new Error('push failed'), { statusCode: status });
  sent.push({ endpoint: target.endpoint, payload: JSON.parse(payload), ttl: options.TTL });
};
const session = (id: string) => ({ atable_session: accounts.createSession(id).token });
async function post(url: string, user: string, payload: object) {
  return app.inject({ method: 'POST', url, cookies: session(user), headers: { origin }, payload });
}
async function subscribe(user: string, id: string, reminders: { lunch: string | null; dinner: string | null } = { lunch: null, dinner: null }) {
  return post('/api/push/subscription', user, { subscription: subscription(id), ...reminders });
}
const tick = (time = clock) => notifier.tick(new Date(time));
const spaceOf = (id: string) => String(store.db.prepare('SELECT space_id FROM memberships WHERE user_id = ?').get(id)!.space_id);

beforeEach(async () => {
  clock = start;
  sent = [];
  failures = new Map();
  store = new Store(readConfig(baseEnv));
  accounts = new Accounts(store, 30, () => clock);
  adminId = accounts.upsertUser('google', profile('admin'));
  userId = accounts.upsertUser('google', profile('user'));
  accounts.ensureHousehold(adminId);
  accounts.ensureHousehold(userId);
  config = readConfig({ ...baseEnv, ADMIN_USER_IDS: adminId });
  app = await buildApp(store, config, { logger: false, now: () => clock, staticRoot: join(tmpdir(), randomUUID()) });
  notifier = new Notifier(store, config, () => undefined, sender);
  store.db.prepare('DELETE FROM push_outbox').run();
});
afterEach(async () => { await notifier.stop(); await app.close(); store.close(); });

describe('configuration Web Push', () => {
  it('exige les deux clés, des comptes et un sujet valide', () => {
    expect(readConfig({ DATABASE_PATH: ':memory:' }).push).toBeNull();
    expect(config.push).toEqual({ publicKey: keys.publicKey, privateKey: keys.privateKey, subject: 'mailto:admin@example.org' });
    expect(() => readConfig({ ...baseEnv, VAPID_PRIVATE_KEY: '' })).toThrow('ensemble');
    expect(() => readConfig({ ...baseEnv, AUTH_ENABLED: 'false', AUTH_TEST_PROVIDER: 'false' })).toThrow('AUTH_ENABLED');
    expect(() => readConfig({ ...baseEnv, VAPID_SUBJECT: '' })).toThrow('VAPID_SUBJECT');
    expect(() => readConfig({ ...baseEnv, VAPID_SUBJECT: 'admin@example.org' })).toThrow('VAPID_SUBJECT');
  });

  it('n’accepte que les services push des navigateurs', () => {
    expect(allowedPushEndpoint('https://fcm.googleapis.com/fcm/send/abc')).toBe(true);
    expect(allowedPushEndpoint('https://web.push.apple.com/abc')).toBe(true);
    expect(allowedPushEndpoint('https://updates.push.services.mozilla.com/wpush/v2/abc')).toBe(true);
    expect(allowedPushEndpoint('https://wns2-par02p.notify.windows.com/w/?token=abc')).toBe(true);
    expect(allowedPushEndpoint('http://fcm.googleapis.com/fcm/send/abc')).toBe(false);
    expect(allowedPushEndpoint('https://fcm.googleapis.com:8443/abc')).toBe(false);
    expect(allowedPushEndpoint('https://evil.example/fcm.googleapis.com')).toBe(false);
    expect(allowedPushEndpoint('https://push.apple.com.evil.example/abc')).toBe(false);
    expect(allowedPushEndpoint('https://127.0.0.1/abc')).toBe(false);
  });
});

describe('abonnements', () => {
  it('publie la clé publique et protège les routes', async () => {
    expect((await app.inject({ url: '/api/push' })).json()).toEqual({ configured: true, publicKey: keys.publicKey });
    const anonymous = await app.inject({ method: 'POST', url: '/api/push/test', headers: { origin }, payload: {} });
    expect(anonymous.statusCode).toBe(401);
    const disabled = await buildApp(new Store(readConfig({ ...baseEnv, VAPID_PUBLIC_KEY: '', VAPID_PRIVATE_KEY: '' })),
      readConfig({ ...baseEnv, VAPID_PUBLIC_KEY: '', VAPID_PRIVATE_KEY: '' }), { logger: false, staticRoot: join(tmpdir(), randomUUID()) });
    expect((await disabled.inject({ url: '/api/push' })).json()).toEqual({ configured: false, publicKey: null });
    expect((await disabled.inject({ method: 'POST', url: '/api/push/test', headers: { origin }, payload: {} })).statusCode).toBe(409);
    await disabled.close();
  });

  it('enregistre, lit et supprime l’appareil du compte courant uniquement', async () => {
    const refused = await post('/api/push/subscription', userId, { subscription: subscription('x', 'evil.example'), lunch: null, dinner: null });
    expect(refused.statusCode).toBe(400);
    const created = await subscribe(userId, 'phone', { lunch: '11:30', dinner: null });
    expect(created.statusCode).toBe(200);
    expect(pushStatusSchema.parse(created.json())).toEqual({ registered: true, lunch: '11:30', dinner: null, admin: false });
    const endpoint = subscription('phone').endpoint;
    expect((await post('/api/push/status', adminId, { endpoint })).json()).toMatchObject({ registered: false, admin: true });
    await post('/api/push/unsubscribe', adminId, { endpoint });
    expect((await post('/api/push/status', userId, { endpoint })).json()).toMatchObject({ registered: true });
    await post('/api/push/unsubscribe', userId, { endpoint });
    expect((await post('/api/push/status', userId, { endpoint })).json()).toMatchObject({ registered: false });
  });

  it('limite le nombre d’appareils et renouvelle un abonnement', async () => {
    for (let index = 0; index < 12; index++) {
      clock += 1000;
      await subscribe(userId, `device-${index}`);
    }
    expect(store.db.prepare('SELECT COUNT(*) AS n FROM push_subscriptions WHERE user_id = ?').get(userId)!.n).toBe(10);
    const renewed = await post('/api/push/renew', userId, { oldEndpoint: subscription('device-11').endpoint, subscription: subscription('rotated') });
    expect(renewed.statusCode).toBe(200);
    expect((await post('/api/push/status', userId, { endpoint: subscription('rotated').endpoint })).json()).toMatchObject({ registered: true });
    expect((await post('/api/push/renew', adminId, { oldEndpoint: subscription('rotated').endpoint, subscription: subscription('stolen') })).statusCode).toBe(404);
  });

  it.each(['subscription', 'renew'] as const)('refuse une collision intercompte sur %s sans les clés de l’appareil', async route => {
    await subscribe(adminId, 'victim', { lunch: '11:30', dinner: '18:00' });
    await subscribe(userId, 'own');
    const before = store.db.prepare('SELECT * FROM push_subscriptions ORDER BY endpoint').all();
    for (const key of ['auth', 'p256dh'] as const) {
      const target = subscription('victim');
      target.keys[key] = (key === 'auth' ? 'b' : 'C').repeat(target.keys[key].length);
      const response = await post(`/api/push/${route}`, userId, route === 'subscription'
        ? { subscription: target, lunch: null, dinner: null }
        : { oldEndpoint: subscription('own').endpoint, subscription: target });
      expect(response.statusCode).toBe(409);
      expect(response.json()).toMatchObject({ code: 'push_conflict' });
      expect(store.db.prepare('SELECT * FROM push_subscriptions ORDER BY endpoint').all()).toEqual(before);
    }
  });

  it('conserve le changement de compte sur le même appareil avec ses clés complètes', async () => {
    await subscribe(adminId, 'shared');
    const transferred = await subscribe(userId, 'shared', { lunch: '11:30', dinner: null });
    expect(transferred.statusCode).toBe(200);
    expect((await post('/api/push/status', adminId, { endpoint: subscription('shared').endpoint })).json()).toMatchObject({ registered: false });
    expect((await post('/api/push/status', userId, { endpoint: subscription('shared').endpoint })).json()).toMatchObject({ registered: true, lunch: '11:30' });
    await subscribe(adminId, 'previous');
    expect((await post('/api/push/renew', adminId, {
      oldEndpoint: subscription('previous').endpoint, subscription: subscription('shared'),
    })).statusCode).toBe(200);
    expect((await post('/api/push/status', adminId, { endpoint: subscription('shared').endpoint })).json()).toMatchObject({ registered: true });
    expect((await post('/api/push/status', userId, { endpoint: subscription('shared').endpoint })).json()).toMatchObject({ registered: false });
  });

  it('oublie les appareils quand les sessions sont révoquées', async () => {
    await subscribe(userId, 'phone');
    accounts.revokeSessions(userId);
    expect(store.db.prepare('SELECT COUNT(*) AS n FROM push_subscriptions').get()!.n).toBe(0);
  });
});

describe('envoi', () => {
  it('envoie un test à tous les appareils et supprime ceux qui ont expiré', async () => {
    await subscribe(userId, 'phone');
    await subscribe(userId, 'tablet');
    failures.set(subscription('tablet').endpoint, 410);
    expect((await post('/api/push/test', userId, {})).json()).toEqual({ devices: 2 });
    await tick();
    expect(sent).toEqual([{ endpoint: subscription('phone').endpoint, payload: expect.objectContaining({ title: 'Notification de test', url: '/' }), ttl: 86400 }]);
    expect(store.db.prepare('SELECT endpoint FROM push_subscriptions').all().map(row => row.endpoint)).toEqual([subscription('phone').endpoint]);
    await tick();
    expect(sent).toHaveLength(1);
  });

  it('notifie l’admin des nouveaux comptes et demandes, et l’auteur d’une réponse', async () => {
    await subscribe(adminId, 'admin-phone');
    await subscribe(userId, 'user-phone');
    accounts.upsertUser('google', profile('newcomer'));
    const request = store.addFeatureRequest(spaceOf(userId), 'Pouvoir trier les courses par rayon', userId);
    store.updateFeatureRequest(request.id, 'planned', 'Prévu pour le printemps');
    store.updateFeatureRequest(request.id, 'planned', 'Prévu pour le printemps');
    await tick();
    const adminTitles = sent.filter(item => item.endpoint === subscription('admin-phone').endpoint).map(item => item.payload.title);
    expect(adminTitles).toEqual(['Nouveau compte', 'Nouvelle demande d’évolution']);
    expect(sent.filter(item => item.endpoint === subscription('user-phone').endpoint)).toEqual([expect.objectContaining({
      payload: expect.objectContaining({ title: 'Réponse à votre demande d’évolution', body: expect.stringContaining('Prévu pour le printemps') }),
    })]);
  });

  it('n’envoie pas les alertes admin aux comptes qui ne sont plus administrateurs', async () => {
    await subscribe(adminId, 'admin-phone');
    store.queuePush(null, { title: 'Alerte', body: '' });
    await new Notifier(store, readConfig(baseEnv), () => undefined, sender).tick(new Date(clock));
    expect(sent).toEqual([]);
  });

  it('ignore les notifications en attente depuis plus de 24 heures', async () => {
    await subscribe(userId, 'phone');
    store.queuePush(userId, { title: 'Ancienne', body: '' });
    store.db.prepare('UPDATE push_outbox SET created_at = ?').run(Date.now() - 25 * 3_600_000);
    await notifier.tick(new Date());
    expect(sent).toEqual([]);
    expect(store.db.prepare('SELECT COUNT(*) AS n FROM push_outbox').get()!.n).toBe(0);
  });

  it('alerte l’admin une seule fois quand le plafond quotidien global est atteint', async () => {
    await subscribe(adminId, 'admin-phone');
    store.setGlobalAiPolicy({ paused: false, dailyLimit: 1, monthlyLimit: null, hourlyLimit: null });
    const spaceId = spaceOf(userId);
    store.reserveGeneration(spaceId);
    expect(() => store.reserveGeneration(spaceId)).toThrow(AiQuotaError);
    expect(() => store.reserveGeneration(spaceId)).toThrow(AiQuotaError);
    await tick();
    expect(sent.map(item => item.payload.title)).toEqual(['Plafond IA atteint']);
  });

  it('ne met rien en file sans clés VAPID', () => {
    const plain = new Store(readConfig({ DATABASE_PATH: ':memory:' }));
    expect(plain.queuePush(null, { title: 'Alerte', body: '' })).toBe(0);
    expect(plain.db.prepare('SELECT COUNT(*) AS n FROM push_outbox').get()!.n).toBe(0);
    plain.close();
  });
});

describe('rappels des repas', () => {
  async function plan(slot: 'lunch' | 'dinner', text: string, index?: 1) {
    const saved = dish({ name: text });
    store.merge(spaceOf(userId), [saved, meal({
      id: `2026-01-15:${slot}${index ? ':2' : ''}`, date: '2026-01-15', slot, text, dishId: saved.id, ...(index ? { index } : {}),
    })]);
  }

  it('rappelle les plats prévus une fois, à l’heure choisie (heure de Paris)', async () => {
    await subscribe(userId, 'phone', { lunch: null, dinner: '17:00' });
    await plan('dinner', 'Soupe de potiron');
    await plan('dinner', 'Tarte aux pommes', 1);
    await tick(Date.parse('2026-01-15T15:59:00Z'));
    expect(sent).toEqual([]);
    await tick(Date.parse('2026-01-15T16:05:00Z'));
    expect(sent).toEqual([expect.objectContaining({ payload: expect.objectContaining({ title: 'Ce soir', body: 'Soupe de potiron · Tarte aux pommes' }), ttl: 3600 })]);
    await tick(Date.parse('2026-01-15T16:06:00Z'));
    expect(sent).toHaveLength(1);
  });

  it('ne rappelle pas un créneau vide, ni un horaire déjà passé à l’activation ou depuis plus d’une heure', async () => {
    clock = Date.parse('2026-01-15T11:00:00Z');
    await subscribe(userId, 'phone', { lunch: '11:00', dinner: '17:00' });
    await plan('lunch', 'Salade');
    await plan('dinner', 'Gratin');
    await tick(Date.parse('2026-01-15T11:01:00Z'));
    expect(sent).toEqual([]);
    await tick(Date.parse('2026-01-15T18:30:00Z'));
    expect(sent).toEqual([]);
    expect(store.db.prepare('SELECT last_lunch_day, last_dinner_day FROM push_subscriptions').get())
      .toEqual({ last_lunch_day: '2026-01-15', last_dinner_day: '2026-01-15' });
  });
});
