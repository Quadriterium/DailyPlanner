import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { Activity, ArrowUpRight, BookOpen, DatabaseBackup, History, House, LayoutDashboard, LogOut, MessageSquare, RefreshCw, Scale, ShieldCheck, Sparkles, Users } from 'lucide-react';
import { z } from 'zod';
import {
  adminAiSchema, adminAnalysesSchema, adminAuditSchema, adminCatalogSchema, adminLegalSchema, adminOverviewSchema, adminRequestsSchema,
  adminSessionSchema, adminSpacesSchema, adminUsersSchema, globalAiPolicySchema, legalFieldLabels, legalFieldMax, legalInfoSchema, spaceAiPolicySchema,
  type AdminAnalysisEntry, type AdminCatalogEntry, type AdminSession, type GlobalAiPolicy, type LegalInfo, type SpaceAiPolicy,
} from '../shared/admin';
import {
  authStartResponseSchema, cookingLevelLabels, cookingLevels, detailsSchema, dishDetails, featureRequestStatusLabels,
  featureRequestStatuses, recipeUrlSchema, seasonLabels, seasons,
  type Capabilities, type CookingLevel, type FeatureRequest, type Ingredient, type Season,
} from '../shared/model';
import { formatIngredient } from '../shared/recipe';
import { sendMessageSchema, sentMessageSchema } from '../shared/messages';
import { pushTestSchema } from '../shared/push';
import { Modal } from './components';
import './admin.css';

const okSchema = z.object({ ok: z.literal(true) }).strict();
type Api = <T>(path: string, schema: z.ZodType<T>, options?: { method: 'POST' | 'PATCH'; body: object }) => Promise<T>;
type Confirmation = { title: string; text: string; run: () => Promise<string> };
type ConfirmAction = (confirmation: Confirmation) => void;
const date = (time: number) => new Intl.DateTimeFormat('fr-FR', { dateStyle: 'short', timeStyle: 'short', timeZone: 'Europe/Paris' }).format(time);
const number = (value: number) => value.toLocaleString('fr-FR');
const message = (error: unknown) => error instanceof Error ? error.message : 'Erreur inattendue lors de l’administration.';
const query = (offset: number, search: string) => `?${new URLSearchParams({ offset: String(offset), search })}`;
const analysisLabels = { all: 'Toutes', error: 'En erreur', pending: 'En attente', processing: 'En cours', ready: 'Terminées' } as const;
type AnalysisFilter = keyof typeof analysisLabels;
const navigationGroups = [
  { title: 'Pilotage', items: [
    { id: 'overview', label: 'Tableau de bord', icon: LayoutDashboard, hint: 'Les indicateurs essentiels et les actions à suivre.' },
    { id: 'analyses', label: 'Analyses', icon: Activity, hint: 'Suivre les traitements IA, comprendre les erreurs et relancer une fiche.' },
    { id: 'ai', label: 'Budget IA', icon: Sparkles, hint: 'Consommation OpenAI, plafonds globaux et suspension des appels.' },
  ] },
  { title: 'Communauté', items: [
    { id: 'users', label: 'Utilisateurs', icon: Users, hint: 'Comptes, messages et gestion des sessions.' },
    { id: 'spaces', label: 'Foyers et quotas', icon: House, hint: 'Espaces partagés et limites propres à chaque foyer.' },
    { id: 'requests', label: 'Demandes', icon: MessageSquare, hint: 'Les idées des utilisateurs et vos réponses.' },
  ] },
  { title: 'Contenu et serveur', items: [
    { id: 'catalog', label: 'Catalogue commun', icon: BookOpen, hint: 'Corriger, retirer ou restaurer les recettes partagées.' },
    { id: 'legal', label: 'Mentions légales', icon: Scale, hint: 'Les informations publiées sur les pages légales.' },
    { id: 'backup', label: 'Sauvegardes', icon: DatabaseBackup, hint: 'Créer un instantané de la base sur le serveur.' },
    { id: 'audit', label: 'Journal', icon: History, hint: 'La traçabilité des interventions administrateur.' },
  ] },
] as const;
type AdminPage = (typeof navigationGroups)[number]['items'][number]['id'];
type Navigate = (page: AdminPage, filter?: AnalysisFilter) => void;

async function request<T>(path: string, schema: z.ZodType<T>, csrfToken: string | null, options?: { method: 'POST' | 'PATCH'; body: object }) {
  const response = await fetch(`/api${path}`, {
    method: options?.method ?? 'GET', credentials: 'same-origin', cache: 'no-store', signal: AbortSignal.timeout(60_000),
    headers: options ? { 'Content-Type': 'application/json', ...(csrfToken ? { 'X-Admin-CSRF': csrfToken } : {}) } : {},
    ...(options ? { body: JSON.stringify(options.body) } : {}),
  });
  const body: unknown = await response.json();
  if (!response.ok) {
    const parsed = z.object({ error: z.string(), code: z.string().optional() }).safeParse(body);
    throw new AdminError(parsed.success ? parsed.data.error : `Appel admin refusé (${response.status}).`,
      parsed.success ? parsed.data.code : undefined);
  }
  const parsed = schema.safeParse(body);
  if (!parsed.success) throw new Error('Réponse admin invalide. Rechargez la page ; si le problème persiste, vérifiez le journal serveur.');
  return parsed.data;
}
class AdminError extends Error {
  constructor(text: string, readonly code?: string) { super(text); }
}

