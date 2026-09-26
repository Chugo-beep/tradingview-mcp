/**
 * Unique source de données : TradingView Desktop (CDP, 127.0.0.1:9222).
 *
 * 1. Lecture PASSIVE de tous les graphiques de la disposition : chaque graphique XAUUSD
 *    fournit sa timeframe sans rien modifier.
 * 2. Timeframes absentes : bascule temporaire du graphique actif puis retour à la
 *    timeframe d'origine, avec un cache pour limiter les bascules.
 * 3. « Préparer TradingView » : disposition multi-graphiques XAUUSD (1m, 5m, 15m, 1h, 4h, 1D)
 *    selon ce que l'abonnement autorise.
 *
 * A05 (injection) : toute valeur insérée dans le code évalué par CDP est un nombre validé
 * ou une chaîne sérialisée par JSON.stringify et vérifiée par liste blanche.
 */
import { TF_LABEL } from './www/js/engine.js';
import { MARKETS, MARKET_IDS, DEFAULT_MARKET, marketOf, marketById } from './www/js/markets.js';

const TFS = ['1', '5', '15', '60', '240', 'D', 'W', 'M', '12M'];
const SWITCH_TTL = { '1': 20, '5': 45, '15': 90, '60': 180, '240': 600, 'D': 1800, 'W': 3600, 'M': 3600, '12M': 3600 };
const CWC = 'window.TradingViewApi._chartWidgetCollection';
const ACTIVE = 'window.TradingViewApi._activeChartWidgetWV.value()';
/** Plafond de sécurité (A05) : nombre maximal de bougies lues/retournées par timeframe. */
export const MAX_BARS = 20000;
/** Historique : rechargement automatique périodique (30 min). */
const HISTORY_INTERVAL_MS = 30 * 60 * 1000;

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

export const normTf = (iv) => {
  const s = String(iv || '').toUpperCase();
  if (s === 'D' || s === '1D') return 'D';
  if (s === 'W' || s === '1W') return 'W';
  if (s === 'M' || s === '1M') return 'M';
  if (s === '12M' || s === '12') return '12M';
  return /^\d+$/.test(s) ? s : null;
};
export const isGold = (sym) => /XAU.?USD/i.test(String(sym || ''));

