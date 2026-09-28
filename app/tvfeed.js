/**
 * Unique source de données : TradingView Desktop (CDP, 127.0.0.1:9222).
 *
 * UN SEUL graphique existe et est utilisé (l'abonnement TradingView de l'utilisateur ne permet pas
 * d'en afficher plusieurs simultanément) : l'application ne crée JAMAIS de disposition
 * multi-graphiques ni de panneau supplémentaire. Chaque marché est sélectionné sur CE graphique
 * unique via la barre de recherche TradingView Desktop (requête EXACTE whitelistée par marché,
 * 1er résultat cliqué — voir `selectMarketViaSearch`), le symbole résolu est mémorisé
 * (`DATA_DIR/symbols.json`) pour éviter de rouvrir la recherche à chaque fois, et les timeframes
 * sont lues par bascule bornée de la résolution du même graphique, avec un cache par marché/TF
 * pour limiter les bascules. « Analyse complète » et « analyse en direct » relaient donc TOUTES
 * deux sur ce graphique unique, jamais en parallèle (un seul verrou global).
 *
 * A05 (injection) : toute valeur insérée dans le code évalué par CDP est un nombre validé
 * ou une chaîne whitelistée (registre markets.js) sérialisée par JSON.stringify.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DATA_DIR } from './security.js';
import { TF_LABEL } from './www/js/engine.js';
import { MARKETS, DEFAULT_MARKET, marketOf, marketById, registerResolvedAlias, symbolMatchesMarket } from './www/js/markets.js';
import { maybeRelaunchTv, relaunchCount } from './watchdog.js';

const TFS = ['1', '5', '15', '60', '240', 'D', 'W', 'M', '12M'];
const SWITCH_TTL = { '1': 20, '5': 45, '15': 90, '60': 180, '240': 600, 'D': 1800, 'W': 3600, 'M': 3600, '12M': 3600 };
const CWC = 'window.TradingViewApi._chartWidgetCollection';
const ACTIVE = 'window.TradingViewApi._activeChartWidgetWV.value()';
/** Plafond de sécurité (A05) : nombre maximal de bougies lues/retournées par timeframe. */
export const MAX_BARS = 20000;
/** Historique : rechargement automatique périodique (30 min). */
const HISTORY_INTERVAL_MS = 30 * 60 * 1000;
/** Mapping marché → symbole résolu (recherche TradingView) : ré-utilisé sans rouvrir la recherche pendant 24 h. */
const SYMBOL_MAP_TTL_MS = 24 * 60 * 60 * 1000;

let core = null;
let coreLoader = async () => {
  const [connection, chart, data] = await Promise.all([
    import('../src/connection.js'), import('../src/core/chart.js'), import('../src/core/data.js'),
  ]);
  return { connection, chart, data };
};
async function loadCore() { if (!core) core = await coreLoader(); return core; }
/** Pour les tests : remplace l'accès à TradingView par un faux. */
export function _setCore(fake) { core = fake; for (const k of Object.keys(cache)) delete cache[k]; }

// ── Santé de la lecture de données (GET /api/health) et relance automatique ──────────────────
// Erreurs transitoires (CDP inaccessible, TradingView pas lancé, WebSocket coupé) : celles-ci
// justifient une nouvelle tentative et comptent dans les échecs consécutifs ; une erreur « marché
// introuvable » (logique métier, pas de connexion) n'en fait pas partie.
const TRANSIENT_CDP_RE = /ECONNREFUSED|ECONNRESET|ETIMEDOUT|CDP|No TradingView|target|fetch failed|WebSocket|EPIPE/i;
const health = { lastDataAt: null, lastError: null, failures: 0 };
/** Pour GET /api/health (server.js). */
export function getHealth() {
  return { lastDataAt: health.lastDataAt, lastError: health.lastError, failures: health.failures, tvRelaunches: relaunchCount() };
}
/** Pour les tests. */
export function _resetHealth() { health.lastDataAt = null; health.lastError = null; health.failures = 0; }

async function recordDataSuccess() { health.lastDataAt = Date.now(); health.failures = 0; health.lastError = null; }
async function recordDataFailure(e) {
  health.failures++;
  health.lastError = String(e?.message || e).slice(0, 300);
  try { await maybeRelaunchTv(health.failures); } catch { /* best-effort : ne doit jamais faire tomber la lecture */ }
}

/** Réessaie `fn` avec un délai croissant sur les erreurs CDP transitoires (pas sur les erreurs métier). */
async function withCdpRetry(fn, { attempts = 3, baseDelayMs = 250 } = {}) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try { return await fn(); }
    catch (e) {
      lastErr = e;
      if (i === attempts - 1 || !TRANSIENT_CDP_RE.test(String(e?.message || ''))) throw e;
      core = null; // force une reconnexion CDP à la tentative suivante
      await new Promise((r) => setTimeout(r, baseDelayMs * 2 ** i));
    }
  }
  throw lastErr;
}

export const normTf = (iv) => {
  const s = String(iv || '').toUpperCase();
  if (s === 'D' || s === '1D') return 'D';
  if (s === 'W' || s === '1W') return 'W';
  if (s === 'M' || s === '1M') return 'M';
  if (s === '12M' || s === '12') return '12M';
  return /^\d+$/.test(s) ? s : null;
};
export const isGold = (sym) => /XAU.?USD/i.test(String(sym || ''));

