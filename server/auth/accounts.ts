import { randomUUID } from 'node:crypto';
import * as oauth from 'openid-client';
import type { InvitationPreview, SessionSpace, SessionUser, SpaceDetails } from '../../shared/model.js';
import type { Store } from '../database.js';
import type { ProviderProfile } from './provider.js';
import { hashToken, newToken } from './tokens.js';

const hour = 3_600_000;
const day = 24 * hour;
export const transactionLifetime = 10 * 60_000;
export const invitationLifetime = 7 * day;
export const maxActiveInvitations = 10;

export interface ResolvedSession {
  user: SessionUser;
  space: SessionSpace | null;
  expiresAt: number;
  /** True when the sliding expiry was pushed back and the cookie must be sent again. */
  refreshed: boolean;
}

export type AcceptResult = { status: 'ok'; space: SessionSpace } | { status: 'invalid' } | { status: 'confirmation_required' };

const householdName = (name: string) => `Foyer de ${name.trim().split(/\s+/)[0] || 'moi'}`.slice(0, 60);

/** Accounts, sessions, OAuth transactions, households and invitations. Every write runs in a SQLite transaction. */
export class Accounts {
  constructor(private readonly store: Store, private readonly sessionDays: number, private readonly now: () => number = Date.now) {}

  private get db() { return this.store.db; }

  // ---------- OAuth transactions ----------

