import { DatabaseSync } from 'node:sqlite';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const destination = process.argv[2];
if (!destination) {
  console.error('Usage: npm run backup -- C:\\Sauvegardes\\a-table-2026-10-30.sqlite');
  process.exitCode = 1;
} else {
  const target = resolve(destination);
  const source = resolve(process.env.DATABASE_PATH ?? './data/planner.sqlite');
  if (!existsSync(source)) throw new Error('Base source introuvable. Démarrez d’abord le serveur.');
  if (existsSync(target)) throw new Error('La destination existe déjà ; aucune sauvegarde ne sera écrasée.');
  mkdirSync(dirname(target), { recursive: true });
  const database = new DatabaseSync(source, { readOnly: true });
  try {
    database.prepare('VACUUM INTO ?').run(target);
    console.log(`Sauvegarde créée : ${target}`);
  } finally { database.close(); }
}
