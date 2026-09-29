/**
 * Moteur de détection des zones XAUUSD — sans IA.
 *
 * Traduction déterministe des règles de TRADING_RULES_MASTER_PROMPT.md :
 *   P  = bougie de prise de liquidité (juste avant C1)
 *   C1 = order block, C2 = intermédiaire, C3 = confirmation de l'imbalance
 *
 * Achat : C1 baissière, C3 haussière, P.low < niveau < P.close, C1.high < C3.low
 * Vente : C1 haussière, C3 baissière, P.high > niveau > P.close, C1.low > C3.high
 * Zone  : [C1.low ; C1.high], mèches incluses
 * Retest: une bougie postérieure à C3 avec high >= zone_low ET low <= zone_high
 *
 * Module ES pur : fonctionne dans le navigateur, l'APK Android et Node.js.
 */

export const TIMEFRAMES = ['1', '5', '15', '60', '240', 'D', 'W', 'M', '12M'];

export const TF_LABEL = { '1': '1m', '5': '5m', '15': '15m', '60': '1h', '240': '4h', 'D': '1D', 'W': '1W', 'M': '1Mo', '12M': '1A' };

export const TF_SECONDS = { '1': 60, '5': 300, '15': 900, '60': 3600, '240': 14400, 'D': 86400, 'W': 604800, 'M': 2629800, '12M': 31557600 };

/** Catégories de trading : timeframes d'exécution associées. */
export const CATEGORIES = {
  scalping: { label: 'Scalp', long: 'Scalping', tfs: ['1', '5'] },
  day: { label: 'Daily', long: 'Day trading', tfs: ['15', '60'] },
  swing: { label: 'Swing', long: 'Swing trading', tfs: ['240', 'D', 'W', 'M', '12M'] },
};
export const categoryOf = (tf) => Object.keys(CATEGORIES).find((k) => CATEGORIES[k].tfs.includes(tf)) || 'day';

export const DEFAULT_OPTIONS = {
  // Fenêtre (en bougies avant P) dont l'extrême définit le niveau de liquidité balayé.
  liquidityLookback: 5,
  // Un gap < ratio × ATR est marqué « fragile » (règle de prévention du journal).
  fragileGapAtrRatio: 0.1,
  atrPeriod: 14,
  // Stratégie Order Blocks « 5 étoiles » (trading_agent_order_blocks.md) — paramètres réglables
  supertrendPeriod: 10,     // ⭐2 tendance : Supertrend standard TradingView (ATR 10, × 3)
  supertrendMult: 3,
  rangeLookback: 50,        // ⭐2 range : nombre de changements de couleur du Supertrend…
  rangeFlips: 4,            // …à partir duquel le marché est jugé en range (non-trading)
  fibLookback: 100,         // ⭐5 Fibonacci : amplitude du mouvement (bougies avant C3)
  equalTolAtr: 0.1,         // ⭐3 égalité de sommets/creux : écart ≤ 0,1 × ATR
  liqNearAtr: 1,            // ⭐3 liquidité « proche » : à moins de 1 × ATR au-delà de l'OB
  swingLookback: 150,       // cartographie des swings (bougies avant C3)
};

/**
 * Statuts :
 *   VIABLE     : jamais retestée, prix du bon côté de la zone
 *   TOUCHEE    : une bougie postérieure à C3 est entrée dans la zone  → non viable
 *   INVALIDEE  : une bougie a clôturé au-delà du bord opposé           → non viable
 *   DEPASSEE   : prix passé de l'autre côté sans toucher (gap de marché) → non viable
 */
export const STATUS = {
  VIABLE: 'VIABLE',
  TOUCHEE: 'TOUCHEE',
  INVALIDEE: 'INVALIDEE',
  DEPASSEE: 'DEPASSEE',
};

export const STATUS_LABEL = {
  VIABLE: 'Viable',
  TOUCHEE: 'Non viable · retestée',
  INVALIDEE: 'Non viable · cassée',
  DEPASSEE: 'Non viable · dépassée',
};

const round = (v, d = 5) => Math.round(v * 10 ** d) / 10 ** d;
const isBull = (c) => c.close > c.open;
const isBear = (c) => c.close < c.open;

