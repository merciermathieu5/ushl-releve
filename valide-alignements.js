/**
 * Validation hors ligne du relevé central des alignements
 * (scripts/fetch-rosters.mjs) et de la diffusion (scripts/diffuser.mjs).
 *
 * Un faux ushl.ca (TeamRosters.php) et une fausse API GitHub tournent en local.
 * Le parseur vient de l'index.html d'une interface : par défaut ../Sharks ou
 * ../sharks à côté de ce dépôt, sinon la variable USHL_INTERFACE.
 * jsdom doit être installé : npm install jsdom --no-save
 *
 * Usage : node valide-alignements.js
 */
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');

const RELEVE = path.join(__dirname, 'scripts', 'fetch-rosters.mjs');
const DIFFUSER = path.join(__dirname, 'scripts', 'diffuser.mjs');
const EQUIPES = [
  'ANAHEIM', 'BOSTON', 'BUFFALO', 'CALGARY', 'CAROLINA', 'CHICAGO', 'COLORADO',
  'COLUMBUS', 'DALLAS', 'DETROIT', 'EDMONTON', 'FLORIDE', 'ISLANDERS',
  'LOSANGELES', 'MINNESOTA', 'MONTREAL', 'NASHVILLE', 'NEWJERSEY', 'NYRANGERS',
  'OTTAWA', 'PHILLY', 'PITTSBURGH', 'SANJOSE', 'SEATTLE', 'ST.LOUIS', 'TAMPABAY',
  'TORONTO', 'UTAH', 'VANCOUVER', 'VEGAS', 'WASHINGTON', 'WINNIPEG'
];

const INTERFACE = process.env.USHL_INTERFACE ||
  ['../Sharks/index.html', '../sharks/index.html'].map(p => path.join(__dirname, p)).find(p => fs.existsSync(p));
if (!INTERFACE || !fs.existsSync(INTERFACE)) {
  console.log('Interface introuvable (USHL_INTERFACE) : validation des alignements sautée.');
  process.exit(0);
}

let ok = 0, ko = 0;
function verifier(cond, libelle) {
  if (cond) { ok++; } else { ko++; console.log('  ✗ ' + libelle); }
}

// ---- faux serveurs -------------------------------------------------------
const faux = {
  bloquerDes: Infinity,   // index d'équipe à partir duquel la page anti-robot est servie
  panne: new Set(),       // équipes qui renvoient HTTP 500
  requetes: [],           // équipes demandées, dans l'ordre
  entetes: null,          // en-têtes de la dernière requête
  appels: []              // déclenchements reçus par la fausse API
};

const ENTETE = '<tr><th>Nom</th><th>PO</th><th>HD</th><th>CD</th><th>IJ</th><th>IN</th><th>SP</th><th>ST</th><th>EN</th><th>DU</th><th>DI</th><th>SK</th><th>PA</th><th>PC</th><th>DF</th><th>OF</th><th>EX</th><th>LD</th><th>OV</th><th>Age</th><th>Salary</th><th>CT</th><th>HT</th><th>WT</th><th>Lien</th></tr>';
function pageEquipe(code) {
  const lignes = Array.from({ length: 12 }, (_, i) =>
    `<tr><td>${code} Joueur ${i}</td><td>C</td><td>G</td><td>OK</td><td></td><td>70</td><td>80</td><td>75</td><td>85</td><td>80</td><td>80</td><td>80</td><td>80</td><td>75</td><td>65</td><td>75</td><td>60</td><td>50</td><td>${70 + i}</td><td>25</td><td>1 000 000 $</td><td>2</td><td>6 ' 1</td><td>190 lbs</td><td>Lien</td></tr>`).join('');
  return `<html><body><p>Dernière mise à jour le jeudi, nov 26 2026</p><h2>${code} 10-8-2 (5e)</h2><table>${ENTETE}${lignes}</table></body></html>`;
}
const PAGE_ANTI_ROBOT = '<html><head><title>One moment, please...</title></head><body>' +
  '<p>Loader Please wait while your request is being verified...</p>' + '<!-- '.padEnd(12000, 'x') + ' --></body></html>';

