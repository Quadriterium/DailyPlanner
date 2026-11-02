import { readConfig } from './config.js';
import { Store } from './database.js';
import { Accounts } from './auth/accounts.js';
import { assignCommon, assignSpace, backupDatabase, listSpaces, listUsers, userByEmail } from './maintenance.js';

const [command, ...args] = process.argv.slice(2);
const option = (name: string) => { const index = args.indexOf(name); return index >= 0 ? args[index + 1] : undefined; };
const date = (time: number) => new Date(time).toLocaleString('fr-FR', { timeZone: 'Europe/Paris' });

function usage() {
  console.error('Usage : npm run admin -- users');
  console.error('        npm run admin -- spaces');
  console.error('        npm run admin -- assign-common --email <adresse> --confirm');
  console.error('        npm run admin -- assign-space --space <identifiant> --email <adresse> --confirm [--force]');
  console.error('        npm run admin -- revoke-sessions --email <adresse>');
  console.error('        npm run admin -- ai-limit --space <identifiant> --mode <unlimited|default>');
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
      console.log(`${user.id.slice(0, 8)}  ${user.name}  ${user.email ?? '(sans e-mail)'}${user.emailVerified ? '' : ' (non vérifié)'}`);
      console.log(`  Foyer : ${user.spaceName ? `${user.spaceName} (${user.spaceId})` : 'aucun'}  ·  dernière connexion : ${date(user.lastLoginAt)}`);
    }
  } else if (command === 'spaces') {
    for (const space of listSpaces(store)) {
      console.log(`${space.id}  [${space.kind === 'common' ? 'commun' : 'foyer'}]  ${space.name}`);
      console.log(`  ${space.members} membre(s)  ·  ${space.records} repas/fiches  ·  créé le ${date(space.createdAt)}`);
      console.log(`  IA : ${store.dailyLimit(space.id) === null ? 'sans limite' : '20 requêtes par jour'}`);
    }
  } else if (command === 'ai-limit' && option('--space') && ['unlimited', 'default'].includes(option('--mode') ?? '')) {
    const spaceId = option('--space')!;
    store.setAiLimitExempt(spaceId, option('--mode') === 'unlimited');
    console.log(`IA pour « ${store.space(spaceId)!.name} » : ${store.dailyLimit(spaceId) === null ? 'sans limite' : '20 requêtes par jour'}.`);
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
  } else usage();
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
} finally { store.close(); }
