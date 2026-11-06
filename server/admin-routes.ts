import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { basename } from 'node:path';
import { z } from 'zod';
import {
  adminAiSchema, adminAuditSchema, adminCatalogCorrectionSchema, adminCatalogRemovalSchema, adminCatalogSchema,
  adminConfirmSchema, adminGlobalPolicyRequestSchema, adminLegalRequestSchema, adminLegalSchema, adminOverviewSchema, adminPageSchema, adminRequestsSchema,
  adminRequestUpdateSchema, adminSessionSchema, adminSpacePolicyRequestSchema, adminSpacesSchema, adminUsersSchema,
} from '../shared/admin.js';
import type { Config } from './config.js';
import { schemaVersion, type Store } from './database.js';
import { adminAccess, isAdminUser, requireAdmin } from './admin-access.js';
import { Accounts } from './auth/accounts.js';
import { cookieNames } from './auth/routes.js';
import { hashToken } from './auth/tokens.js';
import { audit } from './audit.js';
import { backupDatabase, listSpaces, listUsers } from './maintenance.js';
import { normalizedName } from '../shared/model.js';
import { sendMessageSchema, sentMessageSchema } from '../shared/messages.js';

const pageSize = 50;
const uuid = z.object({ id: z.string().uuid() }).strict();
const spaceId = z.object({ id: z.union([z.string().uuid(), z.literal('common')]) }).strict();

function parsed<T>(schema: z.ZodType<T>, input: unknown, reply: FastifyReply): T | undefined {
  const result = schema.safeParse(input);
  if (!result.success) {
    void reply.code(400).send({ error: `Demande admin invalide : ${result.error.issues.map(issue => issue.message).join(' ')}` });
    return;
  }
  return result.data;
}

