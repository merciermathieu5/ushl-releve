#!/usr/bin/env node
/**
 * Lance « Relève des alignements USHL » (rosters.yml) dans chaque dépôt
 * d'interface après un nouveau relevé central. Ce workflow ne fait que copier
 * data/rosters.json de ushl-releve : aucune requête vers ushl.ca, donc une
 * courte pause entre deux dépôts suffit.
 *
 * Variables d'environnement :
 *  USHL_DISPATCH_TOKEN  jeton à accès fin, « Actions : lecture et écriture »
 *                       sur les dépôts des équipes (obligatoire sauf --essai)
 *  GITHUB_API           racine de l'API GitHub (tests hors ligne)
 *  USHL_PAUSE_MS        pause entre deux déclenchements (défaut 3 s)
 *
 * Usage : node scripts/diffuser.mjs [--essai]
 * Sortie : code 0 si tous les dépôts ont été lancés, 1 sinon.
 */

import { PROPRIETAIRE, BRANCHE, DEPOTS } from './depots.mjs';

const WORKFLOW = 'rosters.yml';
const API = (process.env.GITHUB_API || 'https://api.github.com').replace(/\/$/, '');
const PAUSE_MS = process.env.USHL_PAUSE_MS !== undefined ? Number(process.env.USHL_PAUSE_MS) : 3000;
const ESSAI = process.argv.includes('--essai');

const dodo = ms => new Promise(r => setTimeout(r, ms));

async function declencher(depot, jeton) {
  try {
    const rep = await fetch(`${API}/repos/${PROPRIETAIRE}/${depot}/actions/workflows/${WORKFLOW}/dispatches`, {
      method: 'POST',
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${jeton}`,
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'ushl-releve'
      },
      body: JSON.stringify({ ref: BRANCHE })
    });
    if (rep.status === 204) return null;
    return `HTTP ${rep.status} ${(await rep.text()).slice(0, 160).replace(/\s+/g, ' ')}`;
  } catch (e) {
    return e.message;
  }
}

async function main() {
  const jeton = process.env.USHL_DISPATCH_TOKEN;
  if (!jeton && !ESSAI) {
    console.error('Secret USHL_DISPATCH_TOKEN absent : impossible de diffuser les alignements.');
    process.exit(1);
  }
  const echecs = [];
  for (let i = 0; i < DEPOTS.length; i++) {
    const depot = DEPOTS[i];
    if (ESSAI) { console.log(`  (essai) ${depot}`); continue; }
    const motif = await declencher(depot, jeton);
    if (motif) { echecs.push(depot); console.log(`  ✗ ${depot} : ${motif}`); }
    else console.log(`  ✓ ${depot}`);
    if (i < DEPOTS.length - 1 && PAUSE_MS > 0) await dodo(PAUSE_MS);
  }
  console.log(`${DEPOTS.length - echecs.length}/${DEPOTS.length} copie(s) lancée(s).` +
    (echecs.length ? ` Leur cron quotidien rattrapera : ${echecs.join(', ')}` : ''));
  if (echecs.length) process.exit(1);
}

main().catch(e => {
  console.error('Échec :', e.message);
  process.exit(1);
});
