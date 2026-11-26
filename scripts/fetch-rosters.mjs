#!/usr/bin/env node
/**
 * Relève CENTRAL des alignements PRO des 32 clubs sur ushl.ca : écrit
 * data/rosters.json dans ushl-releve. Les 22 interfaces de DG copient ensuite
 * ce fichier (workflow « Relève des alignements USHL » de chaque dépôt) au lieu
 * d'interroger ushl.ca chacune de leur côté.
 *
 * Pourquoi (26 novembre 2026) : les 22 dépôts relevaient les 32 pages en même
 * temps, soit plus de 700 requêtes en quelques minutes depuis les adresses de
 * GitHub. ushl.ca a fini par servir sa page anti-robot (« One moment, please...
 * Please wait while your request is being verified ») à presque tous. Un seul
 * relevé, lent et espacé, en fait 32.
 *
 * Le parseur n'est pas réécrit ici : on charge l'index.html d'une interface
 * (--interface, celui des Sharks dans le workflow) dans jsdom et on réutilise
 * parseRoster tel quel. Le serveur et le navigateur interprètent donc les
 * pages exactement de la même façon.
 *
 * Ménagement de ushl.ca :
 *  - en-têtes d'un navigateur ordinaire plutôt qu'un robot qui s'annonce;
 *  - pause aléatoire de 2 à 4 s entre deux équipes;
 *  - la page anti-robot est reconnue comme telle et suivie d'une longue pause;
 *  - après BLOCAGES_MAX équipes bloquées de suite, on arrête : l'adresse du
 *    runner est refusée et insister ne ferait qu'aggraver les choses. Les
 *    équipes restantes sont reprises du fichier existant et le job de reprise
 *    retente plus tard depuis un autre runner.
 *
 * Fusion par équipe : une équipe dont la page ne se relève pas conserve ses
 * données du fichier existant au lieu de bloquer tout le relevé. Le fichier
 * n'est réécrit que si au moins une équipe fraîche a été obtenue et que le
 * total (fraîches + reprises) couvre la ligue presque au complet.
 *
 * Usage : node scripts/fetch-rosters.mjs [--interface index.html] [--sortie data/rosters.json] [--equipe CODE]
 * Variable USHL_RAPIDE=1 : aucune pause (tests hors ligne seulement).
 * Sortie : code 0 si le fichier est écrit au complet, 1 si la relève est jugée
 * non fiable (fichier laissé intact) ou interrompue par la page anti-robot
 * (parts fraîches écrites quand le seuil est atteint).
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { JSDOM } from 'jsdom';

/* Surchargeable par USHL_BASE : sert aux tests hors ligne (serveur local). */
const BASE = (process.env.USHL_BASE || 'https://ushl.ca/ushl/menu_sim/USHL-pro/jamesishot/TeamRosters.php') + '?team=';

const EQUIPES = [
  'ANAHEIM', 'BOSTON', 'BUFFALO', 'CALGARY', 'CAROLINA', 'CHICAGO', 'COLORADO',
  'COLUMBUS', 'DALLAS', 'DETROIT', 'EDMONTON', 'FLORIDE', 'ISLANDERS',
  'LOSANGELES', 'MINNESOTA', 'MONTREAL', 'NASHVILLE', 'NEWJERSEY', 'NYRANGERS',
  'OTTAWA', 'PHILLY', 'PITTSBURGH', 'SANJOSE', 'SEATTLE', 'ST.LOUIS', 'TAMPABAY',
  'TORONTO', 'UTAH', 'VANCOUVER', 'VEGAS', 'WASHINGTON', 'WINNIPEG'
];

/* Une relève partielle est pire que pas de relève : elle ferait disparaître des
   joueurs de l'interface. Grâce à la fusion, une équipe en échec est reprise du
   fichier existant; le seuil s'applique donc au total couvert, pas aux seules
   équipes fraîches. */
const MIN_EQUIPES = 28;
const MIN_JOUEURS = 10;
const DELAI_MS = 20000;
const ESSAIS = 3;
const RAPIDE = process.env.USHL_RAPIDE === '1';
const PAUSE_MIN_MS = RAPIDE ? 0 : 2000;
const PAUSE_MAX_MS = RAPIDE ? 0 : 4000;
const PAUSE_BLOCAGE_MS = RAPIDE ? 0 : 15000;
const BLOCAGES_MAX = 3;

/* Un navigateur ordinaire : l'ancien « usc-dashboard-bot » s'annonçait robot. */
const ENTETES = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'fr-CA,fr;q=0.9,en;q=0.8'
};
const ANTI_ROBOT = /request is being verified|One moment, please/i;

/** Page de vérification anti-robot reçue à la place de la vraie page. */
class PageBloquee extends Error {}

