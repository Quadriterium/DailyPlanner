import { readFileSync } from 'node:fs';
import { readConfig } from './config.js';
import { Store } from './database.js';
import { Accounts } from './auth/accounts.js';
import { assignCommon, assignSpace, backupDatabase, listSpaces, listUsers, userByEmail } from './maintenance.js';
import { cookingLevelLabels, detailsSchema, recipeUrlSchema, seasonLabels } from '../shared/model.js';
import { z } from 'zod';

const [command, ...args] = process.argv.slice(2);
const option = (name: string) => { const index = args.indexOf(name); return index >= 0 ? args[index + 1] : undefined; };
const date = (time: number) => new Date(time).toLocaleString('fr-FR', { timeZone: 'Europe/Paris' });
const correctionSchema = z.union([
  z.object({ details: detailsSchema, sourceUrl: recipeUrlSchema.nullable().optional() }).strict(),
  detailsSchema.transform(details => ({ details, sourceUrl: undefined })),
]);

function usage() {
  console.error('Usage : npm run admin -- users');
  console.error('        npm run admin -- spaces');
  console.error('        npm run admin -- assign-common --email <adresse> --confirm');
  console.error('        npm run admin -- assign-space --space <identifiant> --email <adresse> --confirm [--force]');
  console.error('        npm run admin -- revoke-sessions --email <adresse>');
  console.error('        npm run admin -- ai-limit --space <identifiant> --mode <unlimited|default>');
  console.error('        npm run admin -- catalog [--search <texte>] [--removed]');
  console.error('        npm run admin -- catalog-show --id <identifiant>');
  console.error('        npm run admin -- catalog-correct --id <identifiant> --file <fiche.json>');
  console.error('        npm run admin -- catalog-remove --id <identifiant>');
  console.error('        npm run admin -- catalog-restore --id <identifiant>');
  process.exitCode = 1;
}

const config = readConfig();
const store = new Store(config);
try {
  const email = option('--email');
  if (command === 'users') {
    const users = listUsers(store);
    if (!users.length) console.log('Aucun compte.');
    for (const user of users) {
      console.log(`${user.id}  ${user.name}  ${user.email ?? '(sans e-mail)'}${user.emailVerified ? '' : ' (non vérifié)'}`);
      console.log(`  Foyer : ${user.spaceName ? `${user.spaceName} (${user.spaceId})` : 'aucun'}  ·  dernière connexion : ${date(user.lastLoginAt)}`);
    }
  } else if (command === 'spaces') {
    for (const space of listSpaces(store)) {
      console.log(`${space.id}  [${space.kind === 'common' ? 'commun' : 'foyer'}]  ${space.name}`);
      console.log(`  ${space.members} membre(s)  ·  ${space.records} repas/fiches  ·  créé le ${date(space.createdAt)}`);
      console.log(`  IA : ${store.dailyLimit(space.id) === null ? 'sans limite quotidienne' : `${store.dailyLimit(space.id)} requêtes par jour`}`);
    }
  } else if (command === 'ai-limit' && option('--space') && ['unlimited', 'default'].includes(option('--mode') ?? '')) {
    const spaceId = option('--space')!;
    store.setAiLimitExempt(spaceId, option('--mode') === 'unlimited');
    console.log(`IA pour « ${store.space(spaceId)!.name} » : ${store.dailyLimit(spaceId) === null ? 'sans limite quotidienne' : `${store.dailyLimit(spaceId)} requêtes par jour`}.`);
  } else if (command === 'assign-common' && email) {
    if (!args.includes('--confirm')) {
      console.error('Déplace toutes les données de l’espace commun vers le foyer de ce compte, puis vide l’espace commun. Ajoutez --confirm.');
      process.exitCode = 1;
    } else {
      const userId = userByEmail(store, email);
      console.log(`Sauvegarde créée : ${backupDatabase(config, 'avant-assign-common')}`);
      const result = assignCommon(store, userId);
      console.log(`${result.moved}/${result.total} enregistrement(s) retenu(s) dans « ${result.space.name} ». L’espace commun est vidé.`);
    }
  } else if (command === 'assign-space' && email && option('--space')) {
    if (!args.includes('--confirm')) {
      console.error('Rattache un foyer sans membre à ce compte, qui quitte son foyer actuel. Ajoutez --confirm.');
      process.exitCode = 1;
    } else {
      const userId = userByEmail(store, email);
      console.log(`Sauvegarde créée : ${backupDatabase(config, 'avant-assign-space')}`);
      const space = assignSpace(store, option('--space')!, userId, args.includes('--force'));
      console.log(`${email} est désormais membre de « ${space.name} ». Ses appareils basculeront à la prochaine ouverture.`);
    }
  } else if (command === 'revoke-sessions' && email) {
    const count = new Accounts(store, config.AUTH_SESSION_DAYS).revokeSessions(userByEmail(store, email));
    console.log(`${count} session(s) supprimée(s).`);
  } else if (command === 'catalog') {
    const entries = store.catalogEntries(option('--search') ?? '', args.includes('--removed'));
    if (!entries.length) console.log('Aucune fiche dans le catalogue.');
    for (const entry of entries) {
      const { details } = entry;
      console.log(`${entry.id.slice(0, 8)}  ${details.name}${entry.deleted ? '  [retirée]' : ''}`);
      console.log(`  ${details.seasons.map(season => seasonLabels[season]).join(' · ')}  ·  ${details.level ? cookingLevelLabels[details.level] : 'sans niveau'}  ·  ajoutée le ${date(entry.createdAt)}`);
    }
    console.log(`${entries.length} fiche(s).`);
  } else if (command === 'catalog-show' && option('--id')) {
    const { id, details, sourceUrl } = store.catalogEntry(option('--id')!);
    console.log(JSON.stringify({ id, details, ...(sourceUrl ? { sourceUrl } : {}) }, null, 2));
  } else if (command === 'catalog-correct' && option('--id') && option('--file')) {
    const parsed = correctionSchema.safeParse(JSON.parse(readFileSync(option('--file')!, 'utf8')));
    if (!parsed.success) throw new Error(`Fiche invalide : ${parsed.error.issues.map(issue => `${issue.path.join('.')} ${issue.message}`).join(' ; ')}`);
    const entry = store.correctCatalogEntry(option('--id')!, parsed.data.details, parsed.data.sourceUrl);
    console.log(`Fiche « ${entry.details.name} » corrigée. Les appareils la recevront à leur prochaine synchronisation ; les carnets des foyers ne changent pas.`);
  } else if ((command === 'catalog-remove' || command === 'catalog-restore') && option('--id')) {
    const entry = store.setCatalogRemoved(option('--id')!, command === 'catalog-remove');
    console.log(`Fiche « ${entry.details.name} » ${command === 'catalog-remove' ? 'retirée du catalogue' : 'restaurée'}. Les carnets des foyers ne changent pas.`);
  } else usage();
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
} finally { store.close(); }
