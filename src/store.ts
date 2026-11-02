import { useSyncExternalStore } from 'react';
import {
  addDays, apiErrorSchema, authSessionSchema, authStartResponseSchema, catalogCandidates, cookingLevelLabels, createdInvitationSchema, defaultCookingLevel,
  defaultOpenAiModel, dishDetails, featureRequestListSchema, featureRequestSchema, generateMealResponseSchema, invitationPreviewSchema,
  mealId, normalizedName, randomMealCandidates, recentMealNames, seasonForDate, spaceDetailsSchema, syncResponseSchema,
  type AuthSession, type CatalogEntry, type CookingLevel, type CreatedInvitation, type Dish, type DishDetails, type FeatureRequest, type Household,
  type InvitationPreview, type Meal, type SessionSpace, type SessionUser, type Slot, type SpaceDetails,
} from '../shared/model';
import {
  accountDatabase, commonDatabase, createRepository, deleteDatabase, guestDatabase, importInto,
  type Draft, type Repository, type Snapshot,
} from './repository';
import { newId } from './id';
import { catalogEntries, syncCatalog } from './catalog';

export type AuthMode = 'unknown' | 'disabled' | 'guest' | 'signed-in' | 'expired' | 'revoked';
export interface AuthState { mode: AuthMode; user: SessionUser | null; space: SessionSpace | null }
export type Connection = 'checking' | 'online' | 'offline' | 'error' | 'local' | 'expired' | 'revoked';

interface State extends Snapshot {
  loaded: boolean;
  syncing: boolean;
  connection: Connection;
  error: string | null;
  auth: AuthState;
  /** Last request to the server succeeded (sign-in button disabled otherwise). */
  reachable: boolean;
  /** Unsent changes of the old common notebook, offered once for import after sign-in. */
  legacyPending: number;
}
let state: State = {
  records: [], analyses: [], pending: 0, lastSync: null, capabilities: null,
  loaded: false, syncing: false, connection: 'checking', error: null,
  auth: { mode: 'unknown', user: null, space: null }, reachable: typeof navigator === 'undefined' || navigator.onLine, legacyPending: 0,
};
const listeners = new Set<() => void>();
let repository: Repository | undefined;
let currentName: string | undefined;
/** Incremented at each database switch: a response obtained for a previous database is ignored. */
let epoch = 0;
let switching: Promise<void> = Promise.resolve();
let initializing: Promise<void> | undefined;
let inFlight: Promise<void> | undefined;
let defaultModel = defaultOpenAiModel;
const saving = new Set<Promise<unknown>>();
const channel = typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel('a-table-changes') : null;
const memoKey = 'a-table-auth';
const invitationKey = 'a-table-invitation';
const legacyKey = 'a-table-legacy-import';
const signInRequired = 'Connectez-vous pour utiliser cette fonction.';

function publish(patch: Partial<State>) {
  state = { ...state, ...patch };
  listeners.forEach(listener => listener());
}

function db() {
  if (!repository) {
    currentName = guestDatabase;
    repository = createRepository(currentName);
  }
  return repository;
}

async function refresh() {
  const current = db();
  const snapshot = await current.snapshot();
  if (current === repository) publish(snapshot);
}

channel?.addEventListener('message', event => {
  if (typeof event.data === 'object' && event.data?.type === 'space-changed') {
    void followMemo().catch(error => publish({ error: `Changement de compte impossible : ${errorMessage(error)}` }));
    return;
  }
  void refresh().catch(error => publish({ error: `Lecture locale impossible : ${errorMessage(error)}` }));
});

export function usePlanner() {
  return useSyncExternalStore(listener => {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
  }, () => state);
}

// ---------- local memo of the last known session (not a proof of authentication) ----------

interface Memo {
  authEnabled: boolean;
  signedIn: boolean;
  userId?: string;
  spaceId?: string;
  name?: string;
  email?: string | null;
  spaceName?: string;
  defaultModel?: string;
}

function readMemo(): Memo | null {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(memoKey) ?? 'null');
    return typeof value === 'object' && value !== null && 'authEnabled' in value ? value as Memo : null;
  } catch { return null; }
}

