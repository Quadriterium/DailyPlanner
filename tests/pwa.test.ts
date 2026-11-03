import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { applyRequiredClientUpdate, refreshApp } from '../src/pwa';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('Mise à jour explicite du client', () => {
  it('vérifie le site sans cache HTTP lorsqu’aucun service worker n’est disponible', async () => {
    vi.stubGlobal('navigator', {});
    vi.stubGlobal('window', { location: { href: 'http://planner.local/' }, isSecureContext: false });
    vi.stubGlobal('DOMParser', class {
      parseFromString() {
        return { querySelectorAll: () => [{ getAttribute: (name: string) => name === 'href' ? '/assets/app.css' : null }] };
      }
    });
    const fetchSite = vi.fn().mockImplementation(async () => new Response('application'));
    vi.stubGlobal('fetch', fetchSite);
    await refreshApp();
    expect(fetchSite).toHaveBeenCalledWith('http://planner.local/', {
      cache: 'reload', signal: expect.any(AbortSignal),
    });
    expect(fetchSite).toHaveBeenCalledWith('http://planner.local/assets/app.css', {
      cache: 'reload', signal: expect.any(AbortSignal),
    });
    fetchSite.mockResolvedValue(new Response('indisponible', { status: 503 }));
    await expect(refreshApp()).rejects.toThrow('serveur est inaccessible');
  });

  it('refuse le rechargement lorsque l’appareil est hors ligne', async () => {
    vi.stubGlobal('navigator', { onLine: false });
    await expect(refreshApp()).rejects.toThrow('hors ligne');
  });

  it('attend l’installation, rafraîchit la nouvelle version puis attend sa prise de contrôle', async () => {
    const events: string[] = [];
    const container = new EventTarget();
    const worker = Object.assign(new EventTarget(), {
      state: 'installing',
      postMessage(message: { type: string }, ports?: MessagePort[]) {
        events.push(message.type);
        if (message.type === 'REFRESH_SHELL') {
          ports?.[0].postMessage({ ok: true });
          ports?.[0].close();
        } else {
          serviceWorker.controller = worker;
          container.dispatchEvent(new Event('controllerchange'));
        }
      },
    });
    const current = {
      installing: worker, waiting: null as typeof worker | null, active: {},
      update: vi.fn().mockResolvedValue(undefined),
    };
    const serviceWorker = Object.assign(container, {
      controller: {} as object,
      getRegistration: vi.fn().mockResolvedValue(current),
    });
    vi.stubGlobal('navigator', { serviceWorker });
    vi.stubGlobal('window', { isSecureContext: true });
    const updating = refreshApp();
    await vi.waitFor(() => expect(current.update).toHaveBeenCalled());
    worker.state = 'installed';
    current.waiting = worker;
    worker.dispatchEvent(new Event('statechange'));
    await updating;
    expect(events).toEqual(['REFRESH_SHELL', 'ACTIVATE_UPDATE']);
    expect(serviceWorker.controller).toBe(worker);
  });

  it('remonte un téléchargement échoué sans activer la nouvelle version', async () => {
    const postMessage = vi.fn((_message: unknown, ports: MessagePort[]) => {
      ports[0].postMessage({ ok: false });
      ports[0].close();
    });
    vi.stubGlobal('navigator', { serviceWorker: {
      getRegistration: async () => ({ update: async () => {}, waiting: { postMessage } }),
    } });
    vi.stubGlobal('window', { isSecureContext: true });
    await expect(refreshApp()).rejects.toThrow('Impossible de télécharger');
    expect(postMessage).toHaveBeenCalledTimes(1);
  });
});

const source = readFileSync(new URL('../pwa/service-worker.js', import.meta.url), 'utf8')
  .replace('__VERSION__', 'test')
  .replace('__PRECACHE__', JSON.stringify(['/index.html', '/assets/app.css']));

describe('Isolation de l’administration du cache PWA', () => {
  it('laisse les navigations admin et les API au réseau, tout en conservant le planning hors ligne', () => {
    const handlers: Record<string, (event: object) => void> = {};
    const match = vi.fn().mockResolvedValue(new Response('planning'));
    runInNewContext(source, {
      self: { location: { origin: 'https://planner.example' }, addEventListener: (name: string, handler: typeof handlers[string]) => { handlers[name] = handler; } },
      caches: { open: async () => ({ match }) }, fetch: vi.fn(), URL,
    });
    for (const path of ['/admin', '/admin/', '/admin/users', '/api/admin/users', '/api/admin/session']) {
      const respondWith = vi.fn();
      handlers.fetch({ request: { url: `https://planner.example${path}`, method: 'GET', mode: 'navigate' }, respondWith });
      expect(respondWith).not.toHaveBeenCalled();
    }
    const respondWith = vi.fn();
    handlers.fetch({ request: { url: 'https://planner.example/', method: 'GET', mode: 'navigate' }, respondWith });
    expect(respondWith).toHaveBeenCalledOnce();
  });
});

