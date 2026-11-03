import { openDB, type DBSchema } from 'idb';
import { newId } from './id';
import {
  compareVersions, defaultCookingLevel, defaultHousehold, dishDetails, isResetScoped, normalizedName, recordKey, recordSchema,
  type Analysis, type Capabilities, type RecordData, type Settings, type SyncResponse,
} from '../shared/model';

type DraftOf<T> = T extends RecordData ? Omit<T, 'modifiedAt' | 'mutationId'> : never;
export type Draft = DraftOf<RecordData>;
interface Metadata { lastSync: number | null; capabilities: Capabilities | null; resetId?: string | null; importedInto?: string }
interface PlannerDatabase extends DBSchema {
  records: { key: string; value: RecordData };
  outbox: { key: string; value: RecordData };
  analyses: { key: string; value: Analysis };
  meta: { key: string; value: Metadata };
}
export interface Snapshot extends Metadata {
  records: RecordData[];
  analyses: Analysis[];
  pending: number;
}

/** Historical name kept for the common space: devices in AUTH_ENABLED=false mode find their data again. */
export const commonDatabase = 'a-table-v1';
export const guestDatabase = 'a-table-guest';
/** One cache per account and per household: never shared between two accounts or two households. */
export const accountDatabase = (userId: string, spaceId: string) => `a-table-u-${userId}-s-${spaceId}`;
const zeroId = '00000000-0000-0000-0000-000000000000';

/** Local settings of version 0, outside the outbox: the server version replaces them at the first synchronization. */
export function initialSettings(model: string): Settings {
  return {
    type: 'settings', id: 'global', model, household: { ...defaultHousehold }, avoid: '', cookingLevel: defaultCookingLevel,
    vegetarian: false, vegetarianDinners: false,
    modifiedAt: 0, mutationId: zeroId,
  };
}

export function createRepository(name = commonDatabase) {
  const database = openDB<PlannerDatabase>(name, 1, {
    upgrade(db) {
      db.createObjectStore('records');
      db.createObjectStore('outbox');
      db.createObjectStore('analyses');
      db.createObjectStore('meta');
    },
  });
  return {
    async snapshot(): Promise<Snapshot> {
      const db = await database;
      const tx = db.transaction(['records', 'outbox', 'analyses', 'meta']);
      const [records, analyses, pending, metadata] = await Promise.all([
        tx.objectStore('records').getAll(), tx.objectStore('analyses').getAll(),
        tx.objectStore('outbox').count(), tx.objectStore('meta').get('sync'),
      ]);
      await tx.done;
      return { records, analyses, pending, lastSync: metadata?.lastSync ?? null, capabilities: metadata?.capabilities ?? null };
    },
    async save(drafts: Draft[]) {
      const validated = drafts.map(draft => recordSchema.parse({
        ...draft, modifiedAt: Date.now(), mutationId: newId(),
      }));
      const db = await database;
      const tx = db.transaction(['records', 'outbox'], 'readwrite');
      try {
        for (const draft of validated) {
          const key = recordKey(draft);
          const previous = await tx.objectStore('records').get(key);
          const record: RecordData = {
            ...draft, modifiedAt: Math.max(Date.now(), (previous?.modifiedAt ?? 0) + 1),
          };
          await tx.objectStore('records').put(record, key);
          await tx.objectStore('outbox').put(record, key);
        }
        await tx.done;
      } catch (error) {
        await tx.done.catch(() => { /* Preserve the original storage or validation error. */ });
        throw error;
      }
    },
    async pending(): Promise<RecordData[]> {
      return (await database).getAll('outbox', undefined, 100);
    },
    async resetId(): Promise<string | null> {
      return (await (await database).get('meta', 'sync'))?.resetId ?? null;
    },
    async merge(response: SyncResponse) {
      const db = await database;
      const tx = db.transaction(['records', 'outbox', 'analyses', 'meta'], 'readwrite');
      const metadata = await tx.objectStore('meta').get('sync');
      if ((metadata?.resetId ?? null) !== response.resetId) {
        // Server-forced reset: local meals and dishes, including unsent ones, are discarded; settings are kept.
        for (const store of ['records', 'outbox'] as const) {
          for (const record of await tx.objectStore(store).getAll()) {
            if (isResetScoped(record)) await tx.objectStore(store).delete(recordKey(record));
          }
        }
        await tx.objectStore('analyses').clear();
      }
      for (const remote of response.records) {
        const key = recordKey(remote);
        const current = await tx.objectStore('records').get(key);
        if (!current || compareVersions(remote, current) >= 0) {
          await tx.objectStore('records').put(remote, key);
        }
        const pending = await tx.objectStore('outbox').get(key);
        // A response cannot acknowledge a local edit made while its request was in flight.
        if (pending && compareVersions(remote, pending) >= 0) await tx.objectStore('outbox').delete(key);
      }
      for (const analysis of response.analyses) {
        const dish = await tx.objectStore('records').get(`dish:${analysis.dishId}`);
        const current = await tx.objectStore('analyses').get(analysis.dishId);
        if (dish?.type === 'dish' && dish.analysisKey === analysis.analysisKey &&
          (!current || current.analysisKey !== analysis.analysisKey || analysis.updatedAt >= current.updatedAt)) {
          await tx.objectStore('analyses').put(analysis, analysis.dishId);
        }
      }
      await tx.objectStore('meta').put({ lastSync: Date.now(), capabilities: response.capabilities, resetId: response.resetId }, 'sync');
      await tx.done;
    },
    /** Creates settings:global (version 0, not queued) when the database has none yet. */
    async ensureSettings(model: string) {
      const db = await database;
      const tx = db.transaction('records', 'readwrite');
      if (!await tx.store.get('settings:global')) await tx.store.put(initialSettings(model), 'settings:global');
      await tx.done;
    },
    /** Records created or edited on this device (the initial settings of version 0 do not count). */
    async userRecords(): Promise<RecordData[]> {
      return (await (await database).getAll('records')).filter(record => record.modifiedAt > 0);
    },
    async outbox(): Promise<RecordData[]> {
      return (await database).getAll('outbox');
    },
    /** Copies records with their original versions into records and outbox, in one transaction; an existing newer version wins. */
    async importRecords(records: RecordData[]) {
      const db = await database;
      const tx = db.transaction(['records', 'outbox'], 'readwrite');
      for (const record of records) {
        const key = recordKey(record);
        const current = await tx.objectStore('records').get(key);
        if (current && compareVersions(record, current) <= 0) continue;
        await tx.objectStore('records').put(record, key);
        await tx.objectStore('outbox').put(record, key);
      }
      await tx.done;
    },
    /** Marks the guest database as imported, then empties it. */
    async markImportedAndClear(target: string) {
      const db = await database;
      const tx = db.transaction(['records', 'outbox', 'analyses', 'meta'], 'readwrite');
      const metadata = await tx.objectStore('meta').get('sync');
      await tx.objectStore('meta').put({ lastSync: metadata?.lastSync ?? null, capabilities: metadata?.capabilities ?? null, importedInto: target }, 'sync');
      await Promise.all([tx.objectStore('records').clear(), tx.objectStore('outbox').clear(), tx.objectStore('analyses').clear()]);
      await tx.done;
    },
    async close() { (await database).close(); },
  };
}

