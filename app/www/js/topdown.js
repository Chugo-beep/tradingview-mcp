/**
 * Fiabilité top-down d'un order block 5★ (trading_agent_order_blocks.md §16 « multi-timeframe »).
 *
 * Pour chaque OB, on lit la structure des UT supérieures puis de l'UT de l'OB :
 *  - UT supérieures : tendance de structure (dernier BOS), CHoCH contraire récent, position
 *    Premium / Discount dans le range de la dernière jambe, confluence avec un POI HTF (FVG ou OB
 *    non invalidé) ;
 *  - UT de l'OB : cassure de structure (BOS / CHoCH) dans le sens de l'OB après sa formation,
 *    absence de cassure contraire, force de l'imbalance (FVG) et du déplacement.
 *
 * SANS information future : tout est évalué à l'instant de décision = ouverture de la bougie qui
 * revient dans la zone (premier contact), ou maintenant si la zone est encore vierge. Un backtest
 * peut donc utiliser ce score sans biais d'anticipation.
 *
 * Le score (0–100) et le niveau (A/B/C/D) sont des PRIORITÉS DE LECTURE, pas des probabilités :
 * leur lien réel avec le résultat des trades est mesuré par le backtest (calibration par niveau,
 * affichée dans l'application).
 * Module ES pur (navigateur, APK, Node).
 */
import { normalizeCandles, atrSeries, TF_SECONDS, lastClosedIndex } from './engine.js';
import { structureEvents } from './smc.js';

/** UT supérieures lues pour chaque UT d'OB, de la plus proche à la plus haute. */
export const TOPDOWN_CHAIN = {
  '1': ['5', '15', '60'], '5': ['15', '60', '240'], '15': ['60', '240', 'D'], '60': ['240', 'D', 'W'],
  '240': ['D', 'W', 'M'], 'D': ['W', 'M'], 'W': ['M'], 'M': [], '12M': [],
};
/** Poids des UT de la chaîne : la plus haute domine (lecture top-down). */
const CHAIN_WEIGHTS = [1, 1.5, 2];

export const TOPDOWN_DEFAULTS = {
  swingK: 2,            // fractales : 2 bougies de chaque côté (identique à smc.js)
  impulseAtr: 1.0,      // FVG HTF : corps de la bougie centrale ≥ 1 ATR
  poiLookback: 200,     // POI HTF formés dans les 200 dernières bougies de leur UT
  legCap: 400,          // borne de calcul du range de la dernière jambe (bougies)
  strongGapAtr: 0.3,    // imbalance « franche » : écart C1/C3 ≥ 0,3 ATR…
  displacementAtr: 1.0, // …ou corps de C2 ≥ 1 ATR
};

/**
 * Points du score (total 100). Pondération MESURÉE (scripts/calibrate.mjs --all-ob, 2 509 OB sur
 * XAUUSD, NAS100, US30, EURUSD 2019 → 2026) : seuls les facteurs qui améliorent l'espérance d'au
 * moins +0,05 R sur la période d'apprentissage (70 % anciens) comptent, pondérés par cet effet ;
 * tous restent positifs sur la période de validation (30 % récents).
 *  - cassure de structure dans le sens de l'OB : +0,20 R · tendance HTF : +0,11 R · déplacement : +0,10 R
 * Premium/Discount HTF, POI HTF et absence de cassure contraire n'ont pas d'effet mesurable :
 * ils sont affichés à titre d'information mais ne comptent pas (0 point).
 */
export const TOPDOWN_POINTS = { localBos: 40, htfTrend: 35, displacement: 25, htfPd: 0, htfPoi: 0, noCounter: 0 };

export const LEVEL_LABEL = { A: 'Fiabilité A', B: 'Fiabilité B', C: 'Fiabilité C', D: 'Fiabilité D' };
export const levelOf = (score) => (score >= 70 ? 'A' : score >= 50 ? 'B' : score >= 30 ? 'C' : 'D');

const bull = (c) => c.close > c.open;
const bear = (c) => c.close < c.open;
const body = (c) => Math.abs(c.close - c.open);
const round = (v, d = 5) => (v == null ? v : Math.round(v * 10 ** d) / 10 ** d);

/** Index de la bougie qui commence à `t` ou juste avant. */
function idxAtTime(c, t) {
  let lo = 0, hi = c.length - 1, idx = -1;
  while (lo <= hi) { const m = (lo + hi) >> 1; if (c[m].time <= t) { idx = m; lo = m + 1; } else hi = m - 1; }
  return idx;
}
/** Dernier POI formé au plus tard à l'index `idx` (POI triés par formation, recherche binaire). */
function lastPoiIdx(pois, idx) {
  let lo = 0, hi = pois.length - 1, k = -1;
  while (lo <= hi) { const m = (lo + hi) >> 1; if (pois[m].formedIdx <= idx) { k = m; lo = m + 1; } else hi = m - 1; }
  return k;
}
/** Dernier événement de structure dont la cassure est clôturée à l'index `idx` (recherche binaire). */
function lastEventIdx(events, idx) {
  let lo = 0, hi = events.length - 1, k = -1;
  while (lo <= hi) { const m = (lo + hi) >> 1; if (events[m].breakIdx <= idx) { k = m; lo = m + 1; } else hi = m - 1; }
  return k;
}

