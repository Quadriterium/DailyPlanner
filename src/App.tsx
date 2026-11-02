import { useEffect, useRef, useState } from 'react';
import { BookOpen, CalendarDays, Check, CircleAlert, CloudOff, Download, Leaf, RefreshCw, Settings2 } from 'lucide-react';
import { mealId, parisDate, type InvitationPreview, type Slot } from '../shared/model';
import { Modal } from './components';
import { Planner } from './Planner';
import { MealEditor } from './MealEditor';
import { Library } from './Library';
import { Settings } from './Settings';
import {
  acceptInvitation, currentAuth, errorMessage, finishSignIn, forgetInvitation, guestRecordsToImport, importGuestData, initialize, pendingInvitation, previewInvitation,
  resolveLegacy, synchronize, synchronizeInBackground, takeAuthReturn, takeInvitationFragment, usePlanner, type AuthReturn,
} from './store';
import { Confirm, GoogleButton } from './Account';
import { checkForUpdate, pwaStatus, registerPwa } from './pwa';
import { useTheme } from './theme';

interface InstallEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}
type Notice = { title: string; text: string; kind: 'success' | 'error' | 'info' };
type InvitationDialog = { token: string; preview: InvitationPreview; kind: 'guest' | 'confirm' };

const authErrors: Record<string, string> = {
  cancelled: 'Connexion annulée. Vos repas restent sur cet appareil.',
  expired: 'La demande de connexion a expiré. Réessayez ; vos repas restent sur cet appareil.',
  invalid: 'La connexion Google n’a pas pu être vérifiée. Réessayez ; vos repas restent sur cet appareil.',
};
const invalidInvitation = 'Cette invitation n’est plus valable. Demandez un nouveau lien.';

function plural(count: number, word: string) {
  return `${count} ${word}${count > 1 ? 's' : ''}`;
}

