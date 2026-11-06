import { useEffect, useState } from 'react';
import {
  Ban, Check, ChefHat, Clock3, Cloud, Download, Lightbulb, Minus, MonitorSmartphone, Moon, Plus, RefreshCw, RotateCcw, Salad, Search, Send, Settings2, ShieldCheck,
  Sparkles, Sun, SunMoon, Users,
} from 'lucide-react';
import {
  cookingLevelHints, cookingLevelLabels, cookingLevels, defaultCookingLevel, defaultHousehold, dishDetails, featureRequestStatusLabels, householdCategories, normalizedName,
  type Analysis, type Capabilities, type CookingLevel, type Dish, type FeatureRequest, type Household, type Settings as AppSettings,
} from '../shared/model';
import { LevelGauge } from './CookingLevel';
import { errorMessage, loadFeatureRequests, save, serverFeaturesAvailable, setDishGenerationExcluded, signInHint, submitFeatureRequest, type AuthState } from './store';
import { AccountCard } from './Account';
import { pwaStatus, refreshApp } from './pwa';
import { timePattern, type ThemeControl, type ThemePreference } from './theme';

const themeModes = [
  ['light', 'Clair', Sun],
  ['dark', 'Sombre', Moon],
  ['schedule', 'Selon l’heure', Clock3],
  ['system', 'Comme le système', MonitorSmartphone],
] as const;
const themeTimes = [['darkFrom', 'Sombre à partir de'], ['lightFrom', 'Clair à partir de']] as const;
type ThemeTime = typeof themeTimes[number][0];

function frenchTime(value: string) {
  const [hours, minutes] = value.split(':');
  return `${Number(hours)} h${minutes === '00' ? '' : ` ${minutes}`}`;
}

function FeatureRequests({ online, allowed }: { online: boolean; allowed: boolean }) {
  const [requests, setRequests] = useState<FeatureRequest[] | null>(null);
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!online || !allowed) return;
    let active = true;
    loadFeatureRequests()
      .then(list => { if (active) { setRequests(list); setError(null); } })
      .catch(cause => { if (active) setError(errorMessage(cause)); });
    return () => { active = false; };
  }, [online, allowed]);
  async function send() {
    setSending(true);
    setError(null);
    setSent(false);
    try {
      const created = await submitFeatureRequest(draft.trim());
      setRequests(current => [created, ...(current ?? []).filter(request => request.id !== created.id)]);
      setDraft('');
      setSent(true);
    } catch (cause) { setError(errorMessage(cause)); }
    finally { setSending(false); }
  }
  const date = new Intl.DateTimeFormat('fr-FR', { dateStyle: 'short', timeZone: 'Europe/Paris' });
  return <div className="settings-card">
    <h3><Lightbulb size={19} />Une idée pour l’application ?</h3>
    {!allowed ? <p className="info-box">{signInHint}.</p> : <>
      <label className="field-label" htmlFor="feature-request">Demande d’évolution</label>
      <textarea id="feature-request" className="avoid-input" rows={3} maxLength={1000} disabled={sending}
        placeholder="Ex. : pouvoir noter les repas, ajouter un goûter…"
        value={draft} onChange={event => { setDraft(event.target.value); setSent(false); }} />
      <div className="settings-actions">
        <button className="secondary-button" disabled={!online || sending || draft.trim().length < 3} onClick={() => void send()}>
          <Send size={16} />Envoyer</button>
      </div>
      {!online && <p className="field-hint">Indisponible hors ligne.</p>}
    </>}
    {sent && <p className="field-hint" role="status">Merci ! Votre demande est enregistrée.</p>}
    {error && <p className="inline-error" role="alert">{error}</p>}
    {requests && (requests.length
      ? <ul className="feature-requests" aria-label="Demandes envoyées">{requests.map(request => <li key={request.id}>
        <div className="feature-request-meta"><span>{date.format(request.createdAt)}</span>
          <span className={`feature-status ${request.status}`}>{featureRequestStatusLabels[request.status]}</span></div>
        <p>{request.text}</p>
        {request.note && <p className="feature-note">{request.note}</p>}
      </li>)}</ul>
      : <p className="field-hint">Aucune demande pour le moment.</p>)}
  </div>;
}

