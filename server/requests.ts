import { readConfig } from './config.js';
import { Store } from './database.js';
import { featureRequestStatusLabels, featureRequestStatuses, type FeatureRequestStatus } from '../shared/model.js';

const [command, id, status, ...noteParts] = process.argv.slice(2);
const store = new Store(readConfig());
try {
  if (!command || command === 'list') {
    const requests = store.allFeatureRequests();
    if (!requests.length) console.log('Aucune demande d’évolution.');
    for (const { request, spaceId, spaceName } of requests) {
      console.log(`${request.id.slice(0, 8)}  [${featureRequestStatusLabels[request.status]}]  ${new Date(request.createdAt).toLocaleString('fr-FR', { timeZone: 'Europe/Paris' })}  ${spaceName ?? `espace supprimé ${spaceId.slice(0, 8)}`}`);
      console.log(`  ${request.text.replace(/\n/g, '\n  ')}`);
      if (request.note) console.log(`  Réponse : ${request.note}`);
    }
  } else if (command === 'set' && id && featureRequestStatuses.includes(status as FeatureRequestStatus)) {
    const note = noteParts.join(' ').trim().slice(0, 1000) || null;
    if (!store.updateFeatureRequest(id, status as FeatureRequestStatus, note)) {
      console.error('Identifiant introuvable ou ambigu.');
      process.exitCode = 1;
    } else console.log(`Statut mis à jour : ${featureRequestStatusLabels[status as FeatureRequestStatus]}.`);
  } else {
    console.error('Usage : npm run requests [-- list]');
    console.error(`        npm run requests -- set <identifiant> <${featureRequestStatuses.join('|')}> [réponse]`);
    process.exitCode = 1;
  }
} finally { store.close(); }