describe('Mise à jour imposée par la synchronisation', () => {
  let values: Map<string, string>;
  let reload: ReturnType<typeof vi.fn>;
  let fetchSite: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    values = new Map();
    reload = vi.fn();
    fetchSite = vi.fn().mockImplementation(async () => new Response('application'));
    vi.stubGlobal('sessionStorage', {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
    });
    vi.stubGlobal('navigator', {});
    vi.stubGlobal('window', { location: { href: 'http://planner.local/', reload }, isSecureContext: false });
    vi.stubGlobal('DOMParser', class {
      parseFromString() { return { querySelectorAll: () => [] }; }
    });
    vi.stubGlobal('fetch', fetchSite);
  });

  it('télécharge avant rechargement et ne traite chaque identifiant qu’une fois par onglet', async () => {
    reload.mockImplementation(() => {
      expect(values.get('a-table-client-update')).toBe('breaking-v2');
      expect(fetchSite).toHaveBeenCalledTimes(1);
    });
    expect(await applyRequiredClientUpdate('breaking-v2')).toBe(true);
    expect(reload).toHaveBeenCalledTimes(1);
    expect(await applyRequiredClientUpdate('breaking-v2')).toBe(false);
    expect(fetchSite).toHaveBeenCalledTimes(1);
    reload.mockReset();
    expect(await applyRequiredClientUpdate('breaking-v3')).toBe(true);
    expect(reload).toHaveBeenCalledTimes(1);
    expect(values.get('a-table-client-update')).toBe('breaking-v3');
    values.clear(); // Another tab must download and reload too.
    expect(await applyRequiredClientUpdate('breaking-v3')).toBe(true);
    expect(reload).toHaveBeenCalledTimes(2);
  });

  it('ne mémorise ni ne recharge en cas d’échec et réessaie au prochain signal', async () => {
    fetchSite.mockResolvedValueOnce(new Response('indisponible', { status: 503 }));
    await expect(applyRequiredClientUpdate('breaking-v2')).rejects.toThrow('serveur est inaccessible');
    expect(values.size).toBe(0);
    expect(reload).not.toHaveBeenCalled();
    expect(await applyRequiredClientUpdate('breaking-v2')).toBe(true);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('refuse de recharger si l’acquittement ne peut pas être enregistré', async () => {
    vi.stubGlobal('sessionStorage', {
      getItem: () => null,
      setItem: () => { throw new Error('Stockage indisponible'); },
    });
    await expect(applyRequiredClientUpdate('breaking-v2')).rejects.toThrow('Stockage indisponible');
    expect(reload).not.toHaveBeenCalled();
  });
});

function shell(fetchFile: ReturnType<typeof vi.fn>) {
  const handlers: Record<string, (event: object) => void> = {};
  const cache = { put: vi.fn().mockResolvedValue(undefined) };
  const skipWaiting = vi.fn().mockResolvedValue(undefined);
  const claim = vi.fn().mockResolvedValue(undefined);
  const logger = { error: vi.fn() };
  runInNewContext(source, {
    self: { addEventListener: (name: string, handler: typeof handlers[string]) => { handlers[name] = handler; }, skipWaiting, clients: { claim } },
    caches: { open: async () => cache, keys: async () => [] },
    fetch: fetchFile, AbortSignal, console: logger,
  });
  async function dispatch(name: string, data?: object) {
    const postMessage = vi.fn();
    let work: Promise<void> | undefined;
    handlers[name]({ data, ports: [{ postMessage }], waitUntil: (promise: Promise<void>) => { work = promise; } });
    await work;
    return postMessage;
  }
  return { cache, skipWaiting, claim, logger, dispatch };
}

describe('Cache du service worker', () => {
  it('retélécharge aussi le CSS sans cache HTTP avant de confirmer', async () => {
    const fetchFile = vi.fn().mockImplementation(async () => new Response('nouveau fichier'));
    const app = shell(fetchFile);
    const reply = await app.dispatch('message', { type: 'REFRESH_SHELL' });
    expect(fetchFile.mock.calls.map(([file]) => file)).toEqual(['/index.html', '/assets/app.css']);
    for (const [, options] of fetchFile.mock.calls) expect(options.cache).toBe('reload');
    expect(app.cache.put).toHaveBeenCalledTimes(2);
    expect(reply).toHaveBeenCalledWith({ ok: true });
    expect(app.skipWaiting).not.toHaveBeenCalled();
  });

  it('conserve le cache si le CSS ou son téléchargement échoue', async () => {
    for (const failure of [new Response('erreur', { status: 503 }), new Error('hors ligne')]) {
      const fetchFile = vi.fn().mockResolvedValueOnce(new Response('html'));
      if (failure instanceof Error) fetchFile.mockRejectedValueOnce(failure);
      else fetchFile.mockResolvedValueOnce(failure);
      const app = shell(fetchFile);
      const reply = await app.dispatch('message', { type: 'REFRESH_SHELL' });
      expect(app.cache.put).not.toHaveBeenCalled();
      expect(reply).toHaveBeenCalledWith({ ok: false });
      expect(app.logger.error).toHaveBeenCalled();
    }
  });

  it('ne force l’activation que sur demande explicite', async () => {
    const app = shell(vi.fn());
    await app.dispatch('activate');
    expect(app.claim).not.toHaveBeenCalled();
    await app.dispatch('message', { type: 'ACTIVATE_UPDATE' });
    expect(app.skipWaiting).toHaveBeenCalledTimes(1);
    await app.dispatch('activate');
    expect(app.claim).toHaveBeenCalledTimes(1);
  });
});