function writeMemo(auth: AuthState) {
  if (auth.mode === 'unknown') return;
  const memo: Memo = {
    authEnabled: auth.mode !== 'disabled', signedIn: Boolean(auth.user && auth.space && auth.mode !== 'guest'), defaultModel,
    ...(auth.user && auth.space && auth.mode !== 'guest' ? {
      userId: auth.user.id, name: auth.user.name, email: auth.user.email, spaceId: auth.space.id, spaceName: auth.space.name,
    } : {}),
  };
  try { localStorage.setItem(memoKey, JSON.stringify(memo)); } catch { /* Private browsing: the session is re-read from the server. */ }
}

function authFromMemo(memo: Memo): AuthState {
  if (!memo.authEnabled) return { mode: 'disabled', user: null, space: null };
  if (memo.signedIn && memo.userId && memo.spaceId) return {
    mode: 'signed-in',
    user: { id: memo.userId, name: memo.name ?? '', email: memo.email ?? null, picture: null },
    space: { id: memo.spaceId, name: memo.spaceName ?? '', kind: 'household' },
  };
  return { mode: 'guest', user: null, space: null };
}

export function databaseName(auth: AuthState): string {
  if (auth.mode === 'disabled') return commonDatabase;
  if (auth.user && auth.space && auth.mode !== 'guest' && auth.mode !== 'unknown') return accountDatabase(auth.user.id, auth.space.id);
  return guestDatabase;
}

async function hasDatabase(name: string): Promise<boolean> {
  try { return Boolean((await indexedDB.databases?.())?.some(database => database.name === name)); }
  catch { return false; }
}

// ---------- database switching ----------

function switchSpace(name: string): Promise<void> {
  const next = switching.then(async () => {
    if (name === currentName && repository) return;
    await inFlight?.catch(() => { /* A failed synchronization does not block the switch. */ });
    epoch += 1;
    const previous = repository;
    repository = createRepository(name);
    currentName = name;
    await previous?.close().catch(() => { /* Already closed. */ });
    await repository.ensureSettings(defaultModel);
    await refresh();
  });
  switching = next.catch(() => { /* The caller reports the error; later switches stay possible. */ });
  return next;
}

function connectionFor(mode: AuthMode): Connection {
  if (mode === 'guest' || mode === 'unknown') return 'local';
  if (mode === 'expired' || mode === 'revoked') return mode;
  return ['online', 'offline', 'error'].includes(state.connection) ? state.connection : 'checking';
}

async function enter(auth: AuthState, broadcast = true) {
  const name = databaseName(auth);
  const changed = name !== currentName;
  writeMemo(auth);
  await switchSpace(name);
  publish({ auth, connection: connectionFor(auth.mode), ...(changed ? { error: null } : {}) });
  if (changed && broadcast) channel?.postMessage({ type: 'space-changed' });
  if (auth.mode === 'signed-in') void checkLegacy();
}

/** Another tab changed account or household: follow it. */
async function followMemo() {
  const memo = readMemo();
  if (!memo) return;
  defaultModel = memo.defaultModel ?? defaultModel;
  const auth = authFromMemo(memo);
  if (databaseName(auth) !== currentName) await enter(auth, false);
}

/** A session that moved the current user to another household without this tab asking for it. */
let pendingSession: AuthSession | undefined;

async function applySession(session: AuthSession, allowSpaceChange = false) {
  defaultModel = session.defaultModel;
  if (!session.authEnabled) return enter({ mode: 'disabled', user: null, space: null });
  const current = state.auth;
  const known = current.mode === 'signed-in' || current.mode === 'expired' || current.mode === 'revoked';
  if (session.user && session.space) {
    const movedAway = known && current.user?.id === session.user.id && current.space?.id !== session.space.id;
    if (movedAway && !allowSpaceChange && readMemo()?.spaceId !== session.space.id) {
      pendingSession = session;
      publish({ auth: { ...current, mode: 'revoked' }, connection: 'revoked' });
      return;
    }
    return enter({ mode: 'signed-in', user: session.user, space: session.space });
  }
  if (known && current.user && current.space) {
    // The cache stays readable; unsent changes wait for a new sign-in with the same account.
    publish({ auth: { ...current, mode: current.mode === 'revoked' ? 'revoked' : 'expired' }, connection: current.mode === 'revoked' ? 'revoked' : 'expired' });
    return;
  }
  return enter({ mode: 'guest', user: null, space: null });
}

