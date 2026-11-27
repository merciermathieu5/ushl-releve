/**
 * Validation hors ligne du relevé central de la production
 * (scripts/fetch-production.mjs), de la diffusion (scripts/diffuser.mjs
 * --workflow production.yml) et, si l'interface des Sharks est clonée à côté,
 * de la copie dans une interface (scripts/copier-production.mjs).
 *
 * Un faux ushl.ca (XtraStats, TeamScoringTemplate.php, TeamScoring.php) et une
 * fausse API GitHub tournent en local. Les parseurs viennent de l'index.html
 * d'une interface : par défaut ../Sharks ou ../sharks à côté de ce dépôt,
 * sinon la variable USHL_INTERFACE. jsdom doit être installé :
 * npm install jsdom --no-save
 *
 * Usage : node valide-production.js
 */
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');

const RELEVE = path.join(__dirname, 'scripts', 'fetch-production.mjs');
const DIFFUSER = path.join(__dirname, 'scripts', 'diffuser.mjs');
const CLUBS = [
  'CHICAGO', 'BOSTON', 'MONTREAL', 'VANCOUVER', 'WASHINGTON', 'NEWJERSEY',
  'ANAHEIM', 'CALGARY', 'PHILLY', 'VEGAS', 'CAROLINA', 'ISLANDERS', 'WINNIPEG',
  'SEATTLE', 'TAMPABAY', 'EDMONTON', 'PITTSBURGH', 'NASHVILLE', 'BUFFALO',
  'SANJOSE', 'DALLAS', 'OTTAWA'
];

const INTERFACE = process.env.USHL_INTERFACE ||
  ['../Sharks/index.html', '../sharks/index.html'].map(p => path.join(__dirname, p)).find(p => fs.existsSync(p));
if (!INTERFACE || !fs.existsSync(INTERFACE)) {
  console.log('Interface introuvable (USHL_INTERFACE) : validation de la production sautée.');
  process.exit(0);
}
const COPIER = path.join(path.dirname(INTERFACE), 'scripts', 'copier-production.mjs');

let ok = 0, ko = 0;
function verifier(cond, libelle) {
  if (cond) { ok++; } else { ko++; console.log('  ✗ ' + libelle); }
}

// Vrais alignements : validerPointage reconnaît un club à ses joueurs.
const ROSTERS = JSON.parse(fs.readFileSync(path.join(__dirname, 'data', 'rosters.json'), 'utf8'));
const joueursDe = code => ROSTERS.equipes[code].joueurs.filter(j => j.po !== 'G').slice(0, 8).map(j => j.nom);

// ---- faux serveurs -------------------------------------------------------
const faux = {
  bloquerDes: Infinity,   // nombre de requêtes servies avant la page anti-robot
  xtraBloque: false,
  panne: new Set(),       // clubs dont le pointage renvoie HTTP 500
  buts: 5,                // buts du premier joueur (pour simuler une nouvelle simulation)
  requetes: [],           // « xtra », « pointage:CODE », « fiche:CODE »
  appels: []
};

function pageXtra() {
  const lignes = ['Player                Team       POS GP  G  A  P Sh PiM  MP  H'];
  for (const code of CLUBS) {
    joueursDe(code).forEach((nom, i) => lignes.push(`${nom}  ${code}  C  20  ${i}  3  ${i + 3}  40  6  300  12`));
  }
  return `<html><body><pre>USHL Xtra Stats As of 11/27/2026\n${lignes.join('\n')}\n</pre>${'<!-- remplissage -->'.repeat(30)}</body></html>`;
}
function pageGabarit(code) {
  const lignes = joueursDe(code).map((nom, i) =>
    `<tr><td>${nom}</td><td>C</td><td>20</td><td>${i === 0 ? faux.buts : i}</td><td>3</td><td>${i + 3}</td><td>0</td><td>4</td><td>1</td><td>0</td><td>40</td><td>12</td></tr>`).join('');
  return `<html><body><table><tr><th>Name</th><th>PO</th><th>GP</th><th>G</th><th>A</th><th>PTS</th><th>+/-</th><th>PIM</th><th>PP</th><th>GW</th><th>S</th><th>HT</th></tr>${lignes}</table>${'<!-- remplissage -->'.repeat(30)}</body></html>`;
}
const pageFiche = code => `<html><body><h2>${code} 10-8-2 (5e)</h2>${'<!-- remplissage -->'.repeat(30)}</body></html>`;
const PAGE_ANTI_ROBOT = '<html><head><title>Un instant, s\'il vous plaît…</title></head><body>' +
  '<p>Loader Votre demande est en cours de vérification, veuillez patienter…</p>' + '<!-- '.padEnd(12000, 'x') + ' --></body></html>';