/**
 * Prépare une UT (une fois par analyse) : bougies clôturées, ATR, structure (BOS, CHoCH marqués),
 * POI (FVG et OB de cassure) triés par date de formation.
 */
export function prepTopdownTf(raw, tf, o = TOPDOWN_DEFAULTS) {
  const c = normalizeCandles(raw || []).filter((x) => x.complete !== false);
  if (c.length < 10) return null;
  const atr = atrSeries(c, 14);
  const { events } = structureEvents(c, o.swingK);
  for (let k = 0; k < events.length; k++) events[k].choch = k > 0 && events[k - 1].dir !== events[k].dir;
  const pois = [];
  for (let i = 1; i < c.length - 1; i++) {
    const a = atr[i];
    if (a == null || body(c[i]) < o.impulseAtr * a) continue;
    if (bull(c[i]) && c[i + 1].low > c[i - 1].high) pois.push({ kind: 'FVG', dir: 'BUY', low: c[i - 1].high, high: c[i + 1].low, formedIdx: i + 1 });
    if (bear(c[i]) && c[i + 1].high < c[i - 1].low) pois.push({ kind: 'FVG', dir: 'SELL', low: c[i + 1].high, high: c[i - 1].low, formedIdx: i + 1 });
  }
  for (const e of events) {
    for (let x = e.breakIdx - 1; x >= e.legIdx; x--) {
      if (e.dir === 'BUY' ? bear(c[x]) : bull(c[x])) { pois.push({ kind: 'OB', dir: e.dir, low: c[x].low, high: c[x].high, formedIdx: e.breakIdx }); break; }
    }
  }
  pois.sort((a, b) => a.formedIdx - b.formedIdx);
  return { tf, c, step: TF_SECONDS[tf], atr, events, pois };
}

/** Le POI est-il invalidé (clôture au-delà du bord opposé) avant l'index `idx` ? (mémorisé) */
function invalidBefore(h, p, idx) {
  if (p.invalidIdx === undefined) {
    p.invalidIdx = null;
    for (let j = p.formedIdx + 1; j < h.c.length; j++) {
      if (p.dir === 'BUY' ? h.c[j].close < p.low : h.c[j].close > p.high) { p.invalidIdx = j; break; }
    }
  }
  return p.invalidIdx != null && p.invalidIdx <= idx;
}

/** Lecture d'une UT supérieure à l'instant t pour un OB [low, high] de direction `dir`. */
function readHtf(h, t, dir, low, high, o) {
  const idx = lastClosedIndex(h.c, h.tf, t); // clôture exacte des mois (engine.js)
  if (idx < 5) return null;
  const k = lastEventIdx(h.events, idx);
  const ev = k >= 0 ? h.events[k] : null;
  const trend = ev ? ev.dir : null;
  const chochAgainst = !!(ev && ev.choch && ev.dir !== dir);
  // Premium / Discount dans le range de la dernière jambe (0 = bas, 1 = haut)
  let pd = null, level = null;
  if (ev) {
    let lo = Infinity, hi = -Infinity;
    for (let x = Math.max(ev.legIdx, idx - o.legCap); x <= idx; x++) { lo = Math.min(lo, h.c[x].low); hi = Math.max(hi, h.c[x].high); }
    if (hi > lo) {
      level = ((low + high) / 2 - lo) / (hi - lo);
      pd = level < 0.5 ? 'DISCOUNT' : level > 0.5 ? 'PREMIUM' : 'EQUILIBRE';
    }
  }
  // POI HTF de même sens, formé avant t, non invalidé, qui chevauche l'OB
  let poi = null;
  const minIdx = idx - o.poiLookback;
  for (let j = lastPoiIdx(h.pois, idx); j >= 0; j--) {
    const p = h.pois[j];
    if (p.formedIdx < minIdx) break;
    if (p.dir !== dir || p.high < low || p.low > high) continue;
    if (invalidBefore(h, p, idx)) continue;
    poi = { kind: p.kind, low: round(p.low), high: round(p.high) };
    break;
  }
  return {
    tf: h.tf, trend, aligned: trend === dir, chochAgainst,
    lastBreak: ev ? { dir: ev.dir, kind: ev.choch ? 'CHoCH' : 'BOS', level: round(ev.level), time: h.c[ev.breakIdx].time } : null,
    pd, level: round(level, 3), pdOk: pd != null && (dir === 'BUY' ? pd === 'DISCOUNT' : pd === 'PREMIUM'),
    poi,
  };
}