/** Reads the session on the server and switches database when needed. Returns null when the server is unreachable. */
export async function checkSession(allowSpaceChange = false, timeout = 8000): Promise<AuthSession | null> {
  let body: unknown;
  try {
    const response = await fetch('/api/auth/session', { cache: 'no-store', signal: AbortSignal.timeout(timeout) });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    body = await response.json();
  } catch {
    if (state.reachable) publish({ reachable: false });
    return null;
  }
  const parsed = authSessionSchema.safeParse(body);
  if (!parsed.success) return null;
  if (!state.reachable) publish({ reachable: true });
  await applySession(parsed.data, allowSpaceChange);
  return parsed.data;
}

export function initialize() {
  if (!initializing) initializing = (async () => {
    void syncCatalog();
    const memo = readMemo();
    let auth = memo ? authFromMemo(memo) : null;
    defaultModel = memo?.defaultModel ?? defaultModel;
    // Devices used before authentication existed keep opening their common notebook until the server answers.
    if (!auth && await hasDatabase(commonDatabase)) auth = { mode: 'disabled', user: null, space: null };
    if (auth) {
      await switchSpace(databaseName(auth));
      publish({ auth, connection: connectionFor(auth.mode), loaded: true });
      await checkSession();
      return;
    }
    if (!await checkSession(false, 4000)) {
      await switchSpace(guestDatabase);
      publish({ auth: { mode: 'unknown', user: null, space: null }, connection: 'local' });
    }
    publish({ loaded: true });
  })().catch(error => {
    publish({ error: `Le stockage local est indisponible : ${errorMessage(error)}` });
    initializing = undefined;
    throw error;
  });
  return initializing;
}

export async function save(drafts: Draft[]) {
  const pending = (async () => {
    try {
      await switching;
      await db().save(drafts);
      await refresh();
      channel?.postMessage('changed');
    } catch (error) {
      const message = `Enregistrement local impossible. Le repas n’a pas été sauvegardé : ${errorMessage(error)}`;
      publish({ error: message });
      throw new Error(message, { cause: error });
    }
  })();
  saving.add(pending);
  try { await pending; } finally { saving.delete(pending); }
  synchronizeInBackground();
}

/** True when server features (AI, recipe import, feature requests) may be used. */
export function serverFeaturesAvailable(auth: AuthState = state.auth): boolean {
  return auth.mode === 'signed-in' || auth.mode === 'disabled';
}

export function currentAuth(): AuthState {
  return state.auth;
}

export function useServerFeatures(): boolean {
  return serverFeaturesAvailable(usePlanner().auth);
}

export const signInHint = 'Connectez-vous pour utiliser cette fonction';

function requireServerFeatures() {
  if (!serverFeaturesAvailable()) throw new Error(signInRequired);
}

/** Niveau de cuisine des paramètres, utilisé quand aucun niveau n'est choisi par appui long. */
export function preferredCookingLevel(records: State['records']): CookingLevel {
  const settings = records.find(record => record.type === 'settings');
  return settings?.cookingLevel ?? defaultCookingLevel;
}

/** Shared recipes eligible for a random draw: not already in the household notebook, nor chosen around this date. */
export function sharedRandomCandidates(
  date: string, level?: CookingLevel, records = state.records, analyses = state.analyses, entries = catalogEntries(),
): CatalogEntry[] {
  const known = records.filter(record => record.type === 'dish').flatMap(dish =>
    [dish.name, dishDetails(dish, analyses.find(analysis => analysis.dishId === dish.id)).name]);
  const settings = records.find(record => record.type === 'settings');
  return catalogCandidates(entries, {
    date, level, avoid: settings?.avoid ?? '', excludedNames: [...known, ...recentMealNames(records, analyses, date)],
  });
}

