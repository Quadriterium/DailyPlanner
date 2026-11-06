import { useEffect, useRef, useState } from 'react';
import { z } from 'zod';
import { userMessagesSchema, type UserMessage } from '../shared/messages';
import { Modal } from './components';
import { errorMessage } from './store';

const okSchema = z.object({ ok: z.literal(true) }).strict();

async function request<T>(path: string, schema: z.ZodType<T>, signal: AbortSignal, method = 'GET'): Promise<T> {
  const response = await fetch(`/api/messages${path}`, {
    method, credentials: 'same-origin', cache: 'no-store', signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]),
  });
  const body: unknown = await response.json();
  if (!response.ok) {
    const parsed = z.object({ error: z.string() }).safeParse(body);
    throw new Error(parsed.success ? parsed.data.error : `Messages indisponibles (${response.status}).`);
  }
  const parsed = schema.safeParse(body);
  if (!parsed.success) throw new Error('Réponse de messagerie invalide. Rechargez la page.');
  return parsed.data;
}

export function UserMessages() {
  const [messages, setMessages] = useState<UserMessage[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [revision, setRevision] = useState(0);
  const controller = useRef<AbortController | null>(null);
  const version = useRef(0);
  const dismissing = useRef(false);
  useEffect(() => {
    const abort = new AbortController();
    controller.current = abort;
    let loading = false;
    async function load() {
      if (document.hidden || loading || dismissing.current) return;
      loading = true;
      const current = version.current;
      try {
        const result = await request('', userMessagesSchema, abort.signal);
        if (!abort.signal.aborted && current === version.current) {
          setMessages(result.messages);
          setError(null);
        }
      } catch (cause) {
        if (!abort.signal.aborted && current === version.current) setError(errorMessage(cause));
      } finally { loading = false; }
    }
    void load();
    const refresh = () => { void load(); };
    const timer = setInterval(refresh, 20_000);
    window.addEventListener('focus', refresh);
    document.addEventListener('visibilitychange', refresh);
    return () => {
      abort.abort();
      clearInterval(timer);
      window.removeEventListener('focus', refresh);
      document.removeEventListener('visibilitychange', refresh);
    };
  }, [revision]);

  async function dismiss() {
    const message = messages[0];
    const abort = controller.current;
    if (!message || !abort || dismissing.current) return;
    dismissing.current = true;
    version.current++;
    setBusy(true);
    setError(null);
    try {
      await request(`/${message.id}/dismiss`, okSchema, abort.signal, 'POST');
      if (!abort.signal.aborted) {
        setMessages(current => current.filter(item => item.id !== message.id));
        setRevision(value => value + 1);
      }
    } catch (cause) {
      if (!abort.signal.aborted) setError(errorMessage(cause));
    } finally {
      dismissing.current = false;
      if (!abort.signal.aborted) setBusy(false);
    }
  }

  if (!messages.length) return error ? <div className="connection-banner" role="alert">
    <span>Messages de l’administration : {error}</span>
    <button className="secondary-button" onClick={() => setRevision(value => value + 1)}>Réessayer</button>
  </div> : null;
  return <Modal title="Message de l’administration" dismissible={false} onClose={() => undefined}>
    <button className="user-message" disabled={busy} onClick={() => void dismiss()}>
      <span className="user-message-text">{messages[0].text}</span>
      <span className="field-hint">{busy ? 'Enregistrement…' : 'Cliquer pour ne plus afficher ce message'}</span>
    </button>
    {error && <p className="inline-error" role="alert">{error} Le message reste visible ; cliquez à nouveau pour réessayer.</p>}
  </Modal>;
}
