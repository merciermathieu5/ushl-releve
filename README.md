# ushl-releve

Dépôt central des relevés USHL pour les 22 interfaces de DG.

## Relève centrale des alignements

Relève les 32 alignements PRO sur ushl.ca une seule fois pour toute la ligue,
écrit `data/rosters.json`, puis lance « Relève des alignements USHL » dans les
22 dépôts. Ceux-ci ne font que copier ce fichier, sans interroger ushl.ca.

Pourquoi (26 novembre 2026) : chaque dépôt relevait les 32 pages lui-même, soit
plus de 700 requêtes en quelques minutes. ushl.ca servait alors sa page
anti-robot (« Please wait while your request is being verified ») à presque
tous et les relèves plantaient.

Ménagements : en-têtes de navigateur ordinaire, pause aléatoire de 2 à 4 s
entre deux équipes, longue pause après une page anti-robot, et arrêt après
3 équipes bloquées de suite (un job de reprise retente 10 minutes plus tard
depuis un autre runner).

- `scripts/fetch-rosters.mjs` : le relevé (réutilise `parseRoster` de
  l'index.html des Sharks, téléchargé à chaque passage)
- `scripts/diffuser.mjs` : lance la copie dans les 22 dépôts
- `.github/workflows/alignements.yml` : 10 h 43 et 22 h 43 UTC, et à la demande

Pour relever à la main (après une ronde d'agents libres, par exemple) : onglet
Actions, « Relève centrale des alignements USHL », « Run workflow ».

## Surveillance des simulations

Surveille la page XtraStats de ushl.ca et, dès que sa date change (nouvelle
simulation), lance « Relève de la production USHL » dans les 22 dépôts, espacés
de 30 s. Une seconde passe suit une heure plus tard par sécurité.

- `scripts/surveiller.mjs` : le script (Node 20, aucune dépendance)
- `.github/workflows/surveiller.yml` : passe aux minutes 7, 27 et 47 de chaque heure
- `data/etat.json` : dernière date vue, passe en cours, dépôts en attente (écrit par le robot)

Pour lancer les 22 relevés à la main : onglet Actions, « Surveillance des
simulations USHL », « Run workflow », cocher « forcer ».

## Commun

- `scripts/depots.mjs` : la liste des 22 dépôts
- `valide.js` et `valide-alignements.js` : validation hors ligne (`npm test`;
  la seconde demande `npm install jsdom --no-save` et l'interface des Sharks
  clonée à côté, ou la variable `USHL_INTERFACE`)

Secret requis : `USHL_DISPATCH_TOKEN`, un jeton à accès fin avec la permission
« Actions : Read and write » sur les 22 dépôts.

Les crons de chaque dépôt restent en place comme filet de sécurité.

Ajouter une équipe : l'ajouter à `scripts/depots.mjs` et au jeton.
