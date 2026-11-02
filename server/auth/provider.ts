export interface ProviderProfile {
  subject: string;
  email: string | null;
  emailVerified: boolean;
  name: string;
  picture: string | null;
}

/** An external identity provider. Only Google is registered for now; Apple can be added behind the same interface. */
export interface IdentityProvider {
  id: 'google';
  authorizationUrl(input: { state: string; nonce: string; codeChallenge: string }): Promise<URL>;
  callback(input: { currentUrl: URL; state: string; nonce: string; codeVerifier: string }): Promise<ProviderProfile>;
}

/** The user cancelled or refused the consent screen. */
export class ProviderCancelledError extends Error {}
