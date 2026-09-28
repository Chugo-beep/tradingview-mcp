/**
 * Statistiques de performance HONNÊTES (sans IA) : un résultat n'est présenté comme un avantage
 * que s'il résiste à l'incertitude d'échantillon et à la comparaison avec le hasard.
 *
 *  - summarize(trades)        : n, réussite, espérance en R et en pips, intervalle de confiance
 *                               à 90 % de l'espérance (bootstrap déterministe), profit factor,
 *                               drawdown maximal, plus longue série de pertes, courbe de capital,
 *                               verdict de significativité.
 *  - randomBenchmark(...)     : mêmes stops/objectifs (en R), entrées et sens tirés au hasard sur
 *                               les mêmes bougies → la stratégie fait-elle mieux que le hasard ?
 *
 * Module ES pur (navigateur, APK, Node).
 */
import { advance, finalize, POS } from './trades.js';

/** Générateur pseudo-aléatoire déterministe (mulberry32) : résultats reproductibles. */
export function rng(seed = 1) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Seuils d'échantillon : en dessous, aucun verdict n'est possible. */
export const MIN_TRADES_INDICATIVE = 30;
export const MIN_TRADES_SIGNIFICANT = 100;

const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);

/** Intervalle de confiance bootstrap (percentiles) de la moyenne. */
export function bootstrapCI(values, { level = 0.9, iterations = 1000, seed = 7 } = {}) {
  const n = values.length;
  if (n < 2) return null;
  const r = rng(seed);
  const means = new Array(iterations);
  for (let k = 0; k < iterations; k++) {
    let s = 0;
    for (let i = 0; i < n; i++) s += values[Math.floor(r() * n)];
    means[k] = s / n;
  }
  means.sort((a, b) => a - b);
  const lo = means[Math.floor(((1 - level) / 2) * (iterations - 1))];
  const hi = means[Math.ceil((1 - (1 - level) / 2) * (iterations - 1))];
  return [lo, hi];
}

/**
 * @param {Array<{r:number, pips?:number, t?:number}>} trades trades CLÔTURÉS (r = résultat en R, coûts déduits)
 */
export function summarize(trades) {
  const xs = (trades || []).filter((x) => Number.isFinite(x?.r)).slice().sort((a, b) => (a.t ?? 0) - (b.t ?? 0));
  const n = xs.length;
  const rs = xs.map((x) => x.r);
  const pips = xs.map((x) => (Number.isFinite(x.pips) ? x.pips : 0));
  const wins = rs.filter((r) => r > 0).length;
  const gainR = rs.filter((r) => r > 0).reduce((a, b) => a + b, 0);
  const lossR = -rs.filter((r) => r < 0).reduce((a, b) => a + b, 0);
  // courbe de capital (R cumulés) et drawdown maximal
  let eq = 0, peak = 0, maxDD = 0, eqP = 0, peakP = 0, maxDDP = 0, streak = 0, maxStreak = 0;
  const curve = [];
  for (let i = 0; i < n; i++) {
    eq += rs[i]; eqP += pips[i];
    peak = Math.max(peak, eq); peakP = Math.max(peakP, eqP);
    maxDD = Math.max(maxDD, peak - eq); maxDDP = Math.max(maxDDP, peakP - eqP);
    streak = rs[i] <= 0 ? streak + 1 : 0; maxStreak = Math.max(maxStreak, streak);
    curve.push({ t: xs[i].t ?? i, r: eq, pips: eqP });
  }
  const meanR = mean(rs);
  const ciR = bootstrapCI(rs);
  return {
    n, wins, losses: n - wins,
    winRate: n ? wins / n : null,
    meanR, ciR,
    meanPips: mean(pips), totalPips: pips.reduce((a, b) => a + b, 0), totalR: eq,
    profitFactor: lossR > 0 ? gainR / lossR : (gainR > 0 ? Infinity : null),
    maxDrawdownR: maxDD, maxDrawdownPips: maxDDP, maxLosingStreak: maxStreak,
    curve,
    verdict: verdictOf(n, ciR),
  };
}

/** Verdict lisible : jamais « rentable » sans échantillon suffisant ET intervalle entièrement positif. */
export function verdictOf(n, ciR) {
  if (n < MIN_TRADES_INDICATIVE) return { level: 'insuffisant', label: `Échantillon insuffisant (${n} < ${MIN_TRADES_INDICATIVE} trades) : aucun avantage mesurable` };
  const lo = ciR?.[0], hi = ciR?.[1];
  const tag = n < MIN_TRADES_SIGNIFICANT ? 'indicatif' : 'significatif';
  if (lo > 0) return { level: tag === 'significatif' ? 'avantage' : 'indicatif', label: tag === 'significatif' ? 'Avantage probable (intervalle à 90 % entièrement positif)' : `Positif mais indicatif (${n} < ${MIN_TRADES_SIGNIFICANT} trades)` };
  if (hi < 0) return { level: 'desavantage', label: 'Désavantage probable (intervalle à 90 % entièrement négatif)' };
  return { level: 'neutre', label: 'Aucun avantage démontré (l\'intervalle contient 0)' };
}

