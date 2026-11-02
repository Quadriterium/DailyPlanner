import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import staticFiles from '@fastify/static';
import type { FastifyRequest } from 'fastify';
import { existsSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { createFeatureRequestSchema, generateMealRequestSchema, isResetScoped, syncRequestSchema } from '../shared/model.js';
import { generateMeal, mealGenerationContext } from './ai.js';
import type { Store } from './database.js';
import { AiQuotaError } from './database.js';
import type { Config } from './config.js';
import { registerAuth, type AuthOptions } from './auth/routes.js';

const loopback = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

/** Rate-limit key: CF-Connecting-IP only when the request comes from the local cloudflared and the proxy is trusted. */
export function rateLimitKey(config: Pick<Config, 'TRUSTED_PROXY'>) {
  return (request: Pick<FastifyRequest, 'headers' | 'ip'> & { socket: { remoteAddress?: string } }) => {
    const remote = request.socket.remoteAddress ?? request.ip;
    const forwarded = request.headers['cf-connecting-ip'];
    if (config.TRUSTED_PROXY === 'cloudflare' && loopback.has(remote) && typeof forwarded === 'string' && forwarded.trim()) return forwarded.trim();
    return remote;
  };
}

/** OAuth callbacks carry `code` and `state` in their query: never log it. */
export const loggedUrl = (url: string) => /^\/api\/(auth|test-auth)\//.test(url) ? url.split('?')[0] : url;

const legalPages: Record<string, string> = { '/confidentialite': 'confidentialite.html', '/conditions-utilisation': 'conditions-utilisation.html' };

export async function buildApp(store: Store, config: Config, options: { logger?: boolean; staticRoot?: string; aiRequest?: typeof fetch } & AuthOptions = {}) {
  const app = Fastify({
    logger: (options.logger ?? true) ? { serializers: { req: request => ({
      method: request.method, url: loggedUrl(request.url), host: request.host, remoteAddress: request.ip, remotePort: request.socket?.remotePort,
    }) } } : false,
    bodyLimit: 2 * 1024 * 1024,
  });
  await app.register(helmet, {
    contentSecurityPolicy: { directives: {
      defaultSrc: ["'self'"], scriptSrc: ["'self'"], styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", 'data:'], connectSrc: ["'self'"], workerSrc: ["'self'"],
      objectSrc: ["'none'"], frameAncestors: ["'none'"], upgradeInsecureRequests: null,
    } },
    hsts: false,
  });
  await app.register(rateLimit, { global: false, keyGenerator: rateLimitKey(config) });
  await app.register(cookie);
  const origins = new Set(config.PUBLIC_ORIGIN ? [config.PUBLIC_ORIGIN] : [
    `http://localhost:${config.PORT}`, `http://127.0.0.1:${config.PORT}`,
    'http://localhost:5173', 'http://127.0.0.1:5173',
  ]);
  app.addHook('onRequest', async (request, reply) => {
    if (!request.url.startsWith('/api/')) return;
    reply.header('Cache-Control', 'no-store');
    const origin = request.headers.origin;
    if (request.method !== 'GET' && (
      (origin && !origins.has(origin)) || request.headers['sec-fetch-site'] === 'cross-site'
    )) return reply.code(403).send({ error: 'Origine non autorisée.' });
  });
  const { requireSpace } = registerAuth(app, store, config, options);
  app.get('/api/health', async () => ({ status: 'ok' }));
  app.post('/api/meals/generate', async (request, reply) => {
    const spaceId = requireSpace(request, reply);
    if (!spaceId) return reply;
    const parsed = generateMealRequestSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'Date du repas ou niveau de cuisine invalide.' });
    const context = mealGenerationContext(store.records(spaceId), store.analyses(spaceId));
    let day: string;
    try { day = store.reserveGeneration(spaceId); }
    catch (error) {
      request.log.warn(error);
      return reply.code(error instanceof AiQuotaError ? 429 : 409).send({ error: error instanceof Error ? error.message : 'Génération IA indisponible.' });
    }
    try {
      const settings = store.settings(spaceId);
      const result = await generateMeal(
        parsed.data.date, parsed.data.level ?? settings.cookingLevel, context, settings, config, settings.model,
        AbortSignal.timeout(45_000), options.aiRequest,
      );
      store.recordTokens(day, result.inputTokens, result.outputTokens, spaceId);
      return { details: result.details };
    } catch (error) {
      request.log.error(error);
      return reply.code(502).send({ error: error instanceof Error ? error.message : 'La génération IA a échoué.' });
    }
  });
  app.get('/api/feature-requests', async (request, reply) => {
    const spaceId = requireSpace(request, reply);
    if (!spaceId) return reply;
    return { requests: store.featureRequests(spaceId) };
  });
  app.post('/api/feature-requests', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (request, reply) => {
    const spaceId = requireSpace(request, reply);
    if (!spaceId) return reply;
    const parsed = createFeatureRequestSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'Décrivez votre demande en 3 à 1 000 caractères.' });
    return reply.code(201).send({ request: store.addFeatureRequest(spaceId, parsed.data.text, request.auth.user?.id ?? null) });
  });
  app.post('/api/sync', { config: { rateLimit: { max: 180, timeWindow: '1 minute' } } }, async (request, reply) => {
    const spaceId = requireSpace(request, reply);
    if (!spaceId) return reply;
    const parsed = syncRequestSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'Données invalides. Aucune modification du lot n’a été appliquée.' });
    const now = Date.now();
    if (parsed.data.mutations.some(record => record.modifiedAt > now + 5 * 60_000)) {
      return reply.code(400).send({ error: 'L’horloge de cet appareil est trop en avance. Corrigez sa date avant de synchroniser.' });
    }
    // A model no longer allowed (e.g. guest settings imported after a configuration change) falls back to the server default.
    const mutations = parsed.data.mutations.map(record => record.type === 'settings' && !config.allowedModels.includes(record.model)
      ? { ...record, model: config.OPENAI_MODEL } : record);
    const resetId = store.resetId(spaceId);
    // A client that has not yet applied the latest reset must not resurrect deleted meals or dishes.
    const stale = (parsed.data.resetId ?? null) !== resetId;
    store.merge(spaceId, stale ? mutations.filter(record => !isResetScoped(record)) : mutations);
    return { resetId, records: store.records(spaceId), analyses: store.analyses(spaceId), serverTime: Date.now(), capabilities: store.capabilities(new Date(), spaceId) };
  });
  const staticRoot = options.staticRoot ?? resolve('dist/client');
  if (existsSync(staticRoot)) {
    await app.register(staticFiles, {
      root: staticRoot,
      setHeaders(reply, path) {
        reply.header('Cache-Control', path.includes(`${sep}assets${sep}`)
          ? 'public, max-age=31536000, immutable' : 'no-cache');
      },
    });
    for (const [path, file] of Object.entries(legalPages)) {
      if (existsSync(join(staticRoot, file))) app.get(path, (_request, reply) => reply.header('Cache-Control', 'no-cache').sendFile(file, { cacheControl: false }));
    }
    app.setNotFoundHandler((request, reply) => {
      if (request.method === 'GET' && !request.url.startsWith('/api/') && request.headers.accept?.includes('text/html')) {
        return reply.sendFile('index.html', { cacheControl: false });
      }
      return reply.code(404).send({ error: 'Ressource introuvable.' });
    });
  }
  app.setErrorHandler((error, request, reply) => {
    request.log.error(error);
    const code = error instanceof Error && 'statusCode' in error ? error.statusCode : undefined;
    const status = typeof code === 'number' && code >= 400 && code < 500 ? code : 500;
    reply.code(status).send({ error: status === 429
      ? 'Trop de requêtes. Réessayez dans une minute.'
      : status === 500 ? 'Erreur du serveur. Les modifications locales sont conservées.' : 'Requête refusée par le serveur.' });
  });
  return app;
}