// Version traduite, servie quand Accept-Language demande le français (comme ushl.ca).
const PAGE_ANTI_ROBOT_FR = '<html><head><title>Un instant, s\'il vous plaît…</title></head><body>' +
  '<p>Loader Votre demande est en cours de vérification, veuillez patienter…</p>' + '<!-- '.padEnd(12000, 'x') + ' --></body></html>';
faux.francais = false;

const serveur = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  if (u.pathname === '/TeamRosters.php') {
    const code = u.searchParams.get('team');
    faux.requetes.push(code);
    faux.entetes = req.headers;
    if (EQUIPES.indexOf(code) >= faux.bloquerDes) { res.writeHead(200, { 'Content-Type': 'text/html' }); return res.end(faux.francais ? PAGE_ANTI_ROBOT_FR : PAGE_ANTI_ROBOT); }
    if (faux.panne.has(code)) { res.writeHead(500); return res.end('panne'); }
    res.writeHead(200, { 'Content-Type': 'text/html' });
    return res.end(pageEquipe(code));
  }
  const m = req.url.match(/^\/api\/repos\/([^/]+)\/([^/]+)\/actions\/workflows\/([^/]+)\/dispatches$/);
  if (m && req.method === 'POST') {
    let corps = '';
    req.on('data', c => (corps += c));
    req.on('end', () => {
      faux.appels.push({ depot: m[2], workflow: m[3], ref: JSON.parse(corps).ref, auth: req.headers.authorization });
      res.writeHead(204); res.end();
    });
    return;
  }
  res.writeHead(404); res.end();
});

function lancer(script, dossier, args = [], envPlus = {}) {
  const port = serveur.address().port;
  const env = {
    ...process.env,
    USHL_BASE: `http://127.0.0.1:${port}/TeamRosters.php`,
    GITHUB_API: `http://127.0.0.1:${port}/api`,
    USHL_RAPIDE: '1',
    USHL_PAUSE_MS: '0',
    ...envPlus
  };
  return new Promise(resolve => {
    execFile(process.execPath, [script, ...args], { cwd: dossier, env, timeout: 120000 }, (err, stdout, stderr) => {
      resolve({ code: err ? (err.code ?? 1) : 0, sortie: stdout + stderr });
    });
  });
}

function dossierNeuf(avecExistant) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'ushl-align-'));
  fs.mkdirSync(path.join(d, 'data'));
  if (avecExistant) fs.copyFileSync(path.join(__dirname, 'data', 'rosters.json'), path.join(d, 'data', 'rosters.json'));
  return d;
}
const lire = d => JSON.parse(fs.readFileSync(path.join(d, 'data', 'rosters.json'), 'utf8'));
const remettre = () => { faux.francais = false; faux.bloquerDes = Infinity; faux.panne = new Set(); faux.requetes = []; faux.appels = []; };

