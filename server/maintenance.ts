import { DatabaseSync } from 'node:sqlite';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { commonSpaceId, compareVersions, recordKey } from '../shared/model.js';
import type { Config } from './config.js';
import type { Store } from './database.js';
import { Accounts } from './auth/accounts.js';

/** Copies the database with VACUUM INTO before an administrative change. Returns the backup path. */
export function backupDatabase(config: Config, prefix: string): string {
  const source = resolve(config.DATABASE_PATH);
  if (!existsSync(source)) throw new Error('Base introuvable. Démarrez d’abord le serveur.');
  const backup = join(dirname(source), 'backups', `${prefix}-${new Date().toISOString().replace(/[:.]/g, '-')}.sqlite`);
  mkdirSync(dirname(backup), { recursive: true });
  const reader = new DatabaseSync(source, { readOnly: true });
  try { reader.prepare('VACUUM INTO ?').run(backup); } finally { reader.close(); }
  return backup;
}

/** The only account whose e-mail matches; refuses missing, unverified or ambiguous e-mails. */
export function userByEmail(store: Store, email: string): string {
  const users = new Accounts(store, 30).usersByEmail(email);
  if (!users.length) throw new Error(`Aucun compte avec l’adresse ${email}. La personne doit d’abord se connecter une fois.`);
  if (users.length > 1) throw new Error(`Plusieurs comptes utilisent l’adresse ${email} : opération refusée.`);
  if (!users[0].verified) throw new Error(`L’adresse ${email} n’est pas vérifiée par Google : opération refusée.`);
  return users[0].id;
}

export function listUsers(store: Store, page: { search: string; offset: number; limit: number } = { search: '', offset: 0, limit: -1 }) {
  return store.db.prepare(`SELECT users.id, users.display_name, users.email, users.email_verified, users.created_at, users.last_login_at, spaces.id AS space_id, spaces.name AS space_name
    FROM users LEFT JOIN memberships ON memberships.user_id = users.id LEFT JOIN spaces ON spaces.id = memberships.space_id
    WHERE instr(lower(users.display_name || ' ' || COALESCE(users.email, '') || ' ' || users.id), lower(?)) > 0
    ORDER BY users.last_login_at DESC, users.id LIMIT ? OFFSET ?`).all(page.search, page.limit, page.offset).map(row => ({
    id: String(row.id), name: String(row.display_name), email: row.email === null ? null : String(row.email),
    emailVerified: Number(row.email_verified) === 1, createdAt: Number(row.created_at), lastLoginAt: Number(row.last_login_at),
    spaceId: row.space_id === null ? null : String(row.space_id), spaceName: row.space_name === null ? null : String(row.space_name),
  }));
}

export function listSpaces(store: Store, page: { search: string; offset: number; limit: number } = { search: '', offset: 0, limit: -1 }) {
  return store.db.prepare(`SELECT spaces.id, spaces.kind, spaces.name, spaces.created_at,
      (SELECT COUNT(*) FROM memberships WHERE space_id = spaces.id) AS members,
      (SELECT COUNT(*) FROM records WHERE space_id = spaces.id AND (key LIKE 'meal:%' OR key LIKE 'dish:%')) AS records
    FROM spaces WHERE instr(lower(spaces.name || ' ' || spaces.id), lower(?)) > 0
    ORDER BY spaces.kind, spaces.created_at, spaces.id LIMIT ? OFFSET ?`).all(page.search, page.limit, page.offset).map(row => ({
    id: String(row.id), kind: String(row.kind), name: String(row.name), createdAt: Number(row.created_at),
    members: Number(row.members), records: Number(row.records),
  }));
}

/**
 * Moves the common space into the household of `userId`: record-by-record merge with compareVersions, analyses kept when
 * their analysisKey matches the retained dish, feature requests moved. The common space is then emptied and gets a new
 * reset_id so devices still in common mode drop their copies.
 */
export function assignCommon(store: Store, userId: string) {
  const accounts = new Accounts(store, 30);
  return store.transaction(() => {
    const target = accounts.ensureHousehold(userId);
    const records = store.records(commonSpaceId);
    const analyses = store.analyses(commonSpaceId);
    store.merge(target.id, records);
    let moved = 0;
    for (const record of records) {
      const current = store.get(target.id, recordKey(record));
      if (current && compareVersions(current, record) === 0) moved++;
    }
    for (const analysis of analyses) {
      const dish = store.get(target.id, `dish:${analysis.dishId}`);
      if (dish?.type === 'dish' && dish.analysisKey === analysis.analysisKey) store.copyAnalysis(target.id, analysis);
    }
    store.db.prepare('UPDATE feature_requests SET space_id = ? WHERE space_id = ?').run(target.id, commonSpaceId);
    const resetId = store.reset(commonSpaceId);
    return { space: target, moved, total: records.length, resetId };
  });
}

/** Attaches a household without member to `userId`, who leaves their current household. */
export function assignSpace(store: Store, spaceId: string, userId: string, force: boolean) {
  const accounts = new Accounts(store, 30);
  return store.transaction(() => {
    const space = store.space(spaceId);
    if (space?.kind !== 'household') throw new Error('Foyer introuvable (l’espace commun ne peut pas être rattaché).');
    if (accounts.memberCount(spaceId) > 0) throw new Error('Ce foyer a encore des membres : utilisez une invitation.');
    const current = accounts.membership(userId);
    if (current && !force && (accounts.memberCount(current.id) > 1 || accounts.hasData(current.id))) {
      throw new Error(`Le foyer actuel « ${current.name} » contient d’autres membres ou des données. Ajoutez --force pour le quitter quand même (il est conservé).`);
    }
    accounts.leave(userId);
    store.db.prepare('INSERT INTO memberships (user_id, space_id, joined_at) VALUES (?, ?, ?)').run(userId, spaceId, Date.now());
    return space;
  });
}