export async function fillMeal(
  date: string, slot: Slot, start: string, mode: 'ai' | 'random', replacing?: Meal, index?: 1, level?: CookingLevel,
) {
  if (mode === 'ai') requireServerFeatures();
  await refresh();
  index = replacing?.index ?? index;
  const id = mealId(date, slot, index);
  const previous = state.records.find(record => record.type === 'meal' && record.id === id);
  if (replacing) {
    if (replacing.id !== id || previous?.mutationId !== replacing.mutationId) {
      throw new Error('Ce créneau a été modifié. Vérifiez le planning avant de remplacer le repas.');
    }
  } else if (previous?.type === 'meal' && previous.text.trim()) throw new Error('Ce créneau contient déjà un repas.');
  let generated: DishDetails | undefined;
  let generatedSource: string | undefined;
  if (mode === 'ai') {
    await synchronize();
    requireServerFeatures();
    const synced = state.records.find(record => record.type === 'meal' && record.id === id);
    if (synced?.mutationId !== previous?.mutationId) {
      throw new Error('Ce créneau a été modifié pendant la synchronisation. Vérifiez le planning avant de générer un repas.');
    }
    const startEpoch = epoch;
    let response: Response;
    try {
      response = await fetch('/api/meals/generate', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ date, level: level ?? preferredCookingLevel(state.records) }),
        cache: 'no-store', signal: AbortSignal.timeout(50_000),
      });
    } catch (error) {
      throw new Error('Génération impossible : serveur inaccessible ou délai dépassé. Le créneau reste inchangé.', { cause: error });
    }
    const body: unknown = await response.json().catch(() => null);
    if (!response.ok) {
      noteAuthFailure(response, body);
      throw new Error(apiError(body, `Génération refusée (HTTP ${response.status}).`));
    }
    if (startEpoch !== epoch) throw new Error('Le compte ou le foyer a changé pendant la génération. Le créneau reste inchangé.');
    const result = generateMealResponseSchema.safeParse(body);
    if (!result.success) throw new Error('Proposition IA invalide. Le créneau reste inchangé.');
    generated = result.data.details;
    generatedSource = result.data.sourceUrl;
    await refresh();
    const current = state.records.find(record => record.type === 'meal' && record.id === id);
    if (current?.mutationId !== previous?.mutationId) {
      throw new Error('Ce créneau a été modifié pendant la génération. Votre modification est conservée.');
    }
  }
  const dishes = state.records.filter(record => record.type === 'dish');
  const meals = state.records.filter(record => record.type === 'meal');
  const randomLevel = level ?? preferredCookingLevel(state.records);
  let selected: Dish | undefined;
  let copied: { details: DishDetails; sourceUrl?: string } | undefined;
  if (generated) {
    selected = dishes.find(dish => !dish.archived && (
      normalizedName(dish.name) === normalizedName(generated.name) ||
      normalizedName(dishDetails(dish, state.analyses.find(analysis => analysis.dishId === dish.id)).name) === normalizedName(generated.name)));
    if (!selected) copied = { details: generated, ...(generatedSource ? { sourceUrl: generatedSource } : {}) };
  } else {
    const candidates = randomMealCandidates(dishes, state.analyses, meals, date, start, randomLevel);
    const week = meals.filter(meal => meal.date >= start && meal.date <= addDays(start, 6) && meal.text.trim());
    const unused = candidates.filter(dish => !week.some(meal => meal.dishId === dish.id));
    const shared = sharedRandomCandidates(date, randomLevel);
    // Uniform draw over unused household dishes and suitable shared ones; household repeats only as a last resort.
    const pool: (Dish | CatalogEntry)[] = unused.length || shared.length ? [...unused, ...shared] : candidates;
    const choice = pool[Math.floor(Math.random() * pool.length)];
    if (choice && 'type' in choice) selected = choice;
    else if (choice) copied = { details: choice.details, ...(choice.sourceUrl ? { sourceUrl: choice.sourceUrl } : {}) };
  }
  const details = copied?.details ?? (selected ? dishDetails(selected, state.analyses.find(analysis => analysis.dishId === selected!.id)) : undefined);
  if (!details) throw new Error(randomMealCandidates(dishes, state.analyses, meals, date, start).length
    ? `Aucun repas de saison de niveau « ${cookingLevelLabels[randomLevel]} » dans le carnet ni le catalogue. Appuyez longuement sur le bouton pour choisir un autre niveau${serverFeaturesAvailable() ? ', ou utilisez la génération IA' : ''}.`
    : `Aucun repas de saison dans le carnet ni le catalogue. Ajoutez-en un${serverFeaturesAvailable() ? ' ou utilisez la génération IA' : ''}.`);
  const drafts: Draft[] = [];
  const dishId = selected?.id ?? newId();
  if (copied) drafts.push({
    type: 'dish', id: dishId, name: copied.details.name, creationSeason: seasonForDate(date),
    analysisKey: newId(), details: copied.details, archived: false, ...(copied.sourceUrl ? { sourceUrl: copied.sourceUrl } : {}),
  });
  drafts.push({ type: 'meal', id, date, slot, ...(index === 1 ? { index } : {}),
    text: details.name, dishId, household: replacing?.household ?? null });
  await save(drafts);
}