function useData<T>(api: Api, path: string, schema: z.ZodType<T>) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    let active = true;
    setData(null);
    setError(null);
    api(path, schema).then(value => { if (active) setData(value); })
      .catch(cause => { if (active) setError(message(cause)); });
    return () => { active = false; };
  }, [api, path, schema, revision]);
  return { data, error, reload: () => setRevision(value => value + 1) };
}
function LoadState({ error, reload }: { error: string | null; reload: () => void }) {
  return error ? <div role="alert"><p className="inline-error">{error}</p><button className="secondary-button" onClick={reload}>Réessayer</button></div>
    : <p role="status">Chargement…</p>;
}
function Search({ label, onSearch }: { label: string; onSearch: (value: string) => void }) {
  return <form className="admin-search" onSubmit={event => {
    event.preventDefault();
    onSearch(String(new FormData(event.currentTarget).get('search') ?? ''));
  }}><label>{label}<input name="search" type="search" maxLength={200} /></label>
    <button className="secondary-button">Rechercher</button></form>;
}
function Pager({ offset, more, setOffset }: { offset: number; more: boolean; setOffset: (offset: number) => void }) {
  return <div className="admin-actions" aria-label="Pagination">
    <button className="secondary-button" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - 50))}>Précédent</button>
    <span>Page {offset / 50 + 1}</span>
    <button className="secondary-button" disabled={!more} onClick={() => setOffset(offset + 50)}>Suivant</button>
  </div>;
}
function Usage({ usage, hourlyCalls }: { usage: Capabilities; hourlyCalls?: number }) {
  return <dl className="admin-metrics">
    {hourlyCalls !== undefined && <div><dt>Appels sur la dernière heure</dt><dd>{number(hourlyCalls)}</dd></div>}
    <div><dt>Appels aujourd’hui</dt><dd>{number(usage.callsToday)}</dd></div>
    <div><dt>Appels ce mois-ci</dt><dd>{number(usage.callsThisMonth)}</dd></div>
    <div><dt>Tokens d’entrée ce mois-ci</dt><dd>{number(usage.inputTokens)}</dd></div>
    <div><dt>Tokens de sortie ce mois-ci</dt><dd>{number(usage.outputTokens)}</dd></div>
  </dl>;
}

function Overview({ api, navigate }: { api: Api; navigate: Navigate }) {
  const state = useData(api, '/admin/overview', adminOverviewSchema);
  if (!state.data) return <LoadState {...state} />;
  const data = state.data;
  const metrics = [
    { label: 'Comptes inscrits', value: data.users, page: 'users' },
    { label: 'Foyers', value: data.spaces, page: 'spaces' },
    { label: 'Recettes du catalogue', value: data.catalog, page: 'catalog' },
    { label: 'Demandes à traiter', value: data.requests, page: 'requests' },
  ] as const;
  return <section aria-label="Tableau de bord">
    <div className="admin-hero"><div><p className="eyebrow">VUE D’ENSEMBLE</p><h2>À table, côté coulisses.</h2>
      <p>Les foyers, les recettes et les traitements, au même endroit.</p></div><ShieldCheck size={42} strokeWidth={1.2} /></div>
    <div className="admin-cards">{metrics.map(item => <button className="settings-card admin-stat" key={item.label} onClick={() => navigate(item.page)}>
      <span>{item.label}<ArrowUpRight size={16} /></span><strong>{number(item.value)}</strong></button>)}</div>
    <div className="settings-card"><h3><Activity size={19} />File des analyses</h3>
      <div className="admin-queue">{(['error', 'pending', 'processing'] as const).map(status =>
        <button key={status} className={`admin-queue-item status-${status}`} onClick={() => navigate('analyses', status)}>
          <strong>{number(data.analyses[status])}</strong><span>{analysisLabels[status]}</span><ArrowUpRight size={16} /></button>)}</div>
      <p className="field-hint">Ouvrez un statut pour consulter les fiches concernées. Les erreurs ne sont pas relancées automatiquement.</p>
    </div>
    <div className="settings-card"><h3><Sparkles size={19} />Consommation IA globale</h3><Usage usage={data.usage} />
      <p>{data.policy.paused ? 'Nouveaux appels IA suspendus.' : 'Nouveaux appels IA autorisés, dans les limites configurées.'}</p></div>
    <div className="settings-card"><h3>État du serveur</h3>
      <p>{number(data.activeSessions)} session(s) utilisateur active(s).</p>
      <p>En service depuis {Math.floor(data.uptime / 60)} minute(s) · schéma SQLite {data.schemaVersion}.</p>
      <p className="field-hint">Actualisé le {date(data.serverTime)}.</p></div>
  </section>;
}

function Analyses({ api, confirmAction, initialFilter }: { api: Api; confirmAction: ConfirmAction; initialFilter: AnalysisFilter }) {
  const [offset, setOffset] = useState(0);
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState(initialFilter);
  const [selected, setSelected] = useState<AdminAnalysisEntry | null>(null);
  const state = useData(api, `/admin/analyses${query(offset, search)}&status=${status}`, adminAnalysesSchema);
  function retry(entry: AdminAnalysisEntry) {
    confirmAction({
      title: 'Relancer l’analyse',
      text: `Remettre « ${dishDetails(entry.dish, entry.analysis).name} » dans la file IA ? Cette nouvelle tentative consommera un appel lors de son traitement. Les menus ne changent pas.`,
      run: async () => {
        await api(`/admin/analyses/${encodeURIComponent(entry.spaceId)}/${entry.dish.id}/retry`, okSchema, { method: 'POST',
          body: { expectedAnalysisKey: entry.analysis.analysisKey, expectedUpdatedAt: entry.analysis.updatedAt, confirm: true } });
        return 'Analyse remise en attente. Elle démarrera automatiquement lorsque la configuration et les quotas le permettront.';
      },
    });
  }
  return <section aria-label="Analyses">
    <details className="settings-card admin-explainer"><summary>Que fait une analyse ?</summary>
      <p>L’IA enrichit un nom ou un lien avec des saisons, un niveau de cuisine, des ingrédients et une recette. Pour une recette saisie, elle standardise les ingrédients et valide son partage, sans réécrire le titre ni les étapes.</p>
      <p>Le serveur traite automatiquement les fiches admissibles, une à la fois. Chaque tentative compte dans les quotas, même en cas d’erreur. Une erreur nécessite une relance explicite.</p>
      <p>Relancer remplace le résultat IA de cette fiche, pas les textes du planning. Les fiches archivées ou corrigées manuellement ne sont pas retraitées.</p>
    </details>
    <div className="admin-filter-bar" aria-label="Filtrer les analyses">{(Object.keys(analysisLabels) as AnalysisFilter[]).map(value =>
      <button key={value} aria-pressed={status === value} onClick={() => { setStatus(value); setOffset(0); }}>{analysisLabels[value]}</button>)}</div>
    <Search label="Rechercher une fiche, un foyer ou une erreur" onSearch={value => { setSearch(value); setOffset(0); }} />
    {!state.data ? <LoadState {...state} /> : <>
      {!state.data.entries.length && <div className="settings-card"><h3>Aucune analyse dans cette sélection</h3><p className="field-hint">Essayez un autre statut ou une autre recherche.</p></div>}
      <div className="admin-list">{state.data.entries.map(entry => <article className="settings-card admin-analysis-card" key={`${entry.spaceId}:${entry.dish.id}`}>
        <div className="admin-card-heading"><span className={`admin-status status-${entry.analysis.status}`}>{analysisLabels[entry.analysis.status]}</span>
          <span className="field-hint">{date(entry.analysis.updatedAt)}</span></div>
        <h3>{dishDetails(entry.dish, entry.analysis).name}</h3><p className="field-hint">{entry.spaceName ?? entry.spaceId}</p>
        {entry.analysis.error && <p className="inline-error admin-text">{entry.analysis.error}</p>}
        {entry.blockedReason && <p className="field-hint">{entry.blockedReason}</p>}
        <button className="secondary-button" onClick={() => setSelected(entry)}>Ouvrir la fiche</button>
      </article>)}</div>
      <Pager offset={offset} more={state.data.more} setOffset={setOffset} />
    </>}
    {selected && <AnalysisSheet entry={selected} onClose={() => setSelected(null)} retry={() => retry(selected)} />}
  </section>;
}