/** Nettoie, déduplique par timestamp et trie du plus ancien au plus récent. */
export function normalizeCandles(raw) {
  const byTime = new Map();
  for (const c of raw || []) {
    const t = Number(c.time);
    const o = Number(c.open), h = Number(c.high), l = Number(c.low), cl = Number(c.close);
    if (![t, o, h, l, cl].every(Number.isFinite)) continue;
    byTime.set(t, { time: t, open: o, high: h, low: l, close: cl, volume: Number(c.volume) || 0, complete: c.complete !== false });
  }
  return [...byTime.values()].sort((a, b) => a.time - b.time);
}

export function atr(candles, period = 14) {
  if (candles.length < 2) return null;
  const trs = [];
  for (let i = 1; i < candles.length; i++) {
    const c = candles[i], p = candles[i - 1];
    trs.push(Math.max(c.high - c.low, Math.abs(c.high - p.close), Math.abs(c.low - p.close)));
  }
  const slice = trs.slice(-period);
  return slice.reduce((a, b) => a + b, 0) / slice.length;
}

/** ATR de Wilder, valeur connue à chaque bougie (sans regarder le futur). */
export function atrSeries(candles, period = 14) {
  const out = new Array(candles.length).fill(null);
  let a = null;
  for (let i = 1; i < candles.length; i++) {
    const c = candles[i], p = candles[i - 1];
    const tr = Math.max(c.high - c.low, Math.abs(c.high - p.close), Math.abs(c.low - p.close));
    a = a == null ? tr : (a * (period - 1) + tr) / period;
    out[i] = i >= Math.min(period, candles.length - 1) ? a : null;
  }
  return out;
}

export function emaSeries(candles, period = 50) {
  const out = new Array(candles.length).fill(null);
  const k = 2 / (period + 1);
  let e = null;
  for (let i = 0; i < candles.length; i++) {
    e = e == null ? candles[i].close : candles[i].close * k + e * (1 - k);
    out[i] = i >= period - 1 ? e : null;
  }
  return out;
}

/**
 * Supertrend (formule TradingView) : +1 haussier (nuage vert), −1 baissier (nuage rouge).
 * Valeur connue à chaque bougie, sans regarder le futur.
 */
export function supertrendSeries(candles, period = 10, mult = 3) {
  const n = candles.length;
  const dir = new Array(n).fill(null);
  const a = atrSeries(candles, period);
  let up = null, dn = null, trend = 1;
  for (let i = 0; i < n; i++) {
    const c = candles[i];
    if (a[i] == null) continue;
    const hl2 = (c.high + c.low) / 2;
    let u = hl2 - mult * a[i], d = hl2 + mult * a[i];
    const prevClose = candles[i - 1]?.close;
    if (up != null && prevClose > up) u = Math.max(u, up);
    if (dn != null && prevClose < dn) d = Math.min(d, dn);
    if (up != null) {
      if (trend === -1 && c.close > dn) trend = 1;
      else if (trend === 1 && c.close < up) trend = -1;
    }
    up = u; dn = d; dir[i] = trend;
  }
  return dir;
}

/** Swings (fractales 2 bougies de chaque côté) entre `from` et `to` inclus. */
function swings(candles, from, to, kind) {
  const out = [];
  for (let i = Math.max(2, from); i <= to - 2; i++) {
    const c = candles[i], l1 = candles[i - 1], l2 = candles[i - 2], r1 = candles[i + 1], r2 = candles[i + 2];
    if (kind === 'high' && c.high > l1.high && c.high > l2.high && c.high >= r1.high && c.high >= r2.high) out.push({ i, level: c.high, time: c.time });
    if (kind === 'low' && c.low < l1.low && c.low < l2.low && c.low <= r1.low && c.low <= r2.low) out.push({ i, level: c.low, time: c.time });
  }
  return out;
}

/** Un niveau est « non pris » si aucune bougie après sa formation (jusqu'à `to`) ne l'a dépassé. */
function untaken(candles, sw, to, kind) {
  for (let j = sw.i + 1; j <= to; j++) if (kind === 'low' ? candles[j].low < sw.level : candles[j].high > sw.level) return false;
  return true;
}