const args = process.argv.slice(2);
const lireArg = (nom, defaut) => {
  const i = args.indexOf(nom);
  return i >= 0 && args[i + 1] ? args[i + 1] : defaut;
};
const SORTIE = lireArg('--sortie', 'data/rosters.json');
const INTERFACE = lireArg('--interface', 'index.html');
const FILTRE = lireArg('--equipe', null);

const dodo = ms => new Promise(r => setTimeout(r, ms));
const pause = () => dodo(PAUSE_MIN_MS + Math.random() * (PAUSE_MAX_MS - PAUSE_MIN_MS));

/** Charge index.html dans jsdom et renvoie les fonctions d'analyse de l'interface. */
async function outilsDepuisInterface(cheminHtml) {
  const html = await fs.readFile(cheminHtml, 'utf8');
  const dom = new JSDOM(html, {
    runScripts: 'dangerously',
    pretendToBeVisual: true,
    url: 'https://example.org/',
    beforeParse(w) {
      // aucune requête pendant le chargement : on ne veut que les fonctions
      w.fetch = () => Promise.reject(new Error('réseau désactivé au chargement'));
    }
  });
  await dodo(400);
  const S = dom.window.__SJS__;
  if (!S || typeof S.parseRoster !== 'function') {
    throw new Error('index.html n\'expose pas parseRoster (window.__SJS__)');
  }
  return { S, window: dom.window };
}

/* Renvoie {texte, statut, longueur}. Les diagnostics servent à distinguer une
   page bloquée (200 mais vide) d'un changement de structure ou d'une panne. */
async function chercher(url) {
  let derniere = null;
  for (let essai = 1; essai <= ESSAIS; essai++) {
    try {
      const ctl = new AbortController();
      const t = setTimeout(() => ctl.abort(), DELAI_MS);
      const rep = await fetch(url, { signal: ctl.signal, headers: ENTETES });
      clearTimeout(t);
      if (!rep.ok) throw new Error('HTTP ' + rep.status);
      const txt = await rep.text();
      if (ANTI_ROBOT.test(txt)) {
        throw new PageBloquee(`page anti-robot · HTTP ${rep.status}, ${txt.length} car. · « ${extraitDePage(txt)} »`);
      }
      if (txt.length < 500) throw new Error(`réponse anormalement courte (HTTP ${rep.status}, ${txt.length} car.)`);
      return { texte: txt, statut: rep.status, longueur: txt.length };
    } catch (e) {
      derniere = e;
      // Bloqué : on laisse au serveur le temps de se calmer avant de retenter.
      if (essai < ESSAIS) await dodo(e instanceof PageBloquee ? PAUSE_BLOCAGE_MS * essai : 1000 * essai);
    }
  }
  throw derniere;
}

/** Extrait lisible d'une page suspecte, pour le journal du workflow. */
function extraitDePage(html) {
  const corps = html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return corps ? corps.slice(0, 160) : '(page sans texte visible)';
}

/** «Dernière mise à jour le vendredi, sept 4 2026» → «sept 4 2026» */
function dateDePage(html) {
  const m = html.match(/Derni[eè]re mise à jour le\s+[^,<]+,?\s+([A-Za-zûéà.]+\s+\d{1,2}\s+\d{4})/i);
  return m ? m[1].replace(/\s+/g, ' ').trim() : null;
}

/** «SANJOSE 3-1-0 (7e Western)» → «SANJOSE 3-1-0» */
function ficheDePage(html, code) {
  const m = html.match(new RegExp(code.replace('.', '\\.') + '\\s+(\\d+)-(\\d+)-(\\d+)'));
  return m ? `${code} ${m[1]}-${m[2]}-${m[3]}` : null;
}

/** Fichier existant, pour la reprise des équipes en échec. Absent → null. */
async function chargerExistant(chemin) {
  try {
    const brut = await fs.readFile(chemin, 'utf8');
    const d = JSON.parse(brut);
    return d && typeof d === 'object' && d.equipes ? d : null;
  } catch {
    return null;
  }
}