/**
 * Évalue la fiabilité top-down d'un OB (zone de detectZones).
 * @param {object} z   zone (timeframe, direction, zoneLow, zoneHigh, c1Time, gap, atr, candles.C2, firstTouch)
 * @param {Record<string, object>} prepared  UT préparées par prepTopdownTf (clé = UT)
 * @param {number} nowT instant présent (s) si la zone n'a pas encore été touchée
 */
export function evaluateTopdown(z, prepared, nowT, o = TOPDOWN_DEFAULTS) {
  const dir = z.direction;
  const t = z.firstTouch?.time ?? nowT;
  const chain = [];
  (TOPDOWN_CHAIN[z.timeframe] || []).forEach((tf, rank) => {
    const h = prepared[tf];
    if (!h) return;
    const r = readHtf(h, t, dir, z.zoneLow, z.zoneHigh, o);
    // rang dans la chaîne (0 = UT la plus proche) : le poids ne dépend pas des UT absentes
    if (r) chain.push({ ...r, rank });
  });
  // structure locale (UT de l'OB) entre la formation de l'OB et la décision
  const L = prepared[z.timeframe];
  let localBos = null, counter = null;
  if (L) {
    const c1 = idxAtTime(L.c, z.c1Time);
    // décision : dernière bougie close AVANT l'ouverture de la bougie de contact (même si celle-ci est
    // la bougie en cours, absente de L.c qui ne garde que les bougies closes)
    const dec = z.firstTouch ? idxAtTime(L.c, z.firstTouch.time - 1) : L.c.length - 1;
    for (const e of L.events) {
      if (e.breakIdx <= c1 || e.breakIdx > dec) continue;
      if (e.dir === dir) { if (!localBos) localBos = { kind: e.choch ? 'CHoCH' : 'BOS', level: round(e.level), time: L.c[e.breakIdx].time }; }
      else counter = { kind: e.choch ? 'CHoCH' : 'BOS', level: round(e.level), time: L.c[e.breakIdx].time };
    }
  }
  const gapAtr = z.atr ? z.gap / z.atr : null;
  const c2Body = z.candles?.C2 ? body(z.candles.C2) : null;
  const displacement = (gapAtr != null && gapAtr >= o.strongGapAtr) || (z.atr && c2Body != null && c2Body >= o.displacementAtr * z.atr);

  // score pondéré
  const w = chain.map((r) => CHAIN_WEIGHTS[r.rank] ?? 2);
  const sumW = w.reduce((a, b) => a + b, 0);
  const share = (pred) => (sumW ? chain.reduce((s, r, i) => s + (pred(r) ? w[i] : 0), 0) / sumW : 0);
  const trendShare = share((r) => r.aligned && !r.chochAgainst);
  const pdShare = share((r) => r.pdOk);
  const htfPoi = chain.find((r) => r.poi) || null;
  const P = TOPDOWN_POINTS;
  const parts = {
    htfTrend: Math.round(P.htfTrend * trendShare),
    htfPd: Math.round(P.htfPd * pdShare),
    htfPoi: htfPoi ? P.htfPoi : 0,
    localBos: localBos ? P.localBos : 0,
    displacement: displacement ? P.displacement : 0,
    noCounter: counter ? 0 : P.noCounter,
  };
  const score = Object.values(parts).reduce((a, b) => a + b, 0);
  return {
    at: t, chain, localBos, counter, gapAtr: round(gapAtr, 2), displacement: !!displacement,
    htfPoi: htfPoi ? { tf: htfPoi.tf, ...htfPoi.poi } : null,
    parts, score, level: levelOf(score),
  };
}

/** Annote une liste de zones (ajoute `zone.topdown`), en préparant chaque UT une seule fois. */
export function annotateTopdown(zones, candlesByTf, nowT, o = TOPDOWN_DEFAULTS) {
  const prepared = {};
  const need = new Set();
  for (const z of zones) { need.add(z.timeframe); for (const tf of TOPDOWN_CHAIN[z.timeframe] || []) need.add(tf); }
  for (const tf of need) if (candlesByTf?.[tf]?.length) prepared[tf] = prepTopdownTf(candlesByTf[tf], tf, o);
  for (const z of zones) z.topdown = evaluateTopdown(z, prepared, nowT, o);
  return zones;
}

/** Derniers événements de structure (BOS / CHoCH) d'une UT, pour l'affichage sur le graphique. */
export function structureMarks(raw, tf, max = 8) {
  const h = prepTopdownTf(raw, tf);
  if (!h) return [];
  return h.events.slice(-max).map((e) => ({
    dir: e.dir, kind: e.choch ? 'CHoCH' : 'BOS', level: round(e.level),
    fromTime: h.c[Math.max(0, e.legIdx)].time, time: h.c[e.breakIdx].time,
  }));
}
