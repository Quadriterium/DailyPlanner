import { useSyncExternalStore } from 'react';
import { syncResponseSchema } from '../shared/model';
import { createRepository, type Draft, type Snapshot } from './repository';

interface State extends Snapshot {
  loaded: boolean;
  syncing: boolean;
  connection: 'checking' | 'online' | 'offline' | 'error';
  error: string | null;
}
let state: State = {
  records: [], analyses: [], pending: 0, lastSync: null, capabilities: null,
  loaded: false, syncing: false, connection: 'checking', error: null,
};
const listeners = new Set<() => void>();
let repository: ReturnType<typeof createRepository> | undefined;
let initializing: Promise<void> | undefined;
let inFlight: Promise<void> | undefined;
const channel = typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel('a-table-changes') : null;

function publish(patch: Partial<State>) {
  state = { ...state, ...patch };
  listeners.forEach(listener => listener());
}

function db() {
  if (!repository) repository = createRepository();
  return repository;
}

async function refresh() { publish(await db().snapshot()); }

channel?.addEventListener('message', () => {
  void refresh().catch(error => publish({ error: `Lecture locale impossible : ${errorMessage(error)}` }));
});

export function usePlanner() {
  return useSyncExternalStore(listener => {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
  }, () => state);
}

export function initialize() {
  if (!initializing) initializing = refresh().then(() => {
    publish({ loaded: true });
  }).catch(error => {
    publish({ error: `Le stockage local est indisponible : ${errorMessage(error)}` });
    initializing = undefined;
    throw error;
  });
  return initializing;
}

export async function save(drafts: Draft[]) {
  try {
    await db().save(drafts);
    await refresh();
    channel?.postMessage('changed');
  } catch (error) {
    const message = `Enregistrement local impossible. Le repas n’a pas été sauvegardé : ${errorMessage(error)}`;
    publish({ error: message });
    throw new Error(message, { cause: error });
  }
  synchronizeInBackground();
}

export function synchronizeInBackground() {
  void synchronize().catch(() => { /* The persistent connection banner reports this failure. */ });
}

export function synchronize(): Promise<void> {
  if (inFlight) return inFlight;
  inFlight = (async () => {
    publish({ syncing: true });
    try {
      await initialize();
      do {
        const mutations = await db().pending();
        let response: Response;
        try {
          response = await fetch('/api/sync', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ mutations }), cache: 'no-store', signal: AbortSignal.timeout(8000),
          });
        } catch (error) {
          publish({ connection: 'offline' });
          throw new Error('Serveur inaccessible. Vos modifications restent enregistrées sur cet appareil.', { cause: error });
        }
        if (!response.ok) {
          publish({ connection: 'error' });
          const body: unknown = await response.json();
          throw new Error(typeof body === 'object' && body !== null && 'error' in body && typeof body.error === 'string'
            ? body.error : `Synchronisation refusée (HTTP ${response.status}).`);
        }
        const result = syncResponseSchema.safeParse(await response.json());
        if (!result.success) {
          publish({ connection: 'error' });
          throw new Error('Réponse serveur incompatible. Vos modifications locales sont conservées.');
        }
        await db().merge(result.data);
        await refresh();
        channel?.postMessage('changed');
      } while (state.pending > 0);
      publish({ connection: 'online', error: null });
    } catch (error) {
      publish({ error: errorMessage(error) });
      throw error;
    } finally {
      publish({ syncing: false });
    }
  })().finally(() => { inFlight = undefined; });
  return inFlight;
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Une erreur inattendue est survenue.';
}