/**
 * Référence « hasard » : pour chaque trade réel, une entrée au marché à une bougie tirée au hasard,
 * dans un sens tiré au hasard, avec le MÊME stop (en prix) et les MÊMES objectifs (en R), la même
 * gestion (BE, trailing, tiers) et le même coût. Répété `runs` fois.
 * @param {Array} candles bougies de l'UT (triées)
 * @param {Array<{riskPx:number, rr:number, rr2:number, rr3:number, pipSize:number, costPips:number}>} templates un par trade réel
 * @returns {{ runs, meanR:number[], strategyPercentile:(m:number)=>number }}
 */
export function randomBenchmark(candles, templates, { runs = 100, seed = 11, maxBars = 2000 } = {}) {
  const out = [];
  if (!candles?.length || !templates?.length || candles.length < 50) return { runs: 0, meanR: out, raw: [], percentileOf: () => null };
  const r = rng(seed);
  for (let k = 0; k < runs; k++) {
    let sum = 0, cnt = 0;
    for (const tp of templates) {
      if (!(tp.riskPx > 0)) continue;
      const i = 20 + Math.floor(r() * (candles.length - 40));
      const buy = r() < 0.5, sgn = buy ? 1 : -1;
      const entry = candles[i].close;
      const pos = {
        dir: buy ? 'BUY' : 'SELL', entry, sl: entry - sgn * tp.riskPx,
        tp1: entry + sgn * tp.rr * tp.riskPx, tp2: entry + sgn * tp.rr2 * tp.riskPx, tp3: entry + sgn * tp.rr3 * tp.riskPx,
        state: POS.OPEN, fillPrice: entry, fillTime: candles[i].time, riskPx: tp.riskPx, riskPips: tp.riskPx / tp.pipSize,
        hits: 0, hitTimes: [], costPips: tp.costPips || 0, entryMode: 'limit',
      };
      advance(pos, candles.slice(i + 1, i + 1 + maxBars), { pipSize: tp.pipSize });
      if (pos.state !== POS.TP && pos.state !== POS.SL) continue;
      const f = finalize(pos, { slPips: tp.riskPx / tp.pipSize, riskPx: tp.riskPx }, null, { pipSize: tp.pipSize, costPips: tp.costPips || 0 });
      if (Number.isFinite(f.r)) { sum += f.r; cnt++; }
    }
    out.push(cnt ? { m: sum / cnt, n: cnt } : null);
  }
  const raw = out;
  const sorted = raw.filter(Boolean).map((x) => x.m).sort((a, b) => a - b);
  return percentileTools(sorted, raw);
}

function percentileTools(sorted, raw = null) {
  const out = sorted;
  return {
    raw,
    runs: out.length, meanR: out,
    /** Part (0–1) des stratégies au hasard dont l'espérance est INFÉRIEURE à `m`. */
    percentileOf: (m) => (out.length && Number.isFinite(m) ? out.filter((x) => x < m).length / out.length : null),
  };
}

/**
 * Combine plusieurs références (une par UT) exécutées avec le même nombre de tirages : le tirage k
 * de chaque UT est pondéré par son nombre de trades.
 */
export function combineBenchmarks(list) {
  const valid = list.filter((b) => b?.raw?.length);
  if (!valid.length) return percentileTools([]);
  const runs = Math.min(...valid.map((b) => b.raw.length));
  const out = [];
  for (let k = 0; k < runs; k++) {
    let s = 0, n = 0;
    for (const b of valid) { const x = b.raw[k]; if (x) { s += x.m * x.n; n += x.n; } }
    if (n) out.push(s / n);
  }
  return percentileTools(out.sort((a, b) => a - b));
}

/** Texte court du test contre le hasard. */
export function benchmarkLabel(pct, n = Infinity) {
  if (pct == null) return 'Test contre le hasard : non disponible';
  const p = Math.round(pct * 100);
  if (n < MIN_TRADES_INDICATIVE) return `Test contre le hasard : non concluant (${n} trade(s), ${MIN_TRADES_INDICATIVE} nécessaires)`;
  const v = pct >= 0.95 ? 'meilleur que le hasard' : pct <= 0.05 ? 'pire que le hasard' : 'non distinguable du hasard';
  return `Test contre le hasard : meilleure que ${p} % des stratégies aléatoires → ${v}`;
}
