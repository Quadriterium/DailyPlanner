import * as client from 'openid-client';
import type { Config } from '../config.js';
import { ProviderCancelledError, type IdentityProvider } from './provider.js';

/** Google sign-in through the server-side authorization code flow (PKCE, state, nonce). No Google token is kept. */
export function googleProvider(config: Config): IdentityProvider {
  let discovered: Promise<client.Configuration> | undefined;
  function configuration() {
    // Discovery is lazy so the server starts even when Google is unreachable; a failure is retried on the next sign-in.
    discovered ??= client.discovery(new URL('https://accounts.google.com'), config.GOOGLE_CLIENT_ID, config.GOOGLE_CLIENT_SECRET)
      .catch(error => { discovered = undefined; throw error; });
    return discovered;
  }
  return {
    id: 'google',
    async authorizationUrl({ state, nonce, codeChallenge }) {
      return client.buildAuthorizationUrl(await configuration(), {
        redirect_uri: config.redirectUri, scope: 'openid email profile', state, nonce,
        code_challenge: codeChallenge, code_challenge_method: 'S256', prompt: 'select_account',
      });
    },
    async callback({ currentUrl, state, nonce, codeVerifier }) {
      if (currentUrl.searchParams.get('error')) throw new ProviderCancelledError(currentUrl.searchParams.get('error') ?? 'cancelled');
      const tokens = await client.authorizationCodeGrant(await configuration(), currentUrl, {
        pkceCodeVerifier: codeVerifier, expectedState: state, expectedNonce: nonce, idTokenExpected: true,
      });
      const claims = tokens.claims();
      if (!claims?.sub) throw new Error('Jeton d’identité Google sans identifiant.');
      const email = typeof claims.email === 'string' ? claims.email : null;
      const name = typeof claims.name === 'string' && claims.name.trim() ? claims.name.trim() : email?.split('@')[0] ?? 'Utilisateur';
      const picture = typeof claims.picture === 'string' && claims.picture.startsWith('https://') ? claims.picture : null;
      return { subject: claims.sub, email, emailVerified: claims.email_verified === true, name: name.slice(0, 120), picture };
    },
  };
}
