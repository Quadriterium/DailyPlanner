import type { LegalInfo } from '../shared/admin.js';

// Date of the last change to the wording itself; saving the details in the admin moves it forward.
const textUpdatedAt = Date.UTC(2026, 10, 2, 12);

const escape = (text: string) => text.replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!);
const missing = (label: string) => `<span class="todo">[À COMPLÉTER : ${label}]</span>`;
const field = (value: string, label: string) => value ? escape(value) : missing(label);
const joined = (...parts: string[]) => parts.map(part => part.trim()).filter(Boolean).join(' ');

function person(info: LegalInfo) {
  return joined(info.firstName, info.lastName);
}
function identity(info: LegalInfo) {
  if (info.companyName) return escape(info.registration ? `${info.companyName} (${info.registration})` : info.companyName);
  return field(person(info), 'nom et prénom, ou raison sociale');
}
function address(info: LegalInfo) {
  if (!info.street || !info.city) return missing('adresse postale');
  return escape([info.street, joined(info.postalCode, info.city), info.country].filter(Boolean).join(', '));
}
function email(info: LegalInfo) {
  return info.email ? `<a href="mailto:${escape(info.email)}">${escape(info.email)}</a>` : missing('adresse e-mail de contact');
}

function page(title: string, updatedAt: number, body: string, extraStyle = '') {
  const date = new Intl.DateTimeFormat('fr-FR', { dateStyle: 'long', timeZone: 'Europe/Paris' }).format(Math.max(textUpdatedAt, updatedAt));
  return `<!doctype html>
<html lang="fr">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <meta name="color-scheme" content="light dark" />
  <link rel="icon" href="/icon.svg" type="image/svg+xml" />
  <title>${title} — À table !</title>
  <style>
    :root { color-scheme: light dark; --ink: #514638; --muted: #827966; --accent: #7f4936; --paper: #fcfaf5; --line: #e6dece; }
    @media (prefers-color-scheme: dark) { :root { --ink: #e9dcc6; --muted: #ab9c84; --accent: #ecc7a6; --paper: #1c1814; --line: #3d342b; } }
    body { margin: 0; background: var(--paper); color: var(--ink); font: 15px/1.65 "Segoe UI", "Helvetica Neue", Arial, sans-serif; }
    main { max-width: 760px; margin: 0 auto; padding: 32px 20px 60px; overflow-wrap: anywhere; }
    h1, h2 { font-family: Georgia, serif; font-weight: 400; color: var(--accent); }
    h1 { font-size: 30px; margin: 0 0 4px; }
    h2 { font-size: 21px; margin: 32px 0 8px; border-top: 1px solid var(--line); padding-top: 20px; }
    a { color: var(--accent); }
    .muted { color: var(--muted); font-size: 13px; }
    .todo { background: #f3e1a6; color: #5a4310; padding: 0 4px; border-radius: 4px; }${extraStyle}
  </style>
</head>
<body>
<main>
  <p><a href="/">← Retour à À table !</a></p>
  <h1>${title}</h1>
  <p class="muted">Dernière mise à jour : ${date}</p>
${body}
</main>
</body>
</html>
`;
}

