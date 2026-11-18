import {
  pushInfoSchema, pushStatusSchema, pushTestSchema, type PushStatus,
} from '../shared/push';

export type Reminders = { lunch: string | null; dinner: string | null };
export type PushInfo = { configured: boolean; publicKey: string | null };

/** Why this device cannot receive notifications, or null when it can. */
export function pushUnsupportedReason(): string | null {
  if (import.meta.env.DEV) return 'Les notifications sont disponibles après le build de production (npm run build).';
  if (!window.isSecureContext) return 'Les notifications nécessitent HTTPS.';
  const ios = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.userAgent.includes('Macintosh') && navigator.maxTouchPoints > 1);
  const standalone = window.matchMedia('(display-mode: standalone)').matches || (navigator as { standalone?: boolean }).standalone === true;
  if (ios && !standalone) return 'Sur iPhone et iPad, ajoutez d’abord l’application à l’écran d’accueil (Partager → Sur l’écran d’accueil), puis ouvrez-la depuis son icône.';
  if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) {
    return ios ? 'Mettez à jour iOS (16.4 ou plus récent) pour recevoir des notifications.' : 'Ce navigateur ne prend pas en charge les notifications.';
  }
  return null;
}

export function notificationPermission(): NotificationPermission {
  return 'Notification' in window ? Notification.permission : 'default';
}

async function request(path: string, payload?: unknown): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(path, {
      method: payload === undefined ? 'GET' : 'POST', cache: 'no-store', signal: AbortSignal.timeout(10_000),
      ...(payload === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) }),
    });
  } catch (error) {
    throw new Error('Serveur inaccessible. Les notifications nécessitent une connexion.', { cause: error });
  }
  const body: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const message = typeof body === 'object' && body !== null && 'error' in body && typeof body.error === 'string' ? body.error : null;
    throw new Error(message ?? `Demande refusée (HTTP ${response.status}).`);
  }
  return body;
}

export async function loadPushInfo(): Promise<PushInfo> {
  const result = pushInfoSchema.safeParse(await request('/api/push'));
  if (!result.success) throw new Error('Réponse serveur incompatible.');
  return result.data;
}

async function registration(): Promise<ServiceWorkerRegistration> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      navigator.serviceWorker.ready,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('Application hors ligne pas encore prête : rechargez la page et réessayez.')), 10_000);
      }),
    ]);
  } finally { clearTimeout(timer); }
}

function keyBytes(base64Url: string): Uint8Array<ArrayBuffer> {
  const base64 = base64Url.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(base64Url.length / 4) * 4, '=');
  return Uint8Array.from(atob(base64), char => char.charCodeAt(0));
}

function sameKey(subscription: PushSubscription, publicKey: string): boolean {
  const current = subscription.options.applicationServerKey;
  if (!current) return false;
  const a = new Uint8Array(current);
  const b = keyBytes(publicKey);
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

function statusOf(body: unknown): PushStatus {
  const result = pushStatusSchema.safeParse(body);
  if (!result.success) throw new Error('Réponse serveur incompatible.');
  return result.data;
}

const notRegistered = (admin = false): PushStatus => ({ registered: false, lunch: null, dinner: null, admin });

/** State of this device for the signed-in account. */
export async function loadPushStatus(): Promise<PushStatus> {
  if (pushUnsupportedReason() || notificationPermission() !== 'granted') return notRegistered();
  const subscription = await (await registration()).pushManager.getSubscription();
  if (!subscription) return notRegistered();
  return statusOf(await request('/api/push/status', { endpoint: subscription.endpoint }));
}

/**
 * Must be called directly from a click: iOS only shows the permission prompt during a user gesture,
 * so the request comes before any other await.
 */
export async function enablePush(publicKey: string, reminders: Reminders): Promise<PushStatus> {
  const permission = await Notification.requestPermission();
  if (permission !== 'granted') {
    throw new Error(permission === 'denied'
      ? 'Notifications refusées. Autorisez-les dans les réglages du téléphone pour cette application, puis réessayez.'
      : 'Autorisation non accordée.');
  }
  const manager = (await registration()).pushManager;
  let subscription = await manager.getSubscription();
  // The server keys changed: the old subscription can no longer receive anything.
  if (subscription && !sameKey(subscription, publicKey)) {
    await subscription.unsubscribe();
    subscription = null;
  }
  subscription ??= await manager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(publicKey) });
  return statusOf(await request('/api/push/subscription', { subscription: subscription.toJSON(), ...reminders }));
}

export async function updateReminders(reminders: Reminders): Promise<PushStatus> {
  const subscription = await (await registration()).pushManager.getSubscription();
  if (!subscription) throw new Error('Notifications désactivées sur cet appareil.');
  return statusOf(await request('/api/push/subscription', { subscription: subscription.toJSON(), ...reminders }));
}

export async function disablePush(): Promise<PushStatus> {
  const subscription = await (await registration()).pushManager.getSubscription();
  if (subscription) {
    await request('/api/push/unsubscribe', { endpoint: subscription.endpoint });
    await subscription.unsubscribe();
  }
  return notRegistered();
}

export async function testPush(): Promise<number> {
  const result = pushTestSchema.safeParse(await request('/api/push/test', {}));
  if (!result.success) throw new Error('Réponse serveur incompatible.');
  return result.data.devices;
}

/** Best effort before signing out: this device stops receiving the account's notifications. */
export async function forgetPushDevice() {
  try {
    if (pushUnsupportedReason()) return;
    const current = await navigator.serviceWorker.getRegistration();
    const subscription = await current?.pushManager.getSubscription();
    if (!subscription) return;
    await request('/api/push/unsubscribe', { endpoint: subscription.endpoint }).catch(() => { /* The server also forgets it when sessions are revoked. */ });
    await subscription.unsubscribe();
  } catch { /* Never blocks the sign-out. */ }
}
