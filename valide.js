/**
 * Validation hors ligne de scripts/surveiller.mjs.
 * Un faux ushl.ca (page XtraStats) et une fausse API GitHub tournent en local;
 * chaque scénario lance le vrai script contre eux et vérifie les déclenchements,
 * l'état écrit et le code de sortie.
 * Usage : node valide.js   (ou npm test)
 */
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');

const SCRIPT = path.join(__dirname, 'scripts', 'surveiller.mjs');
const NB_DEPOTS = 22;

let ok = 0, ko = 0;
function verifier(cond, libelle) {
  if (cond) { ok++; } else { ko++; console.log('  ✗ ' + libelle); }
}

// ---- faux serveurs -------------------------------------------------------
const faux = {
  page: '',               // contenu servi pour XtraStats
  statutPage: 200,
  echouer: new Set(),     // dépôts dont le déclenchement renvoie 500
  appels: [],             // { depot, workflow, ref, auth }
};

const serveur = http.createServer((req, res) => {
  if (req.url.startsWith('/xtra')) {
    res.writeHead(faux.statutPage, { 'Content-Type': 'text/html' });
    return res.end(faux.page);
  }
  const m = req.url.match(/^\/api\/repos\/([^/]+)\/([^/]+)\/actions\/workflows\/([^/]+)\/dispatches$/);
  if (m && req.method === 'POST') {
    let corps = '';
    req.on('data', c => (corps += c));
    req.on('end', () => {
      const [, proprio, depot, workflow] = m;
      faux.appels.push({ proprio, depot, workflow, ref: JSON.parse(corps).ref, auth: req.headers.authorization });
      if (faux.echouer.has(depot)) { res.writeHead(500); return res.end('{"message":"panne simulée"}'); }
      res.writeHead(204); res.end();
    });
    return;
  }
  res.writeHead(404); res.end();
});

function pageXtra(date) {
  const lignes = Array.from({ length: 40 }, (_, i) => `<tr><td>Joueur ${i}</td><td>SANJOSE</td></tr>`).join('');
  return `<html><body><h1>USHL Xtra Stats</h1><p>As of ${date}</p><table>${lignes}</table></body></html>`;
}
const PAGE_ANTI_ROBOT = '<html><body>Please wait while your request is being verified...</body></html>';

function lancer(dossier, { maintenant, jeton = 'jeton-test', extra = [] } = {}) {
  const port = serveur.address().port;
  const env = {
    ...process.env,
    USHL_XTRA: `http://127.0.0.1:${port}/xtra`,
    GITHUB_API: `http://127.0.0.1:${port}/api`,
    USHL_PAUSE_MS: '0',
    USHL_RAPIDE: '1',
  };
  if (maintenant) env.USHL_MAINTENANT = maintenant; else delete env.USHL_MAINTENANT;
  if (jeton) env.USHL_DISPATCH_TOKEN = jeton; else delete env.USHL_DISPATCH_TOKEN;
  return new Promise(resolve => {
    execFile(process.execPath, [SCRIPT, '--etat', path.join(dossier, 'etat.json'), ...extra],
      { env, cwd: dossier, timeout: 60000 },
      (err, stdout, stderr) => resolve({ code: err ? err.code : 0, sortie: stdout + stderr }));
  });
}
const lireEtat = d => JSON.parse(fs.readFileSync(path.join(d, 'etat.json'), 'utf8'));
const existeEtat = d => fs.existsSync(path.join(d, 'etat.json'));
const remise = () => { faux.appels = []; faux.echouer = new Set(); faux.statutPage = 200; };