function AnalysisSheet({ entry, onClose, retry }: { entry: AdminAnalysisEntry; onClose: () => void; retry: () => void }) {
  const { dish, analysis } = entry;
  const details = dishDetails(dish, analysis);
  const canRetry = entry.eligible;
  return <Modal title="Fiche de l’analyse" onClose={onClose} wide>
    <div className="admin-analysis-sheet">
      <div><span className={`admin-status status-${analysis.status}`}>{analysisLabels[analysis.status]}</span>
        <h3>{details.name}</h3><p className="field-hint">Foyer : {entry.spaceName ?? entry.spaceId} · Mise à jour : {date(analysis.updatedAt)}</p></div>
      {analysis.error && <div className="inline-error admin-text" role="alert"><strong>Erreur du traitement</strong><p>{analysis.error}</p></div>}
      {entry.blockedReason && <p className="info-box">{entry.blockedReason}</p>}
      <dl className="admin-sheet-metadata"><div><dt>Saisie d’origine</dt><dd>{dish.name}</dd></div>
        <div><dt>Type de traitement</dt><dd>{dish.sourceRecipe ? 'Validation d’une recette saisie' : dish.sourceUrl ? 'Import d’un lien' : 'Enrichissement d’un nom'}</dd></div>
        <div><dt>Saisons</dt><dd>{details.seasons.map(value => seasonLabels[value]).join(' · ')}</dd></div>
        <div><dt>Niveau de cuisine</dt><dd>{details.level ? cookingLevelLabels[details.level] : 'Non renseigné'}</dd></div>
        <div><dt>Portions de référence</dt><dd>{dish.sourceRecipe?.servings ?? details.servings ?? 'Non renseignées'}</dd></div>
        {analysis.sharing && <div><dt>Partage au catalogue</dt><dd>{analysis.sharing === 'approved' ? 'Validé' : 'Refusé'}</dd></div>}
      </dl>
      {dish.sourceUrl && <a href={dish.sourceUrl} target="_blank" rel="noopener noreferrer">Voir la recette d’origine</a>}
      <div><h4>Ingrédients</h4>{(dish.sourceRecipe?.ingredients ?? details.ingredients).length
        ? <ul>{(dish.sourceRecipe?.ingredients ?? details.ingredients).map((ingredient, index) => <li key={index}>{ingredient}</li>)}</ul>
        : <p className="field-hint">Pas encore disponibles.</p>}</div>
      <div><h4>Recette</h4><p className="admin-text">{dish.sourceRecipe?.recipe ?? (details.recipe || 'Pas encore disponible.')}</p></div>
      <details><summary>Identifiants techniques</summary><p>Foyer : <code>{entry.spaceId}</code></p><p>Fiche : <code>{dish.id}</code></p><p>Analyse : <code>{analysis.analysisKey}</code></p></details>
      <p className="field-hint">Cette consultation ne modifie pas le carnet. Une relance attendra son tour et respectera les quotas et la suspension IA.</p>
      <button className="primary-button" disabled={!canRetry} onClick={retry}><RefreshCw size={17} />Relancer l’IA</button>
      {!canRetry && <p className="field-hint">Relance indisponible : fiche archivée, corrigée manuellement, analyse déjà en cours ou demande obsolète.</p>}
    </div>
  </Modal>;
}