  async createTransaction(provider: string, invitation?: string, returnTo?: '/admin') {
    const token = newToken();
    const codeVerifier = oauth.randomPKCECodeVerifier();
    const transaction = {
      token, state: oauth.randomState(), nonce: oauth.randomNonce(), codeVerifier,
      codeChallenge: await oauth.calculatePKCECodeChallenge(codeVerifier),
    };
    this.db.prepare(`INSERT INTO auth_transactions (id_hash, provider, state, nonce, code_verifier, invitation_hash, expires_at, return_to)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(hashToken(token), provider, transaction.state, transaction.nonce, codeVerifier,
      invitation ? hashToken(invitation) : null, this.now() + transactionLifetime, returnTo ?? null);
    return transaction;
  }

  /** Single use: the transaction is deleted whether it is still valid or not. */
  takeTransaction(token: string, provider: string) {
    return this.store.transaction(() => {
      const idHash = hashToken(token);
      const row = this.db.prepare('SELECT * FROM auth_transactions WHERE id_hash = ?').get(idHash);
      if (!row) return undefined;
      this.db.prepare('DELETE FROM auth_transactions WHERE id_hash = ?').run(idHash);
      if (row.provider !== provider) return undefined;
      if (Number(row.expires_at) <= this.now()) return 'expired' as const;
      return {
        state: String(row.state), nonce: String(row.nonce), codeVerifier: String(row.code_verifier),
        invitationHash: row.invitation_hash === null ? null : String(row.invitation_hash),
        returnTo: row.return_to === '/admin' ? '/admin' as const : undefined,
      };
    });
  }

  // ---------- users and households ----------

  /** Creates or updates the user matching (provider, subject), never by e-mail. */
  upsertUser(provider: string, profile: ProviderProfile): string {
    return this.store.transaction(() => {
      const now = this.now();
      const identity = this.db.prepare('SELECT user_id FROM identities WHERE provider = ? AND subject = ?').get(provider, profile.subject);
      if (identity) {
        const userId = String(identity.user_id);
        this.db.prepare('UPDATE users SET display_name = ?, email = ?, email_verified = ?, picture_url = ?, last_login_at = ? WHERE id = ?')
          .run(profile.name, profile.email, profile.emailVerified ? 1 : 0, profile.picture, now, userId);
        this.db.prepare('UPDATE identities SET email = ? WHERE provider = ? AND subject = ?').run(profile.email, provider, profile.subject);
        return userId;
      }
      const userId = randomUUID();
      this.db.prepare(`INSERT INTO users (id, display_name, email, email_verified, picture_url, created_at, last_login_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)`).run(userId, profile.name, profile.email, profile.emailVerified ? 1 : 0, profile.picture, now, now);
      this.db.prepare('INSERT INTO identities (provider, subject, user_id, email, created_at) VALUES (?, ?, ?, ?, ?)')
        .run(provider, profile.subject, userId, profile.email, now);
      return userId;
    });
  }

  user(userId: string): SessionUser | undefined {
    const row = this.db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
    return row ? {
      id: String(row.id), name: String(row.display_name),
      email: row.email === null ? null : String(row.email), picture: row.picture_url === null ? null : String(row.picture_url),
    } : undefined;
  }

  membership(userId: string): SessionSpace | null {
    const row = this.db.prepare(`SELECT spaces.id, spaces.name, spaces.kind FROM memberships
      JOIN spaces ON spaces.id = memberships.space_id WHERE memberships.user_id = ?`).get(userId);
    return row ? { id: String(row.id), name: String(row.name), kind: row.kind as SessionSpace['kind'] } : null;
  }

  /** Returns the user's household, creating `Foyer de {prénom}` when they have none. */
  ensureHousehold(userId: string): SessionSpace {
    return this.store.transaction(() => {
      const current = this.membership(userId);
      if (current) return current;
      const user = this.user(userId);
      if (!user) throw new Error('Utilisateur introuvable.');
      const space = this.store.createSpace('household', householdName(user.name));
      this.join(userId, space.id);
      return { id: space.id, name: space.name, kind: space.kind };
    });
  }

  private join(userId: string, spaceId: string) {
    this.db.prepare(`INSERT INTO memberships (user_id, space_id, joined_at) VALUES (?, ?, ?)
      ON CONFLICT(user_id) DO UPDATE SET space_id = excluded.space_id, joined_at = excluded.joined_at`).run(userId, spaceId, this.now());
  }

  memberCount(spaceId: string): number {
    return Number(this.db.prepare('SELECT COUNT(*) AS n FROM memberships WHERE space_id = ?').get(spaceId)!.n);
  }

  /** Planned meals or library dishes stored in a space (initial settings do not count). */
  hasData(spaceId: string): boolean {
    return Boolean(this.db.prepare("SELECT 1 FROM records WHERE space_id = ? AND (key LIKE 'meal:%' OR key LIKE 'dish:%') LIMIT 1").get(spaceId));
  }

  /** Removes a household left without member nor data nor feature request; anything else is kept for the administrator. */
  private dropIfAbandoned(spaceId: string) {
    const space = this.store.space(spaceId);
    if (space?.kind !== 'household' || this.memberCount(spaceId) > 0 || this.hasData(spaceId)) return;
    if (this.db.prepare('SELECT 1 FROM feature_requests WHERE space_id = ? LIMIT 1').get(spaceId)) return;
    this.db.prepare('DELETE FROM records WHERE space_id = ?').run(spaceId);
    this.db.prepare('DELETE FROM analyses WHERE space_id = ?').run(spaceId);
    this.db.prepare('DELETE FROM spaces WHERE id = ?').run(spaceId);
  }

  // ---------- sessions ----------

  createSession(userId: string) {
    const token = newToken();
    const now = this.now();
    const expiresAt = now + this.sessionDays * day;
    this.db.prepare('INSERT INTO sessions (token_hash, user_id, created_at, last_seen_at, expires_at) VALUES (?, ?, ?, ?, ?)')
      .run(hashToken(token), userId, now, now, expiresAt);
    return { token, expiresAt };
  }

  resolveSession(token: string): ResolvedSession | undefined {
    const tokenHash = hashToken(token);
    const now = this.now();
    const row = this.db.prepare('SELECT * FROM sessions WHERE token_hash = ? AND expires_at > ?').get(tokenHash, now);
    if (!row) return undefined;
    const user = this.user(String(row.user_id));
    if (!user) return undefined;
    let expiresAt = Number(row.expires_at);
    let refreshed = false;
    if (now - Number(row.last_seen_at) > day) {
      expiresAt = now + this.sessionDays * day;
      refreshed = true;
      this.db.prepare('UPDATE sessions SET last_seen_at = ?, expires_at = ? WHERE token_hash = ?').run(now, expiresAt, tokenHash);
    }
    return { user, space: this.membership(user.id), expiresAt, refreshed };
  }

  deleteSession(token: string) {
    this.db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(hashToken(token));
  }

  revokeSessions(userId: string): number {
    return Number(this.db.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId).changes);
  }

  // ---------- household management ----------

  spaceDetails(spaceId: string, userId: string): SpaceDetails {
    const space = this.store.space(spaceId);
    if (!space) throw new Error('Foyer introuvable.');
    const members = this.db.prepare(`SELECT users.*, memberships.joined_at FROM memberships JOIN users ON users.id = memberships.user_id
      WHERE memberships.space_id = ? ORDER BY memberships.joined_at, users.id`).all(spaceId).map(row => ({
      id: String(row.id), name: String(row.display_name),
      email: row.email === null ? null : String(row.email), picture: row.picture_url === null ? null : String(row.picture_url),
      joinedAt: Number(row.joined_at), isMe: row.id === userId,
    }));
    const invitations = this.db.prepare(`SELECT invitations.*, users.display_name FROM invitations JOIN users ON users.id = invitations.created_by
      WHERE space_id = ? AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at > ? ORDER BY created_at, invitations.id`)
      .all(spaceId, this.now()).map(row => ({
        id: String(row.id), createdBy: String(row.display_name), createdAt: Number(row.created_at), expiresAt: Number(row.expires_at),
      }));
    return { id: space.id, name: space.name, members, invitations };
  }

  renameSpace(spaceId: string, name: string) {
    this.db.prepare("UPDATE spaces SET name = ? WHERE id = ? AND kind = 'household'").run(name, spaceId);
  }

  /** Returns undefined when the household already has the maximum number of active invitations. */
  createInvitation(spaceId: string, userId: string) {
    return this.store.transaction(() => {
      const now = this.now();
      const active = Number(this.db.prepare(`SELECT COUNT(*) AS n FROM invitations
        WHERE space_id = ? AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at > ?`).get(spaceId, now)!.n);
      if (active >= maxActiveInvitations) return undefined;
      const token = newToken();
      const invitation = { id: randomUUID(), token, expiresAt: now + invitationLifetime };
      this.db.prepare('INSERT INTO invitations (id, space_id, token_hash, created_by, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)')
        .run(invitation.id, spaceId, hashToken(token), userId, now, invitation.expiresAt);
      return invitation;
    });
  }

  revokeInvitation(spaceId: string, id: string): boolean {
    return Number(this.db.prepare('UPDATE invitations SET revoked_at = ? WHERE id = ? AND space_id = ? AND accepted_at IS NULL AND revoked_at IS NULL')
      .run(this.now(), id, spaceId).changes) > 0;
  }

  removeMember(spaceId: string, userId: string): boolean {
    return Number(this.db.prepare('DELETE FROM memberships WHERE user_id = ? AND space_id = ?').run(userId, spaceId).changes) > 0;
  }

  /** The last member leaving keeps the household and its data (recoverable with the admin command). */
  leave(userId: string) {
    this.store.transaction(() => {
      const current = this.membership(userId);
      this.db.prepare('DELETE FROM memberships WHERE user_id = ?').run(userId);
      if (current) this.dropIfAbandoned(current.id);
    });
  }

  private validInvitation(tokenHash: string) {
    return this.db.prepare(`SELECT invitations.*, spaces.name AS space_name, users.display_name FROM invitations
      JOIN spaces ON spaces.id = invitations.space_id JOIN users ON users.id = invitations.created_by
      WHERE token_hash = ? AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at > ?`).get(tokenHash, this.now());
  }

  previewInvitation(token: string): InvitationPreview | undefined {
    const row = this.validInvitation(hashToken(token));
    return row ? { spaceName: String(row.space_name), invitedBy: String(row.display_name), expiresAt: Number(row.expires_at) } : undefined;
  }

  /** Atomic consumption: two concurrent acceptances of the same invitation cannot both succeed. */
  private consume(tokenHash: string, userId: string): string | undefined {
    const row = this.validInvitation(tokenHash);
    if (!row) return undefined;
    const now = this.now();
    const changes = this.db.prepare(`UPDATE invitations SET accepted_by = ?, accepted_at = ?
      WHERE id = ? AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at > ?`).run(userId, now, String(row.id), now).changes;
    return Number(changes) === 1 ? String(row.space_id) : undefined;
  }

  /** A user without household joins the invited one (callback step 3). Returns false when the invitation is unusable. */
  joinWithInvitation(userId: string, invitationHash: string): boolean {
    return this.store.transaction(() => {
      if (this.membership(userId)) return false;
      const spaceId = this.consume(invitationHash, userId);
      if (!spaceId) return false;
      this.join(userId, spaceId);
      return true;
    });
  }

  acceptInvitation(userId: string, token: string, leaveCurrent: boolean): AcceptResult {
    return this.store.transaction((): AcceptResult => {
      const tokenHash = hashToken(token);
      const target = this.validInvitation(tokenHash);
      if (!target) return { status: 'invalid' };
      const current = this.membership(userId);
      if (current?.id === String(target.space_id)) return { status: 'ok', space: current };
      if (current && !leaveCurrent && (this.memberCount(current.id) > 1 || this.hasData(current.id))) return { status: 'confirmation_required' };
      const spaceId = this.consume(tokenHash, userId);
      if (!spaceId) return { status: 'invalid' };
      this.join(userId, spaceId);
      if (current) this.dropIfAbandoned(current.id);
      return { status: 'ok', space: this.membership(userId)! };
    });
  }

  // ---------- maintenance ----------

  /** Expired sessions and OAuth transactions, invitations expired for more than 30 days. */
  purge() {
    const now = this.now();
    this.store.transaction(() => {
      this.db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(now);
      this.db.prepare('DELETE FROM admin_sessions WHERE expires_at <= ?').run(now);
      this.db.prepare('DELETE FROM auth_transactions WHERE expires_at <= ?').run(now);
      this.db.prepare('DELETE FROM invitations WHERE expires_at <= ?').run(now - 30 * day);
    });
  }

  /** Users whose verified e-mail matches exactly (case-insensitive). */
  usersByEmail(email: string) {
    return this.db.prepare('SELECT id, email_verified FROM users WHERE lower(email) = lower(?)').all(email.trim())
      .map(row => ({ id: String(row.id), verified: Number(row.email_verified) === 1 }));
  }
}
