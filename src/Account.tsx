import { useEffect, useState, type ReactNode } from 'react';
import { Check, Copy, DoorOpen, Home, LogOut, Pencil, UserMinus, UserPlus, Users, X } from 'lucide-react';
import type { SpaceDetails } from '../shared/model';
import { Modal } from './components';
import {
  acknowledgeRevoked, createInvitation, errorMessage, leaveSpace, loadSpace, removeMember, renameSpace, revokeInvitation, signIn, signOut,
  type AuthState,
} from './store';

const dateFormat = new Intl.DateTimeFormat('fr-FR', { dateStyle: 'short', timeZone: 'Europe/Paris' });

function plural(count: number, word: string) {
  return `${count} ${word}${count > 1 ? 's' : ''}`;
}

export function initials(name: string) {
  const letters = name.trim().split(/\s+/).filter(Boolean).slice(0, 2).map(part => part[0]!.toUpperCase()).join('');
  return letters || '?';
}

/** Logo « G » multicolore des règles de marque Google. */
function GoogleLogo() {
  return <svg className="google-logo" viewBox="0 0 48 48" width="18" height="18" aria-hidden="true">
    <path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z" />
    <path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z" />
    <path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z" />
    <path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z" />
  </svg>;
}

export function GoogleButton({ reachable, compact = false, label = 'Se connecter avec Google', invitation, onError }: {
  reachable: boolean; compact?: boolean; label?: string; invitation?: string; onError: (message: string) => void;
}) {
  const [busy, setBusy] = useState(false);
  const offline = !reachable || (typeof navigator !== 'undefined' && !navigator.onLine);
  async function start() {
    setBusy(true);
    try { await signIn(invitation); }
    catch (error) { onError(errorMessage(error)); setBusy(false); }
  }
  return <button type="button" className={`google-button ${compact ? 'compact' : ''}`} disabled={busy || offline}
    title={offline ? 'La connexion nécessite le réseau' : undefined} onClick={() => void start()}>
    <GoogleLogo /><span>{busy ? 'Redirection…' : label}</span>
  </button>;
}