export async function registerAdmin(app: FastifyInstance, store: Store, config: Config, now: () => number) {
  const accounts = new Accounts(store, config.AUTH_SESSION_DAYS, now);
  function recordAction(request: FastifyRequest, action: string, target: string, details: object) {
    store.db.prepare('INSERT INTO admin_audit (user_id, action, target, details, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(request.auth.user!.id, action, target, JSON.stringify(details), now());
    audit(request, action, `administration : ${action}`, { target });
  }
  function mutate<T>(request: FastifyRequest, action: string, target: string, details: object, work: () => T): T {
    return store.transaction(() => {
      const result = work();
      recordAction(request, action, target, details);
      return result;
    });
  }

  app.get('/api/admin/session', { config: { rateLimit: { max: 60, timeWindow: '1 minute' } } }, async request => {
    const access = adminAccess(request, store, config, now());
    return adminSessionSchema.parse({
      authEnabled: config.authEnabled, user: request.auth.user,
      allowed: Boolean(request.auth.user && isAdminUser(store, config, request.auth.user.id)),
      expiresAt: access?.expiresAt ?? null, csrfToken: access?.csrfToken ?? null,
    });
  });

  await app.register(async admin => {
    const readLimit = admin.rateLimit({ max: 120, timeWindow: '1 minute' });
    const writeLimit = admin.rateLimit({ max: 30, timeWindow: '1 minute' });
    admin.addHook('onRequest', async (request, reply) => {
      const limit = ['GET', 'HEAD'].includes(request.method) ? readLimit : writeLimit;
      return limit.call(admin, request, reply);
    });
    admin.addHook('onRequest', async (request, reply) => {
      if (!requireAdmin(request, reply, store, config, now())) return reply;
    });

    admin.get('/overview', async () => {
      const count = (sql: string) => Number(store.db.prepare(sql).get()!.n);
      const statuses = store.db.prepare("SELECT json_extract(data, '$.status') AS status, COUNT(*) AS n FROM analyses GROUP BY status").all();
      const analyses = { pending: 0, processing: 0, error: 0 };
      for (const row of statuses) {
        if (row.status === 'pending' || row.status === 'processing' || row.status === 'error') analyses[row.status] = Number(row.n);
      }
      return adminOverviewSchema.parse({
        users: count('SELECT COUNT(*) AS n FROM users'), spaces: count("SELECT COUNT(*) AS n FROM spaces WHERE kind = 'household'"),
        activeSessions: Number(store.db.prepare('SELECT COUNT(*) AS n FROM sessions WHERE expires_at > ?').get(now())!.n),
        catalog: count('SELECT COUNT(*) AS n FROM catalog WHERE deleted = 0'),
        requests: count("SELECT COUNT(*) AS n FROM feature_requests WHERE status IN ('received', 'planned')"),
        analyses, usage: store.capabilities(new Date(now())), policy: store.globalAiPolicy(),
        serverTime: now(), uptime: process.uptime(), schemaVersion,
      });
    });
    admin.get('/users', async (request, reply) => {
      const page = parsed(adminPageSchema, request.query, reply);
      if (!page) return reply;
      const users = listUsers(store, { ...page, limit: pageSize + 1 });
      return adminUsersSchema.parse({ users: users.slice(0, pageSize), more: users.length > pageSize });
    });
    admin.post('/messages', async (request, reply) => {
      const input = parsed(sendMessageSchema, request.body, reply);
      if (!input) return reply;
      if (input.userId && !accounts.user(input.userId)) return reply.code(404).send({ error: 'Compte introuvable.' });
      const result = mutate(request, 'admin.message-send', input.userId ?? 'all', {}, () =>
        store.sendMessage(input.text, input.userId, now()));
      return sentMessageSchema.parse(result);
    });
    admin.get('/spaces', async (request, reply) => {
      const page = parsed(adminPageSchema, request.query, reply);
      if (!page) return reply;
      const spaces = listSpaces(store, { ...page, limit: pageSize + 1 });
      return adminSpacesSchema.parse({
        spaces: spaces.slice(0, pageSize).map(space => ({
          ...space, policy: store.spaceAiPolicy(space.id), usage: store.capabilities(new Date(now()), space.id),
        })), more: spaces.length > pageSize,
      });
    });
    admin.post('/users/:id/revoke-sessions', async (request, reply) => {
      const params = parsed(uuid, request.params, reply);
      if (!params || !parsed(adminConfirmSchema, request.body, reply)) return reply;
      if (!accounts.user(params.id)) return reply.code(404).send({ error: 'Compte introuvable.' });
      const revoked = mutate(request, 'admin.revoke-sessions', params.id, {}, () => accounts.revokeSessions(params.id));
      return { revoked };
    });
    admin.get('/ai', async () => adminAiSchema.parse({
      policy: store.globalAiPolicy(), usage: store.capabilities(new Date(now())),
      hourlyCalls: store.hourlyAiCalls(now()),
      configured: Boolean(config.OPENAI_API_KEY), allowedModels: config.allowedModels,
    }));
    admin.patch('/ai', async (request, reply) => {
      const policy = parsed(adminGlobalPolicyRequestSchema, request.body, reply);
      if (!policy) return reply;
      const { confirm, ...limits } = policy;
      mutate(request, 'admin.ai-global', 'global', limits, () => store.setGlobalAiPolicy(limits));
      return { ok: true };
    });
    admin.patch('/spaces/:id/ai', async (request, reply) => {
      const params = parsed(spaceId, request.params, reply);
      const policy = parsed(adminSpacePolicyRequestSchema, request.body, reply);
      if (!params || !policy) return reply;
      if (!store.space(params.id)) return reply.code(404).send({ error: 'Foyer introuvable.' });
      const { confirm, ...limits } = policy;
      mutate(request, 'admin.ai-space', params.id, limits, () => store.setSpaceAiPolicy(params.id, limits));
      return { ok: true };
    });
    admin.get('/catalog', async (request, reply) => {
      const page = parsed(adminPageSchema, request.query, reply);
      if (!page) return reply;
      const rows = store.db.prepare(`SELECT * FROM catalog
        WHERE instr(lower(json_extract(data, '$.details.name')), lower(?)) > 0
        ORDER BY seq DESC LIMIT ? OFFSET ?`).all(page.search, pageSize + 1, page.offset);
      return adminCatalogSchema.parse({
        entries: rows.slice(0, pageSize).map(row => ({
          ...JSON.parse(String(row.data)), deleted: Boolean(row.deleted), seq: Number(row.seq), createdAt: Number(row.created_at),
        })), more: rows.length > pageSize,
      });
    });
    function catalogCurrent(request: FastifyRequest, reply: FastifyReply, expectedSeq: number) {
      const params = parsed(uuid, request.params, reply);
      if (!params) return;
      const row = store.db.prepare('SELECT seq FROM catalog WHERE id = ?').get(params.id);
      if (!row) { void reply.code(404).send({ error: 'Fiche du catalogue introuvable.' }); return; }
      if (Number(row.seq) !== expectedSeq) {
        void reply.code(409).send({ error: 'Cette fiche a changé. Rechargez-la avant de la modifier.' });
        return;
      }
      return store.catalogEntry(params.id);
    }
    admin.patch('/catalog/:id', async (request, reply) => {
      const body = parsed(adminCatalogCorrectionSchema, request.body, reply);
      if (!body) return reply;
      return store.transaction(() => {
        const entry = catalogCurrent(request, reply, body.expectedSeq);
        if (!entry) return reply;
        if (store.db.prepare('SELECT 1 FROM catalog WHERE name_key = ? AND deleted = 0 AND id != ?')
          .get(normalizedName(body.details.name), entry.id)) return reply.code(409).send({ error: 'Une autre fiche active porte déjà ce nom.' });
        mutate(request, 'admin.catalog-correct', entry.id, { expectedSeq: body.expectedSeq }, () =>
          store.correctCatalogEntry(entry.id, body.details, body.sourceUrl));
        return { ok: true };
      });
    });
    admin.post('/catalog/:id/removal', async (request, reply) => {
      const body = parsed(adminCatalogRemovalSchema, request.body, reply);
      if (!body) return reply;
      return store.transaction(() => {
        const entry = catalogCurrent(request, reply, body.expectedSeq);
        if (!entry) return reply;
        if (!body.removed && store.db.prepare('SELECT 1 FROM catalog WHERE name_key = ? AND deleted = 0 AND id != ?')
          .get(normalizedName(entry.details.name), entry.id)) {
          return reply.code(409).send({ error: 'Une autre fiche active porte déjà ce nom.' });
        }
        mutate(request, 'admin.catalog-removal', entry.id, { removed: body.removed }, () => store.setCatalogRemoved(entry.id, body.removed));
        return { ok: true };
      });
    });
    admin.get('/requests', async (request, reply) => {
      const page = parsed(adminPageSchema, request.query, reply);
      if (!page) return reply;
      const rows = store.db.prepare(`SELECT feature_requests.*, spaces.name AS space_name FROM feature_requests
        LEFT JOIN spaces ON spaces.id = feature_requests.space_id
        WHERE instr(lower(feature_requests.text), lower(?)) > 0
        ORDER BY feature_requests.created_at DESC, feature_requests.id LIMIT ? OFFSET ?`).all(page.search, pageSize + 1, page.offset);
      return adminRequestsSchema.parse({
        requests: rows.slice(0, pageSize).map(row => ({
          request: { id: row.id, text: row.text, status: row.status, note: row.note, createdAt: Number(row.created_at), updatedAt: Number(row.updated_at) },
          spaceId: String(row.space_id), spaceName: row.space_name === null ? null : String(row.space_name),
        })), more: rows.length > pageSize,
      });
    });
    admin.patch('/requests/:id', async (request, reply) => {
      const params = parsed(uuid, request.params, reply);
      const body = parsed(adminRequestUpdateSchema, request.body, reply);
      if (!params || !body) return reply;
      return store.transaction(() => {
        const row = store.db.prepare('SELECT updated_at FROM feature_requests WHERE id = ?').get(params.id);
        if (!row) return reply.code(404).send({ error: 'Demande introuvable.' });
        if (Number(row.updated_at) !== body.expectedUpdatedAt) return reply.code(409).send({ error: 'Cette demande a changé. Rechargez-la avant de répondre.' });
        mutate(request, 'admin.request-update', params.id, { status: body.status }, () =>
          store.updateFeatureRequest(params.id, body.status, body.note || null));
        return { ok: true };
      });
    });
    admin.get('/legal', async () => adminLegalSchema.parse(store.legalInfo()));
    admin.patch('/legal', async (request, reply) => {
      const body = parsed(adminLegalRequestSchema, request.body, reply);
      if (!body) return reply;
      return store.transaction(() => {
        const current = store.legalInfo();
        if (current.updatedAt !== body.expectedUpdatedAt) return reply.code(409).send({ error: 'Les mentions légales ont changé. Rechargez-les avant de les modifier.' });
        // Only field names reach the audit trail: the values are personal data.
        const changed = (Object.keys(body.info) as (keyof typeof body.info)[]).filter(key => body.info[key] !== current.info[key]);
        const updatedAt = Math.max(now(), current.updatedAt + 1);
        mutate(request, 'admin.legal-update', 'legal', { changed }, () => store.setLegalInfo(body.info, updatedAt));
        return { ok: true };
      });
    });
    admin.get('/audit', async (request, reply) => {
      const page = parsed(adminPageSchema, request.query, reply);
      if (!page) return reply;
      const rows = store.db.prepare(`SELECT * FROM admin_audit WHERE instr(lower(action || ' ' || target || ' ' || user_id), lower(?)) > 0
        ORDER BY id DESC LIMIT ? OFFSET ?`).all(page.search, pageSize + 1, page.offset);
      return adminAuditSchema.parse({
        entries: rows.slice(0, pageSize).map(row => ({
          id: Number(row.id), userId: String(row.user_id), action: String(row.action), target: String(row.target),
          details: String(row.details), createdAt: Number(row.created_at),
        })), more: rows.length > pageSize,
      });
    });
    admin.post('/backup', async (request, reply) => {
      if (!parsed(adminConfirmSchema, request.body, reply)) return reply;
      if (config.DATABASE_PATH === ':memory:') return reply.code(409).send({ error: 'La base de test en mémoire ne peut pas être sauvegardée sur disque.' });
      const file = basename(backupDatabase(config, 'admin'));
      store.transaction(() => recordAction(request, 'admin.backup', 'database', { file }));
      return { file };
    });
    admin.post('/logout', async (request, reply) => {
      if (!parsed(adminConfirmSchema, request.body, reply)) return reply;
      const token = request.cookies[cookieNames(config).session]!;
      mutate(request, 'admin.logout', request.auth.user!.id, {}, () => {
        store.db.prepare('DELETE FROM admin_sessions WHERE token_hash = ?').run(hashToken(token));
      });
      return { ok: true };
    });
  }, { prefix: '/api/admin' });
}
