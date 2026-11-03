import { readConfig } from '../server/config';
import { Store } from '../server/database';
import { buildApp } from '../server/app';
import { Accounts } from '../server/auth/accounts';

const config = readConfig();
if (!config.AUTH_TEST_PROVIDER || config.NODE_ENV !== 'test' || config.DATABASE_PATH !== ':memory:') {
  throw new Error('Le serveur admin e2e est réservé au fournisseur simulé et à une base en mémoire.');
}
const store = new Store(config);
const id = '11111111-1111-4111-8111-111111111111';
const now = Date.now();
store.db.prepare(`INSERT INTO users (id, display_name, email, email_verified, created_at, last_login_at)
  VALUES (?, ?, ?, 1, ?, ?)`).run(id, 'Admin Test', 'admin-e2e@example.org', now, now);
store.db.prepare('INSERT INTO identities (provider, subject, user_id, email, created_at) VALUES (?, ?, ?, ?, ?)')
  .run('google', 'admin-e2e', id, 'admin-e2e@example.org', now);
const space = new Accounts(store, 30).ensureHousehold(id);
store.addFeatureRequest(space.id, 'Ajouter une rubrique de test admin', id);
store.addToCatalog({
  name: 'Soupe admin', seasons: ['all'], ingredients: ['500 g de carottes'], recipe: 'Faire cuire les carottes.',
  level: 2, servings: 4, items: [{ name: 'carottes', quantity: 500, unit: 'g' }], vegetarian: true,
}, undefined, space.id);
const app = await buildApp(store, config, { logger: false });
let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  await app.close();
  store.close();
}
process.on('SIGINT', () => { void stop(); });
process.on('SIGTERM', () => { void stop(); });
await app.listen({ host: config.HOST, port: config.PORT });
