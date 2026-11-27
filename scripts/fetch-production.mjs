#!/usr/bin/env node
/**
 * Relève CENTRAL de la production des 22 clubs sur ushl.ca : écrit
 * data/production.json dans ushl-releve. Chaque interface de DG copie ensuite
 * la part de son club (workflow « Relève de la production USHL » de chaque
 * dépôt, script copier-production.mjs) au lieu d'interroger ushl.ca.
 *
 * Pourquoi (27 novembre 2026) : chaque dépôt relevait sa production lui-même
 * (3 pages, jusqu'à 3 essais chacune, puis un job de reprise), à chaque
 * simulation, à la seconde passe de sécurité et à ses deux crons, que GitHub
 * retarde de plusieurs heures. Une soixantaine de relèves par jour, dont 22
 * lectures identiques de la page XtraStats; ushl.ca servait alors sa page
 * anti-robot et les relèves échouaient en série (courriels « Run failed »).
 * Ici : XtraStats une seule fois, puis 2 pages par club, lentement, soit
 * 45 requêtes par relève au lieu de plus de 130.
 *
 * Les parseurs ne sont pas réécrits : l'index.html d'une interface (celui des
 * Sharks dans le workflow) est chargé dans jsdom et ses fonctions
 * (parseScoring, parseXtra, validerPointage, extraireFiche) sont réutilisées
 * telles quelles, comme les adresses de son CONFIG (le code du club y est
 * remplacé). Le serveur et le navigateur lisent donc les pages pareil.
 *
 * Sources :
 *  - USHLxtrastats.html : une page pour toute la ligue (minutes, mises en
 *    échec, QG et HS des gardiens), lue une seule fois;
 *  - TeamScoringTemplate.php?team=X : les tableaux de pointage du club;
 *  - TeamScoring.php?team=X : seulement pour la fiche du club (V-D-N).
 *
 * Ménagement de ushl.ca :
 *  - en-têtes d'un navigateur ordinaire;
 *  - pause aléatoire de 2 à 4 s entre deux requêtes;
 *  - la page anti-robot est reconnue et suivie d'une longue pause;
 *  - après BLOCAGES_MAX pages bloquées de suite, on arrête : les clubs restants
 *    gardent leurs données et le job de reprise retente plus tard, depuis un
 *    autre runner, seulement les clubs manquants.
 *
 * Format : { genere, maj, source, equipes: { CODE: <part> } }, où chaque part
 * a exactement la forme de l'ancien data/production.json d'une interface
 * ({ genere, equipe, fiche, pointage, xtra, reprises }). Une part dont le
 * contenu ne change pas est gardée telle quelle (même « genere »), pour ne pas
 * committer à vide.
 *
 * Usage : node scripts/fetch-production.mjs [--interface index.html]
 *           [--sortie data/production.json] [--rosters data/rosters.json]
 *           [--equipes CODE1,CODE2,XTRA]
 *  --equipes  ne relève que ces clubs (XTRA = la page XtraStats); sert au job
 *             de reprise. Sans cette option : XtraStats et les 22 clubs.
 * Variables : USHL_RACINE (ex. http://127.0.0.1:8080) remplace https://ushl.ca
 *             (tests hors ligne); USHL_RAPIDE=1 supprime les pauses (tests).
 * Sortie : code 0 si tout a été relevé, 1 sinon (les parts fraîches sont
 * écrites dans les deux cas). Dans GitHub Actions, écrit aussi dans
 * $GITHUB_OUTPUT : ok=true si tout est relevé, a_reprendre=<liste pour
 * --equipes>, change=true si au moins une part a changé.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { JSDOM } from 'jsdom';

import { DEPOTS, EQUIPES } from './depots.mjs';

const RACINE = process.env.USHL_RACINE || null;
const DELAI_MS = 20000;
const ESSAIS = 3;
const RAPIDE = process.env.USHL_RAPIDE === '1';
const PAUSE_MIN_MS = RAPIDE ? 0 : 2000;
const PAUSE_MAX_MS = RAPIDE ? 0 : 4000;
const PAUSE_BLOCAGE_MS = RAPIDE ? 0 : 15000;
const BLOCAGES_MAX = 3;
const MIN_XTRA = 5;
const XTRA = 'XTRA';

/* Un navigateur ordinaire : l'ancien « usc-dashboard-bot » s'annonçait robot. */
const ENTETES = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'fr-CA,fr;q=0.9,en;q=0.8'
};
/* La page anti-robot est traduite selon Accept-Language (constaté le 26 novembre 2026). */
const ANTI_ROBOT = /being verified|One moment, please|en cours de v[ée]rification|Un instant, s.il vous pla[iî]t/i;