const serveur = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  const code = u.searchParams.get('team');
  let cle = null, page = null;
  if (u.pathname.endsWith('/USHLxtrastats.html')) { cle = 'xtra'; page = pageXtra(); }
  else if (u.pathname.endsWith('/TeamScoringTemplate.php')) { cle = 'pointage:' + code; page = pageGabarit(code); }
  else if (u.pathname.endsWith('/TeamScoring.php')) { cle = 'fiche:' + code; page = pageFiche(code); }
  if (cle) {
    faux.requetes.push(cle);
    const bloque = faux.requetes.length > faux.bloquerDes || (cle === 'xtra' && faux.xtraBloque);
    if (bloque) { res.writeHead(200, { 'Content-Type': 'text/html' }); return res.end(PAGE_ANTI_ROBOT); }
    if (cle.startsWith('pointage:') && faux.panne.has(code)) { res.writeHead(500); return res.end('panne'); }
    res.writeHead(200, { 'Content-Type': 'text/html' });
    return res.end(page);
  }
  const m = req.url.match(/^\/api\/repos\/([^/]+)\/([^/]+)\/actions\/workflows\/([^/]+)\/dispatches$/);
  if (m && req.method === 'POST') {
    let corps = '';
    req.on('data', c => (corps += c));
    req.on('end', () => {
      faux.appels.push({ depot: m[2], workflow: m[3], ref: JSON.parse(corps).ref });
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
    USHL_RACINE: `http://127.0.0.1:${port}`,
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

function dossierNeuf() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'ushl-prod-'));
  fs.mkdirSync(path.join(d, 'data'));
  fs.copyFileSync(path.join(__dirname, 'data', 'rosters.json'), path.join(d, 'data', 'rosters.json'));
  fs.copyFileSync(path.join(__dirname, 'data', 'production.json'), path.join(d, 'data', 'production.json'));
  return d;
}
const lire = d => JSON.parse(fs.readFileSync(path.join(d, 'data', 'production.json'), 'utf8'));
const sorties = d => {
  const f = path.join(d, 'sortie.txt');
  return fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : '';
};
const remettre = () => { faux.bloquerDes = Infinity; faux.xtraBloque = false; faux.panne = new Set(); faux.requetes = []; faux.appels = []; faux.buts = 5; };