async function readPanes(maxBars) {
  const { connection } = await loadCore();
  const n = Math.max(1, Math.min(MAX_BARS, Math.floor(Number(maxBars)) || MAX_BARS));
  const res = await connection.evaluate(`
    (function(maxBars) {
      var out = [];
      var cwc = ${CWC};
      var all = cwc && cwc.getAll ? cwc.getAll() : [];
      for (var i = 0; i < all.length; i++) {
        try {
          var s = all[i].model().mainSeries();
          var bars = s.bars();
          var res = [];
          if (bars && typeof bars.lastIndex === 'function') {
            var end = bars.lastIndex(), start = Math.max(bars.firstIndex(), end - maxBars + 1);
            for (var k = start; k <= end; k++) { var v = bars.valueAt(k); if (v) res.push([v[0], v[1], v[2], v[3], v[4], v[5] || 0]); }
          }
          out.push({ index: i, symbol: String(s.symbol()), interval: String(s.interval()), bars: res });
        } catch (e) { out.push({ index: i, error: 'lecture impossible' }); }
      }
      return out;
    })(${n})
  `);
  return Array.isArray(res) ? res : [];
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
// complète revient régulièrement sur le même marché).
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
 *   par défaut (comportement historique inchangé).
 * @returns {Promise<{status:number, body:object}>}
 */
export function getCandles({ tfs = TFS, count = 500, market } = {}) {
  const wanted = [...new Set(tfs)].filter((t) => TFS.includes(t));
  const mkt = resolveMarket(market);
  // Marché en direct sur un panneau dédié (§ « Marchés en direct » ci-dessous) : lecture parallèle,
  // indépendante du verrou global — sauf pendant une analyse complète, qui reprend le graphique actif.
  const paneIdx = !scanInProgress ? liveMarketIds.indexOf(mkt.id) : -1;
  if (paneIdx >= 0) {
    const job = paneLocks[paneIdx].then(() => doGetCandlesLive(paneIdx, wanted, resolveCount(count), mkt));
    paneLocks[paneIdx] = job.catch(() => {});
    return job;
  }
  const job = lock.then(() => doGetCandles(wanted, resolveCount(count), mkt));
  lock = job.catch(() => {});
  return job;
}

/**
 * Lit les bougies d'un marché sur les timeframes demandées, EN LAISSANT le graphique actif dans
 * l'état où cet appel le trouve (bascule symbole/timeframe possible) : c'est à l'appelant de
 * restaurer l'état d'origine (voir doGetCandles et fullScan, qui partagent ce cœur pour ne
 * restaurer qu'une seule fois par marché ou en fin de scan complet).
 */
async function readMarketCandles(market, tfs, count, onTf) {
  const { connection, chart } = await loadCore();
  const mCache = cacheFor(market.id);
  const panes = await readPanes(count);
  const matched = panes.filter((p) => !p.error && marketOf(p.symbol)?.id === market.id);
  const state = await chart.getState();
  const activeMarket = marketOf(state.symbol);
  const activeMatches = activeMarket?.id === market.id;
  if (!matched.length && !activeMatches) {
    return { ok: false, status: 409, error: `Analyse bloquée : aucun graphique ${market.label} ouvert dans TradingView Desktop.`, candles: {}, errors: {}, sources: {}, symbol: null };
  }
  const symbol = (matched[0] && matched[0].symbol) || (activeMatches ? state.symbol : market.tv);
  const candles = {}, errors = {}, sources = {};
  for (const p of matched) {
    const tf = normTf(p.interval);
    if (tf && tfs.includes(tf) && !candles[tf]) {
      const c = toCandles(p.bars);
      if (c.length) { candles[tf] = c; sources[tf] = 'graphique'; mCache[tf] = { at: Date.now(), candles: c }; onTf?.(tf, 'graphique'); }
    }
  }
  const missing = tfs.filter((tf) => !candles[tf]);
  const now = Date.now();
  const toSwitch = missing.filter((tf) => !mCache[tf] || now - mCache[tf].at > SWITCH_TTL[tf] * 1000);
  for (const tf of missing) if (!toSwitch.includes(tf)) { candles[tf] = mCache[tf].candles; sources[tf] = 'cache'; onTf?.(tf, 'cache'); }

  if (toSwitch.length) {
    // bascule le symbole si nécessaire (une seule fois pour tout ce marché), puis chaque timeframe manquante
    if (!activeMatches) {
      try { await chart.setSymbol({ symbol: market.tv }); }
      catch { for (const tf of toSwitch) { if (mCache[tf]) { candles[tf] = mCache[tf].candles; sources[tf] = 'cache'; } else errors[tf] = 'symbole non basculable'; onTf?.(tf, 'erreur'); } }
    }
    if (!Object.keys(errors).length || toSwitch.some((tf) => !errors[tf])) {
      for (const tf of toSwitch) {
        if (errors[tf]) continue;
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
    }
  }
  return { ok: true, candles, errors, sources, symbol };
}

async function doGetCandles(tfs, count, market) {
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

/** Restaure le symbole/timeframe d'origine du graphique actif, si `readMarketCandles` les a changés. */
async function restoreChart(chart, originalSymbol, originalTf, market) {
  const originalMarket = marketOf(originalSymbol);
  if (originalMarket && originalMarket.id !== market.id) {
    try { await chart.setSymbol({ symbol: originalSymbol }); } catch { /* ignore */ }
  }
  if (originalTf && /^(\d{1,4}[SDWM]?|[DWM])$/i.test(String(originalTf))) {
    try { await chart.setTimeframe({ timeframe: String(originalTf) }); } catch { /* ignore */ }
  }
}

// ── Marchés en direct sur panneaux dédiés (N ≤ 2, « Graphiques disponibles dans TradingView ») ──
// Chaque panneau i de la disposition est dédié au marché liveMarketIds[i] : son symbole n'est
// jamais touché par la rotation de timeframe (contrairement au graphique actif utilisé pour les
// marchés hors direct) — seule sa RÉSOLUTION est basculée temporairement pour les TF manquantes,
// via l'API du chartWidget de CE panneau (jamais le graphique actif), puis restaurée.
let liveMarketIds = [];
/** Assigne les marchés en direct (index = panneau). Ne modifie pas la disposition TradingView. */
export function setLiveMarkets(ids) { liveMarketIds = (ids || []).filter((id) => MARKET_IDS.includes(id)).slice(0, 2); }
export function getLiveMarkets() { return liveMarketIds.slice(); }
/** Vrai pendant une analyse complète : les lectures « en direct » sont mises en pause (le graphique
 * actif est repris pour la rotation multi-marchés du scan). */
let scanInProgress = false;
export function isScanInProgress() { return scanInProgress; }
const paneLocks = [Promise.resolve(), Promise.resolve()];

function paneExpr(idx) { return `${CWC}.getAll()[${idx}]`; }

async function paneState(connection, idx) {
  return connection.evaluate(`
    /*XZPANESTATE*/
    (function(i) { try { var s = ${CWC}.getAll()[i].model().mainSeries(); return { symbol: String(s.symbol()), interval: String(s.interval()) }; } catch (e) { return null; } })(${idx})
  `);
}
async function paneSetSymbol(connection, idx, symbol) {
  await connection.evaluateAsync(`
    /*XZPANESETSYMBOL*/
    (function(i, sym) { return new Promise(function(res) { try { ${CWC}.getAll()[i].setSymbol(sym, {}); } catch (e) {} setTimeout(res, 400); }); })(${idx}, ${JSON.stringify(String(symbol))})
  `);
}
async function paneSetResolution(connection, idx, tf) {
  await connection.evaluate(`
    /*XZPANESETRES*/
    (function(i, tf) { try { ${CWC}.getAll()[i].setResolution(tf, {}); } catch (e) {} })(${idx}, ${JSON.stringify(String(tf))})
  `);
}
async function pumpPaneHistory(connection, idx, targetBars, maxRounds) {
  let stagnant = 0, lastCount = -1;
  for (let round = 0; round < maxRounds; round++) {
    const state = await connection.evaluate(`
      /*XZPANELIVECHECK*/
      (function(i) { try { var ms = ${CWC}.getAll()[i].model().mainSeries(); var bars = ms.bars(); var count = bars && typeof bars.size === 'function' ? bars.size() : 0; var more = true; try { more = ms.requestMoreDataAvailable(); } catch (e) {} return { count: count, more: !!more }; } catch (e) { return { count: 0, more: false }; } })(${idx})
    `);
    if (!state || state.count >= targetBars || !state.more) break;
    if (state.count === lastCount) { stagnant++; if (stagnant >= 2) break; } else stagnant = 0;
    lastCount = state.count;
    await connection.evaluate(`
      /*XZPANELIVEPUMP*/
      (function(i) { try { ${CWC}.getAll()[i].model().mainSeries().requestMoreData(2000); } catch (e) {} })(${idx})
    `);
    await new Promise((r) => setTimeout(r, 1500));
  }
}
async function readPaneSeries(connection, idx, count) {
  return readSeriesBars(connection, `${paneExpr(idx)}.model().mainSeries()`, count);
}

/** Lecture (passive + bascule de résolution bornée à ce panneau) d'un marché en direct dédié. */
async function readDedicatedPane(idx, market, tfs, count, onTf) {
  const { connection } = await loadCore();
  const mCache = cacheFor(market.id);
  const st0 = await paneState(connection, idx);
  if (!st0) return { ok: false, status: 409, error: `Analyse bloquée : panneau dédié ${idx + 1} illisible dans TradingView Desktop.`, candles: {}, errors: {}, sources: {}, symbol: null };
  if (marketOf(st0.symbol)?.id !== market.id) {
    try { await paneSetSymbol(connection, idx, market.tv); } catch { /* ignore */ }
  }
  const homeTf = normTf(st0.interval) || st0.interval;
  const candles = {}, errors = {}, sources = {};
  const cur = await paneState(connection, idx);
  const curTf = normTf(cur?.interval);
  if (curTf && tfs.includes(curTf)) {
    const rows = await readPaneSeries(connection, idx, count);
    const c = toCandles(rows);
    if (c.length) { candles[curTf] = c; sources[curTf] = 'graphique'; mCache[curTf] = { at: Date.now(), candles: c }; onTf?.(curTf, 'graphique'); }
  }
  const missing = tfs.filter((tf) => !candles[tf]);
  const now = Date.now();
  const toSwitch = missing.filter((tf) => !mCache[tf] || now - mCache[tf].at > SWITCH_TTL[tf] * 1000);
  for (const tf of missing) if (!toSwitch.includes(tf)) { candles[tf] = mCache[tf].candles; sources[tf] = 'cache'; onTf?.(tf, 'cache'); }
  for (const tf of toSwitch) {
    try {
      await paneSetResolution(connection, idx, tf);
      await pumpPaneHistory(connection, idx, count, 10);
      const rows = await readPaneSeries(connection, idx, count);
      const c = toCandles(rows);
      if (!c.length) throw new Error('aucune bougie');
      candles[tf] = c; sources[tf] = 'bascule'; mCache[tf] = { at: Date.now(), candles: c }; onTf?.(tf, 'bascule');
    } catch {
      if (mCache[tf]) { candles[tf] = mCache[tf].candles; sources[tf] = 'cache'; } else errors[tf] = 'timeframe non lisible';
      onTf?.(tf, errors[tf] ? 'erreur' : 'cache');
    }
  }
  if (toSwitch.length) { try { await paneSetResolution(connection, idx, homeTf); } catch { /* ignore */ } }
  return { ok: true, candles, errors, sources, symbol: market.tv };
}

async function doGetCandlesLive(idx, tfs, count, market) {
  const res = await readDedicatedPane(idx, market, tfs, count);
  if (!res.ok) return { status: res.status, body: { success: false, error: res.error } };
  const meta = {};
  for (const [tf, arr] of Object.entries(res.candles)) if (arr && arr.length) meta[tf] = { count: arr.length, first: arr[0].time, last: arr.at(-1).time };
  return { status: 200, body: { success: true, market: market.id, symbol: String(res.symbol).slice(0, 40), candles: res.candles, errors: res.errors, sources: res.sources, meta } };
}

/**
 * Dispose jusqu'à 2 panneaux dédiés (un marché « en direct » par panneau) : réutilise la disposition
 * multi-graphiques comme `setupLayout`, mais assigne UN marché différent à chaque panneau (au lieu
 * d'une seule paire symbole fixe/timeframes multiples). Repli : si un seul panneau est disponible
 * (abonnement TradingView à 1 graphique), un seul marché est assigné et le second reste en rotation
 * sur le graphique actif (comportement `getCandles` historique, inchangé).
 */
export function setupLiveLayout(marketIds) {
  const ids = (marketIds || []).filter((id) => MARKET_IDS.includes(id)).slice(0, 2);
  const job = lock.then(async () => {
    const { connection } = await loadCore();
    let applied = null;
    for (const layout of ['2h', '2']) {
      try {
        await connection.evaluateAsync(`${CWC}.setLayout(${JSON.stringify(layout)})`);
        await new Promise((r) => setTimeout(r, 800));
        const n = Number(await connection.evaluate(`${CWC}.getAll().length`));
        if (n >= Math.min(2, ids.length || 1)) { applied = { layout, count: n }; break; }
      } catch { /* disposition refusée par l'abonnement : on essaie plus petit */ }
    }
    if (!applied) applied = { layout: 's', count: 1 };
    const assigned = [];
    for (let i = 0; i < Math.min(ids.length, applied.count); i++) {
      const m = marketById(ids[i]);
      if (!m) continue;
      try {
        await paneSetSymbol(connection, i, m.tv);
        await paneSetResolution(connection, i, '1');
        assigned.push(m.id);
      } catch { /* panneau illisible : marché non assigné, repli rotation active */ }
    }
    setLiveMarkets(assigned);
    return { success: true, layout: applied.layout, charts: applied.count, live: assigned };
  });
  lock = job.catch(() => {});
  return job;
}

/** Prépare une disposition multi-graphiques XAUUSD (une timeframe par graphique). PC uniquement. */
export function setupLayout() {
  const job = lock.then(async () => {
    const { connection, chart } = await loadCore();
    const state = await chart.getState();
    const symbol = isGold(state.symbol) ? String(state.symbol) : 'OANDA:XAUUSD';
    if (!/^[A-Z0-9_]{1,20}:?[A-Z0-9_.]{1,20}$/i.test(symbol)) throw new Error('symbole inattendu');
    let applied = null;
    for (const layout of ['6', '4', '3h', '2h']) {
      try {
        await connection.evaluateAsync(`${CWC}.setLayout(${JSON.stringify(layout)})`);
        await new Promise((r) => setTimeout(r, 800));
        const n = Number(await connection.evaluate(`${CWC}.getAll().length`));
        if (n >= Number(layout[0])) { applied = { layout, count: n }; break; }
      } catch { /* disposition refusée par l'abonnement : on essaie plus petit */ }
    }
    if (!applied) applied = { layout: 's', count: 1 };
    const order = TFS.slice(0, Math.min(6, applied.count));
    for (let i = 0; i < order.length; i++) {
      await connection.evaluate(`(function(){ var c = ${CWC}.getAll()[${i}]; if (c && c._mainDiv) c._mainDiv.click(); })()`);
      await new Promise((r) => setTimeout(r, 300));
      await connection.evaluateAsync(`(function(){ var a = window.TradingViewApi._activeChartWidgetWV.value(); return new Promise(function(res){ a.setSymbol(${JSON.stringify(symbol)}, {}); setTimeout(res, 400); }); })()`);
      await connection.evaluate(`window.TradingViewApi._activeChartWidgetWV.value().setResolution(${JSON.stringify(order[i])}, {})`);
      await new Promise((r) => setTimeout(r, 700));
    }
    return { success: true, symbol, layout: applied.layout, charts: applied.count, timeframes: order };
  });
  lock = job.catch(() => {});
  return job;
}

/**
 * Charge le maximum d'historique disponible pour chaque graphique XAUUSD de la disposition,
 * sans jamais changer la timeframe ou le symbole visible du graphique concerné (lecture passive,
 * `requestMoreData` uniquement — cf. src/core/chart.js setVisibleRange pour le même mécanisme).
 * Verrouillé avec `lock` : ne chevauche jamais un getCandles / setupLayout en cours.
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
  const { connection } = await loadCore();
  const panesInfo = await connection.evaluate(`
    /*XZPANESINFO*/
    (function() {
      var out = [];
      var cwc = ${CWC};
      var all = cwc && cwc.getAll ? cwc.getAll() : [];
      for (var i = 0; i < all.length; i++) {
        try {
          var s = all[i].model().mainSeries();
          out.push({ index: i, symbol: String(s.symbol()), interval: String(s.interval()) });
        } catch (e) { /* graphique illisible : ignoré */ }
      }
      return out;
    })()
  `);
  const golds = (Array.isArray(panesInfo) ? panesInfo : []).filter((p) => isGold(p.symbol));
  const results = [];
  for (const p of golds) {
    const idx = Math.max(0, Math.floor(Number(p.index)) || 0);
    let stagnant = 0, lastCount = -1, state = null;
    for (let round = 0; round < maxRounds; round++) {
      state = await connection.evaluate(`
        /*XZPANECHECK*/
        (function(i) {
          try {
            var cwc = ${CWC};
            var all = cwc && cwc.getAll ? cwc.getAll() : [];
            var s = all[i].model().mainSeries();
            var bars = s.bars();
            var count = bars && typeof bars.size === 'function' ? bars.size() : 0;
            var firstTime = null;
            if (bars && typeof bars.firstIndex === 'function' && count > 0) {
              var v = bars.valueAt(bars.firstIndex());
              firstTime = v ? v[0] : null;
            }
            var more = true; try { more = s.requestMoreDataAvailable(); } catch (e) {}
            return { count: count, firstTime: firstTime, more: !!more };
          } catch (e) { return { count: 0, firstTime: null, more: false, error: 'lecture impossible' }; }
        })(${idx})
      `);
      if (!state || state.error) break;
      if (state.count >= target || !state.more) break;
      if (state.count === lastCount) { stagnant++; if (stagnant >= 2) break; } else stagnant = 0;
      lastCount = state.count;
      await connection.evaluate(`
        /*XZPANEPUMP*/
        (function(i) {
          try {
            var cwc = ${CWC};
            var all = cwc && cwc.getAll ? cwc.getAll() : [];
            all[i].model().mainSeries().requestMoreData(2000);
          } catch (e) { /* graphique illisible : ignoré */ }
        })(${idx})
      `);
      await new Promise((r) => setTimeout(r, 1500));
    }
    const interval = normTf(p.interval) || p.interval;
    results.push({ interval, bars: state?.count || 0, firstTime: state?.firstTime ?? null, more: state?.more ?? false });
  }
  if (results.length) {
    console.log('Historique TradingView : ' + results.map((r) => `${TF_LABEL[r.interval] || r.interval} ${r.bars} bougies`).join(', '));
  } else {
    console.log('Historique TradingView : aucun graphique XAUUSD trouvé dans la disposition.');
  }
  return results;
}

// ── Analyse complète (« fullScan ») : tous les marchés × 6 timeframes, séquentiellement ──────
let scanAbort = false;
/** Abandonne le scan complet en cours (le prochain point de contrôle interrompt la boucle). */
export function abortScan() { scanAbort = true; }

/**
 * Bougies de tous les marchés demandés (par défaut : tout le registre), sur les 6 timeframes,
 * via le même chemin que `getCandles` (lecture passive puis bascule bornée). Le symbole et la
 * timeframe d'origine du graphique actif sont restaurés une seule fois, à la fin du scan complet
 * (pas entre deux marchés) — plus rapide qu'un enchaînement de `getCandles` indépendants.
 * `onProgress({ marketId, marketLabel, tf, done, total, status })` est appelé à chaque étape.
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
  scanInProgress = true; // met en pause les lectures « en direct » sur panneaux dédiés
  const { connection, chart } = await loadCore();
  // reprend le panneau 0 (celui de l'ancien graphique actif si aucun panneau dédié) pour le scan
  try {
    await connection.evaluate(`(function() { var c = ${CWC}.getAll()[0]; if (c && c._mainDiv) c._mainDiv.click(); })()`);
    await new Promise((r) => setTimeout(r, 300));
  } catch { /* ignore */ }
  const before = await chart.getState();
  const originalSymbol = String(before.symbol || '');
  const originalTf = normTf(before.resolution) || before.resolution;
  const total = markets.length * tfs.length;
  let done = 0;
  const results = {};
  try {
    for (const market of markets) {
      if (scanAbort) break;
      const errors = {};
      const res = await readMarketCandles(market, tfs, count, (tf, status) => {
        done++;
        onProgress?.({ marketId: market.id, marketLabel: market.label, tf, done, total, status });
      });
      results[market.id] = res.ok ? { candles: res.candles, errors: res.errors, symbol: res.symbol } : { candles: {}, errors: { _market: res.error }, symbol: null };
      if (!res.ok) done += tfs.length - Object.keys(res.errors || {}).length; // étapes non exécutées comptées comme faites (progression continue)
      void errors;
    }
  } finally {
    // ne restaure qu'à la fin du scan complet (pas entre deux marchés : gain de temps)
    const lastMarket = markets.at(-1) || marketById(DEFAULT_MARKET);
    await restoreChart(chart, originalSymbol, originalTf, lastMarket);
    scanInProgress = false;
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
