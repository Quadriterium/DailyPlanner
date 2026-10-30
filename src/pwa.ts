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
