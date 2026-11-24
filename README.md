# ushl-releve

Surveille la page XtraStats de ushl.ca et, dès que sa date change (nouvelle
simulation), lance « Relève de la production USHL » dans les 22 dépôts des
interfaces de DG. Une seconde passe suit une heure plus tard par sécurité.

Les relevés programmés de chaque dépôt restent en place comme filet de sécurité.

- `scripts/surveiller.mjs` : le script (Node 20, aucune dépendance)
- `.github/workflows/surveiller.yml` : passe aux minutes 7, 27 et 47 de chaque heure
- `data/etat.json` : dernière date vue, passe en cours, dépôts en attente (écrit par le robot)
- `valide.js` : validation hors ligne (`npm test`)

Secret requis : `USHL_DISPATCH_TOKEN`, un jeton à accès fin avec la permission
« Actions : Read and write » sur les 22 dépôts.

Pour lancer les 22 relevés à la main : onglet Actions, « Surveillance des
simulations USHL », « Run workflow », cocher « forcer ».

Ajouter une équipe : l'ajouter à la liste `DEPOTS` dans `scripts/surveiller.mjs`
et au jeton.