/**
 * Évaluation « 5 étoiles » d'un order block, connue à la clôture de C3 (aucune information future),
 * sauf ⭐4 (vierge) qui dépend de l'historique jusqu'à maintenant.
 */
function evaluateStars(candles, p, dir, zoneLow, zoneHigh, atrValue, stDir, o, viable) {
  const c3 = p + 3;
  const buy = dir === 'BUY';
  // ⭐2 tendance + range
  const want = buy ? 1 : -1;
  let flips = 0;
  for (let i = Math.max(1, c3 - o.rangeLookback + 1); i <= c3; i++) if (stDir[i] != null && stDir[i - 1] != null && stDir[i] !== stDir[i - 1]) flips++;
  const trendDir = stDir[c3];
  const aligned = trendDir === want;
  const ranging = flips >= o.rangeFlips;
  // ⭐3 liquidité : poche non prise juste au-delà de l'OB (côté stop) = risque de balayage avant réaction
  const side = buy ? 'low' : 'high';
  const sw = swings(candles, c3 - o.swingLookback, c3, side).filter((x) => x.i < p && untaken(candles, x, c3, side));
  const tol = (atrValue || 0) * o.equalTolAtr;
  const near = (atrValue || 0) * o.liqNearAtr;
  const beyond = sw.filter((x) => (buy ? x.level < zoneLow && x.level >= zoneLow - near : x.level > zoneHigh && x.level <= zoneHigh + near));
  const equal = [];
  for (let a = 0; a < sw.length; a++) for (let b = a + 1; b < sw.length; b++) if (Math.abs(sw[a].level - sw[b].level) <= tol) equal.push(round((sw[a].level + sw[b].level) / 2));
  const equalBeyond = equal.filter((l) => (buy ? l < zoneLow && l >= zoneLow - near : l > zoneHigh && l <= zoneHigh + near));
  // liquidité entre le prix (à C3) et l'OB : elle sera probablement prise avant la réaction
  const before = sw.filter((x) => (buy ? x.level > zoneHigh && x.level < candles[c3].close : x.level < zoneLow && x.level > candles[c3].close)).map((x) => round(x.level));
  const liqRisk = beyond.length > 0 || equalBeyond.length > 0;
  // ⭐5 Fibonacci premium / discount sur le mouvement (bas → haut pour un achat, haut → bas pour une vente)
  let hi = -Infinity, lo = Infinity;
  for (let i = Math.max(0, c3 - o.fibLookback); i <= c3; i++) { hi = Math.max(hi, candles[i].high); lo = Math.min(lo, candles[i].low); }
  const eq = (hi + lo) / 2;
  const mid = (zoneLow + zoneHigh) / 2;
  const fibOk = buy ? mid < eq : mid > eq;
  const stars = {
    imbalance: true,                       // garanti par la détection (C1/C3 sans contact)
    trend: aligned && !ranging,
    liquidity: !liqRisk,
    virgin: viable,
    fib: fibOk,
  };
  const score = Object.values(stars).filter(Boolean).length;
  return {
    stars, score,
    trend: { supertrend: trendDir === 1 ? 'haussier' : trendDir === -1 ? 'baissier' : 'indéterminé', flips, ranging, aligned },
    liquidity: {
      risk: liqRisk,
      beyond: beyond.map((x) => round(x.level)), equal: [...new Set(equal)].slice(0, 6), equalBeyond,
      before: before.slice(0, 6), sweepBonus: true, // la prise de liquidité sur P est obligatoire ici : bonus toujours présent
    },
    fib: { high: round(hi), low: round(lo), eq: round(eq), zone: mid < eq ? 'DISCOUNT' : mid > eq ? 'PREMIUM' : 'EQUILIBRIUM', ok: fibOk },
  };
}

function pick(c) {
  return { time: c.time, open: c.open, high: c.high, low: c.low, close: c.close };
}

/**
 * Niveaux de liquidité opposée pour les objectifs, SANS information future :
 * sommets (achat) ou creux (vente) de swing — fractales à 2 bougies de chaque côté —
 * formés entre `endIdx - lookback` et `endIdx` (clôture de C3), au-delà de l'entrée.
 * Triés du plus proche au plus éloigné ; niveaux quasi identiques fusionnés.
 */
