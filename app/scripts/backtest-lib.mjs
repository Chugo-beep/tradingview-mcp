/**
 * Fonctions pures du backtest long terme (scripts/backtest-dukascopy.mjs) : agrégation 1 minute →
 * timeframes de l'application, et repli synthétique (marche aléatoire) pour tester le pipeline
 * sans dépendre des serveurs Dukascopy. Aucun accès réseau ici : testable isolément
 * (tests/backtest.test.js).
 */
import { TF_SECONDS } from '../www/js/engine.js';

/** Timeframes agrégées pour le backtest (les mêmes que le classement « analyse complète »). */
export const BACKTEST_TFS = ['5', '15', '60', '240', 'D', 'W', 'M']; // W/M : POI et biais HTF de la stratégie SMC

/** Correspondance id de marché (registre www/js/markets.js) → code instrument Dukascopy. */
export const DUKASCOPY_INSTRUMENT = {
  XAUUSD: 'xauusd',
  EURUSD: 'eurusd',
  GBPUSD: 'gbpusd',
  USDJPY: 'usdjpy',
  US30: 'usa30idxusd',
  SP500: 'usa500idxusd',
  NAS100: 'usatechidxusd',
  DAX40: 'deuidxeur',
  CAC40: 'fraidxeur',
  WTI: 'lightcmdusd',
  BRENT: 'brentcmdusd',
};

/**
 * Agrège des bougies 1 minute (triées, temps UTC en secondes) en une timeframe cible, alignée sur
 * des intervalles ronds (00:00 UTC pour 'D', minuit du lundi pour d'éventuelles semaines, etc.),
 * comme le fait TradingView. La dernière bougie agrégée peut être incomplète (`complete:false`)
 * si le dernier intervalle n'est pas terminé par les données 1m fournies.
 * @param {Array<{time:number, open:number, high:number, low:number, close:number, volume?:number}>} m1
 * @param {string} tf clé de TF_SECONDS ('5'|'15'|'60'|'240'|'D'|…)
 * @returns {Array<{time:number, open:number, high:number, low:number, close:number, volume:number, complete:boolean}>}
 */
/** Début d'intervalle calendaire UTC : semaine = lundi 00:00, mois = 1er du mois 00:00, sinon multiple de `step`. */
export function bucketOf(t, tf, step = TF_SECONDS[tf]) {
  if (tf === 'W') { const d = Math.floor(t / 86400); const dow = (d + 3) % 7; return (d - dow) * 86400; } // 1970-01-01 = jeudi
  if (tf === 'M') { const x = new Date(t * 1000); return Date.UTC(x.getUTCFullYear(), x.getUTCMonth(), 1) / 1000; }
  return Math.floor(t / step) * step;
}

export function aggregate1mTo(m1, tf) {
  const step = TF_SECONDS[tf];
  if (!step) throw new Error(`Timeframe inconnue : ${tf}`);
  const out = [];
  let bucket = null, bucketStart = null;
  for (const c of m1) {
    if (!c || !Number.isFinite(c.time)) continue;
    const start = bucketOf(c.time, tf, step);
    if (bucketStart === null || start !== bucketStart) {
      if (bucket) out.push(bucket);
      bucketStart = start;
      bucket = { time: start, open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume || 0, complete: true };
    } else {
      bucket.high = Math.max(bucket.high, c.high);
      bucket.low = Math.min(bucket.low, c.low);
      bucket.close = c.close;
      bucket.volume += c.volume || 0;
    }
  }
  if (bucket) { bucket.complete = false; out.push(bucket); } // dernier intervalle : peut-être partiel
  if (out.length > 1) out[out.length - 2].complete = true; // tous les précédents sont bien clos
  return out;
}

/** Agrège une série 1m en toutes les timeframes du backtest, en une passe par TF. */
export function aggregateAll(m1, tfs = BACKTEST_TFS) {
  const byTf = {};
  for (const tf of tfs) byTf[tf] = aggregate1mTo(m1, tf);
  return byTf;
}

/**
 * Découpe une série 1m en deux tranches temporelles pour la validation « walk-forward » :
 * les `pct` premiers pourcents (in-sample, ex. 70 %) puis le reste (out-of-sample).
 * @returns {{ inSample: Array, outOfSample: Array }}
 */
export function splitWalkForward(m1, pct = 0.7) {
  const n = Math.floor(m1.length * pct);
  return { inSample: m1.slice(0, n), outOfSample: m1.slice(n) };
}

/**
 * Génère une série 1m synthétique (marche aléatoire géométrique, volatilité indicative) pour
 * tester le pipeline de bout en bout sans dépendre des serveurs Dukascopy (--synthetic).
 * Déterministe si `seed` est fourni (PRNG mulberry32), pour des tests reproductibles.
 */
export function syntheticSeries({ from, to, startPrice = 2000, volPct = 0.0006, seed } = {}) {
  const fromS = Math.floor(new Date(from).getTime() / 1000);
  const toS = Math.floor(new Date(to).getTime() / 1000);
  const n = Math.max(1, Math.floor((toS - fromS) / 60));
  const rand = mulberry32(Number.isFinite(seed) ? seed : 42);
  const out = [];
  let price = startPrice;
  for (let i = 0; i < n; i++) {
    const t = fromS + i * 60;
    const drift = (rand() - 0.5) * 2 * volPct * price;
    const open = price;
    const close = Math.max(0.01, open + drift);
    const wick = Math.abs(drift) * (0.5 + rand());
    const high = Math.max(open, close) + wick * rand();
    const low = Math.min(open, close) - wick * rand();
    out.push({ time: t, open, high, low: Math.max(0.01, low), close, volume: Math.round(100 + rand() * 900) });
    price = close;
  }
  return out;
}
function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
