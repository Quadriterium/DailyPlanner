import type { FastifyInstance } from 'fastify';
import webpush from 'web-push';
import type { Config } from './config.js';
import type { Store } from './database.js';
import { isAdminUser } from './admin-access.js';
import {
  type Dish, type Meal, type Slot, mealDisplayName, mealId, parisDate,
} from '../shared/model.js';
import {
  type BrowserSubscription, type PushPayload, pushEndpointSchema, pushInfoSchema, pushPayloadSchema, pushRegisterSchema,
  pushRenewSchema, pushStatusSchema, pushTestSchema,
} from '../shared/push.js';

export const maxDevicesPerUser = 10;
const outboxTtl = 24 * 3_600_000;
const reminderWindowMinutes = 60;
const pushHosts = [/^fcm\.googleapis\.com$/, /^android\.googleapis\.com$/, /\.push\.apple\.com$/, /\.push\.services\.mozilla\.com$/, /\.notify\.windows\.com$/];

/** Only the push services of the major browsers: the server must not POST to an arbitrary URL (SSRF). */
export function allowedPushEndpoint(endpoint: string): boolean {
  try {
    const url = new URL(endpoint);
    return url.protocol === 'https:' && !url.port && !url.username && pushHosts.some(host => host.test(url.hostname));
  } catch {
    return false;
  }
}