export async function saveMealHousehold(meal: Meal, household: Household | null) {
  await refresh();
  const current = state.records.find(record => record.type === 'meal' && record.id === meal.id);
  if (current?.mutationId !== meal.mutationId || !meal.text.trim()) {
    throw new Error('Ce créneau a été modifié. Fermez puis rouvrez le repas avant de changer les convives.');
  }
  await save([{ ...meal, household }]);
}

export function synchronizeInBackground() {
  void synchronize().catch(() => { /* The persistent connection banner reports this failure. */ });
}

export async function synchronize(): Promise<void> {
  await initialize();
  void syncCatalog();
  const mode = state.auth.mode;
  if (mode === 'revoked') return;
  // Guests and expired sessions only look for a session opened meanwhile (sign-in in another tab); never /api/sync.
  if (mode === 'guest' || mode === 'unknown' || mode === 'expired') {
    await checkSession();
    if (state.auth.mode !== 'signed-in' && state.auth.mode !== 'disabled') return;
  }
  return sendOutbox();
}

function sendOutbox(): Promise<void> {
  if (inFlight) return inFlight;
  let recheck = false;
  inFlight = (async () => {
    publish({ syncing: true });
    const startEpoch = epoch;
    const target = db();
    try {
      do {
        const mutations = await target.pending();
        const resetId = await target.resetId();
        let response: Response;
        try {
          response = await fetch('/api/sync', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ mutations, resetId }), cache: 'no-store', signal: AbortSignal.timeout(8000),
          });
        } catch (error) {
          publish({ connection: 'offline', reachable: false });
          throw new Error('Serveur inaccessible. Vos modifications restent enregistrées sur cet appareil.', { cause: error });
        }
        if (startEpoch !== epoch) return;
        if (!state.reachable) publish({ reachable: true });
        if (!response.ok) {
          const body: unknown = await response.json().catch(() => null);
          if (noteAuthFailure(response, body)) {
            // AUTH_ENABLED switched on while this device was on the common notebook: read the session again.
            recheck = state.auth.mode === 'disabled';
            return;
          }
          publish({ connection: 'error' });
          throw new Error(apiError(body, `Synchronisation refusée (HTTP ${response.status}).`));
        }
        const result = syncResponseSchema.safeParse(await response.json());
        if (!result.success) {
          publish({ connection: 'error' });
          throw new Error('Réponse serveur incompatible. Vos modifications locales sont conservées.');
        }
        if (startEpoch !== epoch) return;
        await target.merge(result.data);
        await refresh();
        channel?.postMessage('changed');
      } while (state.pending > 0 && startEpoch === epoch);
      if (startEpoch === epoch) publish({ connection: 'online', error: null });
    } catch (error) {
      publish({ error: errorMessage(error) });
      throw error;
    } finally {
      publish({ syncing: false });
    }
  })().finally(() => {
    inFlight = undefined;
    if (recheck) void checkSession().catch(() => { /* Retried at the next synchronization. */ });
  });
  return inFlight;
}