function ExcludedDishes({ dishes, analyses }: { dishes: Dish[]; analyses: Analysis[] }) {
  const [query, setQuery] = useState('');
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [restored, setRestored] = useState<string | null>(null);
  const analysisMap = new Map(analyses.map(analysis => [analysis.dishId, analysis]));
  const excluded = dishes.filter(dish => dish.excludedFromGeneration)
    .map(dish => ({ dish, details: dishDetails(dish, analysisMap.get(dish.id)) }));
  const entries = excluded.filter(({ dish, details }) =>
    [dish.name, details.name].some(name => normalizedName(name).includes(normalizedName(query))))
    .sort((a, b) => a.details.name.localeCompare(b.details.name, 'fr'));
  async function restore(dish: Dish, name: string) {
    setPendingId(dish.id);
    setError(null);
    setRestored(null);
    try {
      await setDishGenerationExcluded(dish.id, false);
      setRestored(name);
    } catch (cause) { setError(errorMessage(cause)); }
    finally { setPendingId(null); }
  }
  return <section className="settings-card" aria-labelledby="excluded-dishes-title">
    <h3 id="excluded-dishes-title"><Ban size={19} />Plats exclus des générations</h3>
    <label className="search-field"><Search size={18} /><input type="search" aria-label="Rechercher dans les plats exclus"
      placeholder="Rechercher un plat exclu…" value={query} onChange={event => setQuery(event.target.value)} /></label>
    {entries.length ? <ul className="excluded-dishes">{entries.map(({ dish, details }) => <li key={dish.id}>
      <span>{details.name}</span>
      <button className="secondary-button" disabled={pendingId !== null} aria-label={`Réautoriser ${details.name}`}
        onClick={() => void restore(dish, details.name)}><RotateCcw size={16} />Réautoriser</button>
    </li>)}</ul> : <p className="field-hint">{excluded.length
      ? 'Aucun plat exclu ne correspond à cette recherche.' : 'Aucun plat exclu des générations.'}</p>}
    {restored && <p className="field-hint" role="status">« {restored} » est à nouveau autorisé dans les générations.</p>}
    {error && <p className="inline-error" role="alert">{error}</p>}
  </section>;
}

