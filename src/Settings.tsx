import { useEffect, useState } from 'react';
import { Check, ChefHat, Clock3, Cloud, Download, Lightbulb, MonitorSmartphone, Moon, RefreshCw, Send, ShieldCheck, Sparkles, Sun, SunMoon } from 'lucide-react';
import {
  cookingLevelHints, cookingLevelLabels, cookingLevels, defaultCookingLevel, defaultHousehold, featureRequestStatusLabels, householdCategories,
  type Capabilities, type CookingLevel, type FeatureRequest, type Household, type Settings as AppSettings,
} from '../shared/model';
import { LevelGauge } from './CookingLevel';
import { errorMessage, loadFeatureRequests, save, serverFeaturesAvailable, signInHint, submitFeatureRequest, type AuthState } from './store';
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
    <p>Proposez une amélioration ou signalez ce qui vous manque. Les demandes sont conservées sur le serveur et partagées entre tous les appareils ; leur statut évolue au fil de leur prise en compte.</p>
    <label className="field-label" htmlFor="feature-request">Demande d’évolution</label>
    <textarea id="feature-request" className="avoid-input" rows={3} maxLength={1000} disabled={sending}
      placeholder="Ex. : pouvoir noter les repas, ajouter un goûter…"
      value={draft} onChange={event => { setDraft(event.target.value); setSent(false); }} />
    <div className="settings-actions">
      <button className="secondary-button" disabled={!online || !allowed || sending || draft.trim().length < 3} title={allowed ? undefined : signInHint} onClick={() => void send()}>
        <Send size={16} />Envoyer</button>
    </div>
    {!allowed ? <p className="field-hint">{signInHint} : les demandes sont liées à votre foyer.</p>
      : !online && <p className="field-hint">L’envoi et le suivi des demandes nécessitent le serveur.</p>}
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

