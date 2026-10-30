import { DatabaseSync } from 'node:sqlite';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { readConfig } from './config.js';
import { Store } from './database.js';

if (!process.argv.includes('--confirm')) {
  console.error('Supprime les repas du planning et les fiches du carnet (avec leurs analyses), puis force chaque appareil à effacer ses copies locales de ces repas.');
  console.error('Les paramètres (modèle, foyer) et compteurs IA sont conservés. Une sauvegarde est créée au préalable.');
  console.error('Usage : npm run reset -- --confirm');
  process.exitCode = 1;
} else {
  const config = readConfig();
  const source = resolve(config.DATABASE_PATH);
  if (!existsSync(source)) throw new Error('Base introuvable. Démarrez d’abord le serveur.');
  const backup = join(dirname(source), 'backups', `avant-reset-${new Date().toISOString().replace(/[:.]/g, '-')}.sqlite`);
  mkdirSync(dirname(backup), { recursive: true });
  const reader = new DatabaseSync(source, { readOnly: true });
  try { reader.prepare('VACUUM INTO ?').run(backup); } finally { reader.close(); }
  console.log(`Sauvegarde créée : ${backup}`);
  const store = new Store(config);
  try {
    const resetId = store.reset();
    console.log(`Repas supprimés. Les appareils effaceront leurs copies locales à la prochaine synchronisation (${resetId}).`);
  } finally { store.close(); }
}
