import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import {
  acceptInvitationRequestSchema, authProviders, authStartRequestSchema, commonSpaceId, invitationPreviewRequestSchema,
  removeMemberRequestSchema, renameSpaceRequestSchema, revokeInvitationRequestSchema, tokenSchema,
  type AuthCallbackReason, type AuthSession, type SessionSpace, type SessionUser,
} from '../../shared/model.js';
import type { Config } from '../config.js';
import type { Store } from '../database.js';
import { Accounts } from './accounts.js';
import { fakeProvider, registerFakeAuthorizationPage } from './fake.js';
import { googleProvider } from './google.js';
import { ProviderCancelledError, type IdentityProvider } from './provider.js';

export interface RequestAuth {
  user: SessionUser | null;
  space: SessionSpace | null;
  sessionExpiresAt: number | null;
}

declare module 'fastify' {
  interface FastifyRequest { auth: RequestAuth }
}

export const commonSpace: SessionSpace = { id: commonSpaceId, name: 'Espace commun', kind: 'common' };
const invitationError = { error: 'Cette invitation n’est plus valable. Demandez un nouveau lien.', code: 'invitation_invalid' };

export function cookieNames(config: Config) {
  return config.secureCookies
    ? { session: '__Host-atable_session', oauth: '__Host-atable_oauth' }
    : { session: 'atable_session', oauth: 'atable_oauth' };
}

export interface AuthOptions {
  identityProvider?: IdentityProvider;
  now?: () => number;
}