export function termsPage(info: LegalInfo, updatedAt: number) {
  const phone = info.phone ? ` Téléphone : ${escape(info.phone)}.` : '';
  const director = info.publicationDirector || (info.companyName ? '' : person(info));
  const host = info.hostName
    ? [escape(info.hostName), info.hostAddress && escape(info.hostAddress), info.hostPhone && `téléphone : ${escape(info.hostPhone)}`].filter(Boolean).join(', ')
    : missing('nom, adresse et téléphone de l’hébergeur');
  return page('Conditions d’utilisation', updatedAt, `
  <h2>Éditeur</h2>
  <p>« À table ! » est édité par ${identity(info)},
    ${address(info)}.${phone}
    Contact : ${email(info)}.</p>
  <p>Directeur de la publication : ${field(director, 'directeur de la publication')}.</p>
  <p>Hébergement : ${host}.</p>

  <h2>Le service</h2>
  <p>« À table ! » aide à planifier les repas de la semaine et à tenir un carnet de recettes. Il est fourni gratuitement, à titre personnel, sans garantie de disponibilité ni de conservation des données. Pensez à garder une copie de ce qui compte pour vous.</p>

  <h2>Compte et foyer</h2>
  <ul>
    <li>Sans compte, l’application fonctionne en mode invité : les repas restent uniquement sur votre appareil et peuvent être perdus si le navigateur efface ses données.</li>
    <li>La connexion se fait avec un compte Google. Vous êtes responsable de l’usage de votre compte et des appareils sur lesquels vous restez connecté.</li>
    <li>Chaque compte appartient à un foyer. Tous les membres d’un foyer peuvent lire et modifier ses repas, son carnet et ses réglages, et retirer un autre membre. N’invitez que des personnes de confiance : un lien d’invitation est valable 7 jours pour une seule personne.</li>
    <li>En quittant un foyer, ou si vous en êtes retiré, ses repas y restent et ne vous suivent pas.</li>
  </ul>

  <h2>Vos contenus</h2>
  <p>Vous restez responsable des contenus que vous saisissez (noms de repas, recettes, liens, demandes d’évolution). Ils ne doivent pas être illicites ni porter atteinte aux droits d’autrui.</p>
  <p>En ajoutant une recette personnelle depuis le carnet, vous la proposez au catalogue commun : après validation par l’IA, elle peut être recherchée, choisie au hasard et copiée dans le carnet des autres utilisateurs. Son titre et ses étapes restent inchangés ; les ingrédients sont standardisés pour adapter les quantités. Ne proposez que des textes que vous avez le droit de partager, sans données personnelles. Les corrections et l’archivage dans votre carnet ne modifient ni ne retirent les versions déjà partagées.</p>

  <h2>Suggestions de l’intelligence artificielle</h2>
  <p>Les idées de repas, recettes, saisons et niveaux proposés par l’IA sont indicatifs et peuvent être inexacts. Vérifiez toujours les ingrédients, en particulier en cas d’allergie, d’intolérance ou de régime particulier.</p>
  <p>La validation automatique des recettes personnelles vise à écarter les canulars et contenus inadaptés avant leur partage. Elle peut se tromper et ne garantit ni la sécurité alimentaire ni l’exactitude d’une recette.</p>

  <h2>Utilisation acceptable</h2>
  <p>Il est interdit de tenter d’accéder aux données d’un autre foyer, de perturber le service ou d’en faire un usage automatisé abusif. Un compte peut être suspendu en cas d’abus.</p>

  <h2>Fin d’utilisation</h2>
  <p>Vous pouvez cesser d’utiliser le service à tout moment et demander la suppression de votre compte par e-mail. L’éditeur peut faire évoluer ou arrêter le service ; dans ce cas, il s’efforcera de prévenir les utilisateurs suffisamment tôt pour qu’ils récupèrent leurs données.</p>

  <h2>Responsabilité et droit applicable</h2>
  <p>Dans les limites permises par la loi, l’éditeur ne saurait être tenu responsable d’une indisponibilité du service, d’une perte de données ou des conséquences de l’usage des suggestions. Ces conditions sont régies par le droit français.</p>

  <p class="muted"><a href="/confidentialite">Politique de confidentialité</a></p>`);
}