/** 401 → session expired, 403 membership_revoked → household left. Returns true when the response was an access refusal. */
function noteAuthFailure(response: Response, body: unknown): boolean {
  const code = apiErrorSchema.safeParse(body).data?.code;
  const { auth } = state;
  if (response.status === 401 && code === 'auth_required') {
    if (auth.mode === 'signed-in' && auth.user && auth.space) publish({ auth: { ...auth, mode: 'expired' }, connection: 'expired' });
    return true;
  }
  if (response.status === 403 && code === 'membership_revoked') {
    if (auth.user && auth.space) publish({ auth: { ...auth, mode: 'revoked' }, connection: 'revoked' });
    return true;
  }
  return false;
}

function apiError(body: unknown, fallback: string): string {
  return apiErrorSchema.safeParse(body).data?.error ?? fallback;
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Une erreur inattendue est survenue.';
}

/** JSON call to the server; the error carries the French message of the server, and `status`/`code` for the caller. */
class ApiError extends Error {
  constructor(message: string, readonly status: number, readonly code?: string) { super(message); }
}

async function call(path: string, method = 'GET', payload?: unknown, offline = 'Serveur inaccessible. Réessayez une fois connecté.'): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(path, {
      method, cache: 'no-store', signal: AbortSignal.timeout(8000),
      ...(payload === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) }),
    });
  } catch (error) {
    if (state.reachable) publish({ reachable: false });
    throw new Error(offline, { cause: error });
  }
  if (!state.reachable) publish({ reachable: true });
  const body: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    noteAuthFailure(response, body);
    throw new ApiError(apiError(body, `Demande refusée (HTTP ${response.status}).`), response.status, apiErrorSchema.safeParse(body).data?.code);
  }
  return body;
}

function parsed<T>(schema: { safeParse(value: unknown): { success: true; data: T } | { success: false } }, body: unknown): T {
  const result = schema.safeParse(body);
  if (!result.success) throw new Error('Réponse serveur incompatible.');
  return result.data;
}

async function featureRequestCall(payload?: unknown): Promise<unknown> {
  requireServerFeatures();
  return call('/api/feature-requests', payload === undefined ? 'GET' : 'POST', payload,
    'Serveur inaccessible. Les demandes d’évolution nécessitent une connexion.');
}

export async function loadFeatureRequests(): Promise<FeatureRequest[]> {
  return parsed(featureRequestListSchema, await featureRequestCall()).requests;
}

export async function submitFeatureRequest(text: string): Promise<FeatureRequest> {
  const body = await featureRequestCall({ text });
  return parsed(featureRequestSchema, typeof body === 'object' && body !== null && 'request' in body ? body.request : null);
}

// ---------- sign-in, sign-out, invitations ----------

/** Waits for local saves, then leaves for Google. The invitation, if any, is consumed on return. */
export async function signIn(invitation = pendingInvitation() ?? undefined) {
  await Promise.allSettled([...saving]);
  const body = await call('/api/auth/google/start', 'POST', invitation ? { invitation } : {},
    'Serveur inaccessible. La connexion nécessite le réseau.');
  window.location.assign(parsed(authStartResponseSchema, body).url);
}

export type AuthReturn = { status: 'ok'; joined: boolean } | { status: 'error'; reason: string };

/** Reads and removes ?auth=… left by the OAuth callback. */
export function takeAuthReturn(): AuthReturn | null {
  const url = new URL(window.location.href);
  const status = url.searchParams.get('auth');
  if (!status) return null;
  const result: AuthReturn = status === 'ok'
    ? { status: 'ok', joined: url.searchParams.get('joined') === '1' }
    : { status: 'error', reason: url.searchParams.get('reason') ?? 'invalid' };
  for (const key of ['auth', 'reason', 'joined']) url.searchParams.delete(key);
  history.replaceState(history.state, '', `${url.pathname}${url.search}${url.hash}`);
  return result;
}