function UserList({ api, confirmAction }: { api: Api; confirmAction: ConfirmAction }) {
  const [offset, setOffset] = useState(0);
  const [search, setSearch] = useState('');
  const [recipient, setRecipient] = useState<{ id: string | null; name: string } | null>(null);
  const state = useData(api, `/admin/users${query(offset, search)}`, adminUsersSchema);
  return <section><h2>Comptes inscrits</h2>
    <button className="secondary-button" onClick={() => setRecipient({ id: null, name: 'Tous les utilisateurs inscrits' })}>Envoyer un message à tous</button>
    <button className="secondary-button" onClick={() => confirmAction({
      title: 'Tester les notifications', text: 'Envoyer une notification de test aux appareils de votre compte ? Activez-les d’abord dans les paramètres de l’application, sur chaque téléphone.',
      run: async () => {
        const result = await api('/push/test', pushTestSchema, { method: 'POST', body: {} });
        return result.devices ? `Notification envoyée à ${result.devices} appareil(s).` : 'Aucun appareil abonné : activez les notifications dans les paramètres de l’application.';
      },
    })}>Tester les notifications</button>
    <Search label="Rechercher un compte" onSearch={value => { setSearch(value); setOffset(0); }} />
    {!state.data ? <LoadState {...state} /> : <>
      {!state.data.users.length && <p>Aucun compte trouvé.</p>}
      <div className="admin-list">{state.data.users.map(user => <article className="settings-card" key={user.id}>
        <h3>{user.name}</h3><p>{user.email ?? 'Sans e-mail'}{!user.emailVerified && ' · non vérifié'}</p>
        <p className="field-hint">Inscription : {date(user.createdAt)} · dernière connexion : {date(user.lastLoginAt)}</p>
        <p>Foyer : {user.spaceName ?? 'Aucun'}</p><code>{user.id}</code>
        <button className="secondary-button" onClick={() => setRecipient({ id: user.id, name: user.name })}>Envoyer un message à {user.name}</button>
        <button className="secondary-button" onClick={() => confirmAction({
          title: 'Révoquer les sessions', text: `Déconnecter tous les appareils de ${user.name} ? Le compte et ses données seront conservés.`,
          run: async () => {
            const result = await api(`/admin/users/${user.id}/revoke-sessions`, z.object({ revoked: z.number() }), { method: 'POST', body: { confirm: true } });
            return `${result.revoked} session(s) révoquée(s).`;
          },
        })}>Révoquer les sessions de {user.name}</button>
      </article>)}</div><Pager offset={offset} more={state.data.more} setOffset={setOffset} />
    </>}
    {recipient && <Modal title="Envoyer un message" onClose={() => setRecipient(null)}>
      <MessageForm recipient={recipient} api={api} confirmAction={confirmAction} />
    </Modal>}
  </section>;
}
function MessageForm({ recipient, api, confirmAction }: {
  recipient: { id: string | null; name: string }; api: Api; confirmAction: ConfirmAction;
}) {
  const [text, setText] = useState('');
  const [push, setPush] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return <form className="admin-form" onSubmit={event => {
    event.preventDefault();
    const parsed = sendMessageSchema.safeParse({ text, userId: recipient.id, confirm: true, push });
    if (!parsed.success) { setError('Saisissez un message de 1 à 4 000 caractères.'); return; }
    setError(null);
    confirmAction({
      title: 'Confirmer l’envoi', text: `Envoyer ce message à « ${recipient.name} »${push ? ', avec une notification' : ''} ? Il ne pourra pas être modifié après l’envoi.`,
      run: async () => {
        const result = await api('/admin/messages', sentMessageSchema, { method: 'POST', body: parsed.data });
        return `Message envoyé à ${result.recipients} utilisateur(s).${result.pushed === undefined ? '' : ` Notification pour ${result.pushed} utilisateur(s) ayant activé un appareil.`}`;
      },
    });
  }}>
    <p>Destinataire : <strong>{recipient.name}</strong></p>
    <label>Message<textarea rows={6} maxLength={4000} required value={text} onChange={event => setText(event.target.value)} /></label>
    <p className="field-hint">Affiché à la prochaine ouverture ou reconnexion au serveur. Un clic le masque définitivement pour ce compte, sur tous ses appareils.
      {recipient.id === null && ' Tous les comptes existants seront destinataires, même si la liste est filtrée ; les futurs inscrits ne le recevront pas.'}</p>
    <label className="checkbox-field"><input type="checkbox" checked={push} onChange={event => setPush(event.target.checked)} />Envoyer aussi une notification</label>
    <p className="field-hint">Sur les appareils où les notifications sont activées ; les 240 premiers caractères seulement.</p>
    {error && <p className="inline-error" role="alert">{error}</p>}
    <button className="primary-button">Envoyer le message</button>
  </form>;
}
function SpaceList({ api, confirmAction, editable = false }: { api: Api; confirmAction: ConfirmAction; editable?: boolean }) {
  const [offset, setOffset] = useState(0);
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState<z.infer<typeof adminSpacesSchema>['spaces'][number] | null>(null);
  const state = useData(api, `/admin/spaces${query(offset, search)}`, adminSpacesSchema);
  return <section><h2>{editable ? 'Quotas par foyer' : 'Foyers et espaces'}</h2>
    <Search label="Rechercher un foyer" onSearch={value => { setSearch(value); setOffset(0); }} />
    {!state.data ? <LoadState {...state} /> : <>
      {!state.data.spaces.length && <p>Aucun foyer trouvé.</p>}
      <div className="admin-list">{state.data.spaces.map(space => <article className="settings-card" key={space.id}>
        <h3>{space.name}</h3><p>{space.members} membre(s) · {space.records} repas/fiche(s) · {space.kind === 'common' ? 'Espace commun' : 'Foyer'}</p>
        <p className="field-hint">Créé le {date(space.createdAt)}</p><code>{space.id}</code>
        <p>Quota quotidien : {space.policy.dailyLimit ?? 'illimité'} · mensuel : {space.policy.monthlyLimit ?? 'illimité'}</p>
        {editable && <><Usage usage={space.usage} /><button className="secondary-button" onClick={() => setSelected(space)}>Modifier les quotas de {space.name}</button></>}
      </article>)}</div><Pager offset={offset} more={state.data.more} setOffset={setOffset} />
    </>}
    {selected && <Modal title={`Quotas de ${selected.name}`} onClose={() => setSelected(null)}>
      <PolicyForm initial={selected.policy} onSubmit={policy => {
        const limits = spaceAiPolicySchema.parse({ dailyLimit: policy.dailyLimit, monthlyLimit: policy.monthlyLimit });
        confirmAction({ title: 'Confirmer les quotas', text: `Appliquer les nouveaux quotas au foyer « ${selected.name} » ?`,
          run: async () => { await api(`/admin/spaces/${selected.id}/ai`, okSchema, { method: 'PATCH', body: { ...limits, confirm: true } }); return 'Quotas du foyer enregistrés.'; } });
      }} />
    </Modal>}
  </section>;
}
function PolicyForm({ initial, onSubmit }: { initial: SpaceAiPolicy | GlobalAiPolicy; onSubmit: (policy: GlobalAiPolicy) => void }) {
  const global = 'paused' in initial;
  const initialHourlyLimit = 'hourlyLimit' in initial ? initial.hourlyLimit : null;
  const [daily, setDaily] = useState(initial.dailyLimit?.toString() ?? '');
  const [monthly, setMonthly] = useState(initial.monthlyLimit?.toString() ?? '');
  const [hourlyEnabled, setHourlyEnabled] = useState(initialHourlyLimit !== null);
  const [hourly, setHourly] = useState(initialHourlyLimit?.toString() ?? '');
  const [paused, setPaused] = useState(global && initial.paused);
  const [error, setError] = useState<string | null>(null);
  function submit(event: FormEvent) {
    event.preventDefault();
    const result = globalAiPolicySchema.safeParse({
      dailyLimit: daily.trim() ? Number(daily) : null, monthlyLimit: monthly.trim() ? Number(monthly) : null,
      hourlyLimit: global && hourlyEnabled ? hourly.trim() ? Number(hourly) : Number.NaN : null, paused,
    });
    if (!result.success) { setError('Les plafonds doivent être des entiers de 0 à 1 000 000 ; le plafond horaire activé doit être renseigné.'); return; }
    setError(null);
    onSubmit(result.data);
  }
  return <form className="admin-form" onSubmit={submit}>
    {global && <label className="admin-checkbox"><input type="checkbox" checked={paused} onChange={event => setPaused(event.target.checked)} />Suspendre tous les nouveaux appels IA</label>}
    {global && <>
      <label className="admin-checkbox"><input type="checkbox" checked={hourlyEnabled} onChange={event => setHourlyEnabled(event.target.checked)} />Activer le plafond horaire global</label>
      {hourlyEnabled && <label>Plafond horaire global (période glissante de 60 minutes)<input type="number" min={0} max={1_000_000} step={1} required value={hourly} onChange={event => setHourly(event.target.value)} /></label>}
    </>}
    <label>{global ? 'Plafond quotidien global' : 'Quota quotidien'}<input type="number" min={0} max={1_000_000} step={1} value={daily} onChange={event => setDaily(event.target.value)} /></label>
    <label>{global ? 'Plafond mensuel global' : 'Quota mensuel'}<input type="number" min={0} max={1_000_000} step={1} value={monthly} onChange={event => setMonthly(event.target.value)} /></label>
    <p className="field-hint">En nombre d’appels. Vide = illimité ; 0 = aucun nouvel appel. Les plafonds quotidiens et mensuels se renouvellent selon l’heure de Paris.{global && ' Le plafond horaire global porte sur toute période glissante de 60 minutes.'} Les exemptions d’un foyer ne contournent pas les plafonds globaux.</p>
    {error && <p className="inline-error" role="alert">{error}</p>}<button className="primary-button">Enregistrer les limites</button>
  </form>;
}
function Ai({ api, confirmAction }: { api: Api; confirmAction: ConfirmAction }) {
  const state = useData(api, '/admin/ai', adminAiSchema);
  return <section aria-label="OpenAI">
    {!state.data ? <LoadState {...state} /> : <div className="settings-card"><h3>Budget d’appels OpenAI</h3>
      <p>{state.data.configured ? 'Clé OpenAI configurée sur le serveur.' : 'Clé OpenAI absente : aucun appel possible.'}</p>
      <Usage usage={state.data.usage} hourlyCalls={state.data.hourlyCalls} />
      <PolicyForm initial={state.data.policy} onSubmit={policy => confirmAction({
        title: 'Confirmer les limites globales', text: 'Ces limites s’appliqueront à tous les foyers. Les appels déjà en cours ne seront pas annulés.',
        run: async () => { await api('/admin/ai', okSchema, { method: 'PATCH', body: { ...policy, confirm: true } }); return 'Limites globales enregistrées.'; },
      })} />
      <p className="field-hint">Les appels réservés sont comptés, y compris les tentatives échouées. Les tokens affichés sont ceux des réponses enregistrées, pas un relevé de facturation.</p>
      <p className="field-hint">Modèles autorisés : {state.data.allowedModels.join(', ')}. La clé et les modèles se configurent uniquement sur le serveur.</p>
      <a href="https://platform.openai.com/settings/organization/billing/overview" target="_blank" rel="noopener noreferrer">Solde, rechargement et facturation sur OpenAI</a>
      <p className="field-hint">Le solde financier OpenAI n’est ni lu ni modifié par cette interface.</p>
    </div>}
  </section>;
}

