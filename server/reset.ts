import { readConfig } from './config.js';
import { Store } from './database.js';
import { Accounts } from './auth/accounts.js';
import { backupDatabase, userByEmail } from './maintenance.js';

const args = process.argv.slice(2);
const option = (name: string) => { const index = args.indexOf(name); return index >= 0 ? args[index + 1] : undefined; };
const spaceOption = option('--space');
const emailOption = option('--email');

if (!args.includes('--confirm') || (!spaceOption === !emailOption)) {
  console.error('Supprime les repas du planning et les fiches du carnet (avec leurs analyses) d’un seul espace, puis force ses appareils à effacer leurs copies locales.');
  console.error('Les paramètres (modèle, convives) et compteurs IA sont conservés. Une sauvegarde est créée au préalable.');
  console.error('Usage : npm run reset -- --space <common|identifiant> --confirm');
  console.error('        npm run reset -- --email <adresse> --confirm   (foyer de ce compte)');
  process.exitCode = 1;
} else {
  const config = readConfig();
  const store = new Store(config);
  try {
    const spaceId = spaceOption ?? new Accounts(store, config.AUTH_SESSION_DAYS).membership(userByEmail(store, emailOption!))?.id;
    const space = spaceId ? store.space(spaceId) : undefined;
    if (!space) throw new Error('Espace introuvable. Listez-les avec : npm run admin -- spaces');
    console.log(`Sauvegarde créée : ${backupDatabase(config, 'avant-reset')}`);
    const resetId = store.reset(space.id);
    console.log(`Repas supprimés dans « ${space.name} ». Ses appareils effaceront leurs copies locales à la prochaine synchronisation (${resetId}).`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  } finally { store.close(); }
}