/** Reads #invitation=… , keeps it for the duration of the tab and removes it from the address bar. */
export function takeInvitationFragment(): string | null {
  const match = /^#invitation=([A-Za-z0-9_-]{43})$/.exec(window.location.hash);
  if (!match) return null;
  try { sessionStorage.setItem(invitationKey, match[1]); } catch { /* Kept in memory only by the caller. */ }
  history.replaceState(history.state, '', `${window.location.pathname}${window.location.search}`);
  return match[1];
}

export function pendingInvitation(): string | null {
  try { return sessionStorage.getItem(invitationKey); } catch { return null; }
}

export function forgetInvitation() {
  try { sessionStorage.removeItem(invitationKey); } catch { /* Nothing to forget. */ }
}

export async function previewInvitation(token: string): Promise<InvitationPreview | null> {
  try { return parsed(invitationPreviewSchema, await call('/api/invitations/preview', 'POST', { token })); }
  catch (error) {
    if (error instanceof ApiError && error.status === 404) return null;
    throw error;
  }
}

export type AcceptResult = 'joined' | 'confirmation_required' | 'invalid';

/** Joins the household of an invitation. With leaveCurrent, the cache of the household left is deleted from this device. */
export async function acceptInvitation(token: string, leaveCurrent: boolean): Promise<AcceptResult> {
  let body: unknown;
  try { body = await call('/api/invitations/accept', 'POST', { token, leaveCurrent }); }
  catch (error) {
    if (error instanceof ApiError && error.code === 'confirmation_required') return 'confirmation_required';
    if (error instanceof ApiError && error.status === 404) { forgetInvitation(); return 'invalid'; }
    throw error;
  }
  forgetInvitation();
  const previous = currentName;
  await applySession(parsed(authSessionSchema, body), true);
  if (previous && previous !== currentName && previous.startsWith('a-table-u-')) await deleteDatabase(previous).catch(() => { /* Deleted later. */ });
  await importGuestData();
  return 'joined';
}

/**
 * Copies the guest notebook of this device into the account (section 9.3): pull first to learn the resetId, then copy,
 * then empty the guest database, then send. Each step can be resumed; nothing is imported when offline.
 */
export async function importGuestData(): Promise<number> {
  if (state.auth.mode !== 'signed-in') return 0;
  const guest = createRepository(guestDatabase);
  try {
    const records = await guest.userRecords();
    if (!records.length) return 0;
    await sendOutbox();
    if (state.auth.mode !== 'signed-in') return 0;
    const target = db();
    const imported = await importInto(target, records);
    await guest.markImportedAndClear(currentName!);
    await refresh();
    synchronizeInBackground();
    return imported;
  } finally { await guest.close(); }
}

export interface SignInResult { invitation?: AcceptResult; imported: number }

/**
 * After ?auth=ok: joins the invited household when one is pending, then imports the guest notebook. When joining needs a
 * confirmation, the guest notebook waits for the decision so that it lands in the household finally chosen.
 */
export async function finishSignIn(joined: boolean): Promise<SignInResult> {
  await initialize();
  if (state.auth.mode !== 'signed-in') await checkSession(true);
  if (state.auth.mode !== 'signed-in') throw new Error('La connexion n’a pas pu être vérifiée. Vos repas restent sur cet appareil ; réessayez.');
  const token = pendingInvitation();
  if (token && joined) forgetInvitation();
  if (token && !joined) {
    const invitation = await acceptInvitation(token, false);
    if (invitation === 'joined') return { invitation, imported: 0 };
    if (invitation === 'confirmation_required') return { invitation, imported: 0 };
    return { invitation, imported: await importGuestData() };
  }
  return { imported: await importGuestData() };
}

/** Number of unsent changes of the guest notebook still to import (interrupted import, resumed at start-up). */
export async function guestRecordsToImport(): Promise<number> {
  if (state.auth.mode !== 'signed-in') return 0;
  const guest = createRepository(guestDatabase);
  try { return (await guest.userRecords()).length; } finally { await guest.close(); }
}