function CatalogEditor({ entry, save, onClose }: { entry: AdminCatalogEntry; save: (details: z.infer<typeof detailsSchema>, sourceUrl: string | null) => void; onClose: () => void }) {
  const [name, setName] = useState(entry.details.name);
  const [recipe, setRecipe] = useState(entry.details.recipe);
  const [source, setSource] = useState(entry.sourceUrl ?? '');
  const [level, setLevel] = useState<CookingLevel | undefined>(entry.details.level);
  const [selectedSeasons, setSeasons] = useState<Season[]>(entry.details.seasons);
  const [vegetarian, setVegetarian] = useState(entry.details.vegetarian ?? false);
  const [servings, setServings] = useState(entry.details.servings?.toString() ?? '');
  const [items, setItems] = useState<Ingredient[] | undefined>(entry.details.items);
  const [ingredients, setIngredients] = useState(entry.details.ingredients.join('\n'));
  const [error, setError] = useState<string | null>(null);
  function submit(event: FormEvent) {
    event.preventDefault();
    const details = detailsSchema.safeParse({
      ...entry.details, name, recipe, level, seasons: selectedSeasons, vegetarian,
      servings: servings ? Number(servings) : undefined,
      ingredients: items ? items.map(item => formatIngredient(item)) : ingredients.split('\n').map(line => line.trim()).filter(Boolean),
      items,
    });
    const url = source.trim() ? recipeUrlSchema.safeParse(source.trim()) : null;
    if (!details.success || (url && !url.success)) { setError('Vérifiez le nom, les saisons, les portions, les ingrédients et le lien HTTP(S).'); return; }
    save(details.data, url?.data ?? null);
  }
  function updateItem(index: number, patch: Partial<Ingredient>) {
    setItems(current => current?.map((item, at) => at === index ? { ...item, ...patch } : item));
  }
  return <Modal title="Corriger la recette du catalogue" onClose={onClose} wide>
    <form className="admin-form" onSubmit={submit}>
      <label>Nom de la recette<input required maxLength={240} value={name} onChange={event => setName(event.target.value)} /></label>
      <label>Lien source<input type="url" maxLength={2048} value={source} onChange={event => setSource(event.target.value)} /></label>
      <fieldset><legend>Saisons</legend><div className="admin-actions">{seasons.map(season => <label className="admin-checkbox" key={season}>
        <input type="checkbox" checked={selectedSeasons.includes(season)} onChange={event => setSeasons(current => event.target.checked ? [...current, season] : current.filter(value => value !== season))} />
        {seasonLabels[season]}</label>)}</div></fieldset>
      <label>Niveau de cuisine<select value={level ?? ''} onChange={event => setLevel(cookingLevels.find(value => String(value) === event.target.value))}>
        <option value="">Sans niveau</option>{cookingLevels.map(value => <option key={value} value={value}>{cookingLevelLabels[value]}</option>)}</select></label>
      <label>Portions de référence<input type="number" min={0.5} max={60} step={0.5} value={servings} onChange={event => setServings(event.target.value)} /></label>
      <label className="admin-checkbox"><input type="checkbox" checked={vegetarian} onChange={event => setVegetarian(event.target.checked)} />Végétarien</label>
      {items ? <fieldset><legend>Ingrédients structurés</legend>{items.map((item, index) => <div className="admin-ingredient" key={index}>
        <label>Ingrédient {index + 1}<input required maxLength={80} value={item.name} onChange={event => updateItem(index, { name: event.target.value })} /></label>
        <label>Quantité {index + 1}<input type="number" min={0.001} max={100_000} step="any" value={item.quantity ?? ''} onChange={event => updateItem(index, { quantity: event.target.value ? Number(event.target.value) : null })} /></label>
        <label>Unité {index + 1}<input maxLength={20} value={item.unit} onChange={event => updateItem(index, { unit: event.target.value })} /></label>
        <button type="button" className="text-button" onClick={() => setItems(current => current?.filter((_, at) => at !== index))}>Retirer l’ingrédient {index + 1}</button>
      </div>)}<button type="button" className="secondary-button" onClick={() => setItems(current => [...(current ?? []), { name: '', quantity: null, unit: '' }])}>Ajouter un ingrédient</button></fieldset>
        : <label>Ingrédients et quantités<textarea rows={5} value={ingredients} onChange={event => setIngredients(event.target.value)} /></label>}
      <label>Étapes de la recette<textarea rows={7} maxLength={4000} value={recipe} onChange={event => setRecipe(event.target.value)} /></label>
      <p className="field-hint">Seul le catalogue partagé change. Les copies déjà présentes dans les carnets des foyers sont conservées.</p>
      {error && <p className="inline-error" role="alert">{error}</p>}<button className="primary-button">Enregistrer la correction</button>
    </form>
  </Modal>;
}
function Catalog({ api, confirmAction }: { api: Api; confirmAction: ConfirmAction }) {
  const [offset, setOffset] = useState(0);
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState<AdminCatalogEntry | null>(null);
  const state = useData(api, `/admin/catalog${query(offset, search)}`, adminCatalogSchema);
  return <section><h2><BookOpen size={22} />Catalogue commun</h2>
    <Search label="Rechercher une recette" onSearch={value => { setSearch(value); setOffset(0); }} />
    {!state.data ? <LoadState {...state} /> : <>
      {!state.data.entries.length && <p>Aucune recette trouvée.</p>}
      <div className="admin-list">{state.data.entries.map(entry => <article className="settings-card" key={entry.id}>
        <h3>{entry.details.name}{entry.deleted && ' · retirée'}</h3><p className="field-hint">{entry.details.seasons.map(season => seasonLabels[season]).join(' · ')}</p>
        <div className="admin-actions"><button className="secondary-button" onClick={() => setSelected(entry)}>Corriger {entry.details.name}</button>
          <button className="secondary-button" onClick={() => confirmAction({
            title: entry.deleted ? 'Restaurer la recette' : 'Retirer la recette',
            text: `« ${entry.details.name} » sera ${entry.deleted ? 'à nouveau proposée' : 'retirée du catalogue'}. Les copies privées ne changent pas.`,
            run: async () => {
              await api(`/admin/catalog/${entry.id}/removal`, okSchema, { method: 'POST', body: { removed: !entry.deleted, expectedSeq: entry.seq, confirm: true } });
              return entry.deleted ? 'Recette restaurée.' : 'Recette retirée du catalogue.';
            },
          })}>{entry.deleted ? 'Restaurer' : 'Retirer'} {entry.details.name}</button></div>
      </article>)}</div><Pager offset={offset} more={state.data.more} setOffset={setOffset} />
    </>}
    {selected && <CatalogEditor entry={selected} onClose={() => setSelected(null)} save={(details, sourceUrl) => confirmAction({
      title: 'Confirmer la correction', text: `Publier la correction de « ${details.name} » dans le catalogue commun ?`,
      run: async () => {
        await api(`/admin/catalog/${selected.id}`, okSchema, { method: 'PATCH', body: { details, sourceUrl, expectedSeq: selected.seq, confirm: true } });
        return 'Recette du catalogue corrigée.';
      },
    })} />}
  </section>;
}
function RequestEditor({ request: item, api, confirmAction }: { request: FeatureRequest; api: Api; confirmAction: ConfirmAction }) {
  const [status, setStatus] = useState(item.status);
  const [note, setNote] = useState(item.note ?? '');
  return <form className="admin-form" onSubmit={event => {
    event.preventDefault();
    confirmAction({ title: 'Répondre à la demande', text: 'Le statut et la réponse seront visibles par le foyer concerné.',
      run: async () => {
        await api(`/admin/requests/${item.id}`, okSchema, { method: 'PATCH', body: { status, note: note.trim() || null, expectedUpdatedAt: item.updatedAt, confirm: true } });
        return 'Demande mise à jour.';
      } });
  }}><label>Statut<select value={status} onChange={event => {
    const selected = featureRequestStatuses.find(value => value === event.target.value);
    if (selected) setStatus(selected);
  }}>{featureRequestStatuses.map(value => <option key={value} value={value}>{featureRequestStatusLabels[value]}</option>)}</select></label>
    <label>Réponse au foyer<textarea rows={3} maxLength={1000} value={note} onChange={event => setNote(event.target.value)} /></label>
    <button className="secondary-button">Enregistrer la réponse</button>
  </form>;
}
function Requests({ api, confirmAction }: { api: Api; confirmAction: ConfirmAction }) {
  const [offset, setOffset] = useState(0);
  const state = useData(api, `/admin/requests${query(offset, '')}`, adminRequestsSchema);
  return <section><h2>Demandes des utilisateurs</h2>
    {!state.data ? <LoadState {...state} /> : <>
      {!state.data.requests.length && <p>Aucune demande.</p>}
      <div className="admin-list">{state.data.requests.map(({ request: item, spaceName }) => <article className="settings-card" key={item.id}>
        <h3>{spaceName ?? 'Foyer supprimé'}</h3><p className="field-hint">{date(item.createdAt)}</p><p className="admin-text">{item.text}</p>
        <RequestEditor request={item} api={api} confirmAction={confirmAction} />
      </article>)}</div><Pager offset={offset} more={state.data.more} setOffset={setOffset} />
    </>}
  </section>;
}
function Audit({ api }: { api: Api }) {
  const [offset, setOffset] = useState(0);
  const state = useData(api, `/admin/audit${query(offset, '')}`, adminAuditSchema);
  return <section><h2>Journal d’administration</h2>
    {!state.data ? <LoadState {...state} /> : <>
      <ul className="admin-audit">{state.data.entries.map(entry => <li key={entry.id}>
        <strong>{entry.action}</strong> · {date(entry.createdAt)}<p>Administrateur : <code>{entry.userId}</code></p>
        <p>Cible : <code>{entry.target}</code></p><p className="field-hint">{entry.details}</p>
      </li>)}</ul>{!state.data.entries.length && <p>Aucune action enregistrée.</p>}
      <Pager offset={offset} more={state.data.more} setOffset={setOffset} />
    </>}
  </section>;
}
function Backups({ api, confirmAction }: { api: Api; confirmAction: ConfirmAction }) {
  return <section aria-label="Sauvegardes">
    <div className="settings-card"><h3>Sauvegarde du serveur</h3><p>Créer un instantané SQLite dans le dossier de sauvegardes du serveur. Aucun téléchargement de données personnelles dans le navigateur.</p>
      <button className="secondary-button" onClick={() => confirmAction({
        title: 'Créer une sauvegarde', text: 'Créer une sauvegarde de la base sur le serveur ? Elle contiendra les données de tous les foyers.',
        run: async () => {
          const result = await api('/admin/backup', z.object({ file: z.string() }), { method: 'POST', body: { confirm: true } });
          return `Sauvegarde créée sur le serveur : ${result.file}`;
        },
      })}>Créer une sauvegarde</button>
      <p className="field-hint">Les suppressions de comptes, déplacements de foyers, restaurations et changements de secrets restent réservés aux commandes sur le serveur.</p>
    </div>
  </section>;
}

