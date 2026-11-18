import { useEffect, useState } from 'react';
import { Bell, Send } from 'lucide-react';
import type { PushStatus } from '../shared/push';
import { errorMessage, signInHint, type AuthState } from './store';
import {
  disablePush, enablePush, loadPushInfo, loadPushStatus, notificationPermission, pushUnsupportedReason, testPush, updateReminders,
  type PushInfo, type Reminders,
} from './push';

const slots = [['lunch', 'Rappel du midi', '11:00'], ['dinner', 'Rappel du soir', '17:00']] as const;

/** Per-device switch: messages, answers to requests, meal reminders and, for the administrator, server alerts. */
export function Notifications({ auth, online }: { auth: AuthState; online: boolean }) {
  const signedIn = auth.mode === 'signed-in';
  const [info, setInfo] = useState<PushInfo | null>(null);
  const [status, setStatus] = useState<PushStatus | null>(null);
  const [times, setTimes] = useState({ lunch: '11:00', dinner: '17:00' });
  const [enabled, setEnabled] = useState<Record<'lunch' | 'dinner', boolean>>({ lunch: false, dinner: true });
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const unsupported = pushUnsupportedReason();

  useEffect(() => {
    if (!signedIn || !online) return;
    let active = true;
    loadPushInfo()
      .then(async loaded => {
        if (!active) return;
        setInfo(loaded);
        if (!loaded.configured || unsupported) return;
        const current = await loadPushStatus();
        if (!active) return;
        setStatus(current);
        if (current.registered) {
          setEnabled({ lunch: current.lunch !== null, dinner: current.dinner !== null });
          setTimes(previous => ({ lunch: current.lunch ?? previous.lunch, dinner: current.dinner ?? previous.dinner }));
        }
      })
      .catch(cause => { if (active) setError(errorMessage(cause)); });
    return () => { active = false; };
  }, [signedIn, online, unsupported]);

  const reminders = (next = enabled, nextTimes = times): Reminders =>
    ({ lunch: next.lunch ? nextTimes.lunch : null, dinner: next.dinner ? nextTimes.dinner : null });

  async function run(action: () => Promise<PushStatus | void>, success?: string) {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const result = await action();
      if (result) setStatus(result);
      if (success) setNotice(success);
    } catch (cause) { setError(errorMessage(cause)); }
    finally { setBusy(false); }
  }

  function toggle(on: boolean) {
    // enablePush asks for the permission first, while the click still counts as a user gesture (iOS).
    if (on && info?.publicKey) void run(() => enablePush(info.publicKey!, reminders()), 'Notifications activées sur cet appareil.');
    else if (!on) void run(disablePush, 'Notifications désactivées sur cet appareil.');
  }

  function changeReminder(next: typeof enabled, nextTimes = times) {
    setEnabled(next);
    setTimes(nextTimes);
    if (status?.registered) void run(() => updateReminders(reminders(next, nextTimes)), 'Rappels enregistrés.');
  }

  let blocker: string | null = null;
  if (!signedIn) blocker = auth.mode === 'disabled' ? 'Les notifications nécessitent des comptes (AUTH_ENABLED=true).' : `${signInHint}.`;
  else if (!online && !info) blocker = 'Indisponible hors ligne.';
  else if (info && !info.configured) blocker = 'Les notifications ne sont pas configurées sur ce serveur.';
  else if (unsupported) blocker = unsupported;
  const denied = notificationPermission() === 'denied';
  const registered = status?.registered ?? false;

  return <div className="settings-card">
    <h3><Bell size={19} />Notifications</h3>
    {blocker ? <p className="info-box">{blocker}</p> : !info ? <p className="field-hint">Chargement…</p> : <>
      <label className="checkbox-field"><input type="checkbox" checked={registered} disabled={busy || !online || (denied && !registered)}
        onChange={event => toggle(event.target.checked)} />Recevoir des notifications sur cet appareil</label>
      <p className="field-hint">Messages de l’administrateur, réponses à vos demandes d’évolution et rappel des repas prévus.</p>
      {denied && !registered && <p className="info-box">Les notifications sont bloquées pour cette application. Autorisez-les dans les réglages du téléphone ou du navigateur, puis rechargez la page.</p>}
      <fieldset className="reminder-options" disabled={busy || !online}>
        <legend className="field-label">Rappels des repas</legend>
        {slots.map(([slot, label]) => <div key={slot} className="reminder-row">
          <label className="checkbox-field"><input type="checkbox" checked={enabled[slot]}
            onChange={event => changeReminder({ ...enabled, [slot]: event.target.checked })} />{label}</label>
          <input type="time" required aria-label={`Heure du ${label.toLowerCase()}`} value={times[slot]} disabled={!enabled[slot]}
            onChange={event => {
              if (/^\d{2}:\d{2}$/.test(event.target.value)) setTimes({ ...times, [slot]: event.target.value });
            }}
            onBlur={() => { if (status?.registered && times[slot] !== status[slot]) changeReminder(enabled); }} />
        </div>)}
        <p className="field-hint">Envoyés seulement si un plat est prévu, avec les noms des plats (heure de Paris).</p>
      </fieldset>
      {registered && status?.admin && <p className="info-box">Compte administrateur : cet appareil reçoit aussi les alertes (nouveau compte, nouvelle demande, plafond IA atteint).</p>}
      {registered && <div className="settings-actions">
        <button className="secondary-button" disabled={busy || !online}
          onClick={() => void run(async () => { await testPush(); }, 'Notification de test envoyée : elle doit arriver dans quelques secondes.')}>
          <Send size={16} />Envoyer une notification de test</button>
      </div>}
    </>}
    {notice && <p className="field-hint" role="status">{notice}</p>}
    {error && <p className="inline-error" role="alert">{error}</p>}
  </div>;
}
