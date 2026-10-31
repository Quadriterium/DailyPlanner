let registration: ServiceWorkerRegistration | undefined;
let registrationError: string | null = null;
let ready = false;
let updateAvailable = false;
export function registerPwa(onChange: () => void) {
  if (import.meta.env.DEV) return;
  if (!('serviceWorker' in navigator) || !window.isSecureContext) {
    registrationError = 'Le mode hors ligne nécessite HTTPS (ou localhost).';
    onChange();
    return;
  }
  void navigator.serviceWorker.register('/sw.js', { updateViaCache: 'none' }).then(value => {
    registration = value;
    ready = Boolean(value.active);
    updateAvailable = Boolean(value.waiting);
    const watch = () => {
      const installing = value.installing;
      installing?.addEventListener('statechange', () => {
        if (installing.state === 'installed' || installing.state === 'activated') {
          ready = true;
          updateAvailable = Boolean(value.waiting && value.active);
          onChange();
        }
      });
    };
    watch();
    value.addEventListener('updatefound', watch);
    onChange();
  }).catch((error: unknown) => {
    registrationError = error instanceof Error ? error.message : 'Installation du cache hors ligne impossible.';
    console.error('Service worker:', error);
    onChange();
  });
}
export function pwaStatus() { return { ready, updateAvailable, error: registrationError }; }
export async function checkForUpdate() {
  if (!registration) return;
  await registration.update();
}

function waitForInstallation(worker: ServiceWorker) {
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => finish(new Error('Le téléchargement de la mise à jour a pris trop de temps.')), 60_000);
    function finish(error?: Error) {
      clearTimeout(timer);
      worker.removeEventListener('statechange', check);
      if (error) reject(error);
      else resolve();
    }
    function check() {
      if (worker.state === 'installed' || worker.state === 'activated') finish();
      else if (worker.state === 'redundant') finish(new Error('Le téléchargement de la mise à jour a échoué.'));
    }
    worker.addEventListener('statechange', check);
    check();
  });
}

function refreshShell(worker: ServiceWorker) {
  return new Promise<void>((resolve, reject) => {
    const channel = new MessageChannel();
    const timer = setTimeout(() => finish(new Error('Le rafraîchissement a pris trop de temps. Fermez les autres fenêtres de l’application et réessayez.')), 60_000);
    function finish(error?: Error) {
      clearTimeout(timer);
      channel.port1.close();
      if (error) reject(error);
      else resolve();
    }
    channel.port1.onmessage = (event: MessageEvent<unknown>) => {
      const result = event.data;
      if (typeof result !== 'object' || result === null || !('ok' in result)) {
        finish(new Error('Réponse de mise à jour invalide.'));
      } else if (result.ok === true) finish();
      else finish(new Error('Impossible de télécharger tous les fichiers de l’application. Vérifiez la connexion au serveur et réessayez.'));
    };
    try { worker.postMessage({ type: 'REFRESH_SHELL' }, [channel.port2]); }
    catch (cause) { finish(cause instanceof Error ? cause : new Error('Le cache hors ligne est inaccessible.')); }
  });
}

function activateUpdate(worker: ServiceWorker) {
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => finish(new Error('La nouvelle version ne peut pas encore être activée. Fermez les autres fenêtres de l’application et réessayez.')), 15_000);
    function finish(error?: Error) {
      clearTimeout(timer);
      navigator.serviceWorker.removeEventListener('controllerchange', check);
      if (error) reject(error);
      else resolve();
    }
    function check() {
      if (navigator.serviceWorker.controller === worker) finish();
    }
    navigator.serviceWorker.addEventListener('controllerchange', check);
    try { worker.postMessage({ type: 'ACTIVATE_UPDATE' }); }
    catch (cause) { finish(cause instanceof Error ? cause : new Error('Activation de la mise à jour impossible.')); }
    check();
  });
}

export async function refreshApp() {
  if (navigator.onLine === false) throw new Error('Le serveur est inaccessible hors ligne. Réessayez après reconnexion.');
  const current = 'serviceWorker' in navigator && window.isSecureContext
    ? registration ?? await navigator.serviceWorker.getRegistration()
    : undefined;
  if (!current) {
    const response = await fetch(window.location.href, { cache: 'reload', signal: AbortSignal.timeout(15_000) });
    if (!response.ok) throw new Error('Le serveur est inaccessible. L’application n’a pas été rechargée.');
    const document = new DOMParser().parseFromString(await response.text(), 'text/html');
    const files = new Set(Array.from(document.querySelectorAll('script[src], link[rel="stylesheet"], link[rel="modulepreload"]'))
      .map(element => new URL(element.getAttribute('src') ?? element.getAttribute('href') ?? '', response.url || window.location.href).href));
    await Promise.all(Array.from(files, async file => {
      const asset = await fetch(file, { cache: 'reload', signal: AbortSignal.timeout(15_000) });
      if (!asset.ok) throw new Error('Impossible de télécharger tous les fichiers de l’application.');
      await asset.arrayBuffer();
    }));
    return;
  }
  await current.update();
  if (current.installing) await waitForInstallation(current.installing);
  const worker = current.waiting ?? current.active;
  if (!worker) throw new Error('Le cache hors ligne n’est pas encore prêt. Réessayez dans quelques instants.');
  await refreshShell(worker);
  if (current.waiting === worker) await activateUpdate(worker);
}