async function main() {
  const racine = process.cwd();
  const { S, window } = await outilsDepuisInterface(path.resolve(racine, INTERFACE));
  const existant = await chargerExistant(path.join(racine, SORTIE));

  const cibles = FILTRE ? [FILTRE] : EQUIPES;
  const equipes = {};
  const echecs = [];
  const reprises = [];
  let dateMaj = null;
  let bloquesDeSuite = 0;
  let abandon = false;

  for (const code of cibles) {
    if (abandon) {
      // Adresse refusée : on ne sollicite plus ushl.ca, on reprend l'existant.
      const ancienne = existant?.equipes?.[code];
      if (ancienne && Array.isArray(ancienne.joueurs) && ancienne.joueurs.length >= MIN_JOUEURS) {
        equipes[code] = ancienne;
        reprises.push(code);
      } else {
        echecs.push(`${code} (non tentée, relevé interrompu)`);
      }
      continue;
    }
    try {
      const { texte: html, statut, longueur } = await chercher(BASE + encodeURIComponent(code));
      const doc = new window.DOMParser().parseFromString(html, 'text/html');
      const joueurs = S.parseRoster(html, doc);
      if (joueurs.length < MIN_JOUEURS) {
        throw new Error(`${joueurs.length} joueurs analysés (< ${MIN_JOUEURS}) · HTTP ${statut}, ${longueur} car. · « ${extraitDePage(html)} »`);
      }
      equipes[code] = {
        fiche: ficheDePage(html, code),
        maj: dateDePage(html),
        joueurs
      };
      dateMaj = dateMaj || equipes[code].maj;
      bloquesDeSuite = 0;
      console.log(`  ${code.padEnd(11)} ${String(joueurs.length).padStart(2)} joueurs`);
    } catch (e) {
      if (e instanceof PageBloquee && ++bloquesDeSuite >= BLOCAGES_MAX) {
        abandon = true;
        console.log(`  ! ${BLOCAGES_MAX} équipes bloquées de suite : relevé interrompu pour ménager ushl.ca.`);
      }
      /* Reprise : l'équipe garde ses données du fichier existant plutôt que
         de disparaître de l'interface ou de bloquer les 31 autres. */
      const ancienne = existant?.equipes?.[code];
      if (ancienne && Array.isArray(ancienne.joueurs) && ancienne.joueurs.length >= MIN_JOUEURS) {
        equipes[code] = ancienne;
        reprises.push(code);
        console.log(`  ${code.padEnd(11)} ↺ reprise du relevé du ${ancienne.maj || '?'} — ${e.message}`);
      } else {
        echecs.push(`${code} (${e.message})`);
        console.log(`  ${code.padEnd(11)} ✗ ${e.message}`);
      }
    }
    await pause();
  }
  if (abandon) console.log(`  (${reprises.length} équipe(s) reprises du fichier existant sans être tentées ou après blocage)`);

  const fraiches = Object.keys(equipes).length - reprises.length;
  const total = Object.keys(equipes).length;
  console.log(`\n${fraiches}/${cibles.length} équipes relevées` +
    (reprises.length ? ` · ${reprises.length} reprises : ${reprises.join(', ')}` : '') +
    (echecs.length ? ` · échecs : ${echecs.join(', ')}` : ''));

  /* Rien de frais : la source était inaccessible ou illisible pour tout le
     monde. On ne réécrit pas un fichier identique et on signale l'échec. */
  const seuil = FILTRE ? 1 : MIN_EQUIPES;
  if (fraiches < 1 || total < seuil) {
    console.error(`Relève non fiable (${fraiches} fraîche(s), ${total} couverte(s) < ${seuil}) : le fichier existant est laissé intact.`);
    process.exit(1);
  }

  /* Doublons entre clubs : symptôme d'une page servie en cache pendant un échange.
     On le signale sans bloquer, l'interface reste utilisable. */
  const vus = new Map();
  for (const [code, e] of Object.entries(equipes)) {
    for (const j of e.joueurs) {
      if (j.horsAlignement || j.backup) continue;
      if (vus.has(j.nom)) console.warn(`  ! ${j.nom} apparaît dans ${vus.get(j.nom)} et ${code}`);
      else vus.set(j.nom, code);
    }
  }

  const charge = {
    genere: new Date().toISOString(),
    maj: dateMaj,
    source: 'ushl.ca — TeamRosters.php (PRO)',
    nbEquipes: total,
    reprises,
    equipes
  };

  await fs.mkdir(path.dirname(path.join(racine, SORTIE)), { recursive: true });
  await fs.writeFile(path.join(racine, SORTIE), JSON.stringify(charge, null, 1) + '\n', 'utf8');
  console.log(`Écrit : ${SORTIE} (relevé du ${dateMaj || '?'}, ${vus.size} joueurs uniques${reprises.length ? `, ${reprises.length} équipe(s) reprises` : ''})`);

  /* Relevé interrompu par la page anti-robot : les équipes fraîches sont
     gardées, mais on signale l'échec pour que le job de reprise retente toute
     la ligue depuis un autre runner. */
  if (abandon) {
    console.error('Relevé partiel (interrompu par la page anti-robot) : le job de reprise retentera.');
    process.exit(1);
  }
}

main().catch(e => {
  console.error('Échec :', e.message);
  process.exit(1);
});