function LegalEditor({ api, confirmAction }: { api: Api; confirmAction: ConfirmAction }) {
  const state = useData(api, '/admin/legal', adminLegalSchema);
  return <section aria-label="Mentions légales">
    {!state.data ? <LoadState {...state} /> : <LegalForm key={state.data.updatedAt} initial={state.data.info} updatedAt={state.data.updatedAt} api={api} confirmAction={confirmAction} />}
  </section>;
}
const legalGroups: { title: string; hint: string; fields: (keyof LegalInfo)[] }[] = [
  { title: 'Éditeur et responsable du traitement', hint: 'Particulier : prénom et nom. Société ou association : raison sociale, et immatriculation si elle existe.',
    fields: ['firstName', 'lastName', 'companyName', 'registration', 'street', 'postalCode', 'city', 'country', 'phone', 'email', 'publicationDirector'] },
  { title: 'Hébergement', hint: 'Serveur auto-hébergé : indiquez vos propres coordonnées comme hébergeur.',
    fields: ['hostName', 'hostAddress', 'hostPhone', 'hostingLocation', 'logRetention'] },
];
function LegalForm({ initial, updatedAt, api, confirmAction }: { initial: LegalInfo; updatedAt: number; api: Api; confirmAction: ConfirmAction }) {
  const [info, setInfo] = useState(initial);
  const [error, setError] = useState<string | null>(null);
  function submit(event: FormEvent) {
    event.preventDefault();
    const result = legalInfoSchema.safeParse(info);
    if (!result.success) { setError('Vérifiez l’adresse e-mail et la longueur des champs.'); return; }
    setError(null);
    confirmAction({ title: 'Publier les mentions légales', text: 'Ces informations seront visibles publiquement sur les pages Conditions d’utilisation et Confidentialité.',
      run: async () => {
        await api('/admin/legal', okSchema, { method: 'PATCH', body: { info: result.data, expectedUpdatedAt: updatedAt, confirm: true } });
        return 'Mentions légales publiées.';
      } });
  }
  return <form className="admin-form settings-card" onSubmit={submit}>
    <h3><Scale size={19} />Mentions légales</h3>
    <p className="field-hint">Les champs vides apparaissent comme « À COMPLÉTER » sur les pages publiques.
      {updatedAt ? ` Dernière publication : ${date(updatedAt)}.` : ' Valeurs par défaut, jamais publiées.'}</p>
    {legalGroups.map(group => <fieldset key={group.title}><legend>{group.title}</legend><p className="field-hint">{group.hint}</p>
      {group.fields.map(key => <label key={key}>{legalFieldLabels[key]}
        <input type={key === 'email' ? 'email' : key.toLowerCase().includes('phone') ? 'tel' : 'text'} maxLength={legalFieldMax[key]}
          value={info[key]} onChange={event => setInfo(current => ({ ...current, [key]: event.target.value }))} /></label>)}
    </fieldset>)}
    <p className="admin-actions"><a href="/conditions-utilisation" target="_blank" rel="noopener">Voir les conditions d’utilisation</a>
      <a href="/confidentialite" target="_blank" rel="noopener">Voir la politique de confidentialité</a></p>
    {error && <p className="inline-error" role="alert">{error}</p>}<button className="primary-button">Enregistrer les mentions légales</button>
  </form>;
}