export function privacyPage(info: LegalInfo, updatedAt: number) {
  return page('Politique de confidentialité', updatedAt, `
  <h2>Qui est responsable de vos données ?</h2>
  <p>Le responsable du traitement est ${identity(info)},
    ${address(info)}.
    Pour toute question ou demande : ${email(info)}.</p>

  <h2>Quelles données sont utilisées ?</h2>
  <table>
    <tr><th>Données</th><th>Pourquoi</th></tr>
    <tr><td>Identifiant de compte Google, nom, adresse e-mail, indication « e-mail vérifié », adresse de la photo de profil</td>
      <td>Vous identifier lors de la connexion avec Google et afficher votre nom et votre e-mail aux autres membres de votre foyer. Le mot de passe Google n’est jamais transmis à l’application.</td></tr>
    <tr><td>Repas planifiés, fiches du carnet, convives, repas et ingrédients à éviter, niveau de cuisine, modèle d’IA choisi</td>
      <td>Fournir le service : planning et carnet partagés entre les membres du foyer et synchronisés entre vos appareils.</td></tr>
    <tr><td>Nom du foyer, liste des membres, invitations (créateur, dates)</td><td>Partager un carnet entre plusieurs personnes.</td></tr>
    <tr><td>Demandes d’évolution que vous envoyez</td><td>Améliorer l’application.</td></tr>
    <tr><td>Cookie de session, adresse IP, journaux techniques</td><td>Maintenir votre connexion, limiter les abus et assurer la sécurité du service.</td></tr>
  </table>
  <p>Ne saisissez pas d’informations sensibles (par exemple des données de santé) dans les champs libres. Le champ « repas et ingrédients à éviter » sert à orienter les suggestions ; il ne remplace pas une vérification en cas d’allergie.</p>

  <h2>Sur quelles bases légales ?</h2>
  <p>L’exécution du service que vous demandez en créant un compte (article 6.1.b du RGPD) et l’intérêt légitime à sécuriser le service (article 6.1.f).</p>

  <h2>Cookies et stockage sur votre appareil</h2>
  <p>L’application utilise uniquement des cookies strictement nécessaires : un cookie de session (valable 30 jours, prolongé à chaque utilisation, inaccessible aux scripts) et un cookie temporaire de 10 minutes pendant la connexion avec Google. Aucun cookie publicitaire ou de mesure d’audience n’est utilisé.
    Vos repas sont aussi enregistrés dans le stockage du navigateur (IndexedDB et localStorage) pour fonctionner hors ligne. En mode invité, ils ne quittent pas votre appareil.</p>

  <h2>Qui reçoit vos données ?</h2>
  <ul>
    <li><strong>Les membres de votre foyer</strong> : repas, carnet, réglages, ainsi que votre nom et votre e-mail.</li>
    <li><strong>Google</strong> (Google Ireland Limited / Google LLC) : authentification lors de la connexion.</li>
    <li><strong>OpenAI</strong> (OpenAI, L.L.C., États-Unis) : pour analyser ou proposer des repas, l’application transmet le nom des repas, la composition du foyer, les repas et ingrédients à éviter, la saison, le niveau de cuisine et les noms des plats du carnet. Pour une recette personnelle ajoutée depuis le carnet, son titre, ses ingrédients, ses portions et ses étapes sont transmis pour validation et standardisation des ingrédients. Les informations d’identité du compte (nom et e-mail) ne sont pas transmises dans ces demandes ; ne les incluez pas dans le texte d’une recette.</li>
    <li><strong>Le catalogue commun</strong> : après validation par l’IA, les recettes personnelles ajoutées depuis le carnet sont accessibles aux autres utilisateurs de l’application, y compris en mode invité, par recherche ou tirage au hasard. Le titre et les étapes de l’auteur sont conservés, sans identité de compte associée. Elles ne sont pas ajoutées automatiquement aux carnets des autres foyers. Une correction ou un archivage dans votre carnet ne modifie ni ne retire les versions déjà partagées ou copiées.</li>
    <li><strong>Cloudflare</strong> (Cloudflare, Inc.) : acheminement sécurisé du trafic jusqu’au serveur.</li>
  </ul>
  <p>Certains de ces prestataires peuvent traiter des données hors de l’Union européenne, dans le cadre des garanties prévues par le RGPD (décision d’adéquation ou clauses contractuelles types). Le serveur de l’application est hébergé ${field(info.hostingLocation, 'lieu d’hébergement')}. Aucune donnée n’est vendue ni utilisée à des fins publicitaires.</p>

  <h2>Combien de temps ?</h2>
  <ul>
    <li>Compte et données du foyer : tant que le compte est utilisé ; supprimés sur simple demande.</li>
    <li>Sessions : 30 jours après la dernière utilisation.</li>
    <li>Invitations : 7 jours de validité, puis supprimées 30 jours après expiration.</li>
    <li>Journaux techniques : ${field(info.logRetention, 'durée de conservation')}.</li>
  </ul>
  <p>Quand vous quittez un foyer, ses repas y restent pour les autres membres.</p>

  <h2>Vos droits</h2>
  <p>Vous disposez d’un droit d’accès, de rectification, d’effacement, de limitation, de portabilité et d’opposition. Écrivez à ${email(info)} ; une réponse vous sera apportée dans un délai d’un mois. Vous pouvez aussi adresser une réclamation à la CNIL (<a href="https://www.cnil.fr" rel="noopener">www.cnil.fr</a>).
    Vous pouvez à tout moment retirer l’accès de l’application depuis la page « Sécurité » de votre compte Google.</p>

  <p class="muted"><a href="/conditions-utilisation">Conditions d’utilisation</a></p>`, `
    table { border-collapse: collapse; width: 100%; font-size: 14px; }
    th, td { text-align: left; vertical-align: top; padding: 8px 6px; border-bottom: 1px solid var(--line); }`);
}
