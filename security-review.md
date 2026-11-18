# Rapport de securite - DailyPlanner

Date : 18 novembre 2026.
Cible : https://dailyplanner.fr
Methode : audit externe en boite noire, sans authentification.

## Perimetre et limites

Le proprietaire a autorise des tests non destructifs sur l'acces public du
site, hors services tiers. L'analyse repose uniquement sur les reponses HTTP
du deploiement et les modules JavaScript qu'il publie. Aucun code source
local, historique, identifiant ou cookie preexistant n'a ete utilise.

Les requetes effectuees sont des GET cibles, sans suivi des redirections
externes. Aucun compte n'a ete cree, aucune donnee n'a ete modifiee et aucun
test de force brute ou de charge n'a ete realise. La lecture des reponses
aux chemins sensibles et aux API a ete limitee a 4 Kio par reponse.

Ce controle ne couvre pas les droits entre utilisateurs connectes, la
separation des espaces, les operations d'ecriture, les parcours OAuth
complets, la protection CSRF effective ou la securite des cookies apres
connexion. Il ne constitue pas une certification de securite.

## Synthese

Aucune fuite de donnees privees ni aucun acces administrateur non autorise
n'ont ete demontres dans les tests effectues. Un point de durcissement a ete
constate : l'absence de l'en-tete HSTS sur les reponses HTTPS examinees.

| # | Severity | File | Lines | Vulnerability | Confidence |
|---|----------|------|-------|---------------|------------|
| 1 | ⚪ LOW | https://dailyplanner.fr/ | N/A | En-tete Strict-Transport-Security absent des reponses HTTPS testees | 10/10 |

La confiance indique la certitude du constat d'absence de l'en-tete, et non
la demonstration d'une exploitation. La colonne File designe ici une URL :
aucun fichier source ni numero de ligne n'a ete examine.

## Informations recuperables sans connexion

### Application et interface administrateur

Les ressources suivantes sont publiquement accessibles :

- `/assets/index-E7HG9RIw.js`
- `/assets/App-Cdf6a5UJ.js`
- `/assets/Admin-DTuYMGfA.js`
- `/assets/components-Bna0Ywbm.js`

Elles revelent la logique cliente et les noms des routes API, notamment les
fonctions d'administration. C'est normal pour du JavaScript execute dans le
navigateur. Cela ne donne pas les droits correspondants : leur controle doit
rester cote serveur. Les API administrateur testees refusent les requetes
anonymes.

### Catalogue de recettes

`GET /api/catalog?after=0` retourne **200**, avec un contenu JSON dont la
longueur annoncee etait de 64 065 octets. Seuls les 4 premiers Kio ont ete
lus. Le prefixe contient notamment les champs `catalogId`, `cursor`,
`entries`, `id`, `name`, `ingredients`, `quantity`, `recipe`, `servings`,
`seasons` et `tags`.

Le catalogue est donc au moins partiellement recuperable publiquement.
L'exhaustivite et la pagination n'ont pas ete testees. Ce n'est pas classe
comme une vulnerabilite sans indication que ces recettes doivent etre
privees. Le proprietaire doit confirmer que cette publication est voulue.

### Configuration publique

- `/api/push` retourne **200** et les champs `configured` et `publicKey`.
  Une cle publique de notifications n'est pas un secret.
- `/api/auth/session` retourne **200**, `authEnabled: true`, `user: null`,
  et des champs de configuration dont `providers` et `defaultModel`.
- `/api/admin/session` retourne **200**, `allowed: false` et `user: null`.
  Cette reponse n'accorde pas d'acces administrateur.

Aucune valeur personnelle ni cle privee n'est reproduite dans ce rapport.

## Verifications HTTP

| Requete GET | Resultat observe |
|---|---|
| `http://dailyplanner.fr/` | 301 vers `https://dailyplanner.fr/` |
| `https://dailyplanner.fr/` | 200, page HTML publique |
| `/robots.txt` | 200, texte de signaux d'utilisation Cloudflare |
| `/api/admin/overview` | 401, code `admin_reauth` |
| `/api/admin/users` | 401, code `admin_reauth` |
| `/api/admin/spaces` | 401, code `admin_reauth` |
| `/api/space` | 401, code `auth_required` |
| `/api/messages` | 401, code `auth_required` |
| `/api/feature-requests` | 401, code `auth_required` |
| `/api/admin/backup` | 404 pour GET ; aucune autre methode testee |
| `/admin` | 404 pour cet acces direct |
| `/.env` | 404 |
| `/.git/config` | 404 |
| `/package.json` | 404 |
| `/server.js` | 404 |
| `/backup.sql` | 404 |
| `/assets/App-Cdf6a5UJ.js.map` | 404 |
| `/audit-inexistant-20261118` | 404, chemin temoin inexistant |

Les reponses 404 aux fichiers sensibles avaient le meme contenu que le
chemin temoin. Il ne s'agissait pas de faux 200 renvoyant la page d'une SPA.
Ces resultats ne permettent pas de conclure sur tous les noms possibles de
sauvegardes, fichiers de configuration ou source maps.

Une erreur reseau transitoire a eu lieu lors de la premiere lecture du
bundle principal ; une nouvelle tentative a abouti.

## Protections observees

La page principale presente notamment :

- Une CSP avec `default-src 'self'`, `script-src 'self'`,
  `script-src-attr 'none'`, `connect-src 'self'`, `object-src 'none'`
  et `frame-ancestors 'none'`.
- `X-Content-Type-Options: nosniff`.
- `Referrer-Policy: no-referrer`.
- `Cross-Origin-Opener-Policy: same-origin`.
- Une redirection HTTP vers HTTPS.

La CSP autorise les styles inline ; cela ne demontre pas une XSS.
L'existence de ces en-tetes ne remplace pas la verification des controles
d'acces et de validation cote serveur.

## Constat 1 - Absence de HSTS

**Severite : LOW. Point de durcissement, sans exploitation demontree.**

### Preuve

Les reponses HTTPS de la page principale et des API examinees ne contiennent
pas `Strict-Transport-Security`. La requete HTTP vers la racine retourne une
redirection 301, mais cette redirection n'equivaut pas a une politique HSTS.

### Impact et nuance

En l'absence de politique HSTS deja connue du navigateur ou de protection
equivalente, une visite commencee en HTTP peut etre exposee a une
interception avant la redirection. Le statut de prechargement HSTS du
domaine et les protections propres aux navigateurs n'ont pas ete verifies.
Aucune interception n'a ete tentee.

### Recommandation

Configurer l'application ou la couche de publication pour emettre HSTS sur
les reponses HTTPS. Apres validation du fonctionnement HTTPS, la valeur
cible peut etre :

```http
Strict-Transport-Security: max-age=31536000
```

Une duree courte peut etre utilisee au debut du deploiement. Ne pas ajouter
`includeSubDomains` sans verifier tous les sous-domaines. Le prechargement
est une demarche distincte avec des contraintes durables ; l'ajout de
l'en-tete seul ne protege pas retroactivement le premier contact.

Verifier ensuite la presence de l'en-tete sur les pages et les reponses API,
y compris les erreurs. Aucune correction n'a ete appliquee pendant l'audit.

## Suites conseillees

1. Confirmer que le catalogue de recettes doit etre accessible sans compte.
2. Activer puis verifier HSTS.
3. Pour un audit complementaire autorise, utiliser deux comptes de test et
   des donnees fictives afin de verifier la separation des espaces, les
   invitations et les droits administrateur.
