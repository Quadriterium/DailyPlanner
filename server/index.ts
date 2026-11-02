import { readConfig } from './config.js';
import { Store } from './database.js';
import { buildApp } from './app.js';
import { AiWorker } from './ai.js';
import { Accounts } from './auth/accounts.js';

const config = readConfig();
const store = new Store(config);
const app = await buildApp(store, config);
const worker = new AiWorker(store, config, message => app.log.error({ component: 'openai' }, message));
const accounts = new Accounts(store, config.AUTH_SESSION_DAYS);
function purge() {
  try { accounts.purge(); }
  catch (error) { app.log.error(error); }
}
purge();
const timer = setInterval(() => { void worker.tick(); }, 5000);
const purgeTimer = setInterval(purge, 3_600_000);
let stopping = false;
async function shutdown() {
  if (stopping) return;
  stopping = true;
  clearInterval(timer);
  clearInterval(purgeTimer);
  await worker.stop();
  await app.close();
  store.close();
  process.exitCode = 0;
}
process.on('SIGINT', () => { void shutdown(); });
process.on('SIGTERM', () => { void shutdown(); });
try {
  await app.listen({ host: config.HOST, port: config.PORT });
  if (!config.OPENAI_API_KEY) app.log.warn('OPENAI_API_KEY absente : les repas seront sauvegardés, les analyses resteront en attente.');
  app.log.info(config.authEnabled
    ? `Authentification Google activée (${config.PUBLIC_ORIGIN}) : seuls les foyers sont accessibles.`
    : 'Authentification désactivée : espace commun partagé sans compte.');
  void worker.tick();
} catch (error) {
  clearInterval(timer);
  clearInterval(purgeTimer);
  app.log.error(error);
  store.close();
  process.exitCode = 1;
}