export function Admin() {
  const [session, setSession] = useState<AdminSession | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [tab, setTab] = useState<AdminPage>('overview');
  const [analysisFilter, setAnalysisFilter] = useState<AnalysisFilter>('all');
  const [revision, setRevision] = useState(0);
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null);
  const [confirmError, setConfirmError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [signingIn, setSigningIn] = useState(false);
  const csrf = session?.csrfToken ?? null;
  const clearAccess = useCallback((text: string) => {
    setSession(current => current ? { ...current, csrfToken: null, expiresAt: null } : current);
    setConfirmation(null);
    setNotice(null);
    setError(text);
  }, []);
  const api: Api = useCallback(async (path, schema, options) => {
    try { return await request(path, schema, csrf, options); }
    catch (cause) {
      if (cause instanceof AdminError && (cause.code === 'admin_reauth' || cause.code === 'admin_forbidden')) clearAccess(cause.message);
      throw cause;
    }
  }, [csrf, clearAccess]);
  const loadSession = useCallback(async () => {
    setError(null);
    try { setSession(await request('/admin/session', adminSessionSchema, null)); }
    catch (cause) { setError(message(cause)); }
  }, []);
  useEffect(() => {
    document.title = 'Administration — À table !';
    const url = new URL(window.location.href);
    if (url.searchParams.get('auth') === 'error') setNotice('La connexion admin a été refusée ou annulée. Vérifiez le compte Google utilisé.');
    window.history.replaceState(null, '', window.location.pathname);
    void loadSession();
    // Never keep a rendered copy of admin data when a page is restored from the back/forward cache.
    const restored = (event: PageTransitionEvent) => { if (event.persisted) window.location.reload(); };
    window.addEventListener('pageshow', restored);
    return () => window.removeEventListener('pageshow', restored);
  }, [loadSession]);
  useEffect(() => {
    if (!session?.expiresAt) return;
    const timeout = window.setTimeout(() => clearAccess('La session admin a expiré. Reconnectez-vous avec Google.'), Math.max(0, session.expiresAt - Date.now()));
    return () => window.clearTimeout(timeout);
  }, [session?.expiresAt, clearAccess]);
  useEffect(() => {
    const offline = () => clearAccess('Administration indisponible hors ligne. Reconnectez-vous lorsque le réseau est rétabli.');
    window.addEventListener('offline', offline);
    return () => window.removeEventListener('offline', offline);
  }, [clearAccess]);
  async function login() {
    setSigningIn(true);
    setError(null);
    try {
      const result = await request('/auth/google/start', authStartResponseSchema, null, { method: 'POST', body: { returnTo: '/admin' } });
      window.location.assign(result.url);
    } catch (cause) { setError(message(cause)); setSigningIn(false); }
  }
  const confirmAction: ConfirmAction = action => { setConfirmError(null); setConfirmation(action); };
  async function confirm() {
    if (!confirmation) return;
    setBusy(true);
    setConfirmError(null);
    try {
      const text = await confirmation.run();
      setConfirmation(null);
      setNotice(text);
      setRevision(value => value + 1);
      await loadSession();
    } catch (cause) { setConfirmError(message(cause)); }
    finally { setBusy(false); }
  }
  const active = Boolean(session?.allowed && csrf && session.expiresAt && session.expiresAt > Date.now());
  const navigate: Navigate = (page, filter = 'all') => { setTab(page); setAnalysisFilter(filter); setNotice(null); };
  const currentPage = navigationGroups.flatMap(group => [...group.items]).find(item => item.id === tab)!;
  let content: ReactNode;
  if (!active) content = <div className="settings-card admin-login"><h2>Accès administrateur</h2>
    <p>Connexion Google réservée aux comptes autorisés. Aucun mot de passe Google n’est transmis à l’application.</p>
    {session?.user && <><p>Compte actuel : {session.user.email ?? session.user.name}</p><p className="field-hint">Identifiant de votre compte : <code>{session.user.id}</code></p>
      {!session.allowed && <p>Ce compte n’est pas autorisé à administrer le serveur.</p>}</>}
    {session?.authEnabled === false ? <p>Activez l’authentification Google sur le serveur pour utiliser l’administration.</p>
      : <button className="google-button" disabled={signingIn || !navigator.onLine || !session} onClick={() => void login()}>
        {signingIn ? 'Redirection…' : 'Connexion admin avec Google'}</button>}
    <p className="field-hint">Session admin : 30 minutes, sans renouvellement automatique. Aucune donnée admin n’est enregistrée hors ligne.</p>
    {!session && !error && <p role="status">Vérification de la connexion…</p>}
    {error && <button className="secondary-button" onClick={() => void loadSession()}>Vérifier la connexion</button>}
  </div>;
  else content = <div key={`${tab}-${revision}`}>
    <div className="admin-page-heading"><p className="eyebrow">ESPACE ADMINISTRATEUR</p><h2>{currentPage.label}</h2><p>{currentPage.hint}</p></div>
    {tab === 'overview' && <Overview api={api} navigate={navigate} />}
    {tab === 'analyses' && <Analyses api={api} confirmAction={confirmAction} initialFilter={analysisFilter} />}
    {tab === 'users' && <UserList api={api} confirmAction={confirmAction} />}
    {tab === 'spaces' && <SpaceList api={api} confirmAction={confirmAction} editable />}
    {tab === 'ai' && <Ai api={api} confirmAction={confirmAction} />}
    {tab === 'legal' && <LegalEditor api={api} confirmAction={confirmAction} />}
    {tab === 'catalog' && <Catalog api={api} confirmAction={confirmAction} />}
    {tab === 'requests' && <Requests api={api} confirmAction={confirmAction} />}
    {tab === 'backup' && <Backups api={api} confirmAction={confirmAction} />}
    {tab === 'audit' && <Audit api={api} />}
  </div>;
  return <div className="app-shell admin-shell">
    <header className="admin-header"><div><p className="eyebrow">À TABLE !</p><h1><ShieldCheck size={26} />Administration</h1></div>
      <div className="admin-actions"><a href="/">Retour au planning</a>
        {active && <><button className="secondary-button" onClick={() => { setRevision(value => value + 1); void loadSession(); }}><RefreshCw size={16} />Actualiser</button>
          <button className="secondary-button" onClick={() => confirmAction({
            title: 'Quitter l’administration', text: 'Fermer la session admin ? Votre session utilisateur pour le planning restera ouverte.',
            run: async () => { await api('/admin/logout', okSchema, { method: 'POST', body: { confirm: true } }); return 'Session admin fermée.'; },
          })}><LogOut size={16} />Quitter l’admin</button></>}
      </div></header>
    {active && <p className="field-hint admin-session">Connecté : {session?.user?.email ?? session?.user?.name} · fin de session : {date(session!.expiresAt!)}</p>}
    <div className={active ? 'admin-layout' : undefined}>
      {active && <nav className="admin-nav" aria-label="Administration">{navigationGroups.map(group =>
        <div className="admin-nav-group" key={group.title}><p className="eyebrow">{group.title}</p>
          {group.items.map(({ id, label, icon: Icon }) => <button key={id} aria-current={tab === id ? 'page' : undefined}
            onClick={() => navigate(id)}><Icon size={18} />{label}</button>)}</div>)}</nav>}
      <main>{error && <p className="inline-error" role="alert">{error}</p>}
        {notice && <p className="info-box" role="status">{notice}</p>}{content}</main>
    </div>
    {confirmation && active && <Modal title={confirmation.title} onClose={() => { if (!busy) setConfirmation(null); }} dismissible={!busy}>
      <p>{confirmation.text}</p>{confirmError && <p className="inline-error" role="alert">{confirmError}</p>}
      <div className="confirm-actions"><button className="secondary-button" disabled={busy} onClick={() => setConfirmation(null)}>Annuler</button>
        <button className="primary-button" disabled={busy} onClick={() => void confirm()}>{busy ? 'En cours…' : 'Confirmer'}</button></div>
    </Modal>}
  </div>;
}