export function opposingLiquidity(candles, endIdx, dir, entry, lookback = 150) {
  const out = [];
  const from = Math.max(2, endIdx - lookback);
  for (let i = from; i <= endIdx - 2; i++) {
    const c = candles[i];
    const isSwing = dir === 'BUY'
      ? c.high > candles[i - 1].high && c.high > candles[i - 2].high && c.high >= candles[i + 1].high && c.high >= candles[i + 2].high
      : c.low < candles[i - 1].low && c.low < candles[i - 2].low && c.low <= candles[i + 1].low && c.low <= candles[i + 2].low;
    if (!isSwing) continue;
    const lvl = dir === 'BUY' ? c.high : c.low;
    if (dir === 'BUY' ? lvl > entry : lvl < entry) out.push(round(lvl));
  }
  out.sort((a, b) => Math.abs(a - entry) - Math.abs(b - entry));
  const merged = [];
  for (const l of out) if (!merged.some((m) => Math.abs(m - l) < 0.3)) merged.push(l);
  return merged.slice(0, 8);
}

/**
 * Détecte toutes les zones d'une timeframe.
 * @param {Array} rawCandles  bougies {time (s), open, high, low, close, volume, complete}
 * @param {object} opts       { timeframe, currentPrice, liquidityLookback, fragileGapAtrRatio, atrPeriod }
 * @returns {{ zones: Array, stats: object }}
 */