(async () => {
  await new Promise(r => serveur.listen(0, '127.0.0.1', r));
  const argsI = ['--interface', INTERFACE];
  let d, r, f;

  console.log('1. Ligue complète : XtraStats une fois, 2 pages par club, 22 parts fraîches');
  remettre(); d = dossierNeuf();
  r = await lancer(RELEVE, d, argsI, { GITHUB_OUTPUT: path.join(d, 'sortie.txt') });
  f = lire(d);
  verifier(r.code === 0, 'code de sortie 0 : ' + r.sortie.slice(-400));
  verifier(faux.requetes.filter(q => q === 'xtra').length === 1, 'XtraStats lue une seule fois');
  verifier(faux.requetes.length === 45, '45 requêtes (obtenu ' + faux.requetes.length + ')');
  verifier(Object.keys(f.equipes).length === 22, '22 parts');
  verifier(f.maj === '11/27/2026', 'date XtraStats');
  const pit = f.equipes.PITTSBURGH;
  verifier(pit.equipe === 'PITTSBURGH' && pit.fiche === 'PITTSBURGH 10-8-2', 'fiche de Pittsburgh');
  verifier(pit.pointage.patineurs.length === 8 && pit.pointage.patineurs[0].goals === 5, 'pointage de Pittsburgh');
  verifier(pit.xtra.joueurs.length === 8 && pit.xtra.date === '11/27/2026' && pit.xtra.joueurs[0].mp === 300, 'XtraStats de Pittsburgh (8 joueurs, minutes)');
  verifier(pit.reprises.length === 0, 'aucune reprise');
  verifier(['genere', 'equipe', 'fiche', 'pointage', 'xtra', 'reprises'].every(k => k in pit), 'part au format de l\'ancien production.json');
  verifier(/ok=true/.test(sorties(d)) && /change=true/.test(sorties(d)) && /a_reprendre=\n/.test(sorties(d)), 'sorties GitHub ok, change, rien à reprendre');

  console.log('2. Même relevé une seconde fois : rien de changé, fichier intact');
  const avant2 = fs.readFileSync(path.join(d, 'data', 'production.json'), 'utf8');
  remettre(); fs.rmSync(path.join(d, 'sortie.txt'));
  r = await lancer(RELEVE, d, argsI, { GITHUB_OUTPUT: path.join(d, 'sortie.txt') });
  verifier(r.code === 0, 'code de sortie 0');
  verifier(fs.readFileSync(path.join(d, 'data', 'production.json'), 'utf8') === avant2, 'fichier identique (aucun commit à vide)');
  verifier(!/change=true/.test(sorties(d)), 'pas de change=true (aucune diffusion)');

  console.log('3. Nouvelle simulation : seules les parts changées reçoivent un nouvel horodatage');
  remettre(); faux.buts = 9;
  r = await lancer(RELEVE, d, argsI);
  f = lire(d);
  verifier(f.equipes.PITTSBURGH.pointage.patineurs[0].goals === 9, 'nouveau pointage écrit');

  console.log('4. Tout bloqué : arrêt après 3 pages, rien perdu, code 1 et tout à reprendre');
  remettre(); faux.bloquerDes = 0; d = dossierNeuf();
  const avant4 = fs.readFileSync(path.join(d, 'data', 'production.json'), 'utf8');
  r = await lancer(RELEVE, d, argsI, { GITHUB_OUTPUT: path.join(d, 'sortie.txt') });
  verifier(r.code === 1, 'code de sortie 1');
  verifier(faux.requetes.length === 9, '9 requêtes (3 pages × 3 essais) au lieu de 135 (obtenu ' + faux.requetes.length + ')');
  verifier(fs.readFileSync(path.join(d, 'data', 'production.json'), 'utf8') === avant4, 'fichier existant laissé intact');
  verifier(/relevé interrompu/.test(r.sortie), 'interruption nommée dans le journal');
  const ar4 = (sorties(d).match(/a_reprendre=(.*)/) || [])[1] || '';
  verifier(ar4.split(',').length === 23 && ar4.startsWith('XTRA,'), 'XTRA et les 22 clubs à reprendre');

  console.log('5. Bloqué en cours de route : clubs frais écrits, seuls les autres à reprendre');
  remettre(); faux.bloquerDes = 11; d = dossierNeuf();   // xtra + 5 clubs × 2 pages
  r = await lancer(RELEVE, d, argsI, { GITHUB_OUTPUT: path.join(d, 'sortie.txt') });
  f = lire(d);
  verifier(r.code === 1, 'code de sortie 1');
  verifier(f.equipes.CHICAGO.fiche === 'CHICAGO 10-8-2' && f.equipes.WASHINGTON.xtra.date === '11/27/2026', '5 premiers clubs frais');
  verifier(f.equipes.OTTAWA.fiche === 'OTTAWA 3-16-2' && f.equipes.OTTAWA.pointage.releve.startsWith('2026-11-26'), 'Ottawa garde son relevé précédent');
  verifier(f.equipes.OTTAWA.xtra.date === '11/27/2026', 'Ottawa reçoit quand même le XtraStats frais');
  const ar5 = (sorties(d).match(/a_reprendre=(.*)/) || [])[1] || '';
  verifier(!ar5.includes('XTRA') && !ar5.includes('CHICAGO') && ar5.includes('NEWJERSEY') && ar5.includes('OTTAWA'), 'à reprendre : à partir du 6e club (' + ar5 + ')');

  console.log('6. Reprise : seulement les clubs demandés');
  remettre();
  r = await lancer(RELEVE, d, [...argsI, '--equipes', ar5]);
  f = lire(d);
  verifier(r.code === 0, 'code de sortie 0');
  verifier(faux.requetes.length === ar5.split(',').length * 2 && !faux.requetes.includes('xtra'), 'aucune requête de trop');
  verifier(f.equipes.OTTAWA.fiche === 'OTTAWA 10-8-2', 'Ottawa rafraîchi');

  console.log('7. XtraStats bloquée seule : clubs frais, XTRA à reprendre, puis reprise de XTRA seule');
  remettre(); faux.xtraBloque = true; d = dossierNeuf();
  r = await lancer(RELEVE, d, argsI, { GITHUB_OUTPUT: path.join(d, 'sortie.txt') });
  f = lire(d);
  verifier(r.code === 1 && /a_reprendre=XTRA\n/.test(sorties(d)), 'seulement XTRA à reprendre');
  verifier(f.equipes.BOSTON.fiche === 'BOSTON 10-8-2' && f.equipes.BOSTON.xtra.date === '11/26/2026' && f.equipes.BOSTON.reprises.includes('xtra'), 'Boston : pointage frais, XtraStats précédent');
  remettre();
  r = await lancer(RELEVE, d, [...argsI, '--equipes', 'XTRA']);
  f = lire(d);
  verifier(r.code === 0 && faux.requetes.length === 1, 'une seule requête');
  verifier(f.equipes.BOSTON.xtra.date === '11/27/2026' && !f.equipes.BOSTON.reprises.includes('xtra'), 'XtraStats frais appliqué à tous');

  console.log('8. Panne isolée du pointage (HTTP 500) : ce club seul à reprendre');
  remettre(); faux.panne.add('DALLAS'); d = dossierNeuf();
  r = await lancer(RELEVE, d, argsI, { GITHUB_OUTPUT: path.join(d, 'sortie.txt') });
  verifier(r.code === 1 && /a_reprendre=DALLAS\n/.test(sorties(d)), 'DALLAS seul à reprendre');
  verifier(lire(d).equipes.DALLAS.reprises.includes('pointage'), 'pointage précédent de Dallas gardé');

  console.log('9. Club inconnu dans --equipes : refus clair');
  remettre();
  r = await lancer(RELEVE, d, [...argsI, '--equipes', 'QUEBEC']);
  verifier(r.code === 1 && /inconnu/.test(r.sortie) && faux.requetes.length === 0, 'refus sans requête');

  console.log('10. Diffusion : production.yml lancé dans les 22 dépôts');
  remettre();
  r = await lancer(DIFFUSER, d, ['--workflow', 'production.yml'], { USHL_DISPATCH_TOKEN: 'jeton-test' });
  verifier(r.code === 0 && faux.appels.length === 22, '22 déclenchements (obtenu ' + faux.appels.length + ')');
  verifier(faux.appels.every(a => a.workflow === 'production.yml' && a.ref === 'main'), 'production.yml sur main');

  if (fs.existsSync(COPIER)) {
    console.log('11. Copie dans une interface (Sharks) : part du club, au format attendu');
    remettre(); d = dossierNeuf();
    await lancer(RELEVE, d, argsI);
    const central = path.join(d, 'data', 'production.json');
    const i = fs.mkdtempSync(path.join(os.tmpdir(), 'ushl-interface-'));
    fs.mkdirSync(path.join(i, 'data'));
    fs.copyFileSync(INTERFACE, path.join(i, 'index.html'));
    r = await lancer(COPIER, i, [central]);
    const copie = JSON.parse(fs.readFileSync(path.join(i, 'data', 'production.json'), 'utf8'));
    verifier(r.code === 0 && copie.equipe === 'SANJOSE' && copie.fiche === 'SANJOSE 10-8-2', 'part de SANJOSE copiée');
    r = await lancer(COPIER, i, [central]);
    verifier(r.code === 0 && /déjà à jour/.test(r.sortie), 'seconde copie : déjà à jour');
    const faussé = lire(d); faussé.equipes.SANJOSE.equipe = 'OTTAWA';
    fs.writeFileSync(central, JSON.stringify(faussé));
    r = await lancer(COPIER, i, [central]);
    verifier(r.code === 1 && /porte le code/.test(r.sortie), 'part d\'un autre club refusée');
  } else {
    console.log('11. (copier-production.mjs absent de l\'interface : copie non validée)');
  }

  serveur.close();
  console.log(`\n${ok}/${ok + ko} vérifications réussies`);
  process.exit(ko ? 1 : 0);
})();
