import { createHash, randomBytes } from 'node:crypto';

/** Random 32-byte token, base64url encoded (43 characters). */
export function newToken(): string {
  return randomBytes(32).toString('base64url');
}

/** Only this SHA-256 digest of a token is ever stored. */
export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}
