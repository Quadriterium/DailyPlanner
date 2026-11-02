import { createHash } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { Config } from '../config.js';
import { ProviderCancelledError, type IdentityProvider } from './provider.js';

/**
 * Simulated provider for automated tests only. readConfig refuses it outside NODE_ENV=test with an in-memory database.
 * Its authorization page is a plain form that lets a test choose the identity returned to the callback.
 */
export function fakeProvider(config: Config): IdentityProvider {
  if (!config.AUTH_TEST_PROVIDER || config.NODE_ENV !== 'test' || config.DATABASE_PATH !== ':memory:') {
    throw new Error('Le fournisseur simulé est réservé aux tests.');
  }
  return {
    id: 'google',
    async authorizationUrl({ state, nonce, codeChallenge }) {
      const url = new URL('/api/test-auth/authorize', config.PUBLIC_ORIGIN);
      url.search = new URLSearchParams({ state, nonce, code_challenge: codeChallenge }).toString();
      return url;
    },
    async callback({ currentUrl, state, nonce, codeVerifier }) {
      const params = currentUrl.searchParams;
      if (params.get('state') !== state) throw new Error('state invalide');
      if (params.get('error')) throw new ProviderCancelledError(params.get('error') ?? 'cancelled');
      if (params.get('nonce') !== nonce) throw new Error('nonce invalide');
      if (createHash('sha256').update(codeVerifier).digest('base64url') !== params.get('code_challenge')) throw new Error('PKCE invalide');
      const subject = params.get('sub')?.trim();
      if (!subject) throw new Error('sub manquant');
      const email = params.get('email')?.trim() || null;
      return { subject, email, emailVerified: Boolean(email), name: params.get('name')?.trim() || 'Testeur', picture: null };
    },
  };
}

const escape = (value: string) => value.replace(/[&<>"']/g, char => `&#${char.charCodeAt(0)};`);

export function registerFakeAuthorizationPage(app: FastifyInstance) {
  app.get('/api/test-auth/authorize', async (request, reply) => {
    const query = request.query as Record<string, string | undefined>;
    const hidden = ['state', 'nonce', 'code_challenge']
      .map(name => `<input type="hidden" name="${name}" value="${escape(query[name] ?? '')}">`).join('');
    reply.type('text/html; charset=utf-8').send(`<!doctype html><html lang="fr"><head><meta charset="utf-8"><title>Connexion simulée</title></head><body>
      <h1>Connexion simulée</h1>
      <form method="get" action="/api/auth/google/callback">${hidden}
        <label>Identifiant <input name="sub" required></label>
        <label>Nom <input name="name" value="Camille Test"></label>
        <label>E-mail <input name="email" value=""></label>
        <button>Continuer</button>
      </form>
      <form method="get" action="/api/auth/google/callback">${hidden}<input type="hidden" name="error" value="access_denied"><button>Annuler</button></form>
    </body></html>`);
  });
}
