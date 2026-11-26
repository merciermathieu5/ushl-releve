#!/usr/bin/env node
/**
 * Surveille la date de la page XtraStats de ushl.ca et, dès qu'elle change
 * (donc après une simulation), lance le relevé de production (production.yml)
 * dans chacun des dépôts des interfaces de DG.
 *
 * Pourquoi : les relevés programmés de chaque dépôt partent avec plusieurs
 * heures de retard du côté de GitHub (jusqu'à 11 h observées en novembre 2026).
 * Ce script tourne souvent et ne fait qu'une requête légère; quand il voit une
 * nouvelle date, il déclenche les 22 relevés lui-même avec workflow_dispatch.
 *
 * Deux passes par simulation :
 *  1) dès que la nouvelle date apparaît;
 *  2) une seconde fois au moins SECONDE_PASSE_MIN minutes plus tard, au cas où
 *     le gabarit de pointage aurait été publié un peu après XtraStats. Un
 *     relevé sans changement ne committe rien, donc cette passe ne coûte rien.
 * Un dépôt dont le déclenchement échoue reste en attente et est repris au
 * passage suivant du script.
 *
 * Les crons de chaque dépôt restent en place comme filet de sécurité.
 *
 * Variables d'environnement :
 *  USHL_DISPATCH_TOKEN  jeton à accès fin, permission « Actions : lecture et
 *                       écriture » sur les dépôts des équipes (obligatoire,
 *                       sauf avec --essai)
 *  USHL_XTRA            adresse de la page XtraStats (tests hors ligne)
 *  GITHUB_API           racine de l'API GitHub (tests hors ligne)
 *  USHL_MAINTENANT      date ISO qui remplace l'heure courante (tests)
 *  USHL_PAUSE_MS        pause entre deux déclenchements (défaut 30 s, pour étaler
 *                       les relevés de production sur une dizaine de minutes)
 *  USHL_RAPIDE=1        aucune pause entre les essais sur XtraStats (tests)
 *
 * Usage : node scripts/surveiller.mjs [--etat data/etat.json] [--essai] [--forcer]
 *  --essai   n'envoie rien, affiche ce qui serait déclenché
 *  --forcer  déclenche tous les dépôts même si la date n'a pas changé
 * Sortie : code 0 si tout va bien (y compris « rien à faire »), 1 si au moins
 * un déclenchement a échoué ou si le jeton manque.
 */

import fs from 'node:fs/promises';
import path from 'node:path';

import { PROPRIETAIRE, BRANCHE, DEPOTS } from './depots.mjs';

const WORKFLOW = 'production.yml';

const XTRA = process.env.USHL_XTRA || 'https://ushl.ca/ushl/menu_sim/USHL-pro/USHLxtrastats.html';
const API = (process.env.GITHUB_API || 'https://api.github.com').replace(/\/$/, '');
const PAUSE_MS = process.env.USHL_PAUSE_MS !== undefined ? Number(process.env.USHL_PAUSE_MS) : 30000;
const SECONDE_PASSE_MIN = 60;
const DELAI_MS = 20000;
const ESSAIS = 3;
const RAPIDE = process.env.USHL_RAPIDE === '1';

const args = process.argv.slice(2);
const ESSAI = args.includes('--essai');
const FORCER = args.includes('--forcer');
const iEtat = args.indexOf('--etat');
const ETAT = iEtat >= 0 && args[iEtat + 1] ? args[iEtat + 1] : 'data/etat.json';

const dodo = ms => new Promise(r => setTimeout(r, ms));
const maintenant = () => (process.env.USHL_MAINTENANT ? new Date(process.env.USHL_MAINTENANT) : new Date());

/** Lit la date « As of » de XtraStats. Renvoie null si la page est bloquée ou illisible. */
async function dateXtra() {
  for (let essai = 1; essai <= ESSAIS; essai++) {
    try {
      const ctl = new AbortController();
      const t = setTimeout(() => ctl.abort(), DELAI_MS);
      const rep = await fetch(XTRA, {
        signal: ctl.signal,
        headers: {
          // un navigateur ordinaire : « usc-dashboard-bot » s'annonçait robot
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'fr-CA,fr;q=0.9,en;q=0.8'
        }
      });
      clearTimeout(t);
      if (!rep.ok) throw new Error('HTTP ' + rep.status);
      const txt = await rep.text();
      const m = txt.match(/As of\s+([0-9/]+)/i);
      if (m) return m[1];
      throw new Error(`date introuvable (${txt.length} car., page anti-robot probable)`);
    } catch (e) {
      console.log(`  XtraStats, essai ${essai}/${ESSAIS} : ${e.message}`);
      if (essai < ESSAIS) await dodo(RAPIDE ? 0 : 10000 * essai);
    }
  }
  return null;
}