export function Confirm({ title, children, confirmLabel, danger = false, onConfirm, onClose }: {
  title: string; children: ReactNode; confirmLabel: string; danger?: boolean; onConfirm: () => Promise<void> | void; onClose: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function confirm() {
    setBusy(true);
    setError(null);
    try { await onConfirm(); onClose(); }
    catch (cause) { setError(errorMessage(cause)); setBusy(false); }
  }
  return <Modal title={title} onClose={() => { if (!busy) onClose(); }}>
    <div className="notice-text">{children}</div>
    {error && <p className="inline-error" role="alert">{error}</p>}
    <div className="confirm-actions">
      <button type="button" className="secondary-button" disabled={busy} onClick={onClose}>Annuler</button>
      <button type="button" className={`primary-button ${danger ? 'danger-fill' : ''}`} disabled={busy} onClick={() => void confirm()}>{confirmLabel}</button>
    </div>
  </Modal>;
}

function LegalLinks() {
  return <p className="legal-links"><a href="/confidentialite">Confidentialité</a><span aria-hidden="true">·</span><a href="/conditions-utilisation">Conditions d’utilisation</a></p>;
}

/** Carte « Compte et foyer » en tête des paramètres ; absente quand l'authentification est désactivée. */
export function AccountCard({ auth, reachable, pending, onNotice }: {
  auth: AuthState; reachable: boolean; pending: number; onNotice: (title: string, text: string) => void;
}) {
  const [details, setDetails] = useState<SpaceDetails | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [nameDraft, setNameDraft] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [link, setLink] = useState<{ url: string; copied: boolean } | null>(null);
  const [confirm, setConfirm] = useState<'leave' | 'logout' | { remove: string; name: string } | null>(null);
  const signedIn = auth.mode === 'signed-in';
  const spaceId = auth.space?.id;

  useEffect(() => {
    if (!signedIn || !reachable) return;
    let active = true;
    loadSpace().then(value => { if (active) { setDetails(value); setError(null); } })
      .catch(cause => { if (active) setError(errorMessage(cause)); });
    return () => { active = false; };
  }, [signedIn, reachable, spaceId]);

  async function run(action: () => Promise<SpaceDetails | void>) {
    setBusy(true);
    setError(null);
    try {
      const result = await action();
      if (result) setDetails(result);
    } catch (cause) { setError(errorMessage(cause)); }
    finally { setBusy(false); }
  }

  async function invite() {
    await run(async () => {
      const created = await createInvitation();
      let copied = false;
      try { await navigator.clipboard.writeText(created.url); copied = true; } catch { /* The link stays selectable below. */ }
      setLink({ url: created.url, copied });
      return loadSpace();
    });
  }

  if (auth.mode === 'disabled') return null;
  const lost = pending ? ` ${plural(pending, 'modification')} non envoyée${pending > 1 ? 's' : ''} de ce foyer ${pending > 1 ? 'seront perdues' : 'sera perdue'}.` : '';

  if (auth.mode === 'guest' || auth.mode === 'unknown') return <div className="settings-card account-card">
    <h3><Home size={19} />Compte et foyer</h3>
    <p>Vos repas sont enregistrés uniquement sur cet appareil. Connectez-vous pour les retrouver partout, les partager et utiliser l’IA.</p>
    <GoogleButton reachable={reachable} onError={message => setError(message)} />
    {error && <p className="inline-error" role="alert">{error}</p>}
    <LegalLinks />
  </div>;

  const user = auth.user!;
  const header = <div className="account-identity">
    <span className="avatar" aria-hidden="true">{initials(user.name)}</span>
    <span><strong>{user.name || 'Compte Google'}</strong>{user.email && <small>{user.email}</small>}</span>
  </div>;

  if (auth.mode === 'expired') return <div className="settings-card account-card">
    <h3><Home size={19} />Compte et foyer</h3>
    {header}
    <p className="info-box">Session expirée — reconnectez-vous{pending ? ` pour envoyer vos ${plural(pending, 'modification')}` : ''}. Vos repas restent consultables et modifiables sur cet appareil.</p>
    <GoogleButton reachable={reachable} label="Se reconnecter avec Google" onError={message => setError(message)} />
    {error && <p className="inline-error" role="alert">{error}</p>}
    <LegalLinks />
  </div>;

  if (auth.mode === 'revoked') return <div className="settings-card account-card">
    <h3><Home size={19} />Compte et foyer</h3>
    {header}
    <p className="info-box">Vous ne faites plus partie du foyer « {auth.space?.name} ».{lost} Un nouveau foyer vous attend.</p>
    <div className="settings-actions"><button className="secondary-button" disabled={busy}
      onClick={() => void run(async () => { await acknowledgeRevoked(); })}><Check size={16} />Continuer</button></div>
    {error && <p className="inline-error" role="alert">{error}</p>}
  </div>;

  const spaceName = details?.name ?? auth.space?.name ?? '';
  const others = details?.members.filter(member => !member.isMe).length ?? 0;
  return <div className="settings-card account-card">
    <h3><Home size={19} />Compte et foyer</h3>
    {header}
    <form className="space-name" onSubmit={event => {
      event.preventDefault();
      if (nameDraft === null || !nameDraft.trim()) return;
      void run(async () => { const result = await renameSpace(nameDraft.trim()); setNameDraft(null); return result; });
    }}>
      <label className="field-label" htmlFor="space-name">Nom du foyer</label>
      <div className="inline-field">
        <input id="space-name" maxLength={60} value={nameDraft ?? spaceName} disabled={busy || !reachable}
          onChange={event => setNameDraft(event.target.value)} />
        <button className="secondary-button" disabled={busy || nameDraft === null || !nameDraft.trim() || nameDraft.trim() === spaceName}>
          <Pencil size={15} />Renommer</button>
      </div>
    </form>
    <h4><Users size={16} />Membres</h4>
    {details ? <ul className="member-list">{details.members.map(member => <li key={member.id}>
      <span className="avatar small" aria-hidden="true">{initials(member.name)}</span>
      <span className="member-name"><strong>{member.name}{member.isMe ? ' (vous)' : ''}</strong>{member.email && <small>{member.email}</small>}</span>
      {!member.isMe && <button className="text-button" disabled={busy} onClick={() => setConfirm({ remove: member.id, name: member.name })}>
        <UserMinus size={15} />Retirer</button>}
    </li>)}</ul> : <p className="field-hint">{reachable ? 'Chargement du foyer…' : 'La liste des membres nécessite le réseau.'}</p>}
    <div className="settings-actions">
      <button className="secondary-button" disabled={busy || !reachable} onClick={() => void invite()}><UserPlus size={16} />Inviter quelqu’un</button>
    </div>
    {link && <div className="invitation-link" role="status">
      <p>{link.copied ? 'Lien copié. ' : 'Copiez ce lien : '}Valable 7 jours, une seule utilisation.</p>
      <input readOnly value={link.url} aria-label="Lien d’invitation" onFocus={event => event.currentTarget.select()} />
      {!link.copied && <button className="text-button" onClick={() => void navigator.clipboard?.writeText(link.url).then(() => setLink({ ...link, copied: true }))}>
        <Copy size={15} />Copier</button>}
    </div>}
    {details && details.invitations.length > 0 && <>
      <h4>Invitations en attente</h4>
      <ul className="member-list">{details.invitations.map(invitation => <li key={invitation.id}>
        <span className="member-name"><strong>Créée par {invitation.createdBy}</strong><small>Expire le {dateFormat.format(invitation.expiresAt)}</small></span>
        <button className="text-button" disabled={busy} onClick={() => void run(() => revokeInvitation(invitation.id))}><X size={15} />Révoquer</button>
      </li>)}</ul>
    </>}
    {error && <p className="inline-error" role="alert">{error}</p>}
    <div className="settings-actions">
      <button className="text-button" disabled={busy || !reachable} onClick={() => setConfirm('leave')}><DoorOpen size={16} />Quitter le foyer</button>
      <button className="text-button" disabled={busy} onClick={() => setConfirm('logout')}><LogOut size={16} />Se déconnecter</button>
    </div>
    <LegalLinks />
    {confirm === 'leave' && <Confirm title="Quitter le foyer ?" confirmLabel="Quitter le foyer" danger
      onClose={() => setConfirm(null)} onConfirm={async () => { await leaveSpace(); setDetails(null); }}>
      <p>Vous quitterez « {spaceName} ». Ses repas y restent{others ? ' pour les autres membres' : ''} et ne vous suivront pas.{lost} Un nouveau foyer vide sera créé pour vous.</p>
    </Confirm>}
    {confirm === 'logout' && <Confirm title="Se déconnecter ?" confirmLabel="Se déconnecter"
      onClose={() => setConfirm(null)} onConfirm={async () => {
        const waiting = await signOut();
        if (waiting) onNotice('Déconnecté', `${plural(waiting, 'modification')} ${waiting > 1 ? 'restent' : 'reste'} sur cet appareil et ${waiting > 1 ? 'seront envoyées' : 'sera envoyée'} à votre prochaine connexion avec ce compte.`);
      }}>
      <p>Le carnet de ce foyer reste sur cet appareil pour votre prochaine connexion. Vous repasserez en mode invité.</p>
    </Confirm>}
    {typeof confirm === 'object' && confirm !== null && <Confirm title="Retirer ce membre ?" confirmLabel="Retirer" danger
      onClose={() => setConfirm(null)} onConfirm={async () => { setDetails(await removeMember(confirm.remove)); }}>
      <p>{confirm.name} n’aura plus accès aux repas de « {spaceName} ». Ses modifications non envoyées seront perdues.</p>
    </Confirm>}
  </div>;
}