(async () => {
  await new Promise(r => serveur.listen(0, '127.0.0.1', r));
  const argsI = ['--interface', INTERFACE];
  let d, r, f;

  console.log('1. Ligue complète : 32 équipes fraîches, fichier écrit');
  remettre(); d = dossierNeuf(true);
  r = await lancer(RELEVE, d, argsI);
  f = lire(d);
  verifier(r.code === 0, 'code de sortie 0 : ' + r.sortie.slice(-300));
  verifier(f.nbEquipes === 32 && f.reprises.length === 0, '32 équipes, aucune reprise');
  verifier(f.equipes.SANJOSE.joueurs.length === 12, '12 joueurs pour SANJOSE');
  verifier(f.maj === 'nov 26 2026', 'date de mise à jour lue');
  verifier(faux.requetes.length === 32, '32 requêtes seulement (obtenu ' + faux.requetes.length + ')');

  console.log('2. En-têtes de navigateur ordinaire');
  verifier(/Mozilla\/5\.0/.test(faux.entetes['user-agent']) && !/bot/i.test(faux.entetes['user-agent']), 'User-Agent de navigateur, sans « bot »');
  verifier(/fr-CA/.test(faux.entetes['accept-language'] || ''), 'Accept-Language fr-CA');

  console.log('3. Tout bloqué : arrêt après 3 équipes, fichier intact, code 1');
  remettre(); faux.bloquerDes = 0; d = dossierNeuf(true);
  const avant = fs.readFileSync(path.join(d, 'data', 'rosters.json'), 'utf8');
  r = await lancer(RELEVE, d, argsI);
  verifier(r.code === 1, 'code de sortie 1');
  verifier(faux.requetes.length === 9, '9 requêtes (3 équipes × 3 essais) au lieu de 96 (obtenu ' + faux.requetes.length + ')');
  verifier(fs.readFileSync(path.join(d, 'data', 'rosters.json'), 'utf8') === avant, 'fichier existant laissé intact');
  verifier(/page anti-robot/.test(r.sortie) && /relevé interrompu/.test(r.sortie), 'blocage nommé dans le journal');

  console.log('3b. Page anti-robot en français : reconnue aussi, arrêt après 3 équipes');
  remettre(); faux.bloquerDes = 0; faux.francais = true; d = dossierNeuf(true);
  r = await lancer(RELEVE, d, argsI);
  verifier(r.code === 1 && faux.requetes.length === 9, '9 requêtes avec la page française (obtenu ' + faux.requetes.length + ')');

  console.log('4. Bloqué en cours de route : parts fraîches écrites, code 1 pour la reprise');
  remettre(); faux.bloquerDes = 10; d = dossierNeuf(true);
  r = await lancer(RELEVE, d, argsI);
  f = lire(d);
  verifier(r.code === 1, 'code de sortie 1 (le job de reprise retentera)');
  verifier(faux.requetes.length === 10 + 9, '19 requêtes (10 réussies + 3 × 3 bloquées), obtenu ' + faux.requetes.length);
  verifier(f.equipes.ANAHEIM.joueurs[0].nom === 'ANAHEIM Joueur 0', 'ANAHEIM frais');
  verifier(f.nbEquipes === 32 && f.reprises.length === 22, '32 équipes dont 22 reprises (obtenu ' + f.reprises.length + ')');
  verifier(!f.reprises.includes('DETROIT') && f.reprises.includes('EDMONTON') && f.reprises.includes('WINNIPEG'), 'reprises à partir de la 11e équipe');

  console.log('5. Panne isolée (HTTP 500) : reprise de cette équipe seulement, code 0');
  remettre(); faux.panne.add('BOSTON'); d = dossierNeuf(true);
  r = await lancer(RELEVE, d, argsI);
  f = lire(d);
  verifier(r.code === 0, 'code de sortie 0');
  verifier(f.reprises.length === 1 && f.reprises[0] === 'BOSTON', 'BOSTON seule reprise');

  console.log('6. Sans fichier existant et tout bloqué : rien écrit');
  remettre(); faux.bloquerDes = 0; d = dossierNeuf(false);
  r = await lancer(RELEVE, d, argsI);
  verifier(r.code === 1 && !fs.existsSync(path.join(d, 'data', 'rosters.json')), 'aucun fichier créé');

  console.log('7. Diffusion : rosters.yml lancé dans les 22 dépôts');
  remettre(); d = dossierNeuf(false);
  r = await lancer(DIFFUSER, d, [], { USHL_DISPATCH_TOKEN: 'jeton-test' });
  verifier(r.code === 0, 'code de sortie 0');
  verifier(faux.appels.length === 22, '22 déclenchements (obtenu ' + faux.appels.length + ')');
  verifier(faux.appels.every(a => a.workflow === 'rosters.yml' && a.ref === 'main' && a.auth === 'Bearer jeton-test'), 'rosters.yml sur main avec le jeton');
  verifier(new Set(faux.appels.map(a => a.depot)).size === 22, '22 dépôts distincts');

  console.log('8. Diffusion sans jeton : refus, code 1');
  remettre();
  r = await lancer(DIFFUSER, d, [], { USHL_DISPATCH_TOKEN: '' });
  verifier(r.code === 1 && faux.appels.length === 0, 'rien envoyé');

  serveur.close();
  console.log(`\n${ok}/${ok + ko} vérifications réussies`);
  process.exit(ko ? 1 : 0);
})();
