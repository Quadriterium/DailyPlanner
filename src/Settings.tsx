import { useState } from 'react';
import { Check, Cloud, Download, RefreshCw, ShieldCheck, Sparkles } from 'lucide-react';
import { defaultHousehold, type Capabilities, type Household, type Settings as AppSettings } from '../shared/model';
import { errorMessage, save } from './store';
import { pwaStatus } from './pwa';

export function Settings({ settings, capabilities, online, lastSync, pending, syncing, onSync, onInstall }: {
  settings?: AppSettings; capabilities: Capabilities | null; online: boolean; lastSync: number | null;
  pending: number; syncing: boolean; onSync: () => void; onInstall: () => void;
}) {
  const [error, setError] = useState<string | null>(null);
  const [pendingModel, setPendingModel] = useState<string | null>(null);
  const [pendingHousehold, setPendingHousehold] = useState(false);
  const [modelSaved, setModelSaved] = useState(false);
  const [householdSaved, setHouseholdSaved] = useState(false);
  const [avoidDraft, setAvoidDraft] = useState<string | null>(null);
  const [pendingAvoid, setPendingAvoid] = useState(false);
  const [avoidSaved, setAvoidSaved] = useState(false);
  const pwa = pwaStatus();
  const selectedModel = pendingModel ?? settings?.model;
  const savedAvoid = settings?.avoid ?? '';
  const avoidText = avoidDraft ?? savedAvoid;
  function saveSettings(patch: Partial<Pick<AppSettings, 'model' | 'household' | 'avoid'>>) {
    return save([{
      type: 'settings', id: 'global', model: settings?.model ?? '', household: settings?.household ?? defaultHousehold,
      avoid: savedAvoid, ...patch,
    }]);
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
  return <section className="settings">
    <div className="section-heading"><div><p className="eyebrow">LES COULISSES DU CARNET</p><h2>À votre façon</h2></div><Sparkles size={23} strokeWidth={1.3} /></div>
    <div className="settings-card">
      <h3><Cloud size={19} />Votre carnet, partout</h3>
      <p>Les repas sont enregistrés sur cet appareil, puis partagés avec le serveur. En cas de conflit sur un même créneau ou une même fiche, la modification la plus récente l’emporte.</p>
      <dl><div><dt>Connexion au serveur</dt><dd>{online ? 'Disponible' : 'Indisponible'}</dd></div>
        <div><dt>Modifications à envoyer</dt><dd>{pending}</dd></div>
        <div><dt>Dernière synchronisation</dt><dd>{lastSync ? new Intl.DateTimeFormat('fr-FR', { dateStyle: 'short', timeStyle: 'short', timeZone: 'Europe/Paris' }).format(lastSync) : 'Pas encore'}</dd></div>
        <div><dt>Application hors ligne</dt><dd>{pwa.error ? 'Indisponible sur cet appareil' : pwa.ready ? 'Prête sur cet appareil' : import.meta.env.DEV ? 'Après le build de production' : 'Préparation en cours'}</dd></div>
      </dl>
      {pwa.error && <p className="inline-error" role="alert">{pwa.error}</p>}
      {pwa.updateAvailable && <p className="info-box">Une nouvelle version est prête. Fermez tous les onglets et fenêtres de l’application, puis rouvrez-la. Vos modifications locales restent conservées.</p>}
      <div className="settings-actions"><button className="secondary-button" disabled={syncing} onClick={onSync}><RefreshCw size={16} className={syncing ? 'spinning' : ''} />Synchroniser</button>
        <button className="text-button" onClick={onInstall}><Download size={16} />Installer l’application</button></div>
      <p className="field-hint">Astuce : quatre taps rapides sur « À table ! » actualisent aussi les données, sans effacer le carnet.</p>
    </div>
    <div className="settings-card">
      <h3><Sparkles size={19} />Votre foyer</h3>
      <p>Les prochaines recettes générées par l’IA indiqueront des quantités adaptées à votre foyer.</p>
      <fieldset disabled={!settings || pendingHousehold}><legend className="field-label">Personnes à table</legend>
        <div className="household-options">
          {([
            ['adults', 'Adultes'],
            ['teenagers', 'Adolescents'],
            ['children', 'Enfants'],
          ] as const).map(([person, label]) => <label key={person}>
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
      <h3><Sparkles size={19} />Un petit coup de pouce de l’IA</h3>
      <p>Pour enrichir vos fiches et générer de nouvelles idées de saison, en tenant compte du carnet et des repas choisis de J−15 à J+15 autour d’aujourd’hui. L’enrichissement ne change pas les textes déjà saisis dans le planning.</p>
      {!capabilities?.aiConfigured && <p className="info-box">L’analyse attend la configuration de la clé OpenAI sur le serveur. Vous pouvez déjà tout planifier.</p>}
      {settings && capabilities && !capabilities.allowedModels.includes(settings.model) &&
        <p className="inline-error" role="alert">Le modèle enregistré ({settings.model}) n’est plus autorisé par le serveur. Choisissez un modèle ci-dessous pour reprendre les analyses en attente.</p>}
      <fieldset disabled={!online || pendingModel !== null || !capabilities}><legend className="field-label">Modèle OpenAI</legend>
        <div className="model-options">{(capabilities?.allowedModels ?? []).map(model =>
          <label key={model} className={selectedModel === model ? 'selected' : ''}>
            <input type="radio" name="model" checked={selectedModel === model} onChange={() => void changeModel(model)} />
            <span>{model}</span>{selectedModel === model && <Check size={16} />}
          </label>)}</div>
      </fieldset>
      {!online && <p className="field-hint">Le choix du modèle et la relance de l’IA nécessitent le serveur.</p>}
      {modelSaved && <p className="field-hint" role="status">Choix enregistré localement ; il sera appliqué aux prochaines analyses et générations après synchronisation.</p>}
      {error && <p className="inline-error" role="alert">{error}</p>}
      {capabilities && <dl>
        <div><dt>Appels IA aujourd’hui</dt><dd>{capabilities.callsToday}</dd></div>
        <div><dt>Appels IA ce mois-ci</dt><dd>{capabilities.callsThisMonth}</dd></div>
        <div><dt>Tokens comptabilisés ce mois-ci</dt><dd>{(capabilities.inputTokens + capabilities.outputTokens).toLocaleString('fr-FR')}</dd></div>
      </dl>}
      <p className="field-hint">L’application ne limite pas le nombre d’appels IA. Les échecs comptent comme des tentatives et ne sont pas relancés automatiquement. Les compteurs ne sont pas une facture. Les limites de votre projet OpenAI restent applicables.</p>
    </div>
    <div className="privacy-note"><ShieldCheck size={22} strokeWidth={1.4} /><p>Un carnet partagé, sans compte utilisateur. Toute personne ayant accès à cette adresse peut lire et modifier les repas. La clé OpenAI ne quitte jamais le serveur. L’analyse transmet le nom du repas, la composition du foyer et les repas et ingrédients à éviter à OpenAI ; la génération transmet aussi la saison du créneau, les noms du carnet (archives comprises) et ceux des repas choisis de J−15 à J+15 autour d’aujourd’hui, sans leurs dates ni les recettes.</p></div>
  </section>;
}
