import { useEffect, useRef, useState } from 'react';
import { BookOpen, CalendarDays, Check, CircleAlert, CloudOff, Download, Leaf, RefreshCw, Settings2 } from 'lucide-react';
import { parisDate, recipeUrl, type Slot } from '../shared/model';
import { Modal } from './components';
import { Planner } from './Planner';
import { MealEditor } from './MealEditor';
import { Library } from './Library';
import { Settings } from './Settings';
import { errorMessage, initialize, synchronize, synchronizeInBackground, usePlanner } from './store';
import { checkForUpdate, pwaStatus, registerPwa } from './pwa';
import { useTheme } from './theme';

interface InstallEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}
type Notice = { title: string; text: string; kind: 'success' | 'error' | 'info' };

export function App() {
  const state = usePlanner();
  const appearance = useTheme();
  const [tab, setTab] = useState<'planner' | 'library' | 'settings'>('planner');
  const [today, setToday] = useState(parisDate());
  const [selected, setSelected] = useState<{ date: string; slot: Slot; start: string } | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [toast, setToast] = useState(false);
  const [, updatePwa] = useState(0);
  const [installEvent, setInstallEvent] = useState<InstallEvent | null>(null);
  const taps = useRef({ count: 0, last: 0 });
  const forcing = useRef(false);
  const dishes = state.records.filter(record => record.type === 'dish');
  const meals = state.records.filter(record => record.type === 'meal');
  const settings = state.records.find(record => record.type === 'settings');
  const pwa = pwaStatus();
  const importing = Boolean(state.capabilities?.aiConfigured) && dishes.some(dish => {
    const analysis = state.analyses.find(item => item.dishId === dish.id && item.analysisKey === dish.analysisKey);
    return !dish.archived && !dish.details && (dish.sourceUrl || recipeUrl(dish.name)) &&
      (!analysis || analysis.status === 'pending' || analysis.status === 'processing');
  });

  useEffect(() => {
    if (!importing) return;
    const timer = setInterval(() => { if (!document.hidden) synchronizeInBackground(); }, 2000);
    return () => clearInterval(timer);
  }, [importing]);

  useEffect(() => {
    void initialize().then(synchronizeInBackground).catch(error => {
      setNotice({ kind: 'error', title: 'Stockage indisponible', text: errorMessage(error) });
    });
    registerPwa(() => updatePwa(value => value + 1));
    const sync = () => { if (!document.hidden) { setToday(parisDate()); synchronizeInBackground(); } };
    const timer = setInterval(sync, 20_000);
    window.addEventListener('online', sync);
    window.addEventListener('focus', sync);
    document.addEventListener('visibilitychange', sync);
    const beforeInstall = (event: Event) => {
      if (!('prompt' in event) || typeof event.prompt !== 'function' || !('userChoice' in event)) return;
      event.preventDefault();
      setInstallEvent(event as InstallEvent);
    };
    window.addEventListener('beforeinstallprompt', beforeInstall);
    return () => {
      clearInterval(timer);
      window.removeEventListener('online', sync);
      window.removeEventListener('focus', sync);
      document.removeEventListener('visibilitychange', sync);
      window.removeEventListener('beforeinstallprompt', beforeInstall);
    };
  }, []);

  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(false), 2800);
    return () => clearTimeout(timer);
  }, [toast]);

  async function forceSync() {
    if (forcing.current) return;
    forcing.current = true;
    try {
      await synchronize();
      try { await checkForUpdate(); }
      catch (error) {
        throw new Error('Données synchronisées, mais la vérification de mise à jour a échoué. L’application reste utilisable.', { cause: error });
      }
      setNotice({ kind: 'success', title: 'Tout est à jour', text: 'Votre carnet est synchronisé avec le serveur. Vous pouvez continuer à préparer vos petits plats.' });
    } catch (error) {
      setNotice({ kind: 'error', title: 'Actualisation impossible', text: errorMessage(error) });
    } finally { forcing.current = false; }
  }

  function titleTap() {
    const now = performance.now();
    taps.current.count = now - taps.current.last < 650 ? taps.current.count + 1 : 1;
    taps.current.last = now;
    if (taps.current.count === 4) {
      taps.current.count = 0;
      void forceSync();
    }
  }

  async function install() {
    try {
      if (navigator.storage?.persist) await navigator.storage.persist();
      if (installEvent) {
        await installEvent.prompt();
        await installEvent.userChoice;
        setInstallEvent(null);
      } else setNotice({
        kind: 'info', title: 'Votre carnet à portée de main',
        text: 'Sur Android, ouvrez le menu de Chrome ou Firefox puis « Installer » ou « Ajouter à l’écran d’accueil ». Sur ordinateur, Chrome propose une icône d’installation dans la barre d’adresse. Firefox sur ordinateur reste utilisable comme un site classique. Une première visite en HTTPS est nécessaire.',
      });
    } catch (error) {
      setNotice({ kind: 'error', title: 'Installation indisponible', text: errorMessage(error) });
    }
  }

  const connectionText = state.syncing ? 'Synchronisation…'
    : state.connection === 'offline' ? 'Hors ligne · tout reste ici'
      : state.connection === 'error' ? 'Synchronisation à vérifier'
        : state.pending ? `${state.pending} modification${state.pending > 1 ? 's' : ''} en attente`
          : state.connection === 'online' ? 'Carnet à jour' : 'Ouverture du carnet…';

  return <div className={`app-shell ${tab === 'planner' ? 'planner-view' : ''}`}>
    <header className="masthead">
      <div className="masthead-content">
        <h1><button onClick={titleTap} title="Quatre taps rapides pour actualiser et synchroniser">À table <span>!</span></button></h1>
      </div>
      <nav className="main-nav" aria-label="Navigation principale">
        <button className={tab === 'planner' ? 'active' : ''} aria-current={tab === 'planner' ? 'page' : undefined} onClick={() => setTab('planner')}><CalendarDays size={17} />Mon planning</button>
        <button className={tab === 'library' ? 'active' : ''} aria-current={tab === 'library' ? 'page' : undefined} onClick={() => setTab('library')}><BookOpen size={17} />Mon carnet</button>
        <button className={`settings-nav ${tab === 'settings' ? 'active' : ''}`} aria-label="Paramètres" aria-current={tab === 'settings' ? 'page' : undefined} onClick={() => setTab('settings')}><Settings2 size={18} /><span>Paramètres</span></button>
      </nav>
      {installEvent && <button className="install-shortcut icon-button" onClick={() => void install()} aria-label="Installer À table"><Download size={19} /></button>}
    </header>
    <main>
      {!state.loaded ? <div className="loading-state" role="status">
        {state.error ? <><CircleAlert /><h2>Impossible d’ouvrir le stockage local</h2><p>{state.error}</p><p>Vérifiez les permissions de stockage et l’espace disponible. Aucune saisie ne sera acceptée tant qu’elle ne peut pas être sauvegardée.</p></> : <><Leaf className="spinning" /><p>On met la table…</p></>}
      </div> : <>
        {state.error && <div className="connection-banner" role="status"><CloudOff size={17} /><span>{state.error}</span></div>}
        {tab === 'planner' && <Planner key={today} today={today} meals={meals} dishes={dishes} analyses={state.analyses} onSelect={(date, slot, start) => setSelected({ date, slot, start })} onSaved={() => setToast(true)} />}
        {tab === 'library' && <Library dishes={dishes} analyses={state.analyses} online={state.connection === 'online' && Boolean(state.capabilities?.aiConfigured)} onSaved={() => setToast(true)} />}
        {tab === 'settings' && <Settings settings={settings} capabilities={state.capabilities} online={state.connection === 'online'} appearance={appearance}
          lastSync={state.lastSync} pending={state.pending} syncing={state.syncing} onSync={() => void forceSync()} onInstall={() => void install()} />}
      </>}
    </main>
    <footer className="app-footer"><span className={`connection-indicator ${state.connection}`} aria-live="polite">
      {state.syncing ? <RefreshCw size={12} className="spinning" /> : <span className="status-dot" />}{connectionText}</span>
      <span className="footer-signature">Le plaisir des choses simples</span>
    </footer>
    {pwa.error && tab !== 'settings' && <p className="pwa-warning" role="alert">Mode hors ligne : {pwa.error}</p>}
    {selected && <MealEditor {...selected} today={today} dishes={dishes} analyses={state.analyses}
      meal={meals.find(meal => meal.id === `${selected.date}:${selected.slot}`)}
      onClose={() => setSelected(null)} onSaved={() => setToast(true)} />}
    {toast && <div className="toast" role="status"><Check size={17} />Enregistré sur cet appareil</div>}
    {notice && <Modal title={notice.title} onClose={() => setNotice(null)}>
      <div className={`notice-icon ${notice.kind}`}>{notice.kind === 'error' ? <CloudOff size={27} /> : notice.kind === 'success' ? <Check size={27} /> : <Leaf size={27} />}</div>
      <p className="notice-text">{notice.text}</p>
      <button className="primary-button notice-button" onClick={() => setNotice(null)}>Compris</button>
    </Modal>}
  </div>;
}