export function detectZones(rawCandles, opts = {}) {
  const o = { ...DEFAULT_OPTIONS, ...opts };
  const candles = normalizeCandles(rawCandles);
  const n = candles.length;
  const lb = Math.max(1, Math.floor(o.liquidityLookback));
  const closed = candles.filter((c) => c.complete);
  const currentPrice = Number.isFinite(o.currentPrice) ? o.currentPrice : (n ? candles[n - 1].close : null);
  const atrArr = atrSeries(candles, o.atrPeriod);
  const emaArr = emaSeries(candles, 50);
  const stArr = supertrendSeries(candles, o.supertrendPeriod, o.supertrendMult);
  const fallbackAtr = atr(closed.length ? closed : candles, o.atrPeriod);

  const stats = {
    candles: n,
    from: n ? candles[0].time : null,
    to: n ? candles[n - 1].time : null,
    candidates: 0,
    rejected: { liquidite: 0, imbalance: 0, egalite: 0 },
  };
  const zones = [];

  for (let p = lb; p + 3 < n; p++) {
    const P = candles[p], C1 = candles[p + 1], C2 = candles[p + 2], C3 = candles[p + 3];
    // La séquence doit être composée de bougies clôturées.
    if (!P.complete || !C1.complete || !C2.complete || !C3.complete) continue;

    for (const dir of ['BUY', 'SELL']) {
      // 1. Order block directionnel + déplacement confirmé par C3
      if (dir === 'BUY' && !(isBear(C1) && isBull(C3))) continue;
      if (dir === 'SELL' && !(isBull(C1) && isBear(C3))) continue;
      // C1 doit être la DERNIÈRE bougie inverse avant l'impulsion : C2 ne doit pas être inverse
      if (dir === 'BUY' ? isBear(C2) : isBull(C2)) continue;
      stats.candidates++;

      // 2. Liquidité prise sur P, niveau explicite = extrême des `lb` bougies avant P
      const win = candles.slice(p - lb, p);
      let refIdx = 0;
      for (let k = 1; k < win.length; k++) {
        if (dir === 'BUY' ? win[k].low < win[refIdx].low : win[k].high > win[refIdx].high) refIdx = k;
      }
      const ref = win[refIdx];
      const level = dir === 'BUY' ? ref.low : ref.high;
      const swept = dir === 'BUY'
        ? P.low < level && P.close > level
        : P.high > level && P.close < level;
      if (!swept) { stats.rejected.liquidite++; continue; }

      // 3. Imbalance stricte avec mèches
      const gap = dir === 'BUY' ? C3.low - C1.high : C1.low - C3.high;
      if (gap === 0) { stats.rejected.egalite++; continue; }
      if (gap < 0) { stats.rejected.imbalance++; continue; }

      const zoneLow = C1.low, zoneHigh = C1.high;

      // 4. Retest après C3 (la bougie en cours compte : un contact en direct invalide)
      let touch = null, broken = null;
      for (let j = p + 4; j < n; j++) {
        const L = candles[j];
        if (!touch && L.high >= zoneLow && L.low <= zoneHigh) touch = L;
        if (touch && !broken) {
          const closedBeyond = dir === 'BUY' ? L.close < zoneLow : L.close > zoneHigh;
          if (closedBeyond && L.complete) broken = L;
        }
        if (touch && broken) break;
      }

      // 5. Position du prix et statut
      let status;
      if (broken) status = STATUS.INVALIDEE;
      else if (touch) status = STATUS.TOUCHEE;
      else if (currentPrice != null && (dir === 'BUY' ? currentPrice < zoneLow : currentPrice > zoneHigh)) status = STATUS.DEPASSEE;
      else status = STATUS.VIABLE;

      const entry = dir === 'BUY' ? zoneHigh : zoneLow;       // bord proche du prix
      const invalidation = dir === 'BUY' ? zoneLow : zoneHigh; // bord opposé
      const barsAfter = n - (p + 4);
      const atrValue = atrArr[p + 3] ?? fallbackAtr;

      // 6. Liquidité opposée (objectifs) : sommets/creux de swing connus à la clôture de C3
      const liqTargets = opposingLiquidity(candles, p + 3, dir, entry, o.targetLookback ?? 150);
      const grade = evaluateStars(candles, p, dir, zoneLow, zoneHigh, atrValue, stArr, o, status === STATUS.VIABLE);

      zones.push({
        id: `${o.marketId || 'tf'}:${o.timeframe || 'tf'}-${C1.time}-${dir}`,
        liqTargets,
        stars: grade.stars, grade: grade.score,
        // note connue à la clôture de C3 (⭐4 « vierge » y est toujours vraie) : seule note utilisable
        // pour un backtest — `grade` exige « jamais touchée jusqu'à maintenant », ce qui exclut par
        // construction toute zone déjà exécutée.
        gradeAtDetection: grade.score + (grade.stars.virgin ? 0 : 1),
        session: sessionOfTime(C3.time),
        trend: grade.trend, liq: grade.liquidity, fib: grade.fib,
        direction: dir,
        timeframe: o.timeframe || null,
        status,
        viable: status === STATUS.VIABLE,
        zoneLow: round(zoneLow),
        zoneHigh: round(zoneHigh),
        entry: round(entry),
        invalidation: round(invalidation),
        gap: round(gap),
        fragile: atrValue != null && gap < o.fragileGapAtrRatio * atrValue,
        atr: atrValue != null ? round(atrValue) : null,
        liquidity: { level: round(level), refTime: ref.time, lookback: lb },
        candles: { P: pick(P), C1: pick(C1), C2: pick(C2), C3: pick(C3) },
        c1Time: C1.time,
        c3Index: p + 3,
        category: categoryOf(o.timeframe),
        ema50: emaArr[p + 3] != null ? round(emaArr[p + 3]) : null,
        c3Time: C3.time,
        barsChecked: barsAfter,
        firstTouch: touch ? pick(touch) : null,
        brokenBy: broken ? pick(broken) : null,
        distance: currentPrice != null ? round(dir === 'BUY' ? currentPrice - zoneHigh : zoneLow - currentPrice) : null,
      });
    }
  }

  return { zones, stats, candles };
}

/** Séance (UTC) d'un instant : Asie < 7 h, Londres < 12 h, New York < 17 h, sinon clôture US. */
export function sessionOfTime(t) {
  const h = new Date(t * 1000).getUTCHours();
  if (h < 7) return 'Asie';
  if (h < 12) return 'Londres';
  if (h < 17) return 'New York';
  return 'Clôture US';
}

