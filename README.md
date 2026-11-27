# ushl-releve

Dépôt central des relevés USHL pour les 22 interfaces de DG : ushl.ca n'est
interrogé que d'ici, jamais par les interfaces elles-mêmes.

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

## Relève centrale de la production

Relève la production des 22 clubs (pointage, fiche V-D-N et XtraStats) sur
ushl.ca une seule fois pour toute la ligue, écrit `data/production.json`, puis
lance « Relève de la production USHL » dans les 22 dépôts. Ceux-ci ne font que
copier la part de leur club (`scripts/copier-production.mjs`), sans interroger
ushl.ca.

Pourquoi (27 novembre 2026) : chaque dépôt relevait sa production lui-même
(3 pages, 3 essais chacune, puis un job de reprise), après chaque simulation,
une heure plus tard, et à ses deux crons que GitHub retarde de plusieurs
heures. Le 27 novembre, sans aucune nouvelle simulation, il y a eu 63 relèves
de production : ushl.ca servait sa page anti-robot et 11 ont échoué (courriels
« Run failed: Relève de la production USHL »). Le relevé central fait 45
requêtes lentes : XtraStats une fois, puis 2 pages par club.

Mêmes ménagements que pour les alignements (pause de 2 à 4 s, arrêt après
3 pages bloquées de suite). Un club non relevé garde ses données; le job de
reprise retente 10 minutes plus tard, depuis un autre runner, seulement les
clubs manquants.

- `scripts/fetch-production.mjs` : le relevé (réutilise les parseurs de
  l'index.html des Sharks)
- `.github/workflows/production.yml` : lancé par la surveillance, et à la demande
- `scripts/diffuser.mjs --workflow production.yml` : lance la copie dans les 22 dépôts

## Surveillance des simulations

Surveille la page XtraStats de ushl.ca et, dès que sa date change (nouvelle
simulation), lance la relève centrale de la production. Une seconde passe suit
une heure plus tard par sécurité (sans changement, rien n'est committé ni
diffusé).

- `scripts/surveiller.mjs` : le script (Node 20, aucune dépendance)
- `.github/workflows/surveiller.yml` : passe aux minutes 7, 27 et 47 de chaque heure
- `data/etat.json` : dernière date vue, passe en cours, déclenchement en attente (écrit par le robot)

Pour relever la production à la main : onglet Actions, « Relève centrale de la
production USHL », « Run workflow ».

## Commun

- `scripts/depots.mjs` : la liste des 22 dépôts et le code ushl.ca de chaque club
- `valide.js`, `valide-alignements.js` et `valide-production.js` : validation
  hors ligne (`npm test`; les deux dernières demandent
  `npm install jsdom --no-save` et l'interface des Sharks clonée à côté, ou la
  variable `USHL_INTERFACE`)

Secret requis : `USHL_DISPATCH_TOKEN`, un jeton à accès fin avec la permission
« Actions : Read and write » sur les 22 dépôts (pour la diffusion). La
surveillance lance la relève de ce dépôt avec le jeton intégré de GitHub.

Les crons de chaque dépôt restent en place comme filet de sécurité : ils ne
font que copier les fichiers de ce dépôt.

Ajouter une équipe : l'ajouter à `scripts/depots.mjs` (DEPOTS et EQUIPES) et au jeton.
