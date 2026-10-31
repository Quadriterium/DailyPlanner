import { useSyncExternalStore } from 'react';
import {
  dishDetails, featureRequestListSchema, featureRequestSchema, generateMealResponseSchema, normalizedName, randomMealCandidates,
  seasonForDate, syncResponseSchema, type DishDetails, type FeatureRequest, type Meal, type Slot,
} from '../shared/model';
import { createRepository, type Draft, type Snapshot } from './repository';
import { newId } from './id';

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

export async function fillMeal(date: string, slot: Slot, start: string, mode: 'ai' | 'random', replacing?: Meal) {
  await refresh();
  const id = `${date}:${slot}`;
  const previous = state.records.find(record => record.type === 'meal' && record.id === id);
  if (replacing) {
    if (replacing.id !== id || previous?.mutationId !== replacing.mutationId) {
      throw new Error('Ce créneau a été modifié. Vérifiez le planning avant de remplacer le repas.');
    }
  } else if (previous?.type === 'meal' && previous.text.trim()) throw new Error('Ce créneau contient déjà un repas.');
  let generated: DishDetails | undefined;
  if (mode === 'ai') {
    await synchronize();
    const synced = state.records.find(record => record.type === 'meal' && record.id === id);
    if (synced?.mutationId !== previous?.mutationId) {
      throw new Error('Ce créneau a été modifié pendant la synchronisation. Vérifiez le planning avant de générer un repas.');
    }
    let response: Response;
    try {
      response = await fetch('/api/meals/generate', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ date }), cache: 'no-store', signal: AbortSignal.timeout(50_000),
      });
    } catch (error) {
      throw new Error('Génération impossible : serveur inaccessible ou délai dépassé. Le créneau reste inchangé.', { cause: error });
    }
    const body: unknown = await response.json();
    if (!response.ok) throw new Error(typeof body === 'object' && body !== null && 'error' in body && typeof body.error === 'string'
      ? body.error : `Génération refusée (HTTP ${response.status}).`);
    const result = generateMealResponseSchema.safeParse(body);
    if (!result.success) throw new Error('Proposition IA invalide. Le créneau reste inchangé.');
    generated = result.data.details;
    await refresh();
    const current = state.records.find(record => record.type === 'meal' && record.id === id);
    if (current?.mutationId !== previous?.mutationId) {
      throw new Error('Ce créneau a été modifié pendant la génération. Votre modification est conservée.');
    }
  }
  const dishes = state.records.filter(record => record.type === 'dish');
  const meals = state.records.filter(record => record.type === 'meal');
  const candidates = randomMealCandidates(dishes, state.analyses, meals, date, start);
  const selected = generated
    ? dishes.find(dish => !dish.archived && (
      normalizedName(dish.name) === normalizedName(generated.name) ||
      normalizedName(dishDetails(dish, state.analyses.find(analysis => analysis.dishId === dish.id)).name) === normalizedName(generated.name)))
    : candidates[Math.floor(Math.random() * candidates.length)];
  const details = generated ?? (selected ? dishDetails(selected, state.analyses.find(analysis => analysis.dishId === selected.id)) : undefined);
  if (!details) throw new Error('Aucun repas de saison dans le carnet. Ajoutez-en un ou utilisez la génération IA.');
  const drafts: Draft[] = [];
  const dishId = selected?.id ?? newId();
  if (!selected && generated) drafts.push({
    type: 'dish', id: dishId, name: generated.name, creationSeason: seasonForDate(date),
    analysisKey: newId(), details: generated, archived: false,
  });
  drafts.push({ type: 'meal', id, date, slot, text: details.name, dishId });
  await save(drafts);
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
        const resetId = await db().resetId();
        let response: Response;
        try {
          response = await fetch('/api/sync', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ mutations, resetId }), cache: 'no-store', signal: AbortSignal.timeout(8000),
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

async function featureRequestCall(init?: RequestInit): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch('/api/feature-requests', { ...init, cache: 'no-store', signal: AbortSignal.timeout(8000) });
  } catch (error) {
    throw new Error('Serveur inaccessible. Les demandes d’évolution nécessitent une connexion.', { cause: error });
  }
  const body: unknown = await response.json().catch(() => null);
  if (!response.ok) throw new Error(typeof body === 'object' && body !== null && 'error' in body && typeof body.error === 'string'
    ? body.error : `Demande refusée (HTTP ${response.status}).`);
  return body;
}

export async function loadFeatureRequests(): Promise<FeatureRequest[]> {
  const result = featureRequestListSchema.safeParse(await featureRequestCall());
  if (!result.success) throw new Error('Réponse serveur incompatible.');
  return result.data.requests;
}

export async function submitFeatureRequest(text: string): Promise<FeatureRequest> {
  const body = await featureRequestCall({
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text }),
  });
  const result = featureRequestSchema.safeParse(typeof body === 'object' && body !== null && 'request' in body ? body.request : null);
  if (!result.success) throw new Error('Réponse serveur incompatible.');
  return result.data;
}
