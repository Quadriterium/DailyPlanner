import { useSyncExternalStore } from 'react';
import { openDB, type DBSchema } from 'idb';
import { catalogEntrySchema, catalogResponseSchema, type CatalogEntry } from '../shared/model';

interface CatalogMeta { catalogId: string; cursor: number }
interface CatalogDatabase extends DBSchema {
  entries: { key: string; value: CatalogEntry };
  meta: { key: string; value: CatalogMeta };
}

/** Shared by every account and household of the device: the catalogue is common and read-only. */
export const catalogDatabase = 'a-table-catalog';

let entries: CatalogEntry[] = [];
const listeners = new Set<() => void>();
let database: ReturnType<typeof open> | undefined;
let loading: Promise<void> | undefined;
let inFlight: Promise<void> | undefined;

function open() {
  return openDB<CatalogDatabase>(catalogDatabase, 1, {
    upgrade(db) {
      db.createObjectStore('entries');
      db.createObjectStore('meta');
    },
  });
}

function db() {
  database ??= open();
  return database;
}

function publish(next: CatalogEntry[]) {
  entries = next.sort((a, b) => a.details.name.localeCompare(b.details.name, 'fr'));
  listeners.forEach(listener => listener());
}

function load() {
  if (typeof indexedDB === 'undefined') return Promise.resolve();
  loading ??= (async () => {
    const stored = await (await db()).getAll('entries');
    publish(stored.filter(entry => catalogEntrySchema.safeParse(entry).success));
  })().catch(() => { loading = undefined; });
  return loading;
}

/** Entries known by this device (possibly empty before the first download). */
export function catalogEntries(): CatalogEntry[] {
  return entries;
}

export function useCatalog(): CatalogEntry[] {
  void load();
  return useSyncExternalStore(listener => {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
  }, () => entries);
}

/** Downloads catalogue changes since the last known position. Failures keep the local copy unchanged. */
export function syncCatalog(): Promise<void> {
  if (typeof indexedDB === 'undefined') return Promise.resolve();
  inFlight ??= (async () => {
    await load();
    const target = await db();
    let meta = await target.get('meta', 'catalog');
    for (let page = 0; page < 100; page++) {
      const response = await fetch(`/api/catalog?after=${meta?.cursor ?? 0}`, { cache: 'no-store', signal: AbortSignal.timeout(15_000) });
      if (!response.ok) return;
      const result = catalogResponseSchema.safeParse(await response.json());
      if (!result.success) return;
      const { catalogId, cursor, more, entries: changed, removed } = result.data;
      const tx = target.transaction(['entries', 'meta'], 'readwrite');
      // A different identifier means a new server database: start again from scratch.
      if (meta && meta.catalogId !== catalogId) {
        await tx.objectStore('entries').clear();
        if (cursor > 0 || more) {
          await tx.objectStore('meta').put({ catalogId, cursor: 0 }, 'catalog');
          await tx.done;
          meta = { catalogId, cursor: 0 };
          continue;
        }
      }
      for (const entry of changed) await tx.objectStore('entries').put(entry, entry.id);
      for (const id of removed) await tx.objectStore('entries').delete(id);
      meta = { catalogId, cursor };
      await tx.objectStore('meta').put(meta, 'catalog');
      await tx.done;
      if (changed.length || removed.length || page === 0) publish(await target.getAll('entries'));
      if (!more) return;
    }
  })().catch(() => { /* Offline: the local copy remains usable. */ }).finally(() => { inFlight = undefined; });
  return inFlight;
}