export function Settings({ settings, dishes, analyses, capabilities, online, appearance, lastSync, pending, syncing, onSync, onInstall, auth, reachable, onNotice }: {
  settings?: AppSettings; capabilities: Capabilities | null; online: boolean; appearance: ThemeControl; lastSync: number | null;
  dishes: Dish[]; analyses: Analysis[];
  pending: number; syncing: boolean; onSync: () => void; onInstall: () => void;
  auth: AuthState; reachable: boolean; onNotice: (title: string, text: string) => void;
}) {
  const allowed = serverFeaturesAvailable(auth);
  const local = auth.mode === 'guest' || auth.mode === 'unknown';
  const [householdError, setHouseholdError] = useState<string | null>(null);
  const [preferencesError, setPreferencesError] = useState<string | null>(null);
  const [modelError, setModelError] = useState<string | null>(null);
  const [pendingModel, setPendingModel] = useState<string | null>(null);
  const [pendingHousehold, setPendingHousehold] = useState(false);
  const [modelSaved, setModelSaved] = useState(false);
  const [householdSaved, setHouseholdSaved] = useState(false);
  const [avoidDraft, setAvoidDraft] = useState<string | null>(null);
  const [pendingAvoid, setPendingAvoid] = useState(false);
  const [avoidSaved, setAvoidSaved] = useState(false);
  const [pendingLevel, setPendingLevel] = useState<CookingLevel | null>(null);
  const [levelSaved, setLevelSaved] = useState(false);
  const [levelError, setLevelError] = useState<string | null>(null);
  const [pendingDiet, setPendingDiet] = useState<Partial<Pick<AppSettings, 'vegetarian' | 'vegetarianDinners'>> | null>(null);
  const [dietSaved, setDietSaved] = useState(false);
  const [themeError, setThemeError] = useState<string | null>(null);
  const [timeDraft, setTimeDraft] = useState<Partial<Record<ThemeTime, string>>>({});
  const [updating, setUpdating] = useState(false);
  const [updateError, setUpdateError] = useState<string | null>(null);
  const pwa = pwaStatus();
  const selectedModel = pendingModel ?? settings?.model;
  const savedAvoid = settings?.avoid ?? '';
  const selectedLevel = pendingLevel ?? settings?.cookingLevel ?? defaultCookingLevel;
  const selectedVegetarian = pendingDiet?.vegetarian ?? settings?.vegetarian ?? false;
  const selectedVegetarianDinners = pendingDiet?.vegetarianDinners ?? settings?.vegetarianDinners ?? false;
  const avoidText = avoidDraft ?? savedAvoid;
  const { preference, theme } = appearance;
  const currentTheme = theme === 'dark' ? 'sombre' : 'clair';
  const themeStatus = preference.mode === 'schedule'
    ? preference.darkFrom === preference.lightFrom
      ? 'Choisissez deux horaires différents ; en attendant, le thème reste clair.'
      : `Sombre de ${frenchTime(preference.darkFrom)} à ${frenchTime(preference.lightFrom)}, selon l’heure de cet appareil. En ce moment : ${currentTheme}.`
    : preference.mode === 'system'
      ? `Suit le réglage clair ou sombre de l’appareil. En ce moment : ${currentTheme}.`
      : `Thème ${currentTheme} sur cet appareil.`;
  function changeTheme(next: ThemePreference) {
    setThemeError(null);
    try { appearance.changePreference(next); }
    catch (cause) { setThemeError(`Thème appliqué, mais impossible de le mémoriser sur cet appareil : ${errorMessage(cause)}`); }
  }
  function changeTime(key: ThemeTime, value: string) {
    setTimeDraft(current => ({ ...current, [key]: value }));
    if (timePattern.test(value)) changeTheme({ ...preference, [key]: value });
  }
  function saveSettings(patch: Partial<Pick<AppSettings, 'model' | 'household' | 'avoid' | 'cookingLevel' | 'vegetarian' | 'vegetarianDinners'>>) {
    return save([{
      type: 'settings', id: 'global', model: settings?.model ?? '', household: settings?.household ?? defaultHousehold,
      avoid: savedAvoid, cookingLevel: settings?.cookingLevel ?? defaultCookingLevel,
      vegetarian: settings?.vegetarian ?? false, vegetarianDinners: settings?.vegetarianDinners ?? false,
      ...patch,
    }]);
  }
  async function changeDiet(patch: Partial<Pick<AppSettings, 'vegetarian' | 'vegetarianDinners'>>) {
    setPendingDiet(patch);
    setDietSaved(false);
    setPreferencesError(null);
    try { await saveSettings(patch); setDietSaved(true); }
    catch (cause) { setPreferencesError(errorMessage(cause)); }
    finally { setPendingDiet(null); }
  }
  async function changeLevel(cookingLevel: CookingLevel) {
    setPendingLevel(cookingLevel);
    setLevelError(null);
    setLevelSaved(false);
    try {
      await saveSettings({ cookingLevel });
      setLevelSaved(true);
    } catch (cause) { setLevelError(errorMessage(cause)); }
    finally { setPendingLevel(null); }
  }
  async function changeModel(model: string) {
    setPendingModel(model);
    setModelError(null);
    setModelSaved(false);
    try {
      await saveSettings({ model });
      setModelSaved(true);
    } catch (cause) { setModelError(errorMessage(cause)); }
    finally { setPendingModel(null); }
  }
  async function changeHousehold(person: keyof Household, value: string) {
    const count = Number(value);
    const household = settings?.household ?? defaultHousehold;
    if (!Number.isInteger(count) || count < 0 || count > 20 || household.adults + household.teenagers + household.children - household[person] + count < 1) {
      setHouseholdError('Indiquez entre 0 et 20 personnes par catégorie, avec au moins une personne au total.');
      return;
    }
    setPendingHousehold(true);
    setHouseholdError(null);
    setHouseholdSaved(false);
    try {
      await saveSettings({ household: { ...household, [person]: count } });
      setHouseholdSaved(true);
    } catch (cause) { setHouseholdError(errorMessage(cause)); }
    finally { setPendingHousehold(false); }
  }
  async function saveAvoid() {
    if (avoidDraft === null || avoidDraft.trim() === savedAvoid.trim()) { setAvoidDraft(null); return; }
    setPendingAvoid(true);
    setPreferencesError(null);
    setAvoidSaved(false);
    try {
      await saveSettings({ avoid: avoidDraft.trim() });
      setAvoidDraft(null);
      setAvoidSaved(true);
    } catch (cause) { setPreferencesError(errorMessage(cause)); }
    finally { setPendingAvoid(false); }
  }
  async function updateApp() {
    setUpdating(true);
    setUpdateError(null);
    try {
      await refreshApp();
      window.location.reload();
    } catch (cause) {
      setUpdateError(`Mise à jour impossible : ${errorMessage(cause)} Vos repas et modifications locales restent conservés.`);
      setUpdating(false);
    }
  }
  const household = settings?.household ?? defaultHousehold;
  const totalGuests = household.adults + household.teenagers + household.children;
  const modelInvalid = Boolean(settings && capabilities && !capabilities.allowedModels.includes(settings.model));
  return <section className="settings">
    <div className="section-heading"><h2>Paramètres</h2><Settings2 size={23} strokeWidth={1.3} /></div>
    <AccountCard auth={auth} reachable={reachable} pending={pending} onNotice={onNotice} />
    <div className="settings-card">
      <h3><Users size={19} />Personnes à table</h3>
      <fieldset disabled={!settings || pendingHousehold}><legend className="sr-only">Personnes à table</legend>
        <div className="meal-guests-counts">{householdCategories.map(([person, label]) => {
          const count = household[person];
          const singular = label.toLocaleLowerCase('fr-FR').slice(0, -1);
          return <div className="meal-guest-row" key={person}>
            <label htmlFor={`household-${person}`}>{label}</label>
            <div className="meal-guest-stepper">
              <button type="button" aria-label={`Retirer un ${singular}`} disabled={count <= 0 || totalGuests <= 1}
                onClick={() => void changeHousehold(person, String(count - 1))}><Minus size={16} /></button>
              <input id={`household-${person}`} type="number" inputMode="numeric" min="0" max="20" step="1" value={count}
                onChange={event => void changeHousehold(person, event.target.value)} />
              <button type="button" aria-label={`Ajouter un ${singular}`} disabled={count >= 20}
                onClick={() => void changeHousehold(person, String(count + 1))}><Plus size={16} /></button>
            </div>
          </div>;
        })}</div>
      </fieldset>
      {householdSaved && <p className="field-hint" role="status">Nombre de personnes enregistré.</p>}
      {householdError && <p className="inline-error" role="alert">{householdError}</p>}
    </div>
    <div className="settings-card">
      <h3><Salad size={19} />Préférences alimentaires</h3>
      <fieldset disabled={!settings || pendingDiet !== null}><legend className="field-label">Menus végétariens</legend>
        <label className="checkbox-field"><input type="checkbox" checked={selectedVegetarian}
          onChange={event => void changeDiet({ vegetarian: event.target.checked })} />Je suis végétarien</label>
        <label className="checkbox-field"><input type="checkbox" checked={selectedVegetarian || selectedVegetarianDinners}
          disabled={selectedVegetarian}
          onChange={event => void changeDiet({ vegetarianDinners: event.target.checked })} />Repas du soir végétariens</label>
      </fieldset>
      {dietSaved && <p className="field-hint" role="status">Préférences végétariennes enregistrées.</p>}
      <label className="field-label" htmlFor="avoid">Repas et ingrédients à éviter</label>
      <textarea id="avoid" className="avoid-input" rows={3} maxLength={1000} disabled={!settings || pendingAvoid}
        placeholder="Ex. : champignons, fruits de mer, coriandre, plats trop épicés…"
        value={avoidText} onChange={event => { setAvoidDraft(event.target.value); setAvoidSaved(false); }} />
      <div className="settings-actions">
        <button className="secondary-button" disabled={!settings || pendingAvoid || avoidDraft === null || avoidDraft.trim() === savedAvoid.trim()}
          onClick={() => void saveAvoid()}><Check size={16} />Enregistrer</button>
      </div>
      <p className="field-hint">Pris en compte par l’IA, sans garantie : vérifiez toujours en cas d’allergie.</p>
      {avoidSaved && <p className="field-hint" role="status">Repas et ingrédients à éviter enregistrés.</p>}
      {preferencesError && <p className="inline-error" role="alert">{preferencesError}</p>}
    </div>
    <ExcludedDishes dishes={dishes} analyses={analyses} />
    <div className="settings-card">
      <h3><ChefHat size={19} />Niveau de cuisine</h3>
      <fieldset disabled={!settings || pendingLevel !== null}><legend className="sr-only">Niveau de cuisine</legend>
        <div className="level-options">{cookingLevels.map(level =>
          <label key={level} className={selectedLevel === level ? 'selected' : ''}>
            <input type="radio" name="cooking-level" checked={selectedLevel === level} onChange={() => void changeLevel(level)} />
            <span className="level-option-text"><strong>{cookingLevelLabels[level]}</strong><small>{cookingLevelHints[level]}</small></span>
            <LevelGauge level={level} />
          </label>)}</div>
      </fieldset>
      {levelSaved && <p className="field-hint" role="status">Niveau « {cookingLevelLabels[selectedLevel]} » enregistré.</p>}
      {levelError && <p className="inline-error" role="alert">{levelError}</p>}
    </div>
    <div className="settings-card">
      <h3><SunMoon size={19} />Apparence</h3>
      <fieldset><legend className="sr-only">Thème</legend>
        <div className="theme-options">{themeModes.map(([mode, label, Icon]) =>
          <label key={mode} className={preference.mode === mode ? 'selected' : ''}>
            <input type="radio" name="theme" checked={preference.mode === mode} onChange={() => changeTheme({ ...preference, mode })} />
            <Icon size={16} /><span>{label}</span>
          </label>)}</div>
      </fieldset>
      {preference.mode === 'schedule' && <div className="theme-schedule">{themeTimes.map(([key, label]) =>
        <label key={key}><span>{label}</span>
          <input type="time" required value={timeDraft[key] ?? preference[key]} onChange={event => changeTime(key, event.target.value)}
            onBlur={() => setTimeDraft(current => ({ ...current, [key]: undefined }))} />
        </label>)}</div>}
      <p className="field-hint" role="status">{themeStatus}</p>
      {themeError && <p className="inline-error" role="alert">{themeError}</p>}
    </div>
    <div className="settings-card">
      <h3><Sparkles size={19} />Intelligence artificielle</h3>
      {!allowed ? <p className="info-box">{signInHint}.</p> : <>
        {capabilities && !capabilities.aiConfigured && <p className="info-box">IA indisponible : la clé OpenAI n’est pas configurée sur le serveur.</p>}
        {capabilities?.aiPaused && <p className="info-box">Les nouveaux appels IA sont suspendus par l’administrateur. Vos recettes restent disponibles.</p>}
        {modelInvalid && <p className="inline-error" role="alert">Le modèle enregistré ({settings?.model}) n’est plus autorisé. Choisissez-en un autre dans les options avancées.</p>}
        {capabilities && <>
          <dl><div><dt>Appels IA aujourd’hui</dt><dd>{capabilities.callsToday}</dd></div></dl>
          <p className="field-hint">{capabilities.dailyLimit === null
            ? 'Sans limite quotidienne pour votre foyer.'
            : `${capabilities.dailyLimit} requêtes IA par jour, renouvelées à minuit.`}</p>
          {capabilities.monthlyLimit != null && <p className="field-hint">{capabilities.monthlyLimit} requêtes IA maximum par mois pour votre foyer (heure de Paris).</p>}
          <details className="settings-advanced" open={modelInvalid || undefined}>
            <summary>Options avancées</summary>
            <fieldset disabled={!online || pendingModel !== null}><legend className="field-label">Modèle OpenAI</legend>
              <div className="model-options">{capabilities.allowedModels.map(model =>
                <label key={model} className={selectedModel === model ? 'selected' : ''}>
                  <input type="radio" name="model" checked={selectedModel === model} onChange={() => void changeModel(model)} />
                  <span>{model}</span>{selectedModel === model && <Check size={16} />}
                </label>)}</div>
            </fieldset>
            {!online && <p className="field-hint">Indisponible hors ligne.</p>}
            {modelSaved && <p className="field-hint" role="status">Modèle enregistré.</p>}
            <dl>
              <div><dt>Appels IA ce mois-ci</dt><dd>{capabilities.callsThisMonth}</dd></div>
              <div><dt>Tokens comptabilisés ce mois-ci</dt><dd>{(capabilities.inputTokens + capabilities.outputTokens).toLocaleString('fr-FR')}</dd></div>
            </dl>
          </details>
        </>}
        {modelError && <p className="inline-error" role="alert">{modelError}</p>}
      </>}
    </div>
    <div className="settings-card">
      <h3><Cloud size={19} />Synchronisation</h3>
      <dl><div><dt>Dernière synchronisation</dt><dd>{local ? 'Mode invité' : lastSync ? new Intl.DateTimeFormat('fr-FR', { dateStyle: 'short', timeStyle: 'short', timeZone: 'Europe/Paris' }).format(lastSync) : 'Pas encore'}</dd></div>
        {!local && <div><dt>Modifications à envoyer</dt><dd>{pending}</dd></div>}
      </dl>
      {pwa.error && <p className="inline-error" role="alert">{pwa.error}</p>}
      {pwa.updateAvailable && <p className="info-box">Une nouvelle version est prête : utilisez « Forcer la mise à jour » ci-dessous.</p>}
      <div className="settings-actions"><button className="secondary-button" disabled={syncing || !allowed} onClick={onSync}><RefreshCw size={16} className={syncing ? 'spinning' : ''} />Synchroniser</button>
        <button className="text-button" onClick={onInstall}><Download size={16} />Installer l’application</button></div>
      <details className="settings-advanced" open={pwa.updateAvailable || undefined}>
        <summary>Options avancées</summary>
        <dl><div><dt>Connexion au serveur</dt><dd>{local ? 'Non utilisée (mode invité)' : online ? 'Disponible' : 'Indisponible'}</dd></div>
          <div><dt>Application hors ligne</dt><dd>{pwa.error ? 'Indisponible sur cet appareil' : pwa.ready ? 'Prête sur cet appareil' : import.meta.env.DEV ? 'Après le build de production' : 'Préparation en cours'}</dd></div>
        </dl>
        <div className="settings-actions">
          <button className="secondary-button" disabled={updating || syncing || pendingModel !== null || pendingHousehold || pendingAvoid || pendingDiet !== null || pendingLevel !== null}
            onClick={() => void updateApp()}><RefreshCw size={16} className={updating ? 'spinning' : ''} />{updating ? 'Mise à jour…' : 'Forcer la mise à jour'}</button>
        </div>
        {updating && <p className="field-hint" role="status">Téléchargement de l’application avant rechargement…</p>}
      </details>
      {updateError && <p className="inline-error" role="alert">{updateError}</p>}
    </div>
    <FeatureRequests online={online} allowed={allowed} />
    {auth.mode === 'disabled' && <div className="privacy-note"><ShieldCheck size={22} strokeWidth={1.4} />
      <p>Carnet partagé sans compte : toute personne ayant accès à cette adresse peut lire et modifier les repas.</p></div>}
  </section>;
}
