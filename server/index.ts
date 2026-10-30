import { readConfig } from './config.js';
import { Store } from './database.js';
import { buildApp } from './app.js';
import { AiWorker } from './ai.js';

const config = readConfig();
const store = new Store(config);
const app = await buildApp(store, config);
const worker = new AiWorker(store, config, message => app.log.error({ component: 'openai' }, message));
const timer = setInterval(() => { void worker.tick(); }, 5000);
let stopping = false;
async function shutdown() {
  if (stopping) return;
  stopping = true;
  clearInterval(timer);
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
  void worker.tick();
} catch (error) {
  clearInterval(timer);
  app.log.error(error);
  store.close();
  process.exitCode = 1;
}
