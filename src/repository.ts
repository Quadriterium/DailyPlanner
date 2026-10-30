import { openDB, type DBSchema } from 'idb';
import { newId } from './id';
import {
  compareVersions, recordKey, recordSchema,
  type Analysis, type Capabilities, type RecordData, type SyncResponse,
} from '../shared/model';

type DraftOf<T> = T extends RecordData ? Omit<T, 'modifiedAt' | 'mutationId'> : never;
export type Draft = DraftOf<RecordData>;
interface Metadata { lastSync: number | null; capabilities: Capabilities | null }
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

export function createRepository(name = 'a-table-v1') {
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
    async merge(response: SyncResponse) {
      const db = await database;
      const tx = db.transaction(['records', 'outbox', 'analyses', 'meta'], 'readwrite');
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
      await tx.objectStore('meta').put({ lastSync: Date.now(), capabilities: response.capabilities }, 'sync');
      await tx.done;
    },
    async close() { (await database).close(); },
  };
}
export type Repository = ReturnType<typeof createRepository>;
