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
const TFS = ['1', '5', '15', '60', '240', 'D'];
const SWITCH_TTL = { '1': 20, '5': 45, '15': 90, '60': 180, '240': 600, 'D': 1800 };
const CWC = 'window.TradingViewApi._chartWidgetCollection';
/** Plafond de sécurité (A05) : nombre maximal de bougies lues/retournées par timeframe. */
export const MAX_BARS = 20000;

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

const cache = {};
let lock = Promise.resolve();

/** count : entier (50 à MAX_BARS) ou littéral 'all' → toutes les bougies chargées dans TradingView (plafonné). */
function resolveCount(count) {
  if (count === 'all') return MAX_BARS;
  const n = Math.floor(Number(count));
  return Number.isFinite(n) ? Math.max(50, Math.min(MAX_BARS, n)) : 500;
}

/** @returns {Promise<{status:number, body:object}>} */
export function getCandles({ tfs = TFS, count = 500 } = {}) {
  const wanted = [...new Set(tfs)].filter((t) => TFS.includes(t));
  const job = lock.then(() => doGetCandles(wanted, resolveCount(count)));
  lock = job.catch(() => {});
  return job;
}

async function doGetCandles(tfs, count) {
  const { chart, data } = await loadCore();
  const panes = await readPanes(count);
  const gold = panes.filter((p) => !p.error && isGold(p.symbol));
  const state = await chart.getState();
  const activeSymbol = String(state.symbol || '');
  if (!gold.length && !isGold(activeSymbol)) {
    return { status: 409, body: { success: false, error: 'Analyse bloquée : aucun graphique XAUUSD ouvert dans TradingView Desktop.' } };
  }
  const symbol = (gold[0] && gold[0].symbol) || activeSymbol;
  const candles = {}, errors = {}, sources = {};
  for (const p of gold) {
    const tf = normTf(p.interval);
    if (tf && tfs.includes(tf) && !candles[tf]) {
      const c = toCandles(p.bars);
      if (c.length) { candles[tf] = c; sources[tf] = 'graphique'; cache[tf] = { at: Date.now(), candles: c }; }
    }
  }
  const missing = tfs.filter((tf) => !candles[tf]);
  const now = Date.now();
  const toSwitch = missing.filter((tf) => !cache[tf] || now - cache[tf].at > SWITCH_TTL[tf] * 1000);
  for (const tf of missing) if (!toSwitch.includes(tf)) { candles[tf] = cache[tf].candles; sources[tf] = 'cache'; }

  if (toSwitch.length) {
    if (!isGold(activeSymbol)) {
      for (const tf of toSwitch) { if (cache[tf]) { candles[tf] = cache[tf].candles; sources[tf] = 'cache'; } else errors[tf] = 'graphique actif ≠ XAUUSD'; }
    } else {
      const original = normTf(state.resolution) || state.resolution;
      try {
        for (const tf of toSwitch) {
          try {
            await chart.setTimeframe({ timeframe: tf });
            const r = await data.getOhlcv({ count });
            const c = toCandles((r.bars || []).map((b) => [b.time, b.open, b.high, b.low, b.close, b.volume]));
            if (!c.length) throw new Error('aucune bougie');
            candles[tf] = c; sources[tf] = 'bascule'; cache[tf] = { at: Date.now(), candles: c };
          } catch {
            if (cache[tf]) { candles[tf] = cache[tf].candles; sources[tf] = 'cache'; } else errors[tf] = 'timeframe non lisible';
          }
        }
      } finally {
        if (original && /^(\d{1,4}[SDWM]?|[DWM])$/i.test(String(original))) {
          try { await chart.setTimeframe({ timeframe: String(original) }); } catch { /* ignore */ }
        }
      }
    }
  }
  return {
    status: 200,
    body: {
      success: true, symbol: String(symbol).slice(0, 40), candles, errors, sources,
      panes: panes.map((p) => ({ index: p.index, symbol: String(p.symbol || '').slice(0, 40), tf: normTf(p.interval), bars: p.bars?.length || 0 })),
    },
  };
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
