import { timingSafeEqual } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Config } from './config.js';
import type { Store } from './database.js';
import { cookieNames } from './auth/routes.js';
import { hashToken } from './auth/tokens.js';

export function isAdminUser(store: Store, config: Config, userId: string): boolean {
  return config.authEnabled && config.adminUserIds.includes(userId) && Boolean(store.db.prepare(`
    SELECT 1 FROM users JOIN identities ON identities.user_id = users.id
    WHERE users.id = ? AND users.email_verified = 1 AND identities.provider = 'google'
  `).get(userId));
}

export function adminAccess(request: FastifyRequest, store: Store, config: Config, now: number) {
  const user = request.auth.user;
  if (!user || !isAdminUser(store, config, user.id)) return undefined;
  const token = request.cookies[cookieNames(config).session];
  if (!token) return undefined;
  const session = store.db.prepare('SELECT expires_at FROM admin_sessions WHERE token_hash = ?').get(hashToken(token));
  if (!session || Number(session.expires_at) <= now) return undefined;
  return { expiresAt: Number(session.expires_at), csrfToken: hashToken(`admin-csrf:${token}`) };
}

export function requireAdmin(request: FastifyRequest, reply: FastifyReply, store: Store, config: Config, now: number) {
  if (!config.authEnabled || !config.adminUserIds.length) {
    void reply.code(403).send({ error: 'Administration désactivée sur ce serveur.', code: 'admin_forbidden' });
    return;
  }
  if (!request.auth.user) {
    void reply.code(401).send({ error: 'Connectez-vous avec Google pour administrer le serveur.', code: 'admin_reauth' });
    return;
  }
  if (!isAdminUser(store, config, request.auth.user.id)) {
    void reply.code(403).send({ error: 'Ce compte n’est pas administrateur.', code: 'admin_forbidden' });
    return;
  }
  const access = adminAccess(request, store, config, now);
  if (!access) {
    void reply.code(401).send({ error: 'La session admin a expiré. Reconnectez-vous depuis la page admin.', code: 'admin_reauth' });
    return;
  }
  if (!['GET', 'HEAD'].includes(request.method)) {
    const csrf = request.headers['x-admin-csrf'];
    const origin = request.headers.origin;
    if (origin !== config.PUBLIC_ORIGIN || request.headers['sec-fetch-site'] === 'cross-site' ||
        typeof csrf !== 'string' || !/^[a-f0-9]{64}$/.test(csrf) ||
        !timingSafeEqual(Buffer.from(csrf), Buffer.from(access.csrfToken))) {
      void reply.code(403).send({ error: 'Protection CSRF : rechargez la page admin et réessayez.', code: 'admin_csrf' });
      return;
    }
  }
  return access;
}
