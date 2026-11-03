import Fastify, { LogController } from 'fastify';
import cookie from '@fastify/cookie';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import staticFiles from '@fastify/static';
import type { FastifyRequest } from 'fastify';
import { existsSync } from 'node:fs';
import { randomInt } from 'node:crypto';
import { join, resolve, sep } from 'node:path';
import {
  catalogCandidates, catalogDrawThreshold, catalogRequestSchema, createFeatureRequestSchema, generateMealRequestSchema, generationErrorMessage, isResetScoped,
  recentMealNames, seasonForDate, syncRequestSchema, vegetarianForSlot,
} from '../shared/model.js';
import { generateMeal, mealGenerationContext, refineShoppingList } from './ai.js';
import { refineShoppingRequestSchema } from '../shared/shopping.js';
import type { Store } from './database.js';
import { AiQuotaError } from './database.js';
import type { Config } from './config.js';
import { registerAuth, type AuthOptions } from './auth/routes.js';
import { audit, describeMutations, loggedUrl, logFailedRequest } from './audit.js';
import { registerAdmin } from './admin-routes.js';

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

export { loggedUrl };

const legalPages: Record<string, string> = { '/confidentialite': 'confidentialite.html', '/conditions-utilisation': 'conditions-utilisation.html' };

export async function buildApp(store: Store, config: Config, options: { logger?: boolean; staticRoot?: string; aiRequest?: typeof fetch } & AuthOptions = {}) {
  const app = Fastify({
    logger: (options.logger ?? true) ? { serializers: { req: request => ({
      method: request.method, url: loggedUrl(request.url), host: request.host, remoteAddress: request.ip, remotePort: request.socket?.remotePort,
    }) } } : false,
    // Every successful request (assets, polling, sync) drowned the console: only user actions and failures are logged.
    logController: new LogController({ disableRequestLogging: true }),
    bodyLimit: 2 * 1024 * 1024,
  });
  app.addHook('onResponse', async (request, reply) => logFailedRequest(request, reply));
  app.addHook('onSend', async (request, reply, payload) => {
    if (/^\/admin(?:[/?]|$)/.test(request.url) || request.url.startsWith('/api/admin/')) {
      reply.header('Cache-Control', 'no-store').header('X-Robots-Tag', 'noindex, nofollow');
    }
    return payload;
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
  await registerAdmin(app, store, config, options.now ?? Date.now);
  app.get('/api/health', async () => ({ status: 'ok' }));
  app.post('/api/meals/generate', async (request, reply) => {
    const spaceId = requireSpace(request, reply);
    if (!spaceId) return reply;
    const parsed = generateMealRequestSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'Date du repas ou niveau de cuisine invalide.' });
    const { date } = parsed.data;
    const settings = store.settings(spaceId);
    if (settings.vegetarianDinners && !settings.vegetarian && !parsed.data.slot) {
      return reply.code(400).send({ error: 'Précisez midi ou soir pour appliquer les préférences végétariennes.' });
    }
    const vegetarian = vegetarianForSlot(settings, parsed.data.slot) || parsed.data.vegetarian === true;
    const level = parsed.data.level ?? settings.cookingLevel;
    const records = store.records(spaceId);
    const analyses = store.analyses(spaceId);
    const catalog = store.catalog();
    // Enough suitable shared recipes: draw one instead of paying for a new AI proposal.
    const candidates = catalogCandidates(catalog, { date, level, vegetarian, avoid: settings.avoid, excludedNames: recentMealNames(records, analyses, date) });
    if (candidates.length >= catalogDrawThreshold) {
      const entry = candidates[randomInt(candidates.length)];
      audit(request, 'meal.generate', `suggestion du catalogue pour le ${date} : « ${entry.details.name} »`, { date, level, source: 'catalog' });
      return { details: entry.details, source: 'catalog', ...(entry.sourceUrl ? { sourceUrl: entry.sourceUrl } : {}) };
    }
    const comparable = catalogCandidates(catalog, { date, level, vegetarian, avoid: '', excludedNames: [] }).map(entry => entry.details.name);
    const context = mealGenerationContext(records, analyses, date, comparable);
    let proposedName: string | undefined;
    for (let attempt = 0; attempt < 2; attempt++) {
      let day: string;
      try { day = store.reserveGeneration(spaceId); }
      catch (error) {
        request.log.warn(error);
        if (attempt === 0) {
          return reply.code(error instanceof AiQuotaError ? 429 : 409).send({ error: error instanceof Error ? error.message : 'Génération IA indisponible.' });
        }
        break;
      }
      let result: Awaited<ReturnType<typeof generateMeal>>;
      try {
        result = await generateMeal(
          date, level, context, { ...settings, vegetarian }, config, settings.model,
          AbortSignal.timeout(45_000), options.aiRequest, name => { proposedName = name; },
        );
      } catch (error) {
        request.log.error(error);
        continue;
      }
      store.recordTokens(day, result.inputTokens, result.outputTokens, spaceId);
      if (!result.troll) store.addToCatalog(result.details, undefined, spaceId);
      audit(request, 'meal.generate', `suggestion IA pour le ${date} : « ${result.details.name} »`, { date, level, source: 'ai' });
      return { details: result.details, source: 'ai' };
    }
    if (proposedName && !vegetarian) return {
      details: { name: proposedName, seasons: [seasonForDate(date)], ingredients: [], recipe: '' },
      source: 'ai', warning: generationErrorMessage,
    };
    return reply.code(502).send({ error: generationErrorMessage });
  });
  // Same budget and model as meal generation; nothing is stored, the household copies the result.
  app.post('/api/shopping/refine', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (request, reply) => {
    const spaceId = requireSpace(request, reply);
    if (!spaceId) return reply;
    const parsed = refineShoppingRequestSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'Liste de courses invalide.' });
    const settings = store.settings(spaceId);
    let day: string;
    try { day = store.reserveGeneration(spaceId); }
    catch (error) {
      request.log.warn(error);
      return reply.code(error instanceof AiQuotaError ? 429 : 409).send({ error: error instanceof Error ? error.message : 'IA indisponible.' });
    }
    try {
      const result = await refineShoppingList(parsed.data.lines, config, settings.model, AbortSignal.timeout(60_000), options.aiRequest);
      store.recordTokens(day, result.inputTokens, result.outputTokens, spaceId);
      audit(request, 'shopping.refine', `liste de courses affinée (${parsed.data.lines.length} lignes)`, { lines: parsed.data.lines.length });
      return { list: result.list };
    } catch (error) {
      request.log.error(error);
      return reply.code(502).send({ error: 'Oups, l’IA n’a pas pu affiner la liste. La liste exacte reste disponible.' });
    }
  });
  // Read-only and without session: the cached catalogue also serves autocompletion and random draws in guest mode.
  app.get('/api/catalog', { config: { rateLimit: { max: 60, timeWindow: '1 minute' } } }, async (request, reply) => {
    const parsed = catalogRequestSchema.safeParse(request.query);
    if (!parsed.success) return reply.code(400).send({ error: 'Position du catalogue invalide.' });
    return store.catalogChanges(parsed.data.after);
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
    audit(request, 'feature-request.create', `demande d’évolution : « ${parsed.data.text.slice(0, 120)} »`);
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
    const applied = stale ? mutations.filter(record => !isResetScoped(record)) : mutations;
    store.merge(spaceId, applied);
    if (applied.length) audit(request, 'sync', describeMutations(applied), { mutations: applied.length });
    return {
      ...(config.CLIENT_UPDATE_ID ? { forceClientUpdate: config.CLIENT_UPDATE_ID } : {}),
      resetId, records: store.records(spaceId), analyses: store.analyses(spaceId),
      serverTime: Date.now(), capabilities: store.capabilities(new Date(), spaceId),
    };
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
      : status === 500 ? request.url.startsWith('/api/admin/')
        ? 'Erreur du serveur d’administration. Vérifiez le journal serveur avant de réessayer.'
        : 'Erreur du serveur. Les modifications locales sont conservées.' : 'Requête refusée par le serveur.' });
  });
  return app;
}
