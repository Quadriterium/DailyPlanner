import { useState } from 'react';
import { Check, Cloud, Download, RefreshCw, ShieldCheck, Sparkles } from 'lucide-react';
import type { Capabilities, Settings as AppSettings } from '../shared/model';
import { errorMessage, save } from './store';
import { pwaStatus } from './pwa';

export function Settings({ settings, capabilities, online, lastSync, pending, syncing, onSync, onInstall }: {
  settings?: AppSettings; capabilities: Capabilities | null; online: boolean; lastSync: number | null;
  pending: number; syncing: boolean; onSync: () => void; onInstall: () => void;
}) {
  const [error, setError] = useState<string | null>(null);
  const [pendingModel, setPendingModel] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const pwa = pwaStatus();
  const selectedModel = pendingModel ?? settings?.model;
  async function changeModel(model: string) {
    setPendingModel(model);
    setError(null);
    setSaved(false);
    try {
      await save([{ type: 'settings', id: 'global', model }]);
      setSaved(true);
    } catch (cause) { setError(errorMessage(cause)); }
    finally { setPendingModel(null); }
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
      <h3><Sparkles size={19} />Un petit coup de pouce de l’IA</h3>
      <p>Uniquement pour corriger le nom dans le carnet, reconnaître les saisons et proposer une recette. Le texte de vos menus reste tel que vous l’avez écrit.</p>
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
      {saved && <p className="field-hint" role="status">Choix enregistré localement ; il sera appliqué aux prochaines analyses après synchronisation.</p>}
      {error && <p className="inline-error" role="alert">{error}</p>}
      {capabilities && <dl>
        <div><dt>Analyses aujourd’hui</dt><dd>{capabilities.callsToday} / {capabilities.dailyLimit}</dd></div>
        <div><dt>Analyses ce mois-ci</dt><dd>{capabilities.callsThisMonth} / {capabilities.monthlyLimit}</dd></div>
        <div><dt>Tokens comptabilisés ce mois-ci</dt><dd>{(capabilities.inputTokens + capabilities.outputTokens).toLocaleString('fr-FR')}</dd></div>
      </dl>}
      <p className="field-hint">Les plafonds sont fixés côté serveur. Les échecs comptent comme des tentatives et ne sont pas relancés automatiquement. Ce sont des limites d’usage, pas une garantie de coût en euros. Vérifiez également les limites de votre projet OpenAI.</p>
    </div>
    <div className="privacy-note"><ShieldCheck size={22} strokeWidth={1.4} /><p>Un carnet partagé, sans compte utilisateur. Toute personne ayant accès à cette adresse peut lire et modifier les repas. La clé OpenAI ne quitte jamais le serveur ; seuls les noms des repas sont envoyés à OpenAI pour l’analyse.</p></div>
  </section>;
}