/** Session resolution, `requireSpace` and every account, household and invitation route. */
export function registerAuth(app: FastifyInstance, store: Store, config: Config, options: AuthOptions = {}) {
  const now = options.now ?? Date.now;
  const accounts = new Accounts(store, config.AUTH_SESSION_DAYS, now);
  const names = cookieNames(config);
  const cookieOptions = { httpOnly: true, sameSite: 'lax' as const, path: '/', secure: config.secureCookies };
  let provider: IdentityProvider | undefined;
  if (config.authEnabled) {
    provider = options.identityProvider ?? (config.AUTH_TEST_PROVIDER ? fakeProvider(config) : googleProvider(config));
    if (config.AUTH_TEST_PROVIDER) registerFakeAuthorizationPage(app);
  }

  const setSessionCookie = (reply: FastifyReply, token: string, expiresAt: number) =>
    reply.setCookie(names.session, token, { ...cookieOptions, maxAge: Math.max(1, Math.floor((expiresAt - now()) / 1000)) });

  app.decorateRequest('auth', null as unknown as RequestAuth);
  app.addHook('onRequest', async (request, reply) => {
    if (!config.authEnabled) {
      request.auth = { user: null, space: commonSpace, sessionExpiresAt: null };
      return;
    }
    request.auth = { user: null, space: null, sessionExpiresAt: null };
    if (!request.url.startsWith('/api/')) return;
    const token = request.cookies[names.session];
    if (!token) return;
    const session = tokenSchema.safeParse(token).success ? accounts.resolveSession(token) : undefined;
    if (!session) {
      reply.clearCookie(names.session, cookieOptions);
      return;
    }
    // Only households are reachable with authentication enabled.
    request.auth = { user: session.user, space: session.space?.kind === 'household' ? session.space : null, sessionExpiresAt: session.expiresAt };
    if (session.refreshed) setSessionCookie(reply, token, session.expiresAt);
  });

  /** The space of the request, decided by the session only; sends 401/403 and returns undefined otherwise. */
  function requireSpace(request: FastifyRequest, reply: FastifyReply): string | undefined {
    if (!config.authEnabled) return commonSpaceId;
    if (!request.auth.user) {
      void reply.code(401).send({ error: 'Connectez-vous pour utiliser cette fonction.', code: 'auth_required' });
      return;
    }
    if (!request.auth.space) {
      void reply.code(403).send({ error: 'Vous ne faites plus partie de ce foyer.', code: 'membership_revoked' });
      return;
    }
    return request.auth.space.id;
  }

  function sessionPayload(user: SessionUser | null, space: SessionSpace | null, expiresAt: number | null): AuthSession {
    return {
      authEnabled: config.authEnabled, providers: config.authEnabled ? [...authProviders] : [],
      user, space, defaultModel: config.OPENAI_MODEL, sessionExpiresAt: expiresAt,
    };
  }

  app.get('/api/auth/session', async request => {
    if (!config.authEnabled) return sessionPayload(null, commonSpace, null);
    const { user, sessionExpiresAt } = request.auth;
    if (!user) return sessionPayload(null, null, null);
    // A member removed from (or who left) their household gets a fresh one, as on a first sign-in.
    return sessionPayload(user, request.auth.space ?? accounts.ensureHousehold(user.id), sessionExpiresAt);
  });

  const authRate = { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } };
  const knownProvider = (request: FastifyRequest) => (request.params as { provider?: string }).provider === provider?.id;

  app.post('/api/auth/:provider/start', authRate, async (request, reply) => {
    if (!provider || !knownProvider(request)) return reply.code(404).send({ error: 'Connexion indisponible.' });
    const parsed = authStartRequestSchema.safeParse(request.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: 'Demande de connexion invalide.' });
    const transaction = await accounts.createTransaction(provider.id, parsed.data.invitation);
    let url: URL;
    try { url = await provider.authorizationUrl(transaction); }
    catch (error) {
      request.log.error({ err: error instanceof Error ? error.message : String(error) }, 'Fournisseur d’identité injoignable');
      return reply.code(502).send({ error: 'Connexion Google indisponible pour le moment. Réessayez plus tard.' });
    }
    reply.setCookie(names.oauth, transaction.token, { ...cookieOptions, maxAge: 600 });
    return { url: url.href };
  });

  app.get('/api/auth/:provider/callback', authRate, async (request, reply) => {
    const redirect = (target: string) => {
      reply.clearCookie(names.oauth, cookieOptions);
      return reply.redirect(target, 303);
    };
    const fail = (reason: AuthCallbackReason) => redirect(`/?auth=error&reason=${reason}`);
    if (!provider || !knownProvider(request)) return fail('invalid');
    const token = request.cookies[names.oauth];
    if (!token || !tokenSchema.safeParse(token).success) return fail('expired');
    const transaction = accounts.takeTransaction(token, provider.id);
    if (!transaction || transaction === 'expired') return fail('expired');
    let profile;
    try {
      // The tunnel reaches the server over HTTP: the public URL is rebuilt from PUBLIC_ORIGIN.
      profile = await provider.callback({ currentUrl: new URL(request.url, config.PUBLIC_ORIGIN), ...transaction });
    } catch (error) {
      if (error instanceof ProviderCancelledError) return fail('cancelled');
      request.log.warn({ err: error instanceof Error ? error.message : String(error) }, 'Retour du fournisseur d’identité refusé');
      return fail('invalid');
    }
    const result = store.transaction(() => {
      const userId = accounts.upsertUser(provider.id, profile);
      let invitationFailed = false;
      let joined = false;
      if (!accounts.membership(userId)) {
        if (transaction.invitationHash) {
          joined = accounts.joinWithInvitation(userId, transaction.invitationHash);
          invitationFailed = !joined;
        }
        accounts.ensureHousehold(userId);
      }
      // A user who already has a household keeps the invitation unconsumed: the client asks for an explicit confirmation.
      return { invitationFailed, joined, session: accounts.createSession(userId) };
    });
    setSessionCookie(reply, result.session.token, result.session.expiresAt);
    if (result.invitationFailed) return redirect('/?auth=error&reason=invitation_invalid');
    return redirect(result.joined ? '/?auth=ok&joined=1' : '/?auth=ok');
  });

  app.post('/api/auth/logout', async (request, reply) => {
    const token = request.cookies[names.session];
    if (token && tokenSchema.safeParse(token).success) accounts.deleteSession(token);
    reply.clearCookie(names.session, cookieOptions);
    return { ok: true };
  });

  /** Household routes: authentication enabled and a current household required. */
  function household(request: FastifyRequest, reply: FastifyReply) {
    if (!config.authEnabled) {
      void reply.code(404).send({ error: 'Les foyers ne sont pas activés sur ce serveur.' });
      return;
    }
    const spaceId = requireSpace(request, reply);
    return spaceId ? { spaceId, userId: request.auth.user!.id } : undefined;
  }

  app.get('/api/space', async (request, reply) => {
    const access = household(request, reply);
    if (!access) return reply;
    return accounts.spaceDetails(access.spaceId, access.userId);
  });

  app.patch('/api/space', async (request, reply) => {
    const access = household(request, reply);
    if (!access) return reply;
    const parsed = renameSpaceRequestSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'Le nom du foyer doit contenir 1 à 60 caractères.' });
    accounts.renameSpace(access.spaceId, parsed.data.name);
    return accounts.spaceDetails(access.spaceId, access.userId);
  });

  app.post('/api/space/invitations', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (request, reply) => {
    const access = household(request, reply);
    if (!access) return reply;
    const invitation = accounts.createInvitation(access.spaceId, access.userId);
    if (!invitation) return reply.code(409).send({ error: 'Ce foyer a déjà 10 invitations actives. Révoquez-en une avant d’en créer une autre.' });
    return reply.code(201).send({
      id: invitation.id, url: `${config.PUBLIC_ORIGIN}/#invitation=${invitation.token}`, expiresAt: invitation.expiresAt,
    });
  });

  app.post('/api/space/invitations/revoke', async (request, reply) => {
    const access = household(request, reply);
    if (!access) return reply;
    const parsed = revokeInvitationRequestSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'Invitation invalide.' });
    if (!accounts.revokeInvitation(access.spaceId, parsed.data.id)) return reply.code(404).send({ error: 'Invitation introuvable.' });
    return accounts.spaceDetails(access.spaceId, access.userId);
  });

  app.post('/api/space/members/remove', async (request, reply) => {
    const access = household(request, reply);
    if (!access) return reply;
    const parsed = removeMemberRequestSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'Membre invalide.' });
    if (parsed.data.userId === access.userId) return reply.code(400).send({ error: 'Pour partir vous-même, utilisez « Quitter le foyer ».' });
    if (!accounts.removeMember(access.spaceId, parsed.data.userId)) return reply.code(404).send({ error: 'Ce membre ne fait plus partie du foyer.' });
    return accounts.spaceDetails(access.spaceId, access.userId);
  });

  app.post('/api/space/leave', async (request, reply) => {
    const access = household(request, reply);
    if (!access) return reply;
    accounts.leave(access.userId);
    return { ok: true };
  });

  app.post('/api/invitations/preview', authRate, async (request, reply) => {
    if (!config.authEnabled) return reply.code(404).send(invitationError);
    const parsed = invitationPreviewRequestSchema.safeParse(request.body);
    const preview = parsed.success ? accounts.previewInvitation(parsed.data.token) : undefined;
    return preview ?? reply.code(404).send(invitationError);
  });

  app.post('/api/invitations/accept', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (request, reply) => {
    if (!config.authEnabled) return reply.code(404).send(invitationError);
    const user = request.auth.user;
    if (!user) return reply.code(401).send({ error: 'Connectez-vous pour rejoindre ce foyer.', code: 'auth_required' });
    const parsed = acceptInvitationRequestSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(404).send(invitationError);
    const result = accounts.acceptInvitation(user.id, parsed.data.token, parsed.data.leaveCurrent);
    if (result.status === 'invalid') return reply.code(404).send(invitationError);
    if (result.status === 'confirmation_required') return reply.code(409).send({
      error: 'Vous faites déjà partie d’un foyer qui contient des données ou d’autres membres. Confirmez pour le quitter.',
      code: 'confirmation_required',
    });
    return sessionPayload(user, result.space, request.auth.sessionExpiresAt);
  });

  return { requireSpace, accounts };
}