export function Settings({ settings, capabilities, online, appearance, lastSync, pending, syncing, onSync, onInstall, auth, reachable, onNotice }: {
  settings?: AppSettings; capabilities: Capabilities | null; online: boolean; appearance: ThemeControl; lastSync: number | null;
  pending: number; syncing: boolean; onSync: () => void; onInstall: () => void;
  auth: AuthState; reachable: boolean; onNotice: (title: string, text: string) => void;
}) {
  const allowed = serverFeaturesAvailable(auth);
  const local = auth.mode === 'guest' || auth.mode === 'unknown';
  const [error, setError] = useState<string | null>(null);
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
  const [themeError, setThemeError] = useState<string | null>(null);
  const [timeDraft, setTimeDraft] = useState<Partial<Record<ThemeTime, string>>>({});
  const [updating, setUpdating] = useState(false);
  const [updateError, setUpdateError] = useState<string | null>(null);
  const pwa = pwaStatus();
  const selectedModel = pendingModel ?? settings?.model;
  const savedAvoid = settings?.avoid ?? '';
  const selectedLevel = pendingLevel ?? settings?.cookingLevel ?? defaultCookingLevel;
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
  function saveSettings(patch: Partial<Pick<AppSettings, 'model' | 'household' | 'avoid' | 'cookingLevel'>>) {
    return save([{
      type: 'settings', id: 'global', model: settings?.model ?? '', household: settings?.household ?? defaultHousehold,
      avoid: savedAvoid, cookingLevel: settings?.cookingLevel ?? defaultCookingLevel, ...patch,
    }]);
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
    setError(null);
    setModelSaved(false);
    try {
      await saveSettings({ model });
      setModelSaved(true);
    } catch (cause) { setError(errorMessage(cause)); }
    finally { setPendingModel(null); }
  }
  async function changeHousehold(person: keyof Household, value: string) {
    const count = Number(value);
    const household = settings?.household ?? defaultHousehold;
    if (!Number.isInteger(count) || count < 0 || count > 20 || household.adults + household.teenagers + household.children - household[person] + count < 1) {
      setError('Indiquez entre 0 et 20 personnes par catégorie, avec au moins une personne au total.');
      return;
    }
    setPendingHousehold(true);
    setError(null);
    setHouseholdSaved(false);
    try {
      await saveSettings({ household: { ...household, [person]: count } });
      setHouseholdSaved(true);
    } catch (cause) { setError(errorMessage(cause)); }
    finally { setPendingHousehold(false); }
  }
  async function saveAvoid() {
    if (avoidDraft === null || avoidDraft.trim() === savedAvoid.trim()) { setAvoidDraft(null); return; }
    setPendingAvoid(true);
    setError(null);
    setAvoidSaved(false);
    try {
      await saveSettings({ avoid: avoidDraft.trim() });
      setAvoidDraft(null);
      setAvoidSaved(true);
    } catch (cause) { setError(errorMessage(cause)); }
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
  return <section className="settings">
    <div className="section-heading"><div><p className="eyebrow">LES COULISSES DU CARNET</p><h2>À votre façon</h2></div><Sparkles size={23} strokeWidth={1.3} /></div>
    <AccountCard auth={auth} reachable={reachable} pending={pending} onNotice={onNotice} />
    <div className="settings-card">
      <h3><SunMoon size={19} />Clair ou sombre</h3>
      <p>Une ambiance lumineuse pour la journée, plus feutrée pour le soir. Ce choix ne concerne que cet appareil.</p>
      <fieldset><legend className="field-label">Thème</legend>
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
      <h3><Cloud size={19} />Votre carnet, partout</h3>
      <p>{local ? 'En mode invité, les repas sont enregistrés uniquement sur cet appareil. Connectez-vous pour les partager avec le serveur et votre foyer.'
        : 'Les repas sont enregistrés sur cet appareil, puis partagés avec le serveur. En cas de conflit sur un même créneau ou une même fiche, la modification la plus récente l’emporte.'}</p>
      <dl><div><dt>Connexion au serveur</dt><dd>{local ? 'Non utilisée (mode invité)' : online ? 'Disponible' : 'Indisponible'}</dd></div>
        <div><dt>Modifications à envoyer</dt><dd>{pending}</dd></div>
        <div><dt>Dernière synchronisation</dt><dd>{lastSync ? new Intl.DateTimeFormat('fr-FR', { dateStyle: 'short', timeStyle: 'short', timeZone: 'Europe/Paris' }).format(lastSync) : 'Pas encore'}</dd></div>
        <div><dt>Application hors ligne</dt><dd>{pwa.error ? 'Indisponible sur cet appareil' : pwa.ready ? 'Prête sur cet appareil' : import.meta.env.DEV ? 'Après le build de production' : 'Préparation en cours'}</dd></div>
      </dl>
      {pwa.error && <p className="inline-error" role="alert">{pwa.error}</p>}
      {pwa.updateAvailable && <p className="info-box">Une nouvelle version est prête. Utilisez « Forcer la mise à jour » ou fermez tous les onglets et fenêtres de l’application, puis rouvrez-la. Vos modifications locales restent conservées.</p>}
      <div className="settings-actions"><button className="secondary-button" disabled={syncing || !allowed} onClick={onSync}><RefreshCw size={16} className={syncing ? 'spinning' : ''} />Synchroniser</button>
        <button className="secondary-button" disabled={updating || syncing || pendingModel !== null || pendingHousehold || pendingAvoid || pendingLevel !== null}
          onClick={() => void updateApp()}><RefreshCw size={16} className={updating ? 'spinning' : ''} />{updating ? 'Mise à jour…' : 'Forcer la mise à jour'}</button>
        <button className="text-button" onClick={onInstall}><Download size={16} />Installer l’application</button></div>
      <p className="field-hint">La mise à jour retélécharge l’application, y compris les styles CSS, puis recharge cette page. Le serveur doit être accessible ; les repas et modifications enregistrés restent conservés. Enregistrez d’abord les champs en cours de saisie.</p>
      {updating && <p className="field-hint" role="status">Téléchargement de l’application avant rechargement…</p>}
      {updateError && <p className="inline-error" role="alert">{updateError}</p>}
      <p className="field-hint">Astuce : quatre taps rapides sur « À table ! » actualisent aussi les données, sans effacer le carnet.</p>
    </div>
    <div className="settings-card">
      <h3><Sparkles size={19} />Votre foyer</h3>
      <p>Ces convives sont utilisés par défaut pour les repas. Touchez un repas choisi dans le planning pour adapter les convives de ce créneau uniquement. Les prochaines recettes générées par l’IA indiqueront des quantités adaptées au foyer.</p>
      <fieldset disabled={!settings || pendingHousehold}><legend className="field-label">Personnes à table</legend>
        <div className="household-options">
          {householdCategories.map(([person, label]) => <label key={person}>
            <span>{label}</span>
            <input type="number" min="0" max="20" step="1" value={settings?.household[person] ?? defaultHousehold[person]}
              onChange={event => void changeHousehold(person, event.target.value)} />
          </label>)}
        </div>
      </fieldset>
      {householdSaved && <p className="field-hint" role="status">Composition du foyer enregistrée ; elle sera utilisée pour les prochaines recettes IA.</p>}
      <label className="field-label" htmlFor="avoid">Repas et ingrédients à éviter</label>
      <textarea id="avoid" className="avoid-input" rows={3} maxLength={1000} disabled={!settings || pendingAvoid}
        placeholder="Ex. : champignons, fruits de mer, coriandre, plats trop épicés…"
        value={avoidText} onChange={event => { setAvoidDraft(event.target.value); setAvoidSaved(false); }} />
      <div className="settings-actions">
        <button className="secondary-button" disabled={!settings || pendingAvoid || avoidDraft === null || avoidDraft.trim() === savedAvoid.trim()}
          onClick={() => void saveAvoid()}><Check size={16} />Enregistrer</button>
      </div>
      <p className="field-hint">L’IA évitera ces repas et ingrédients dans ses propositions et les retirera si possible des recettes. Ce n’est pas une garantie : vérifiez toujours en cas d’allergie.</p>
      {avoidSaved && <p className="field-hint" role="status">Préférences enregistrées ; elles seront utilisées pour les prochaines propositions IA.</p>}
      {error && <p className="inline-error" role="alert">{error}</p>}
    </div>
    <div className="settings-card">
      <h3><ChefHat size={19} />Votre niveau en cuisine</h3>
      <p>Du plat vite fait au repas de fête : ce niveau guide les idées générées par l’IA et le choix au hasard dans le carnet, qui ne pioche que parmi les plats de ce niveau. Pour un repas ponctuel, un appui long sur les boutons de génération ou de choix au hasard permet d’en choisir un autre.</p>
      <fieldset disabled={!settings || pendingLevel !== null}><legend className="field-label">Niveau de cuisine</legend>
        <div className="level-options">{cookingLevels.map(level =>
          <label key={level} className={selectedLevel === level ? 'selected' : ''}>
            <input type="radio" name="cooking-level" checked={selectedLevel === level} onChange={() => void changeLevel(level)} />
            <span className="level-option-text"><strong>{cookingLevelLabels[level]}</strong><small>{cookingLevelHints[level]}</small></span>
            <LevelGauge level={level} />
          </label>)}</div>
      </fieldset>
      {levelSaved && <p className="field-hint" role="status">Niveau « {cookingLevelLabels[selectedLevel]} » enregistré ; il sera utilisé pour les prochaines générations IA et le choix au hasard.</p>}
      {levelError && <p className="inline-error" role="alert">{levelError}</p>}
    </div>
    <div className="settings-card">
      <h3><Sparkles size={19} />Un petit coup de pouce de l’IA</h3>
      <p>Pour enrichir vos fiches et générer de nouvelles idées de saison, en tenant compte du carnet et des repas choisis de J−15 à J+15 autour d’aujourd’hui. L’enrichissement ne change pas les textes déjà saisis dans le planning.</p>
      {!allowed && <p className="info-box">{signInHint} : l’IA est réservée aux comptes connectés. Le choix au hasard dans le carnet reste disponible.</p>}
      {allowed && !capabilities?.aiConfigured && <p className="info-box">L’analyse attend la configuration de la clé OpenAI sur le serveur. Vous pouvez déjà tout planifier.</p>}
      {settings && capabilities && !capabilities.allowedModels.includes(settings.model) &&
        <p className="inline-error" role="alert">Le modèle enregistré ({settings.model}) n’est plus autorisé par le serveur. Choisissez un modèle ci-dessous pour reprendre les analyses en attente.</p>}
      <fieldset disabled={!online || !allowed || pendingModel !== null || !capabilities}><legend className="field-label">Modèle OpenAI</legend>
        <div className="model-options">{(capabilities?.allowedModels ?? []).map(model =>
          <label key={model} className={selectedModel === model ? 'selected' : ''}>
            <input type="radio" name="model" checked={selectedModel === model} onChange={() => void changeModel(model)} />
            <span>{model}</span>{selectedModel === model && <Check size={16} />}
          </label>)}</div>
      </fieldset>
      {allowed && !online && <p className="field-hint">Le choix du modèle et la relance de l’IA nécessitent le serveur.</p>}
      {modelSaved && <p className="field-hint" role="status">Choix enregistré localement ; il sera appliqué aux prochaines analyses et générations après synchronisation.</p>}
      {error && <p className="inline-error" role="alert">{error}</p>}
      {capabilities && <dl>
        <div><dt>Appels IA aujourd’hui</dt><dd>{capabilities.callsToday}</dd></div>
        <div><dt>Appels IA ce mois-ci</dt><dd>{capabilities.callsThisMonth}</dd></div>
        <div><dt>Tokens comptabilisés ce mois-ci</dt><dd>{(capabilities.inputTokens + capabilities.outputTokens).toLocaleString('fr-FR')}</dd></div>
      </dl>}
      <p className="field-hint">{capabilities?.dailyLimit === null
        ? 'Votre foyer utilise l’IA sans limite quotidienne.'
        : 'Votre foyer dispose de 20 requêtes IA par jour, renouvelées à minuit (heure de Paris). Générations et enrichissements partagent cette limite.'} Les échecs comptent comme des tentatives et ne sont pas relancés automatiquement. Les compteurs concernent votre foyer et ne sont pas une facture. Les limites de votre projet OpenAI restent applicables.</p>
    </div>
    <FeatureRequests online={online} allowed={allowed} />
    <div className="privacy-note"><ShieldCheck size={22} strokeWidth={1.4} /><p>{auth.mode === 'disabled'
      ? 'Un carnet partagé, sans compte utilisateur. Toute personne ayant accès à cette adresse peut lire et modifier les repas. '
      : 'Chaque foyer a son propre carnet : seuls ses membres, connectés avec Google, peuvent le lire et le modifier. L’application ne reçoit ni votre mot de passe Google ni l’accès à vos autres données Google. '}La clé OpenAI ne quitte jamais le serveur. L’analyse transmet le nom du repas, la composition du foyer et les repas et ingrédients à éviter à OpenAI ; la génération transmet aussi la saison du créneau, le niveau de cuisine demandé, les noms du carnet (archives comprises) et ceux des repas choisis de J−15 à J+15 autour d’aujourd’hui, sans leurs dates ni les recettes.</p></div>
  </section>;
}