async function lireEtat(chemin) {
  try {
    return JSON.parse(await fs.readFile(chemin, 'utf8'));
  } catch {
    return { date: null, passe: 0, dernierEnvoi: null, enAttente: [] };
  }
}

/** Lance production.yml dans un dépôt. Renvoie null si réussi, sinon le motif. */
async function declencher(depot, jeton) {
  const url = `${API}/repos/${PROPRIETAIRE}/${depot}/actions/workflows/${WORKFLOW}/dispatches`;
  try {
    const rep = await fetch(url, {
      method: 'POST',
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${jeton}`,
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'usc-dashboard-bot/1.0'
      },
      body: JSON.stringify({ ref: BRANCHE })
    });
    if (rep.status === 204) return null;
    const corps = (await rep.text()).slice(0, 160).replace(/\s+/g, ' ');
    return `HTTP ${rep.status} ${corps}`;
  } catch (e) {
    return e.message;
  }
}

/** Déclenche chaque dépôt de la liste; renvoie ceux qui ont échoué. */
async function envoyer(liste, jeton) {
  const echecs = [];
  for (let i = 0; i < liste.length; i++) {
    const depot = liste[i];
    if (ESSAI) {
      console.log(`  (essai) ${depot}`);
      continue;
    }
    const motif = await declencher(depot, jeton);
    if (motif) {
      echecs.push(depot);
      console.log(`  ✗ ${depot} : ${motif}`);
    } else {
      console.log(`  ✓ ${depot}`);
    }
    // Pause entre deux dépôts pour ne pas solliciter ushl.ca d'un seul coup.
    if (i < liste.length - 1 && PAUSE_MS > 0) await dodo(PAUSE_MS);
  }
  return echecs;
}

async function main() {
  const jeton = process.env.USHL_DISPATCH_TOKEN;
  if (!jeton && !ESSAI) {
    console.error('Secret USHL_DISPATCH_TOKEN absent : impossible de lancer les relevés.');
    process.exit(1);
  }

  const chemin = path.resolve(ETAT);
  const etat = await lireEtat(chemin);
  const avant = JSON.stringify(etat);
  const date = await dateXtra();
  const now = maintenant();

  console.log(`Date XtraStats : ${date ?? 'illisible'} · dernière connue : ${etat.date ?? 'aucune'} · passe ${etat.passe}`);

  let liste = [];
  if (FORCER) {
    console.log('Déclenchement forcé de tous les dépôts.');
    liste = DEPOTS.slice();
    if (date) {
      etat.date = date;
      etat.passe = 1;
    }
  } else if (!date) {
    console.log('Page illisible : on réessaiera au prochain passage.');
  } else if (date !== etat.date) {
    console.log(`Nouvelle simulation détectée (${etat.date ?? 'aucune'} → ${date}) : passe 1.`);
    etat.date = date;
    etat.passe = 1;
    liste = DEPOTS.slice();
  } else if (etat.enAttente.length) {
    console.log(`Reprise des dépôts en attente (passe ${etat.passe}).`);
    liste = etat.enAttente.slice();
  } else if (etat.passe === 1 && etat.dernierEnvoi &&
             now - new Date(etat.dernierEnvoi) >= SECONDE_PASSE_MIN * 60000) {
    console.log('Seconde passe de sécurité.');
    etat.passe = 2;
    liste = DEPOTS.slice();
  } else {
    console.log('Rien à faire.');
  }

  let echecs = [];
  if (liste.length) {
    echecs = await envoyer(liste, jeton);
    if (!ESSAI) {
      etat.enAttente = echecs;
      // La seconde passe se mesure à partir de la passe complète, pas d'une reprise.
      if (liste.length === DEPOTS.length) etat.dernierEnvoi = now.toISOString();
      console.log(`${liste.length - echecs.length}/${liste.length} relevé(s) lancé(s).`);
    }
  }

  if (!ESSAI && JSON.stringify(etat) !== avant) {
    await fs.mkdir(path.dirname(chemin), { recursive: true });
    await fs.writeFile(chemin, JSON.stringify(etat, null, 1) + '\n', 'utf8');
    console.log(`Écrit : ${ETAT}`);
  }

  if (echecs.length) process.exit(1);
}

main().catch(e => {
  console.error('Échec :', e.message);
  process.exit(1);
});