// ── Résolution des symboles (barre de recherche TradingView Desktop) ────────────────────────────
const SYMBOL_MAP_FILE = () => join(DATA_DIR, 'symbols.json');
let symbolMap = {};
let symbolMapLoaded = false;
async function loadSymbolMap() {
  if (symbolMapLoaded) return symbolMap;
  try { symbolMap = JSON.parse(await readFile(SYMBOL_MAP_FILE(), 'utf8')) || {}; } catch { symbolMap = {}; }
  symbolMapLoaded = true;
  // purge : toute entrée incohérente (ex. US30 → OANDA:XAUUSD, héritée de l'ancien bug) est supprimée
  let purged = false;
  for (const [id, e] of Object.entries(symbolMap)) {
    if (!e?.symbol || !symbolMatchesMarket(e.symbol, id) || !/^[A-Z0-9_]+:[A-Z0-9_.!]+$/.test(e.symbol)) { delete symbolMap[id]; purged = true; continue; }
    registerResolvedAlias(id, e.symbol);
  }
  if (purged) { console.log('symbols.json : entrées incohérentes supprimées (seront re-résolues via la recherche).'); await persistSymbolMap(); }
  return symbolMap;
}
async function persistSymbolMap() {
  try { await mkdir(DATA_DIR, { recursive: true }); await writeFile(SYMBOL_MAP_FILE(), JSON.stringify(symbolMap), 'utf8'); } catch { /* best-effort : jamais bloquant */ }
}
// marchés dont la dernière résolution a échoué : évite de rouvrir la recherche à chaque cycle en
// direct pour un marché introuvable (10 min de « cache négatif » par marché).
const NEGATIVE_CACHE_MS = 10 * 60 * 1000;
const failMap = {};
function retryTimeLabel(ms) { return new Date(ms).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' }); }
function notFoundError(market, until) { return `Marché introuvable sur TradingView Desktop : ${market.label} (nouvel essai à ${retryTimeLabel(until)}).`; }
/** Pour les tests uniquement. */
export function _resetFailMap() { for (const k of Object.keys(failMap)) delete failMap[k]; }

async function setResolvedSymbol(marketId, symbol, via) {
  symbolMap[marketId] = { symbol, resolvedAt: Date.now(), via };
  registerResolvedAlias(marketId, symbol);
  delete failMap[marketId]; // une résolution réussie efface un éventuel échec précédent
  await persistSymbolMap();
  console.log(`Marché résolu sur TradingView : ${marketId} → ${symbol} (${via === 'rest' ? 'recherche REST (repli)' : via === 'recherche' ? 'barre de recherche' : via}).`);
}
/** Mapping courant marché → { symbol, resolvedAt, via } (pour GET /api/markets). */
export async function getSymbolMap() { await loadSymbolMap(); return { ...symbolMap }; }
/** Pour les tests uniquement. */
export function _resetSymbolMap() { symbolMap = {}; symbolMapLoaded = true; }

// ── Entrées RÉELLES (CDP Input) : clic souris / saisie clavier comme un utilisateur ──────────────
// Les .click()/KeyboardEvent synthétiques du DOM sont ignorés par l'interface React de TradingView
// Desktop (cause du bug « tous les marchés résolus en OANDA:XAUUSD ») : on utilise donc le domaine
// CDP `Input`, qui produit de vrais événements souris/clavier dans la fenêtre TradingView.
async function inputApi(connection) {
  try { const c = await connection.getClient?.(); return c?.Input || null; } catch { return null; }
}
async function realClick(connection, x, y) {
  const I = await inputApi(connection);
  if (!I || !Number.isFinite(x) || !Number.isFinite(y)) return false;
  await I.dispatchMouseEvent({ type: 'mouseMoved', x, y });
  await I.dispatchMouseEvent({ type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
  await I.dispatchMouseEvent({ type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
  return true;
}
const KEYS = { Enter: { code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' }, Escape: { code: 'Escape', windowsVirtualKeyCode: 27 } };
async function realKey(connection, key) {
  const I = await inputApi(connection);
  if (!I || !KEYS[key]) return false;
  const k = KEYS[key];
  await I.dispatchKeyEvent({ type: k.text ? 'keyDown' : 'rawKeyDown', key, ...k });
  await I.dispatchKeyEvent({ type: 'keyUp', key, code: k.code, windowsVirtualKeyCode: k.windowsVirtualKeyCode });
  return true;
}
/** Saisie réelle (requête whitelistée du registre, jamais une entrée utilisateur). */
async function realType(connection, text) {
  const I = await inputApi(connection);
  if (!I) return false;
  await I.insertText({ text: String(text) });
  return true;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// délais d'attente de l'interface (ms) — réduits dans les tests uniquement
const T = { rows: 5000, settle: 400, chart: 4000, enter: 3000, poll: 250, dialog: 150, data: 6000 };
/** Pour les tests uniquement. */
export function _setSearchTimeouts(o) { Object.assign(T, o); }

// Localise le dialogue de recherche de symbole (plusieurs sélecteurs : l'interface TradingView
// évolue entre versions) ; à défaut, le dialogue qui contient le champ actuellement focalisé.
const FIND_DLG = `function xzDlg() {
  var sels = ['[data-name="symbol-search-items-dialog"]', '[data-dialog-name*="ymbol"]', '[data-name*="symbol-search"][role="dialog"]'];
  for (var i = 0; i < sels.length; i++) { var d = document.querySelector(sels[i]); if (d) return d; }
  var inp = document.querySelector('input[data-role="search"]');
  if (inp) return inp.closest('[role="dialog"]') || inp.closest('[class*="dialog"]') || null;
  var a = document.activeElement;
  if (a && a.tagName === 'INPUT') return a.closest('[role="dialog"]') || null;
  return null;
}`;
// Diagnostic local (DATA_DIR/search-debug.json) : étape où la recherche UI échoue + métadonnées DOM
// (tags, data-name, rectangles — aucune donnée personnelle), pour ajuster les sélecteurs.
const searchDiag = {};
async function probeDom(connection) {
  try {
    return await connection.evaluate(`
      /*XZSEARCHPROBE*/
      (function() {
        function d(el) { var r = el.getBoundingClientRect(); return { tag: el.tagName, id: el.id || '', name: el.getAttribute('data-name') || '', role: el.getAttribute('role') || '', aria: (el.getAttribute('aria-label') || '').slice(0, 40), cls: String(el.className || '').slice(0, 60), x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) }; }
        var out = { active: document.activeElement ? d(document.activeElement) : null, candidates: [], dialogs: [], inputs: [] };
        document.querySelectorAll('[data-name*="search" i], [id*="search" i], [aria-label*="search" i], [aria-label*="recherch" i], [data-name*="symbol" i]').forEach(function(el, i) { if (i < 25) out.candidates.push(d(el)); });
        document.querySelectorAll('[role="dialog"], [data-dialog-name], [data-name*="dialog" i]').forEach(function(el, i) { if (i < 10) { var x = d(el); x.dialogName = el.getAttribute('data-dialog-name') || ''; out.dialogs.push(x); } });
        document.querySelectorAll('input').forEach(function(el, i) { if (i < 10) { var x = d(el); x.role2 = el.getAttribute('data-role') || ''; x.ph = (el.getAttribute('placeholder') || '').slice(0, 30); out.inputs.push(x); } });
        return out;
      })()
    `);
  } catch { return null; }
}
async function saveSearchDiag(marketId, info) {
  searchDiag[marketId] = { at: new Date().toISOString(), ...info };
  try { await mkdir(DATA_DIR, { recursive: true }); await writeFile(join(DATA_DIR, 'search-debug.json'), JSON.stringify(searchDiag, null, 1), 'utf8'); } catch { /* best-effort */ }
}
/** Le graphique a-t-il des bougies pour le symbole affiché (symbole existant + données disponibles) ? */
async function seriesHasData(connection, timeoutMs) {
  const start = Date.now();
  await sleep(Math.min(800, timeoutMs / 2));
  for (let first = true; first || Date.now() - start < timeoutMs; first = false) {
    let n = 0;
    try {
      n = await connection.evaluate(`
        /*XZSERIESOK*/
        (function() { try { var b = ${ACTIVE}._chartWidget.model().mainSeries().bars(); return b && typeof b.size === 'function' ? b.size() : 0; } catch (e) { return 0; } })()
      `);
    } catch { n = 0; }
    if (Number(n) > 0) return true;
    await sleep(T.poll * 2);
  }
  return false;
}

/** Position (px CSS) du bouton de recherche de symbole de la barre d'outils du graphique. */
async function searchButtonRect(connection) {
  return connection.evaluate(`
    /*XZSEARCHOPEN*/
    (function() {
      var sels = ['#header-toolbar-symbol-search', '[data-name="symbol-search-button"]', 'button[aria-label*="Symbol Search" i]', 'button[aria-label*="Recherche de symbole" i]'];
      for (var i = 0; i < sels.length; i++) {
        var el = document.querySelector(sels[i]);
        if (el) { var r = el.getBoundingClientRect(); if (r.width > 0 && r.height > 0) return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; }
      }
      return null;
    })()
  `);
}
/** Dialogue de recherche ouvert ? → focalise et sélectionne son champ (la saisie réelle remplacera le texte). */
async function focusSearchInput(connection) {
  return connection.evaluate(`
    /*XZSEARCHINPUT*/
    (function() {
      ${FIND_DLG}
      var dlg = xzDlg();
      if (!dlg) return false;
      var input = dlg.querySelector('input[data-role="search"]') || dlg.querySelector('input');
      if (!input) return false;
      input.focus(); try { input.select(); } catch (e) {}
      return document.activeElement === input;
    })()
  `);
}
/** Position (px CSS) du PREMIER résultat du dialogue de recherche (et son libellé), sinon null. */
async function firstSearchRow(connection) {
  return connection.evaluate(`
    /*XZSEARCHROWS*/
    (function() {
      ${FIND_DLG}
      var dlg = xzDlg();
      if (!dlg) return null;
      // lignes de résultat (TradingView Desktop : data-name="symbol-search-dialog-content-item",
      // souvent en « display: contents » → rectangle nul : on vise alors son 1er descendant visible)
      var sels = ['[data-name="symbol-search-dialog-content-item"]', '[data-role="list-item"]', '[class*="itemRow"]', '[class*="listItem"]', '[role="option"]', '[role="row"]'];
      function vis(el) { var r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0 ? r : null; }
      for (var i = 0; i < sels.length; i++) {
        var list = dlg.querySelectorAll(sels[i]);
        for (var j = 0; j < list.length; j++) {
          var el = list[j], r = vis(el);
          if (!r) { var kids = el.querySelectorAll('*'); for (var k = 0; k < kids.length && !r; k++) { r = vis(kids[k]); } }
          if (r) return { x: r.left + Math.min(r.width / 2, 120), y: r.top + r.height / 2, text: (el.innerText || el.textContent || '').replace(/\\s+/g, ' ').slice(0, 80) };
        }
      }
      return null;
    })()
  `);
}
async function searchDialogOpen(connection) {
  try { return !!(await connection.evaluate(`/*XZSEARCHDLG*/ (function() { ${FIND_DLG} return !!xzDlg(); })()`)); } catch { return false; }
}
async function closeSearchDialog(connection) {
  try { if (await searchDialogOpen(connection)) await realKey(connection, 'Escape'); } catch { /* ignore */ }
}
/** Attend (≤ timeoutMs) que le graphique affiche un symbole du marché voulu. */
async function waitChartOnMarket(chart, market, timeoutMs) {
  const start = Date.now();
  let last = null;
  while (Date.now() - start < timeoutMs) {
    try { last = (await chart.getState())?.symbol || null; } catch { last = null; }
    if (last && symbolMatchesMarket(last, market)) return { ok: true, symbol: String(last) };
    await sleep(T.poll);
  }
  return { ok: false, symbol: last };
}

/**
 * Résout un marché sur le graphique UNIQUE de TradingView Desktop via sa barre de recherche, avec
 * de VRAIS événements souris/clavier : clic sur le bouton de recherche, saisie de la requête EXACTE
 * du registre (`market.searchQuery`), clic sur le PREMIER résultat (Entrée en secours), puis
 * vérification que le graphique affiche bien un symbole du marché demandé (`symbolMatchesMarket`).
 * Jamais de graphique/panneau supplémentaire. Si l'interface échoue OU si le symbole affiché ne
 * correspond pas au marché, repli : recherche REST publique (1er résultat cohérent) + bascule
 * directe, elle aussi vérifiée. Un symbole incohérent n'est JAMAIS renvoyé comme succès.
 * @returns {Promise<{ok:boolean, symbol?:string, via?:string, error?:string}>}
 */
export async function selectMarketViaSearch(market) {
  const { connection, chart } = await loadCore();
  let uiSeen = null;
  const diag = { query: market.searchQuery, step: 'début' };
  try {
    const btn = await searchButtonRect(connection);
    diag.button = btn || null;
    if (!btn) { diag.step = 'bouton de recherche introuvable'; diag.dom = await probeDom(connection); }
    else if (!(await realClick(connection, btn.x, btn.y))) diag.step = 'entrées CDP indisponibles';
    else {
      let focused = false;
      for (let i = 0; i < 10 && !focused; i++) { await sleep(T.dialog); focused = await focusSearchInput(connection); }
      if (!focused) { diag.step = 'dialogue/champ de recherche non détecté après le clic'; diag.dom = await probeDom(connection); }
      else if (await realType(connection, market.searchQuery)) {
        let row = null;
        const t0 = Date.now();
        while (!row && Date.now() - t0 < T.rows) { await sleep(T.poll); row = await firstSearchRow(connection); }
        if (!row) { diag.step = 'aucune ligne de résultat détectée'; diag.dom = await probeDom(connection); }
        else {
          await sleep(T.settle); // laisse la liste se stabiliser (résultats mis à jour à la frappe)
          row = (await firstSearchRow(connection)) || row;
          diag.firstRow = row.text || '';
          await realClick(connection, row.x, row.y);
          let r = await waitChartOnMarket(chart, market, T.chart);
          if (!r.ok && await searchDialogOpen(connection)) { await realKey(connection, 'Enter'); r = await waitChartOnMarket(chart, market, T.enter); }
          await closeSearchDialog(connection);
          if (r.ok && await seriesHasData(connection, T.data)) { await saveSearchDiag(market.id, { ...diag, step: 'ok', symbol: r.symbol }); return { ok: true, symbol: r.symbol, via: 'recherche' }; }
          diag.step = r.ok ? `symbole ${r.symbol} sans données` : `graphique resté sur ${r.symbol}`;
          uiSeen = r.symbol;
        }
      }
    }
  } catch (e) { diag.step = 'exception : ' + String(e?.message || e).slice(0, 120); }
  await closeSearchDialog(connection);
  // repli : recherche REST publique → résultats COHÉRENTS avec le marché, essayés dans l'ordre
  // (le 1er qui s'affiche AVEC des bougies est retenu ; nom TradingView valide uniquement)
  const tried = [];
  try {
    const res = await chart.symbolSearch?.({ query: market.searchQuery });
    const cands = (res?.results || [])
      .map((x) => x?.full_name)
      .filter((n) => n && /^[A-Z0-9_]+:[A-Z0-9_.!]+$/.test(n) && symbolMatchesMarket(n, market))
      .slice(0, 4);
    for (const name of cands) {
      tried.push(name);
      await chart.setSymbol({ symbol: name });
      const r = await waitChartOnMarket(chart, market, T.chart);
      if (r.ok && await seriesHasData(connection, T.data)) {
        await saveSearchDiag(market.id, { ...diag, rest: tried, symbol: r.symbol });
        return { ok: true, symbol: r.symbol, via: 'rest' };
      }
    }
  } catch { /* aucun repli possible */ }
  await saveSearchDiag(market.id, { ...diag, rest: tried, symbol: null });
  return { ok: false, error: uiSeen ? `le graphique affiche ${uiSeen} au lieu de ${market.label}` : undefined };
}

/**
 * Vérifie/assure que le graphique unique affiche `market` : déjà bon → rien à faire ; sinon
 * bascule via le symbole déjà résolu (< 24 h, et cohérent avec le marché) et vérifie, sinon
 * résout via la recherche (voir `selectMarketViaSearch`) et mémorise le résultat.
 */
async function ensureChartOn(market, { bypassNegativeCache = false, forceSearch = false } = {}) {
  const { chart } = await loadCore();
  const state0 = await chart.getState();
  if (symbolMatchesMarket(state0.symbol, market)) return { ok: true, symbol: state0.symbol, via: 'déjà affiché' };
  await loadSymbolMap();
  const entry = symbolMap[market.id];
  const fresh = !forceSearch && entry && Date.now() - entry.resolvedAt < SYMBOL_MAP_TTL_MS && symbolMatchesMarket(entry.symbol, market);
  if (fresh) {
    try {
      await chart.setSymbol({ symbol: entry.symbol });
      const s2 = await chart.getState();
      const { connection } = await loadCore();
      if (symbolMatchesMarket(s2.symbol, market) && await seriesHasData(connection, T.data)) return { ok: true, symbol: s2.symbol, via: 'connu' };
      delete symbolMap[market.id]; await persistSymbolMap(); // symbole mémorisé sans bougies : oublié, re-recherché
    } catch { /* repli recherche ci-dessous */ }
  }
  // cache négatif (10 min) : un marché récemment introuvable n'est pas rerecherché à chaque cycle
  // en direct — sauf « Vérifier les marchés TradingView », qui force toujours une résolution fraîche.
  const failing = failMap[market.id];
  if (!bypassNegativeCache && failing && Date.now() < failing.until) {
    return { ok: false, error: notFoundError(market, failing.until) };
  }
  const viaSearch = await selectMarketViaSearch(market);
  if (viaSearch.ok) {
    await setResolvedSymbol(market.id, viaSearch.symbol, viaSearch.via);
    return { ok: true, symbol: viaSearch.symbol, via: viaSearch.via };
  }
  const until = Date.now() + NEGATIVE_CACHE_MS;
  failMap[market.id] = { at: Date.now(), until };
  return { ok: false, error: notFoundError(market, until) + (viaSearch.error ? ` Détail : ${viaSearch.error}.` : '') };
}

/** Lit jusqu'à maxBars bougies directement depuis une série (expression JS confiée, jamais construite depuis une entrée utilisateur). */
async function readSeriesBars(connection, seriesExpr, maxBars) {
  const n = Math.max(1, Math.min(MAX_BARS, Math.floor(Number(maxBars)) || MAX_BARS));
  const res = await connection.evaluate(`
    /*XZSERIESBARS*/
    (function(maxBars) {
      try {
        var s = ${seriesExpr};
        var bars = s.bars();
        var res = [];
        if (bars && typeof bars.lastIndex === 'function') {
          var end = bars.lastIndex(), start = Math.max(bars.firstIndex(), end - maxBars + 1);
          for (var k = start; k <= end; k++) { var v = bars.valueAt(k); if (v) res.push([v[0], v[1], v[2], v[3], v[4], v[5] || 0]); }
        }
        return res;
      } catch (e) { return []; }
    })(${n})
  `);
  return Array.isArray(res) ? res : [];
}

/** Pousse `requestMoreData` sur la série active tant qu'il reste de l'historique, plafonné à maxRounds (bascule de timeframe : chargement borné, pas de blocage indéfini). */
async function pumpActiveHistory(connection, targetBars, maxRounds) {
  let stagnant = 0, lastCount = -1;
  for (let round = 0; round < maxRounds; round++) {
    const state = await connection.evaluate(`
      /*XZACTIVECHECK*/
      (function() {
        try {
          var ms = ${ACTIVE}._chartWidget.model().mainSeries();
          var bars = ms.bars();
          var count = bars && typeof bars.size === 'function' ? bars.size() : 0;
          var more = true; try { more = ms.requestMoreDataAvailable(); } catch (e) {}
          return { count: count, more: !!more };
        } catch (e) { return { count: 0, more: false }; }
      })()
    `);
    if (!state || state.count >= targetBars || !state.more) break;
    if (state.count === lastCount) { stagnant++; if (stagnant >= 2) break; } else stagnant = 0;
    lastCount = state.count;
    await connection.evaluate(`
      /*XZACTIVEPUMP*/
      (function() { try { ${ACTIVE}._chartWidget.model().mainSeries().requestMoreData(2000); } catch (e) {} })()
    `);
    await new Promise((r) => setTimeout(r, 1500));
  }
}

/** Validation stricte des bougies reçues de TradingView (A08 : intégrité des données). */
function toCandles(rows) {
  const c = [];
  for (const r of rows || []) {
    if (!Array.isArray(r) || r.length < 5) continue;
    const [t, o, h, l, cl, v] = r.map(Number);
    if (![t, o, h, l, cl].every(Number.isFinite) || h < l || o <= 0) continue;
    c.push({ time: Math.floor(t), open: o, high: h, low: l, close: cl, volume: Number.isFinite(v) ? v : 0, complete: true });
  }
  if (c.length) c[c.length - 1].complete = false; // bougie en formation
  return c;
}

// cache[marketId][tf] = { at, candles } : un cache par marché (bascule moins souvent si l'analyse
// complète ou la rotation en direct revient régulièrement sur le même marché).
const cache = {};
function cacheFor(marketId) { return cache[marketId] || (cache[marketId] = {}); }
let lock = Promise.resolve();

/** count : entier (50 à MAX_BARS) ou littéral 'all' → toutes les bougies chargées dans TradingView (plafonné). */
function resolveCount(count) {
  if (count === 'all') return MAX_BARS;
  const n = Math.floor(Number(count));
  return Number.isFinite(n) ? Math.max(50, Math.min(MAX_BARS, n)) : 500;
}

/** Marché whitelisté (registre markets.js) ; XAUUSD par défaut (comportement historique). */
function resolveMarket(marketId) {
  return marketById(marketId) || marketById(DEFAULT_MARKET);
}

/**
 * @param {object} [opts] { tfs, count, market } — `market` : id whitelisté (markets.js), XAUUSD
 *   par défaut (comportement historique inchangé). UN SEUL graphique existe : tous les marchés
 *   (analyse en direct incluse) se relaient sur ce même graphique, en file (verrou `lock`).
 * @returns {Promise<{status:number, body:object}>}
 */
export function getCandles({ tfs = TFS, count = 500, market } = {}) {
  const wanted = [...new Set(tfs)].filter((t) => TFS.includes(t));
  const mkt = resolveMarket(market);
  const job = lock.then(() => doGetCandles(wanted, resolveCount(count), mkt));
  lock = job.catch(() => {});
  return job;
}

/**
 * Lit les bougies d'un marché sur les timeframes demandées, sur le graphique UNIQUE, en vérifiant
 * d'abord qu'il pointe sur le bon marché (sélection via recherche si besoin — voir `ensureChartOn`),
 * EN LAISSANT ensuite le graphique dans l'état où cet appel le trouve (bascule de résolution
 * possible) : c'est à l'appelant de restaurer l'état d'origine (voir doGetCandles et fullScan, qui
 * partagent ce cœur pour ne restaurer qu'une seule fois par marché ou en fin de scan complet).
 */
async function readMarketCandles(market, tfs, count, onTf, ensureOpts = {}) {
  const { connection, chart } = await loadCore();
  const mCache = cacheFor(market.id);
  const ver = await ensureChartOn(market, ensureOpts);
  if (!ver.ok) return { ok: false, status: 409, error: ver.error, candles: {}, errors: {}, sources: {}, symbol: null };
  const symbol = ver.symbol;
  const candles = {}, errors = {}, sources = {};
  const state0 = await chart.getState();
  const curTf = normTf(state0.resolution);
  if (curTf && tfs.includes(curTf)) {
    const rows = await readSeriesBars(connection, `${ACTIVE}._chartWidget.model().mainSeries()`, count);
    const c = toCandles(rows);
    if (c.length) { candles[curTf] = c; sources[curTf] = 'graphique'; mCache[curTf] = { at: Date.now(), candles: c }; onTf?.(curTf, 'graphique'); }
  }
  const missing = tfs.filter((tf) => !candles[tf]);
  const now = Date.now();
  const toSwitch = missing.filter((tf) => !mCache[tf] || now - mCache[tf].at > SWITCH_TTL[tf] * 1000);
  for (const tf of missing) if (!toSwitch.includes(tf)) { candles[tf] = mCache[tf].candles; sources[tf] = 'cache'; onTf?.(tf, 'cache'); }
  for (const tf of toSwitch) {
    try {
      await chart.setTimeframe({ timeframe: tf });
      await pumpActiveHistory(connection, count, 10);
      const rows = await readSeriesBars(connection, `${ACTIVE}._chartWidget.model().mainSeries()`, count);
      const c = toCandles(rows);
      if (!c.length) throw new Error('aucune bougie');
      candles[tf] = c; sources[tf] = 'bascule'; mCache[tf] = { at: Date.now(), candles: c }; onTf?.(tf, 'bascule');
    } catch {
      if (mCache[tf]) { candles[tf] = mCache[tf].candles; sources[tf] = 'cache'; } else errors[tf] = 'timeframe non lisible';
      onTf?.(tf, errors[tf] ? 'erreur' : 'cache');
    }
  }
  return { ok: true, candles, errors, sources, symbol };
}

async function doGetCandles(tfs, count, market) {
  try {
    const out = await withCdpRetry(() => doGetCandlesOnce(tfs, count, market));
    if (out.status === 200) await recordDataSuccess();
    return out;
  } catch (e) {
    await recordDataFailure(e);
    throw e;
  }
}

async function doGetCandlesOnce(tfs, count, market) {
  const { chart } = await loadCore();
  const before = await chart.getState();
  const originalSymbol = String(before.symbol || '');
  const originalTf = normTf(before.resolution) || before.resolution;
  let res;
  try {
    res = await readMarketCandles(market, tfs, count);
  } finally {
    await restoreChart(chart, originalSymbol, originalTf, market);
  }
  if (!res.ok) return { status: res.status, body: { success: false, error: res.error } };
  const meta = {};
  for (const [tf, arr] of Object.entries(res.candles)) {
    if (arr && arr.length) meta[tf] = { count: arr.length, first: arr[0].time, last: arr.at(-1).time };
  }
  return {
    status: 200,
    body: {
      success: true, market: market.id, symbol: String(res.symbol).slice(0, 40), candles: res.candles, errors: res.errors, sources: res.sources, meta,
    },
  };
}

/** Restaure le symbole/timeframe d'origine du graphique, si `readMarketCandles` les a changés. */
async function restoreChart(chart, originalSymbol, originalTf, market) {
  const originalMarket = marketOf(originalSymbol);
  if (originalMarket && originalMarket.id !== market.id) {
    try { await chart.setSymbol({ symbol: originalSymbol }); } catch { /* ignore */ }
  }
  if (originalTf && /^(\d{1,4}[SDWM]?|[DWM])$/i.test(String(originalTf))) {
    try { await chart.setTimeframe({ timeframe: String(originalTf) }); } catch { /* ignore */ }
  }
}

/**
 * « Vérifier les marchés TradingView » : résout CHACUN des 11 marchés du registre via la recherche
 * (ou le mapping connu, < 24 h) sur le graphique UNIQUE, sans jamais créer de graphique/panneau
 * supplémentaire, puis restaure le symbole/TF d'origine. Remplace l'ancienne préparation
 * multi-graphiques (retirée : l'abonnement de l'utilisateur ne permet qu'un seul graphique).
 * @returns {Promise<{success:boolean, resolved:Array<{market:string,label:string,symbol:string|null,via:string|null,ok:boolean}>}>}
 */
export function verifyMarkets({ markets = MARKETS } = {}) {
  const list = markets.map((m) => (typeof m === 'string' ? marketById(m) : m)).filter(Boolean);
  const job = lock.then(() => doVerifyMarkets(list));
  lock = job.catch(() => {});
  return job;
}

async function doVerifyMarkets(markets) {
  const { chart } = await loadCore();
  const before = await chart.getState();
  const originalSymbol = String(before.symbol || '');
  const originalTf = normTf(before.resolution) || before.resolution;
  const resolved = [];
  try {
    for (const market of markets) {
      const ver = await ensureChartOn(market, { bypassNegativeCache: true, forceSearch: true });
      resolved.push({ market: market.id, label: market.label, symbol: ver.ok ? ver.symbol : null, via: ver.ok ? ver.via : null, ok: ver.ok, error: ver.ok ? undefined : ver.error });
    }
  } finally {
    const lastMarket = markets.at(-1) || marketById(DEFAULT_MARKET);
    await restoreChart(chart, originalSymbol, originalTf, lastMarket);
  }
  return { success: true, resolved };
}

/**
 * Charge le maximum d'historique disponible pour le graphique UNIQUE (quel que soit le marché
 * actuellement affiché), sans jamais changer sa timeframe ou son symbole (lecture passive,
 * `requestMoreData` uniquement — cf. src/core/chart.js setVisibleRange pour le même mécanisme).
 * Verrouillé avec `lock` : ne chevauche jamais un getCandles / une vérification en cours.
 * @returns {Promise<Array<{interval:string, bars:number, firstTime:number|null, more:boolean}>>}
 */
export function loadHistory({ targetBars = 20000, maxRounds = 40 } = {}) {
  const target = Math.max(1, Math.min(MAX_BARS, Math.floor(Number(targetBars)) || 20000));
  const rounds = Math.max(1, Math.min(200, Math.floor(Number(maxRounds)) || 40));
  const job = lock.then(() => doLoadHistory(target, rounds));
  lock = job.catch(() => {});
  return job;
}

async function doLoadHistory(target, maxRounds) {
  const { connection, chart } = await loadCore();
  const before = await chart.getState();
  if (!marketOf(before.symbol)) {
    console.log('Historique TradingView : le graphique n\'affiche pas un marché suivi, aucun chargement.');
    return [];
  }
  let stagnant = 0, lastCount = -1, state = null;
  for (let round = 0; round < maxRounds; round++) {
    state = await connection.evaluate(`
      /*XZACTIVECHECK*/
      (function() {
        try {
          var ms = ${ACTIVE}._chartWidget.model().mainSeries();
          var bars = ms.bars();
          var count = bars && typeof bars.size === 'function' ? bars.size() : 0;
          var firstTime = null;
          if (bars && typeof bars.firstIndex === 'function' && count > 0) { var v = bars.valueAt(bars.firstIndex()); firstTime = v ? v[0] : null; }
          var more = true; try { more = ms.requestMoreDataAvailable(); } catch (e) {}
          return { count: count, firstTime: firstTime, more: !!more };
        } catch (e) { return { count: 0, firstTime: null, more: false, error: 'lecture impossible' }; }
      })()
    `);
    if (!state || state.error) break;
    if (state.count >= target || !state.more) break;
    if (state.count === lastCount) { stagnant++; if (stagnant >= 2) break; } else stagnant = 0;
    lastCount = state.count;
    await connection.evaluate(`
      /*XZACTIVEPUMP*/
      (function() { try { ${ACTIVE}._chartWidget.model().mainSeries().requestMoreData(2000); } catch (e) {} })()
    `);
    await new Promise((r) => setTimeout(r, 1500));
  }
  const interval = normTf(before.resolution) || before.resolution;
  const result = { interval, bars: state?.count || 0, firstTime: state?.firstTime ?? null, more: state?.more ?? false };
  console.log('Historique TradingView : ' + `${TF_LABEL[result.interval] || result.interval} ${result.bars} bougies`);
  return [result];
}

// ── Analyse complète (« fullScan ») : tous les marchés × 9 timeframes, séquentiellement, sur le
// graphique UNIQUE (chaque marché est d'abord vérifié/sélectionné via la recherche si besoin) ────
let scanAbort = false;
/** Abandonne le scan complet en cours (le prochain point de contrôle interrompt la boucle). */
export function abortScan() { scanAbort = true; }

/**
 * Bougies de tous les marchés demandés (par défaut : tout le registre), sur les 9 timeframes, via
 * le même chemin que `getCandles` (vérification du marché puis bascule de résolution bornée sur
 * le graphique unique). Le symbole et la timeframe d'origine sont restaurés une seule fois, à la
 * fin du scan complet (pas entre deux marchés) — plus rapide qu'un enchaînement de `getCandles`
 * indépendants. `onProgress({ marketId, marketLabel, tf, done, total, status })` à chaque étape.
 * @returns {Promise<{ results: Record<string, {candles, errors, symbol}>, aborted: boolean }>}
 */
export function fullScan({ markets = MARKETS, tfs = TFS, count = 5000, onProgress } = {}) {
  const wanted = [...new Set(tfs)].filter((t) => TFS.includes(t));
  const list = markets.map((m) => (typeof m === 'string' ? marketById(m) : m)).filter(Boolean);
  const job = lock.then(() => doFullScan(list, wanted, resolveCount(count), onProgress));
  lock = job.catch(() => {});
  return job;
}

async function doFullScan(markets, tfs, count, onProgress) {
  scanAbort = false;
  const { chart } = await loadCore();
  const before = await chart.getState();
  const originalSymbol = String(before.symbol || '');
  const originalTf = normTf(before.resolution) || before.resolution;
  const total = markets.length * tfs.length;
  let done = 0;
  const results = {};
  try {
    for (const market of markets) {
      if (scanAbort) break;
      const res = await readMarketCandles(market, tfs, count, (tf, status) => {
        done++;
        onProgress?.({ marketId: market.id, marketLabel: market.label, tf, done, total, status });
      }, { forceSearch: true }); // analyse complète : chaque marché est (re)sélectionné via la barre de recherche
      results[market.id] = res.ok ? { candles: res.candles, errors: res.errors, symbol: res.symbol } : { candles: {}, errors: { _market: res.error }, symbol: null };
      if (!res.ok) done += tfs.length - Object.keys(res.errors || {}).length; // étapes non exécutées comptées comme faites (progression continue)
    }
  } finally {
    // ne restaure qu'à la fin du scan complet (pas entre deux marchés : gain de temps)
    const lastMarket = markets.at(-1) || marketById(DEFAULT_MARKET);
    await restoreChart(chart, originalSymbol, originalTf, lastMarket);
  }
  return { results, aborted: scanAbort };
}

/**
 * Programme le chargement d'historique en tâche de fond : une première fois peu après le
 * démarrage du serveur, puis toutes les 30 minutes. `unref()` sur les minuteries : ne bloque
 * jamais l'arrêt du processus (utile aussi pour les tests, qui n'attendent pas ces déclenchements).
 */
export function scheduleHistoryLoads({ delayMs = 8000, intervalMs = HISTORY_INTERVAL_MS } = {}) {
  const kick = () => { loadHistory().catch((e) => console.log('Historique TradingView : échec (' + (e?.message || e) + ')')); };
  const t1 = setTimeout(kick, delayMs);
  if (t1.unref) t1.unref();
  const t2 = setInterval(kick, intervalMs);
  if (t2.unref) t2.unref();
  return { initial: t1, interval: t2 };
}