export function App() {
  const state = usePlanner();
  const appearance = useTheme();
  const [tab, setTab] = useState<'planner' | 'library' | 'settings'>('planner');
  const [today, setToday] = useState(parisDate());
  const [selected, setSelected] = useState<{ date: string; slot: Slot; start: string; index?: 1 } | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [toast, setToast] = useState(false);
  const [recentMeal, setRecentMeal] = useState<string | null>(null);
  const [, updatePwa] = useState(0);
  const [installEvent, setInstallEvent] = useState<InstallEvent | null>(null);
  const [invitation, setInvitation] = useState<InvitationDialog | null>(null);
  const started = useRef(false);
  const taps = useRef({ count: 0, last: 0 });
  const forcing = useRef(false);
  const dishes = state.records.filter(record => record.type === 'dish');
  const meals = state.records.filter(record => record.type === 'meal');
  const settings = state.records.find(record => record.type === 'settings');
  const otherSelectedMeal = selected ? meals.find(meal =>
    meal.date === selected.date && meal.slot === selected.slot &&
    meal.id !== mealId(selected.date, selected.slot, selected.index) && meal.text.trim()) : undefined;
  const pwa = pwaStatus();
  const enriching = Boolean(state.capabilities?.aiConfigured) && dishes.some(dish => {
    const analysis = state.analyses.find(item => item.dishId === dish.id && item.analysisKey === dish.analysisKey);
    return !dish.archived && !dish.details && !analysis?.error &&
      (!analysis || analysis.status === 'pending' || analysis.status === 'processing');
  });

  useEffect(() => {
    if (!enriching) return;
    const timer = setInterval(() => { if (!document.hidden) synchronizeInBackground(); }, 2000);
    return () => clearInterval(timer);
  }, [enriching]);

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    const authReturn = takeAuthReturn();
    const token = takeInvitationFragment();
    void initialize().then(() => start(authReturn, token)).then(synchronizeInBackground).catch(error => {
      setNotice({ kind: 'error', title: 'Stockage indisponible', text: errorMessage(error) });
    });
  }, []);

  useEffect(() => {
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

  /** Return from Google, invitation link, or resumption of an interrupted import of the guest notebook. */
  async function start(authReturn: AuthReturn | null, token: string | null) {
    try {
      if (authReturn?.status === 'error' && authReturn.reason !== 'invitation_invalid') {
        setNotice({ kind: 'error', title: 'Connexion impossible', text: authErrors[authReturn.reason] ?? authErrors.invalid! });
        return;
      }
      if (authReturn) {
        if (authReturn.status === 'error') forgetInvitation();
        setNotice({ kind: 'info', title: 'Connecté', text: 'Connecté — synchronisation de vos repas…' });
        const result = await finishSignIn(authReturn.status === 'ok' && authReturn.joined);
        if (result.invitation === 'confirmation_required') {
          const pending = pendingInvitation();
          const preview = pending ? await previewInvitation(pending) : null;
          if (pending && preview) {
            setNotice(null);
            setInvitation({ token: pending, preview, kind: 'confirm' });
            return;
          }
          forgetInvitation();
          await importGuestData();
        }
        const joined = authReturn.status === 'ok' && authReturn.joined || result.invitation === 'joined';
        setNotice(authReturn.status === 'error' || result.invitation === 'invalid'
          ? { kind: 'info', title: 'Connecté', text: `Vous êtes connecté, mais ${invalidInvitation.charAt(0).toLowerCase()}${invalidInvitation.slice(1)}` }
          : { kind: 'success', title: 'Connecté', text: joined ? 'Vous avez rejoint le foyer. Bon appétit !'
            : result.imported ? `${plural(result.imported, 'élément')} de cet appareil ${result.imported > 1 ? 'ont été ajoutés' : 'a été ajouté'} à votre carnet.`
              : 'Votre carnet est synchronisé sur cet appareil.' });
        return;
      }
      if (token) { await openInvitation(token); return; }
      if (await guestRecordsToImport()) await importGuestData();
    } catch (error) {
      setNotice({ kind: 'error', title: 'Connexion', text: `${errorMessage(error)} Vos repas restent sur cet appareil.` });
    }
  }

  async function openInvitation(token: string) {
    const preview = await previewInvitation(token);
    if (!preview) {
      forgetInvitation();
      setNotice({ kind: 'error', title: 'Invitation', text: invalidInvitation });
      return;
    }
    if (currentAuth().mode !== 'signed-in') { setInvitation({ token, preview, kind: 'guest' }); return; }
    const result = await acceptInvitation(token, false);
    if (result === 'confirmation_required') setInvitation({ token, preview, kind: 'confirm' });
    else setNotice(result === 'joined'
      ? { kind: 'success', title: 'Bienvenue', text: `Vous avez rejoint « ${preview.spaceName} ».` }
      : { kind: 'error', title: 'Invitation', text: invalidInvitation });
  }

  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(false), 2800);
    return () => clearTimeout(timer);
  }, [toast]);

  useEffect(() => {
    if (!recentMeal) return;
    const timer = setTimeout(() => setRecentMeal(null), 2400);
    return () => clearTimeout(timer);
  }, [recentMeal]);

  function mealSaved(id: string) {
    setToast(true);
    setRecentMeal(id);
  }

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
    setTab('planner');
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

  const connectionText = state.connection === 'local' ? 'Sur cet appareil uniquement'
    : state.connection === 'expired' ? 'Session expirée'
      : state.connection === 'revoked' ? 'Accès au foyer retiré'
        : state.syncing ? 'Synchronisation…'
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
        {tab === 'planner' && <Planner key={today} today={today} meals={meals} dishes={dishes} analyses={state.analyses} cookingLevel={settings?.cookingLevel} recentMeal={recentMeal} onSelect={(date, slot, start, index) => setSelected({ date, slot, start, index })} onSaved={mealSaved} />}
        {tab === 'library' && <Library dishes={dishes} analyses={state.analyses} online={state.connection === 'online' && Boolean(state.capabilities?.aiConfigured)} onSaved={() => setToast(true)} />}
        {tab === 'settings' && <Settings settings={settings} capabilities={state.capabilities} online={state.connection === 'online'} appearance={appearance}
          lastSync={state.lastSync} pending={state.pending} syncing={state.syncing} onSync={() => void forceSync()} onInstall={() => void install()}
          auth={state.auth} reachable={state.reachable} onNotice={(title, text) => setNotice({ kind: 'info', title, text })} />}
      </>}
    </main>
    {state.loaded && (state.auth.mode === 'guest' || state.auth.mode === 'unknown') && <div className="account-banner" role="region" aria-label="Mode invité">
      <p><strong className="banner-long">Vos repas restent sur cet appareil et peuvent être perdus.</strong>
        <strong className="banner-short">Données sur cet appareil uniquement</strong></p>
      <GoogleButton compact reachable={state.reachable} onError={text => setNotice({ kind: 'error', title: 'Connexion impossible', text })} />
    </div>}
    {state.auth.mode === 'expired' && <div className="account-banner warning" role="status">
      <p><strong>Session expirée</strong> — reconnectez-vous{state.pending ? ` pour envoyer vos ${plural(state.pending, 'modification')}` : ''}.</p>
      <GoogleButton compact reachable={state.reachable} label="Se reconnecter" onError={text => setNotice({ kind: 'error', title: 'Connexion impossible', text })} />
    </div>}
    {state.auth.mode === 'revoked' && <div className="account-banner warning" role="status">
      <p><strong>Vous ne faites plus partie de ce foyer.</strong></p>
      <button className="secondary-button" onClick={() => setTab('settings')}>Voir</button>
    </div>}
    <footer className="app-footer"><span className={`connection-indicator ${state.connection}`} aria-live="polite">
      {state.syncing ? <RefreshCw size={12} className="spinning" /> : <span className="status-dot" />}{connectionText}</span>
      <span className="footer-signature">Le plaisir des choses simples</span>
    </footer>
    {pwa.error && tab !== 'settings' && <p className="pwa-warning" role="alert">Mode hors ligne : {pwa.error}</p>}
    {selected && <MealEditor key={mealId(selected.date, selected.slot, selected.index)} {...selected} today={today} dishes={dishes} analyses={state.analyses}
      aiConfigured={Boolean(state.capabilities?.aiConfigured)}
      household={settings?.household} cookingLevel={settings?.cookingLevel}
      meal={meals.find(meal => meal.id === mealId(selected.date, selected.slot, selected.index))}
      onAddDish={!otherSelectedMeal ? () => setSelected({ ...selected, index: selected.index === 1 ? undefined : 1 }) : undefined}
      onClose={() => setSelected(null)} onSaved={() => mealSaved(mealId(selected.date, selected.slot, selected.index))} />}
    {toast && <div className="toast" role="status"><Check size={17} />Enregistré sur cet appareil</div>}
    {invitation?.kind === 'guest' && <Modal title="Invitation" onClose={() => { forgetInvitation(); setInvitation(null); }}>
      <p className="notice-text">{invitation.preview.invitedBy} vous invite à rejoindre « {invitation.preview.spaceName} ». Vos repas de cet appareil y seront ajoutés.</p>
      <div className="confirm-actions">
        <GoogleButton reachable={state.reachable} invitation={invitation.token} label="Se connecter avec Google pour accepter"
          onError={text => setNotice({ kind: 'error', title: 'Connexion impossible', text })} />
      </div>
    </Modal>}
    {invitation?.kind === 'confirm' && <Confirm title="Changer de foyer ?" confirmLabel={`Rejoindre « ${invitation.preview.spaceName} »`}
      onClose={() => {
        forgetInvitation();
        setInvitation(null);
        void importGuestData().catch(error => setNotice({ kind: 'error', title: 'Import', text: errorMessage(error) }));
      }}
      onConfirm={async () => {
        const result = await acceptInvitation(invitation.token, true);
        setInvitation(null);
        setNotice(result === 'joined'
          ? { kind: 'success', title: 'Bienvenue', text: `Vous avez rejoint « ${invitation.preview.spaceName} ».` }
          : { kind: 'error', title: 'Invitation', text: invalidInvitation });
      }}>
      <p>{invitation.preview.invitedBy} vous invite à rejoindre « {invitation.preview.spaceName} ». Vous quitterez « {state.auth.space?.name} » : ses données y restent et ne vous suivront pas.
        {state.pending ? ` ${plural(state.pending, 'modification')} non envoyée${state.pending > 1 ? 's' : ''} de ce foyer ${state.pending > 1 ? 'seront perdues' : 'sera perdue'}.` : ''}</p>
    </Confirm>}
    {state.legacyPending > 0 && state.auth.mode === 'signed-in' && !invitation && <Confirm title="Ancien carnet commun"
      confirmLabel="Importer les modifications" onClose={() => void resolveLegacy(false)}
      onConfirm={async () => {
        const imported = await resolveLegacy(true);
        setNotice({ kind: 'success', title: 'Import terminé', text: `${plural(imported, 'modification')} de l’ancien carnet commun ${imported > 1 ? 'ont été ajoutées' : 'a été ajoutée'} à votre foyer.` });
      }}>
      <p>Cet appareil contient {plural(state.legacyPending, 'modification')} non synchronisée{state.legacyPending > 1 ? 's' : ''} de l’ancien carnet commun. Importer les modifications non synchronisées de l’ancien carnet commun dans « {state.auth.space?.name} » ? « Annuler » les ignore définitivement sur cet appareil.</p>
    </Confirm>}
    {notice && <Modal title={notice.title} onClose={() => setNotice(null)}>
      <div className={`notice-icon ${notice.kind}`}>{notice.kind === 'error' ? <CloudOff size={27} /> : notice.kind === 'success' ? <Check size={27} /> : <Leaf size={27} />}</div>
      <p className="notice-text">{notice.text}</p>
      <button className="primary-button notice-button" onClick={() => setNotice(null)}>Compris</button>
    </Modal>}
  </div>;
}