/**
 * Instant (s) de clôture de la bougie `i` de l'UT `tf`. Mois et année ont une durée variable
 * (28 à 31 jours, 365 ou 366) : leur clôture est l'ouverture de la bougie suivante, et non
 * « ouverture + durée moyenne » (qui la déclarait close jusqu'à 13 h trop tôt pour un mois de 31 jours,
 * soit une information future dans un backtest). Pour la dernière bougie, durée nominale.
 */
export function closeTimeOf(c, i, tf) {
  if ((tf === 'M' || tf === '12M') && i + 1 < c.length) return c[i + 1].time;
  return c[i].time + (TF_SECONDS[tf] || 0);
}

/** Index de la dernière bougie de `c` (UT `tf`) entièrement clôturée à l'instant `t` (−1 si aucune). */
export function lastClosedIndex(c, tf, t) {
  let lo = 0, hi = c.length - 1, idx = -1;
  while (lo <= hi) { const m = (lo + hi) >> 1; if (closeTimeOf(c, m, tf) <= t) { idx = m; lo = m + 1; } else hi = m - 1; }
  return idx;
}

/** UT supérieure utilisée pour la tendance de fond. */
export const HTF_OF = { '1': '15', '5': '60', '15': '240', '60': '240', '240': 'D', 'D': 'W', 'W': 'M', 'M': '12M', '12M': null };

/**
 * Tendance de fond (UT supérieure) de chaque zone, SANS information future : direction du
 * Supertrend de la dernière bougie de l'UT supérieure CLÔTURÉE au moment de la clôture de C3.
 * Si l'UT supérieure directe n'est pas chargée, la suivante disponible est utilisée.
 * Ajoute `zone.htf = { tf, dir: 1|-1|null, aligned: bool|null }`.
 */
export function annotateHtf(zones, candlesByTf, opts = {}) {
  const o = { ...DEFAULT_OPTIONS, ...opts };
  const cache = {};
  const series = (tf) => {
    if (cache[tf] !== undefined) return cache[tf];
    const c = candlesByTf?.[tf]?.length ? normalizeCandles(candlesByTf[tf]) : null;
    cache[tf] = c ? { c, st: supertrendSeries(c, o.supertrendPeriod, o.supertrendMult) } : null;
    return cache[tf];
  };
  for (const z of zones) {
    let tf = HTF_OF[z.timeframe];
    while (tf && !series(tf)) tf = HTF_OF[tf];
    if (!tf) { z.htf = { tf: null, dir: null, aligned: null }; continue; }
    const { c, st } = series(tf);
    const t = z.c3Time + (TF_SECONDS[z.timeframe] || 0); // clôture de C3
    // dernière bougie HTF entièrement clôturée à l'instant t
    const idx = lastClosedIndex(c, tf, t);
    const dir = idx >= 0 ? st[idx] : null;
    z.htf = { tf, dir, aligned: dir == null ? null : dir === (z.direction === 'BUY' ? 1 : -1) };
  }
  return zones;
}

/**
 * Analyse plusieurs timeframes.
 * @param {Record<string, Array>} candlesByTf
 */
export function analyze(candlesByTf, opts = {}) {
  // Prix courant : dernière clôture de la plus petite timeframe disponible.
  let currentPrice = opts.currentPrice;
  let priceTime = null;
  if (!Number.isFinite(currentPrice)) {
    for (const tf of TIMEFRAMES) {
      const arr = candlesByTf[tf];
      if (arr && arr.length) {
        const last = normalizeCandles(arr).at(-1);
        currentPrice = last.close; priceTime = last.time; break;
      }
    }
  }
  const byTf = {};
  let zones = [];
  for (const tf of TIMEFRAMES) {
    if (!candlesByTf[tf]) continue;
    const r = detectZones(candlesByTf[tf], { ...opts, timeframe: tf, currentPrice });
    byTf[tf] = r.stats;
    zones = zones.concat(r.zones);
  }
  annotateHtf(zones, candlesByTf, opts);
  const order = { VIABLE: 0, TOUCHEE: 1, INVALIDEE: 2, DEPASSEE: 3 };
  zones.sort((a, b) => order[a.status] - order[b.status] || Math.abs(a.distance) - Math.abs(b.distance));
  return { currentPrice, priceTime, zones, stats: byTf, analyzedAt: Date.now() };
}