async function checkLegacy() {
  let handled = false;
  try { handled = localStorage.getItem(legacyKey) !== null; } catch { handled = true; }
  if (handled || !await hasDatabase(commonDatabase)) return;
  const legacy = createRepository(commonDatabase);
  try { publish({ legacyPending: (await legacy.outbox()).length }); }
  finally { await legacy.close(); }
}

/** Imports (or ignores, forever on this device) the unsent changes of the old common notebook. */
export async function resolveLegacy(importChanges: boolean): Promise<number> {
  if (!state.legacyPending) return 0;
  let imported = 0;
  if (importChanges) {
    if (state.auth.mode !== 'signed-in') throw new Error(signInRequired);
    const legacy = createRepository(commonDatabase);
    try {
      const records = await legacy.outbox();
      await sendOutbox();
      imported = await importInto(db(), records);
    } finally { await legacy.close(); }
    await refresh();
    synchronizeInBackground();
  }
  try { localStorage.setItem(legacyKey, importChanges ? 'imported' : 'ignored'); } catch { /* Offered again next time. */ }
  publish({ legacyPending: 0 });
  return imported;
}

/** Signs out after a last synchronization attempt. Returns the number of changes left waiting for this account. */
export async function signOut(): Promise<number> {
  await Promise.allSettled([...saving]);
  if (state.auth.mode === 'signed-in') await sendOutbox().catch(() => { /* Reported by the returned count. */ });
  const waiting = state.pending;
  await call('/api/auth/logout', 'POST', undefined, 'Serveur inaccessible. La déconnexion nécessite le réseau.');
  await enter({ mode: 'guest', user: null, space: null });
  return waiting;
}

/** After a removal (or a household change made elsewhere): forget the old cache and open the current household. */
export async function acknowledgeRevoked() {
  const previous = currentName;
  const session = pendingSession ?? await checkSession(true);
  pendingSession = undefined;
  if (!session) throw new Error('Serveur inaccessible. Réessayez une fois connecté.');
  await applySession(session, true);
  if (previous && previous !== currentName) await deleteDatabase(previous).catch(() => { /* Deleted later. */ });
}

export async function loadSpace(): Promise<SpaceDetails> {
  return parsed(spaceDetailsSchema, await call('/api/space'));
}

export async function renameSpace(name: string): Promise<SpaceDetails> {
  const details = parsed(spaceDetailsSchema, await call('/api/space', 'PATCH', { name }));
  const { auth } = state;
  if (auth.space && auth.mode === 'signed-in') {
    const next = { ...auth, space: { ...auth.space, name: details.name } };
    writeMemo(next);
    publish({ auth: next });
  }
  return details;
}

export async function createInvitation(): Promise<CreatedInvitation> {
  return parsed(createdInvitationSchema, await call('/api/space/invitations', 'POST', {}));
}

export async function revokeInvitation(id: string): Promise<SpaceDetails> {
  return parsed(spaceDetailsSchema, await call('/api/space/invitations/revoke', 'POST', { id }));
}

export async function removeMember(userId: string): Promise<SpaceDetails> {
  return parsed(spaceDetailsSchema, await call('/api/space/members/remove', 'POST', { userId }));
}

/** Leaves the household: its unsent changes are lost, the user gets a new empty household. */
export async function leaveSpace() {
  await call('/api/space/leave', 'POST', {});
  const previous = currentName;
  const session = await checkSession(true);
  if (!session) throw new Error('Foyer quitté, mais le serveur ne répond plus. Rouvrez l’application une fois connecté.');
  if (previous && previous !== currentName) await deleteDatabase(previous).catch(() => { /* Deleted later. */ });
}

/** For tests: forgets the module state between two scenarios. */
export async function resetStoreForTests() {
  await inFlight?.catch(() => undefined);
  await repository?.close();
  repository = undefined;
  currentName = undefined;
  initializing = undefined;
  pendingSession = undefined;
  epoch += 1;
  state = { ...state, records: [], analyses: [], pending: 0, lastSync: null, capabilities: null, loaded: false, syncing: false,
    connection: 'checking', error: null, auth: { mode: 'unknown', user: null, space: null }, reachable: true, legacyPending: 0 };
}