/** Deletes a whole local database (household left, or account cache no longer used). */
export async function deleteDatabase(name: string) {
  const { deleteDB } = await import('idb');
  await deleteDB(name);
}

/**
 * Brings records of another local database (guest data, or the unsent changes of the old common space) into an account
 * database. The target must already be synchronized once, so that its resetId is known and the import is not discarded.
 * Guest dishes whose normalized name matches a non-archived dish of the target are not imported: meals pointing to them
 * are rewritten to the target dish (new mutationId, same modifiedAt). Re-running it is idempotent.
 */
export async function importInto(target: Repository, source: RecordData[]): Promise<number> {
  const snapshot = await target.snapshot();
  const existing = new Map<string, string>();
  for (const dish of snapshot.records) {
    if (dish.type !== 'dish' || dish.archived) continue;
    const analysis = snapshot.analyses.find(item => item.dishId === dish.id);
    for (const name of [dish.name, dishDetails(dish, analysis).name]) {
      const key = normalizedName(name);
      if (key && !existing.has(key)) existing.set(key, dish.id);
    }
  }
  const replaced = new Map<string, string>();
  for (const dish of source) {
    if (dish.type !== 'dish' || dish.archived) continue;
    const match = [dish.name, dish.details?.name ?? ''].map(normalizedName).map(key => existing.get(key)).find(Boolean);
    if (match && match !== dish.id) replaced.set(dish.id, match);
  }
  const records = source.flatMap((record): RecordData[] => {
    if (record.type === 'settings' && record.modifiedAt === 0) return [];
    if (record.type === 'dish' && replaced.has(record.id)) return [];
    if (record.type === 'meal' && record.dishId && replaced.has(record.dishId)) {
      return [{ ...record, dishId: replaced.get(record.dishId)!, mutationId: newId() }];
    }
    return [record];
  });
  await target.importRecords(records);
  return records.length;
}
export type Repository = ReturnType<typeof createRepository>;