/** Page de vérification anti-robot reçue à la place de la vraie page. */
class PageBloquee extends Error {}
/** Relevé interrompu pour ménager ushl.ca : la requête n'a pas été faite. */
class NonTentee extends Error {}

const args = process.argv.slice(2);
const lireArg = (nom, defaut) => {
  const i = args.indexOf(nom);
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : defaut;
};
const SORTIE = lireArg('--sortie', 'data/production.json');
const ROSTERS = lireArg('--rosters', 'data/rosters.json');
const INTERFACE = lireArg('--interface', 'index.html');
const FILTRE = lireArg('--equipes', null);

const dodo = ms => new Promise(r => setTimeout(r, ms));
const pause = () => dodo(PAUSE_MIN_MS + Math.random() * (PAUSE_MAX_MS - PAUSE_MIN_MS));
const adresse = url => (RACINE ? url.replace(/^https:\/\/ushl\.ca/, RACINE) : url);
const pourClub = (url, code) => url.replace(/([?&]team=)[^&]*/, `$1${encodeURIComponent(code)}`);

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
  for (const f of ['parseScoring', 'parseXtra', 'validerPointage', 'extraireFiche']) {
    if (!S || typeof S[f] !== 'function') {
      throw new Error(`index.html n'expose pas ${f} (window.__SJS__)`);
    }
  }
  if (!S.CONFIG?.urls || !S.ETAT) throw new Error('index.html n\'expose pas CONFIG ou ETAT (window.__SJS__)');
  return { S, window: dom.window };
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

async function lireJson(chemin) {
  try {
    return JSON.parse(await fs.readFile(chemin, 'utf8'));
  } catch {
    return null;
  }
}

/** Ce qui décide d'une réécriture : le contenu, pas les horodatages. */
function empreinte(d) {
  if (!d) return null;
  return JSON.stringify({
    equipe: d.equipe,
    fiche: d.fiche,
    pointage: d.pointage ? { patineurs: d.pointage.patineurs, gardiens: d.pointage.gardiens } : null,
    xtra: d.xtra ? { date: d.xtra.date, joueurs: d.xtra.joueurs } : null
  });
}

