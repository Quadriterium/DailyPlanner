import Fastify from 'fastify';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import staticFiles from '@fastify/static';
import { existsSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import { generateMealRequestSchema, isResetScoped, syncRequestSchema } from '../shared/model.js';
import { generateMeal, mealGenerationContext } from './ai.js';
import type { Store } from './database.js';
import type { Config } from './config.js';

export async function buildApp(store: Store, config: Config, options: { logger?: boolean; staticRoot?: string; aiRequest?: typeof fetch } = {}) {
  const app = Fastify({ logger: options.logger ?? true, bodyLimit: 2 * 1024 * 1024 });
  await app.register(helmet, {
    contentSecurityPolicy: { directives: {
      defaultSrc: ["'self'"], scriptSrc: ["'self'"], styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", 'data:'], connectSrc: ["'self'"], workerSrc: ["'self'"],
      objectSrc: ["'none'"], frameAncestors: ["'none'"], upgradeInsecureRequests: null,
    } },
    hsts: false,
  });
  await app.register(rateLimit, { global: false });
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
  app.get('/api/health', async () => ({ status: 'ok' }));
  app.post('/api/meals/generate', async (request, reply) => {
    const parsed = generateMealRequestSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'Date du repas invalide.' });
    const context = mealGenerationContext(store.records(), store.analyses());
    let day: string;
    try { day = store.reserveGeneration(); }
    catch (error) {
      request.log.warn(error);
      return reply.code(409).send({ error: error instanceof Error ? error.message : 'Génération IA indisponible.' });
    }
    try {
      const settings = store.settings();
      const result = await generateMeal(parsed.data.date, context, settings, config, settings.model, AbortSignal.timeout(45_000), options.aiRequest);
      store.recordTokens(day, result.inputTokens, result.outputTokens);
      return { details: result.details };
    } catch (error) {
      request.log.error(error);
      return reply.code(502).send({ error: error instanceof Error ? error.message : 'La génération IA a échoué.' });
    }
  });
  app.post('/api/sync', { config: { rateLimit: { max: 180, timeWindow: '1 minute' } } }, async (request, reply) => {
    const parsed = syncRequestSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'Données invalides. Aucune modification du lot n’a été appliquée.' });
    const now = Date.now();
    if (parsed.data.mutations.some(record => record.modifiedAt > now + 5 * 60_000)) {
      return reply.code(400).send({ error: 'L’horloge de cet appareil est trop en avance. Corrigez sa date avant de synchroniser.' });
    }
    if (parsed.data.mutations.some(record => record.type === 'settings' && !config.allowedModels.includes(record.model))) {
      return reply.code(400).send({ error: 'Ce modèle n’est pas autorisé dans la configuration du serveur.' });
    }
    const resetId = store.resetId();
    // A client that has not yet applied the latest reset must not resurrect deleted meals or dishes.
    const stale = (parsed.data.resetId ?? null) !== resetId;
    store.merge(stale ? parsed.data.mutations.filter(record => !isResetScoped(record)) : parsed.data.mutations);
    return { resetId, records: store.records(), analyses: store.analyses(), serverTime: Date.now(), capabilities: store.capabilities() };
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