/** Current time in Paris as HH:MM. */
export function parisTime(now = new Date()): string {
  return new Intl.DateTimeFormat('fr-FR', { timeZone: 'Europe/Paris', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(now);
}
const minutes = (time: string) => Number(time.slice(0, 2)) * 60 + Number(time.slice(3, 5));

export type PushSender = (subscription: BrowserSubscription, payload: string, options: { TTL: number; urgency: 'normal' | 'high'; topic?: string }) => Promise<unknown>;
type Log = (message: string, error?: unknown) => void;
interface Device { endpoint: string; userId: string; subscription: BrowserSubscription }

function device(row: Record<string, unknown>): Device {
  return {
    endpoint: String(row.endpoint), userId: String(row.user_id),
    subscription: { endpoint: String(row.endpoint), keys: { p256dh: String(row.p256dh), auth: String(row.auth) } },
  };
}

function canReplaceSubscription(existing: Record<string, unknown> | undefined, userId: string, subscription: BrowserSubscription): boolean {
  // Switching accounts on the same browser requires its full subscription, not just its endpoint.
  return !existing || existing.user_id === userId ||
    (existing.p256dh === subscription.keys.p256dh && existing.auth === subscription.keys.auth);
}

/** Delivers the push outbox and the daily meal reminders. Failed deliveries are logged, not retried. */
export class Notifier {
  private running: Promise<void> | null = null;
  private stopped = false;
  private lastReminderMinute = '';
  private readonly send: PushSender;

  constructor(private readonly store: Store, private readonly config: Config, private readonly log: Log, send?: PushSender) {
    const push = config.push;
    this.send = send ?? ((subscription, payload, options) => webpush.sendNotification(subscription, payload, {
      ...options, timeout: 10_000,
      vapidDetails: { subject: push!.subject, publicKey: push!.publicKey, privateKey: push!.privateKey },
    }));
  }

  async tick(now = new Date()) {
    if (!this.config.push || this.running || this.stopped) return;
    this.running = this.run(now).finally(() => { this.running = null; });
    await this.running;
  }

  /** Waits for the deliveries in progress before the database is closed. */
  async stop() {
    this.stopped = true;
    await this.running;
  }

  private async run(now: Date) {
    try {
      // The outbox is stamped with the wall clock, unlike the reminders which follow `now`.
      await this.drain(Date.now());
      const minute = `${parisDate(now)} ${parisTime(now)}`;
      if (minute !== this.lastReminderMinute) {
        this.lastReminderMinute = minute;
        await this.remind(now);
      }
    } catch (error) {
      this.log('Échec du traitement des notifications.', error);
    }
  }

  /** Rows are deleted before sending so that a crash cannot repeat a notification. */
  private async drain(now: number) {
    for (;;) {
      const rows = this.store.transaction(() => {
        const batch = this.store.db.prepare('SELECT id, user_id, payload, created_at FROM push_outbox ORDER BY id LIMIT 50').all();
        if (batch.length) this.store.db.prepare(`DELETE FROM push_outbox WHERE id <= ?`).run(Number(batch.at(-1)!.id));
        return batch;
      });
      if (!rows.length) return;
      for (const row of rows) {
        if (Number(row.created_at) < now - outboxTtl) continue;
        const payload = pushPayloadSchema.safeParse(JSON.parse(String(row.payload)));
        if (!payload.success) continue;
        const users = row.user_id === null
          ? this.config.adminUserIds.filter(id => isAdminUser(this.store, this.config, id))
          : [String(row.user_id)];
        await this.deliver(this.devices(users), payload.data, { TTL: outboxTtl / 1000, urgency: 'normal' });
      }
    }
  }

  private devices(users: string[]): Device[] {
    if (!users.length) return [];
    return this.store.db.prepare(`SELECT endpoint, user_id, p256dh, auth FROM push_subscriptions
      WHERE user_id IN (${users.map(() => '?').join(',')})`).all(...users).map(device);
  }

  private async deliver(devices: Device[], payload: PushPayload, options: Parameters<PushSender>[2]) {
    const data = JSON.stringify(pushPayloadSchema.parse(payload));
    await Promise.all(devices.map(async item => {
      if (!allowedPushEndpoint(item.endpoint)) return this.forget(item.endpoint);
      try {
        await this.send(item.subscription, data, options);
      } catch (error) {
        const status = (error as { statusCode?: number }).statusCode;
        if (status === 404 || status === 410) this.forget(item.endpoint);
        else this.log(`Notification non délivrée (statut ${status ?? 'réseau'}).`, error);
      }
    }));
  }

  private forget(endpoint: string) {
    this.store.db.prepare('DELETE FROM push_subscriptions WHERE endpoint = ?').run(endpoint);
  }

  /** Each reminder is considered once a day; one missed by more than an hour (server stopped) is skipped. */
  private async remind(now: Date) {
    const day = parisDate(now);
    const time = minutes(parisTime(now));
    for (const slot of ['lunch', 'dinner'] as const) {
      const column = `${slot}_reminder`;
      const last = `last_${slot}_day`;
      const due = this.store.transaction(() => {
        const rows = this.store.db.prepare(`SELECT endpoint, user_id, p256dh, auth, ${column} AS reminder FROM push_subscriptions
          WHERE ${column} IS NOT NULL AND (${last} IS NULL OR ${last} <> ?)`).all(day)
          .filter(row => minutes(String(row.reminder)) <= time);
        for (const row of rows) this.store.db.prepare(`UPDATE push_subscriptions SET ${last} = ? WHERE endpoint = ?`).run(day, String(row.endpoint));
        return rows.filter(row => time - minutes(String(row.reminder)) <= reminderWindowMinutes).map(device);
      });
      const byUser = new Map<string, Device[]>();
      for (const item of due) byUser.set(item.userId, [...byUser.get(item.userId) ?? [], item]);
      for (const [userId, devices] of byUser) {
        const names = this.plannedMeals(userId, day, slot);
        if (!names.length) continue;
        await this.deliver(devices, {
          title: slot === 'lunch' ? 'Ce midi' : 'Ce soir', body: names.join(' · ').slice(0, 240), url: '/', tag: `reminder-${slot}`,
        }, { TTL: 3600, urgency: 'normal', topic: `reminder-${slot}` });
      }
    }
  }

  private plannedMeals(userId: string, day: string, slot: Slot): string[] {
    const space = this.store.db.prepare('SELECT space_id FROM memberships WHERE user_id = ?').get(userId);
    if (!space) return [];
    const spaceId = String(space.space_id);
    return [undefined, 1 as const].flatMap(index => {
      const meal = this.store.get(spaceId, `meal:${mealId(day, slot, index)}`) as Meal | undefined;
      if (!meal?.text.trim()) return [];
      const dish = meal.dishId ? this.store.get(spaceId, `dish:${meal.dishId}`) as Dish | undefined : undefined;
      return [mealDisplayName(meal, dish, dish ? this.store.analysis(spaceId, dish.id) : undefined)];
    });
  }
}

export function registerPush(app: FastifyInstance, store: Store, config: Config, now: () => number) {
  const limit = (max: number) => ({ config: { rateLimit: { max, timeWindow: '1 minute' } } });
  const status = (userId: string, endpoint: string) => {
    const row = store.db.prepare('SELECT lunch_reminder, dinner_reminder FROM push_subscriptions WHERE endpoint = ? AND user_id = ?').get(endpoint, userId);
    return pushStatusSchema.parse({
      registered: Boolean(row), lunch: (row?.lunch_reminder as string | null) ?? null, dinner: (row?.dinner_reminder as string | null) ?? null,
      admin: isAdminUser(store, config, userId),
    });
  };

  app.get('/api/push', async () => pushInfoSchema.parse({ configured: Boolean(config.push), publicKey: config.push?.publicKey ?? null }));
  app.addHook('preHandler', async (request, reply) => {
    if (!request.url.startsWith('/api/push/')) return;
    if (!config.push) return reply.code(409).send({ error: 'Les notifications ne sont pas configurées sur ce serveur.', code: 'push_disabled' });
    if (!request.auth.user) return reply.code(401).send({ error: 'Connectez-vous pour gérer les notifications.', code: 'auth_required' });
  });

  app.post('/api/push/subscription', limit(30), async (request, reply) => {
    const parsed = pushRegisterSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'Abonnement aux notifications invalide.' });
    const { subscription, lunch, dinner } = parsed.data;
    if (!allowedPushEndpoint(subscription.endpoint)) return reply.code(400).send({ error: 'Service de notification non pris en charge par ce serveur.' });
    const userId = request.auth.user!.id;
    const time = new Date(now());
    const day = parisDate(time);
    const current = minutes(parisTime(time));
    const saved = store.transaction(() => {
      const existing = store.db.prepare('SELECT user_id, p256dh, auth, last_lunch_day, last_dinner_day FROM push_subscriptions WHERE endpoint = ?').get(subscription.endpoint);
      if (!canReplaceSubscription(existing, userId, subscription)) return false;
      // A reminder whose time has already passed today starts tomorrow.
      const last = (reminder: string | null, previous: unknown) => reminder && minutes(reminder) <= current ? day : (previous as string | null) ?? null;
      store.db.prepare(`INSERT INTO push_subscriptions (endpoint, user_id, p256dh, auth, lunch_reminder, dinner_reminder,
          last_lunch_day, last_dinner_day, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(endpoint) DO UPDATE SET user_id = excluded.user_id, p256dh = excluded.p256dh, auth = excluded.auth,
          lunch_reminder = excluded.lunch_reminder, dinner_reminder = excluded.dinner_reminder,
          last_lunch_day = excluded.last_lunch_day, last_dinner_day = excluded.last_dinner_day, updated_at = excluded.updated_at`)
        .run(subscription.endpoint, userId, subscription.keys.p256dh, subscription.keys.auth, lunch, dinner,
          last(lunch, existing?.last_lunch_day), last(dinner, existing?.last_dinner_day), time.getTime(), time.getTime());
      store.db.prepare(`DELETE FROM push_subscriptions WHERE user_id = ? AND endpoint NOT IN (
        SELECT endpoint FROM push_subscriptions WHERE user_id = ? ORDER BY updated_at DESC, created_at DESC LIMIT ?)`)
        .run(userId, userId, maxDevicesPerUser);
      return true;
    });
    if (!saved) return reply.code(409).send({ error: 'Cet abonnement appartient à un autre compte et ses clés ne correspondent pas.', code: 'push_conflict' });
    request.log.info({ action: 'push.subscribe', userId }, 'Appareil abonné aux notifications');
    return status(userId, subscription.endpoint);
  });

  app.post('/api/push/status', limit(60), async (request, reply) => {
    const parsed = pushEndpointSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'Abonnement invalide.' });
    return status(request.auth.user!.id, parsed.data.endpoint);
  });

  app.post('/api/push/unsubscribe', limit(30), async (request, reply) => {
    const parsed = pushEndpointSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'Abonnement invalide.' });
    store.db.prepare('DELETE FROM push_subscriptions WHERE endpoint = ? AND user_id = ?').run(parsed.data.endpoint, request.auth.user!.id);
    return { ok: true };
  });

  // Called by the service worker when the browser rotates the subscription.
  app.post('/api/push/renew', limit(30), async (request, reply) => {
    const parsed = pushRenewSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'Abonnement invalide.' });
    const { oldEndpoint, subscription } = parsed.data;
    if (!allowedPushEndpoint(subscription.endpoint)) return reply.code(400).send({ error: 'Service de notification non pris en charge par ce serveur.' });
    const changed = store.transaction(() => {
      const userId = request.auth.user!.id;
      if (!store.db.prepare('SELECT 1 FROM push_subscriptions WHERE endpoint = ? AND user_id = ?').get(oldEndpoint, userId)) return 'missing';
      const existing = store.db.prepare('SELECT user_id, p256dh, auth FROM push_subscriptions WHERE endpoint = ?').get(subscription.endpoint);
      if (!canReplaceSubscription(existing, userId, subscription)) return 'conflict';
      if (oldEndpoint !== subscription.endpoint && existing) {
        store.db.prepare('DELETE FROM push_subscriptions WHERE endpoint = ? AND user_id = ?').run(subscription.endpoint, String(existing.user_id));
      }
      store.db.prepare('UPDATE push_subscriptions SET endpoint = ?, p256dh = ?, auth = ?, updated_at = ? WHERE endpoint = ? AND user_id = ?')
        .run(subscription.endpoint, subscription.keys.p256dh, subscription.keys.auth, now(), oldEndpoint, userId);
      return 'renewed';
    });
    if (changed === 'missing') return reply.code(404).send({ error: 'Ancien abonnement introuvable.' });
    if (changed === 'conflict') return reply.code(409).send({ error: 'Cet abonnement appartient à un autre compte et ses clés ne correspondent pas.', code: 'push_conflict' });
    return { ok: true };
  });

  app.post('/api/push/test', limit(5), async request => {
    const userId = request.auth.user!.id;
    const devices = Number(store.db.prepare('SELECT COUNT(*) AS count FROM push_subscriptions WHERE user_id = ?').get(userId)?.count ?? 0);
    store.queuePush(userId, { title: 'Notification de test', body: 'Les notifications fonctionnent sur cet appareil.', url: '/', tag: 'test' });
    return pushTestSchema.parse({ devices });
  });
}