async function scenarios() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'surv-'));
  let r, e;

  console.log('1. Premier passage, aucune date connue : passe 1 sur les 22 dépôts');
  remise(); faux.page = pageXtra('11/24/2026');
  r = await lancer(d, { maintenant: '2026-11-24T13:30:00Z' });
  verifier(r.code === 0, 'code 0');
  verifier(faux.appels.length === NB_DEPOTS, `22 déclenchements (obtenu ${faux.appels.length})`);
  verifier(new Set(faux.appels.map(a => a.depot)).size === NB_DEPOTS, 'aucun dépôt en double');
  verifier(faux.appels.every(a => a.proprio === 'merciermathieu5'), 'propriétaire merciermathieu5');
  verifier(faux.appels.every(a => a.workflow === 'production.yml'), 'workflow production.yml');
  verifier(faux.appels.every(a => a.ref === 'main'), 'branche main');
  verifier(faux.appels.every(a => a.auth === 'Bearer jeton-test'), 'jeton transmis');
  verifier(faux.appels.some(a => a.depot === 'Sharks') && faux.appels.some(a => a.depot === 'senateurs'), 'Sharks et senateurs inclus');
  e = lireEtat(d);
  verifier(e.date === '11/24/2026' && e.passe === 1, 'état : date et passe 1');
  verifier(e.dernierEnvoi === '2026-11-24T13:30:00.000Z', 'état : heure de la passe 1');
  verifier(Array.isArray(e.enAttente) && e.enAttente.length === 0, 'état : rien en attente');

  console.log('2. Même date, 20 minutes plus tard : rien à faire');
  remise();
  const avant = fs.readFileSync(path.join(d, 'etat.json'), 'utf8');
  r = await lancer(d, { maintenant: '2026-11-24T13:50:00Z' });
  verifier(r.code === 0, 'code 0');
  verifier(faux.appels.length === 0, 'aucun déclenchement');
  verifier(fs.readFileSync(path.join(d, 'etat.json'), 'utf8') === avant, 'état non réécrit');
  verifier(/Rien à faire/.test(r.sortie), 'journal « Rien à faire »');

  console.log('3. Même date, 60 minutes après la passe 1 : seconde passe');
  remise();
  r = await lancer(d, { maintenant: '2026-11-24T14:30:00Z' });
  verifier(r.code === 0, 'code 0');
  verifier(faux.appels.length === NB_DEPOTS, `22 déclenchements (obtenu ${faux.appels.length})`);
  e = lireEtat(d);
  verifier(e.passe === 2, 'état : passe 2');
  verifier(e.dernierEnvoi === '2026-11-24T14:30:00.000Z', 'état : heure de la passe 2');

  console.log('4. Après la seconde passe : plus rien jusqu\'à la prochaine simulation');
  remise();
  r = await lancer(d, { maintenant: '2026-11-24T20:00:00Z' });
  verifier(faux.appels.length === 0, 'aucun déclenchement');
  verifier(lireEtat(d).passe === 2, 'passe reste 2');

  console.log('5. Page anti-robot : rien envoyé, état intact, code 0');
  remise(); faux.page = PAGE_ANTI_ROBOT;
  const avant5 = fs.readFileSync(path.join(d, 'etat.json'), 'utf8');
  r = await lancer(d, { maintenant: '2026-11-25T03:07:00Z' });
  verifier(r.code === 0, 'code 0');
  verifier(faux.appels.length === 0, 'aucun déclenchement');
  verifier(fs.readFileSync(path.join(d, 'etat.json'), 'utf8') === avant5, 'état intact');
  verifier(/illisible/.test(r.sortie), 'journal « illisible »');

  console.log('6. Page en erreur HTTP 503 : même comportement');
  remise(); faux.statutPage = 503; faux.page = 'Service indisponible';
  r = await lancer(d, { maintenant: '2026-11-25T03:27:00Z' });
  verifier(r.code === 0 && faux.appels.length === 0, 'code 0 et aucun déclenchement');

  console.log('7. Nouvelle simulation avec 2 dépôts en panne : échecs gardés en attente');
  remise(); faux.page = pageXtra('11/26/2026'); faux.echouer = new Set(['Kraken', 'Bruins']);
  r = await lancer(d, { maintenant: '2026-11-26T05:07:00Z' });
  verifier(r.code === 1, 'code 1 (échecs)');
  verifier(faux.appels.length === NB_DEPOTS, 'les 22 tentés malgré les pannes');
  e = lireEtat(d);
  verifier(e.date === '11/26/2026' && e.passe === 1, 'état : nouvelle date, passe 1');
  verifier(JSON.stringify(e.enAttente.slice().sort()) === '["Bruins","Kraken"]', 'en attente : Bruins et Kraken');
  verifier(e.dernierEnvoi === '2026-11-26T05:07:00.000Z', 'heure de la passe 1 enregistrée');

  console.log('8. Passage suivant : seuls les dépôts en attente sont repris');
  remise();
  r = await lancer(d, { maintenant: '2026-11-26T05:27:00Z' });
  verifier(r.code === 0, 'code 0');
  verifier(JSON.stringify(faux.appels.map(a => a.depot).sort()) === '["Bruins","Kraken"]', 'seulement Bruins et Kraken');
  e = lireEtat(d);
  verifier(e.enAttente.length === 0, 'plus rien en attente');
  verifier(e.dernierEnvoi === '2026-11-26T05:07:00.000Z', 'la reprise ne repousse pas la seconde passe');

  console.log('9. Seconde passe calculée depuis la passe 1, pas depuis la reprise');
  remise();
  r = await lancer(d, { maintenant: '2026-11-26T06:07:00Z' });
  verifier(faux.appels.length === NB_DEPOTS && lireEtat(d).passe === 2, 'passe 2 sur les 22');

  console.log('10. Jeton absent : erreur claire, rien envoyé, état intact');
  remise(); faux.page = pageXtra('11/28/2026');
  const avant10 = fs.readFileSync(path.join(d, 'etat.json'), 'utf8');
  r = await lancer(d, { maintenant: '2026-11-28T05:07:00Z', jeton: null });
  verifier(r.code === 1, 'code 1');
  verifier(/USHL_DISPATCH_TOKEN/.test(r.sortie), 'message nomme le secret');
  verifier(faux.appels.length === 0, 'aucun déclenchement');
  verifier(fs.readFileSync(path.join(d, 'etat.json'), 'utf8') === avant10, 'état intact');

  console.log('11. Mode essai : rien envoyé, rien écrit');
  remise();
  r = await lancer(d, { maintenant: '2026-11-28T05:07:00Z', jeton: null, extra: ['--essai'] });
  verifier(r.code === 0, 'code 0');
  verifier(faux.appels.length === 0, 'aucun déclenchement');
  verifier((r.sortie.match(/\(essai\)/g) || []).length === NB_DEPOTS, '22 lignes « (essai) »');
  verifier(fs.readFileSync(path.join(d, 'etat.json'), 'utf8') === avant10, 'état intact');

  console.log('12. Forcer avec la date déjà connue : 22 déclenchements');
  remise(); faux.page = pageXtra('11/26/2026');
  r = await lancer(d, { maintenant: '2026-11-26T09:00:00Z', extra: ['--forcer'] });
  verifier(r.code === 0 && faux.appels.length === NB_DEPOTS, 'code 0 et 22 déclenchements');

  console.log('13. Forcer alors que la page est bloquée : déclenche quand même, date gardée');
  remise(); faux.page = PAGE_ANTI_ROBOT;
  r = await lancer(d, { maintenant: '2026-11-26T09:30:00Z', extra: ['--forcer'] });
  verifier(faux.appels.length === NB_DEPOTS, '22 déclenchements');
  verifier(lireEtat(d).date === '11/26/2026', 'date connue conservée');

  console.log('14. Fichier d\'état absent dans un dossier neuf : créé');
  const d2 = fs.mkdtempSync(path.join(os.tmpdir(), 'surv-'));
  remise(); faux.page = pageXtra('11/24/2026');
  verifier(!existeEtat(d2), 'absent au départ');
  r = await lancer(d2, { maintenant: '2026-11-24T13:30:00Z' });
  verifier(existeEtat(d2) && lireEtat(d2).date === '11/24/2026', 'créé avec la date');
}

serveur.listen(0, '127.0.0.1', async () => {
  try {
    await scenarios();
  } catch (e) {
    ko++; console.log('Exception : ' + e.stack);
  }
  serveur.close();
  console.log(`\n${ok}/${ok + ko} vérifications réussies`);
  process.exit(ko ? 1 : 0);
});