async function main() {
  const racine = process.cwd();
  const { S, window } = await outilsDepuisInterface(path.resolve(racine, INTERFACE));
  const urls = S.CONFIG.urls;
  for (const cle of ['pointage', 'scoring', 'xtra']) {
    if (!urls[cle]) throw new Error(`index.html ne déclare pas CONFIG.urls.${cle}`);
  }

  const tous = DEPOTS.map(d => EQUIPES[d]);
  if (tous.some(c => !c)) throw new Error('depots.mjs : un dépôt n\'a pas de code d\'équipe (EQUIPES)');
  const demandes = FILTRE ? FILTRE.split(',').map(s => s.trim()).filter(Boolean) : [XTRA, ...tous];
  const inconnus = demandes.filter(c => c !== XTRA && !tous.includes(c));
  if (inconnus.length) throw new Error(`club(s) inconnu(s) : ${inconnus.join(', ')}`);
  const clubs = tous.filter(c => demandes.includes(c));
  const lireXtra = demandes.includes(XTRA);

  const rosters = await lireJson(path.join(racine, ROSTERS));
  const existant = await lireJson(path.join(racine, SORTIE));
  const anciennes = existant?.equipes && typeof existant.equipes === 'object' ? existant.equipes : {};
  const maintenant = new Date().toISOString();

  let bloquesDeSuite = 0;
  let abandon = false;

  /* Une requête vers ushl.ca, avec le compteur de blocages. */
  async function chercher(url) {
    if (abandon) throw new NonTentee('non tentée, relevé interrompu');
    let derniere = null;
    for (let essai = 1; essai <= ESSAIS; essai++) {
      try {
        const ctl = new AbortController();
        const t = setTimeout(() => ctl.abort(), DELAI_MS);
        const rep = await fetch(adresse(url), { signal: ctl.signal, headers: ENTETES });
        clearTimeout(t);
        if (!rep.ok) throw new Error('HTTP ' + rep.status);
        const txt = await rep.text();
        if (ANTI_ROBOT.test(txt)) {
          throw new PageBloquee(`page anti-robot · HTTP ${rep.status}, ${txt.length} car. · « ${extraitDePage(txt)} »`);
        }
        if (txt.length < 500) throw new Error(`réponse anormalement courte (HTTP ${rep.status}, ${txt.length} car.)`);
        bloquesDeSuite = 0;
        return { texte: txt, statut: rep.status, longueur: txt.length };
      } catch (e) {
        derniere = e;
        // Bloqué : on laisse au serveur le temps de se calmer avant de retenter.
        if (essai < ESSAIS) await dodo(e instanceof PageBloquee ? PAUSE_BLOCAGE_MS * essai : 1000 * essai);
      }
    }
    if (derniere instanceof PageBloquee && ++bloquesDeSuite >= BLOCAGES_MAX && !abandon) {
      abandon = true;
      console.log(`  ! ${BLOCAGES_MAX} pages bloquées de suite : relevé interrompu pour ménager ushl.ca.`);
    }
    throw derniere;
  }

  const aReprendre = [];
  let frais = 0;

  // 1) XtraStats : une page pour toute la ligue, lue une seule fois
  let xtraTexte = null, xtraDate = null;
  if (lireXtra) {
    try {
      const { texte } = await chercher(urls.xtra);
      const m = texte.match(/As of\s+([0-9/]+)/i);
      if (!m) throw new Error(`date « As of » introuvable · « ${extraitDePage(texte)} »`);
      xtraTexte = texte;
      xtraDate = m[1];
      frais++;
      console.log(`XtraStats    en date du ${xtraDate}`);
    } catch (e) {
      aReprendre.push(XTRA);
      console.log(`XtraStats    ✗ ${e.message} · reprise du relevé précédent`);
    }
    if (clubs.length) await pause();
  }

  // 2) Pointage et fiche, club par club
  const equipes = { ...anciennes };
  let changees = 0;
  for (const code of clubs) {
    const precedent = anciennes[code]?.equipe === code ? anciennes[code] : null;
    const part = { genere: maintenant, equipe: code, fiche: null, pointage: null, xtra: null, reprises: [] };
    const notes = [];

    // validerPointage reconnaît le club à ses joueurs (ETAT.roster) et
    // extraireFiche cherche CONFIG.equipe : on les règle sur ce club.
    S.CONFIG.equipe = code;
    S.ETAT.roster = (rosters?.equipes?.[code]?.joueurs || []).map(j => ({ ...j }));

    let pointageFrais = false;
    try {
      const { texte, statut, longueur } = await chercher(pourClub(urls.pointage, code));
      if (!S.validerPointage(texte)) {
        throw new Error(`gabarit illisible ou d'un autre club · HTTP ${statut}, ${longueur} car. · « ${extraitDePage(texte)} »`);
      }
      const doc = new window.DOMParser().parseFromString(texte, 'text/html');
      const s = S.parseScoring(texte, doc);
      part.pointage = { releve: maintenant, patineurs: s.patineurs, gardiens: s.gardiens };
      pointageFrais = true;
      frais++;
      notes.push(`pointage ${s.patineurs.length}+${s.gardiens.length}`);
    } catch (e) {
      if (precedent?.pointage) {
        part.pointage = precedent.pointage;
        part.reprises.push('pointage');
      }
      notes.push(`pointage ✗ ${e.message}`);
    }
    if (!abandon) await pause();

    try {
      const { texte } = await chercher(pourClub(urls.scoring, code));
      const f = S.extraireFiche(texte);
      if (!f) throw new Error(`fiche introuvable · « ${extraitDePage(texte)} »`);
      part.fiche = f;
      frais++;
      notes.push(`fiche ${f.slice(code.length + 1)}`);
    } catch (e) {
      part.fiche = precedent?.fiche || rosters?.equipes?.[code]?.fiche || null;
      notes.push(`fiche ✗ ${e.message}`);
    }

    if (xtraTexte) {
      const x = S.parseXtra(xtraTexte, code);
      if (x.length >= MIN_XTRA) {
        part.xtra = { releve: maintenant, date: xtraDate, joueurs: x };
        notes.push(`XtraStats ${x.length}`);
      } else {
        notes.push(`XtraStats ✗ ${x.length} joueurs lus (< ${MIN_XTRA})`);
      }
    }
    if (!part.xtra && precedent?.xtra) {
      part.xtra = precedent.xtra;
      part.reprises.push('xtra');
    }

    if (!pointageFrais) aReprendre.push(code);

    const utile = part.pointage || part.xtra;
    if (!utile) {
      console.log(`${code.padEnd(12)} ✗ rien d'exploitable · ${notes.join(' · ')}`);
    } else if (empreinte(part) === empreinte(precedent)) {
      console.log(`${code.padEnd(12)} = inchangé · ${notes.join(' · ')}`);
    } else {
      equipes[code] = part;
      changees++;
      console.log(`${code.padEnd(12)} ✓ ${notes.join(' · ')}${part.reprises.length ? ` (reprises : ${part.reprises.join(', ')})` : ''}`);
    }
    if (!abandon && code !== clubs[clubs.length - 1]) await pause();
  }

  // Reprise de XtraStats (--equipes XTRA,...) : les clubs non relevés cette
  // fois reçoivent aussi le XtraStats frais, sur leur part existante.
  if (xtraTexte) {
    for (const code of tous.filter(c => !clubs.includes(c))) {
      const precedent = anciennes[code]?.equipe === code ? anciennes[code] : null;
      if (!precedent) continue;
      S.CONFIG.equipe = code;
      const x = S.parseXtra(xtraTexte, code);
      if (x.length < MIN_XTRA) continue;
      const part = {
        ...precedent,
        genere: maintenant,
        xtra: { releve: maintenant, date: xtraDate, joueurs: x },
        reprises: (precedent.reprises || []).filter(r => r !== 'xtra')
      };
      if (empreinte(part) !== empreinte(precedent)) {
        equipes[code] = part;
        changees++;
        console.log(`${code.padEnd(12)} ✓ XtraStats ${x.length}`);
      }
    }
  }

  console.log(`\n${frais} source(s) fraîche(s) · ${changees} club(s) changé(s)` +
    (aReprendre.length ? ` · à reprendre : ${aReprendre.join(', ')}` : ''));

  if (changees) {
    const charge = {
      genere: maintenant,
      maj: xtraDate || existant?.maj || null,
      source: 'ushl.ca : TeamScoringTemplate.php, TeamScoring.php et USHLxtrastats.html',
      equipes: Object.fromEntries(tous.filter(c => equipes[c]).map(c => [c, equipes[c]]))
    };
    const sortie = path.join(racine, SORTIE);
    await fs.mkdir(path.dirname(sortie), { recursive: true });
    await fs.writeFile(sortie, JSON.stringify(charge, null, 1) + '\n', 'utf8');
    console.log(`Écrit : ${SORTIE}`);
  } else {
    console.log('Aucun changement : fichier laissé tel quel.');
  }

  if (process.env.GITHUB_OUTPUT) {
    await fs.appendFile(process.env.GITHUB_OUTPUT,
      (aReprendre.length ? '' : 'ok=true\n') +
      `a_reprendre=${aReprendre.join(',')}\n` +
      (changees ? 'change=true\n' : ''));
  }

  if (aReprendre.length) {
    console.error(`Relevé incomplet (${aReprendre.join(', ')}) : le job de reprise retentera depuis un runner neuf.`);
    process.exit(1);
  }
}

main().catch(e => {
  console.error('Échec :', e.message);
  process.exit(1);
});
