/**
 * Les dépôts des interfaces de DG, partagés par surveiller.mjs et diffuser.mjs.
 * Tous sur main, tous avec production.yml et rosters.yml (vérifié le
 * 26 novembre 2026).
 *
 * Ajouter une équipe : l'ajouter ici (DEPOTS et EQUIPES) et au jeton USHL_DISPATCH_TOKEN.
 */
export const PROPRIETAIRE = 'merciermathieu5';
export const BRANCHE = 'main';

export const DEPOTS = [
  'Blackhawks', 'Bruins', 'Canadiens', 'Canucks', 'Capitals', 'Devils',
  'Ducks', 'Flames', 'Flyers', 'GoldenKnights', 'Hurricanes', 'Islanders',
  'Jets', 'Kraken', 'Lightning', 'Oilers', 'Penguins', 'Predateurs',
  'Sabres', 'Sharks', 'Stars', 'senateurs'
];

/* Code d'équipe sur ushl.ca de chaque dépôt (CONFIG.equipe de son index.html,
   vérifié le 27 novembre 2026). Sert au relevé central de la production. */
export const EQUIPES = {
  Blackhawks: 'CHICAGO', Bruins: 'BOSTON', Canadiens: 'MONTREAL',
  Canucks: 'VANCOUVER', Capitals: 'WASHINGTON', Devils: 'NEWJERSEY',
  Ducks: 'ANAHEIM', Flames: 'CALGARY', Flyers: 'PHILLY', GoldenKnights: 'VEGAS',
  Hurricanes: 'CAROLINA', Islanders: 'ISLANDERS', Jets: 'WINNIPEG',
  Kraken: 'SEATTLE', Lightning: 'TAMPABAY', Oilers: 'EDMONTON',
  Penguins: 'PITTSBURGH', Predateurs: 'NASHVILLE', Sabres: 'BUFFALO',
  Sharks: 'SANJOSE', Stars: 'DALLAS', senateurs: 'OTTAWA'
};
