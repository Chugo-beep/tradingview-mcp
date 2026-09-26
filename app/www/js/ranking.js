/**
 * Classement des marchés pour l'« analyse complète » : backtest des zones 5★ de chaque marché
 * sur l'historique chargé, puis tri par performance (gains en pips, puis taux de réussite).
 *
 * Module ES pur (pas d'accès réseau/TradingView) : utilisé par server.js après un `fullScan`
 * de tvfeed.js, et testable isolément.
 */
import { TIMEFRAMES, detectZones, DEFAULT_OPTIONS } from './engine.js';
import { simulateZone, planFor, POS, DEFAULT_RISK } from './trades.js';

/** Échantillon minimal de trades clôturés pour être classé avant les marchés « insuffisants ». */
export const MIN_SAMPLE_TRADES = 8;

/** Backtest + classement d'un seul marché sur les bougies déjà chargées (par timeframe). */
export function rankMarket(market, candlesByTf, opts = {}) {
  const risk = { ...DEFAULT_RISK, ...(opts.risk || {}), pipSize: market.pip, contractSize: market.contractSize, minStars: 5 };
  const strategy = { ...DEFAULT_OPTIONS, ...(opts.strategy || {}) };
  let trades = 0, pips = 0, wins = 0, proposals = 0;
  const topZones = [];
  const barsPerTf = {};
  for (const tf of TIMEFRAMES) {
    const c = candlesByTf?.[tf];
    if (!c || !c.length) continue;
    barsPerTf[tf] = c.length;
    const currentPrice = c.at(-1).close;
    const { zones } = detectZones(c, { ...strategy, timeframe: tf, currentPrice, marketId: market.id });
    for (const z of zones) {
      // seules les zones 5★ sont valides (règle non réglable, cf. TRADING_RULES_MASTER_PROMPT.md)
      if (!z.grade || z.grade < 5 || !z.stars?.trend) continue;
      const plan = planFor(z, risk);
      if (!plan.slOk) continue;
      const pos = simulateZone(z, c, risk, { currentPrice });
      if (pos.state === POS.TP || pos.state === POS.SL) { trades++; pips += pos.pips ?? 0; if ((pos.pips ?? 0) > 0) wins++; }
      if (z.viable) {
        proposals++;
        topZones.push({ timeframe: tf, direction: z.direction, zoneLow: z.zoneLow, zoneHigh: z.zoneHigh, entry: plan.entry, sl: plan.sl, tp1: plan.tp1, grade: z.grade, c1Time: z.c1Time });
      }
    }
  }
  topZones.sort((a, b) => b.c1Time - a.c1Time);
  const winRate = trades ? wins / trades : null;
  const expectancyPips = trades ? pips / trades : null;
  return {
    market: market.id, label: market.label,
    pips: Math.round(pips * 100) / 100, trades, winRate, expectancyPips: expectancyPips != null ? Math.round(expectancyPips * 100) / 100 : null,
    proposals, insufficient: trades < MIN_SAMPLE_TRADES,
    topZones: topZones.slice(0, 5), barsPerTf,
  };
}

/**
 * Classe une liste de résultats `rankMarket(...)` : échantillon suffisant (≥ 8 trades clôturés)
 * d'abord, triés par gains en pips puis taux de réussite ; puis les marchés à échantillon
 * insuffisant, dans le même ordre secondaire.
 */
export function rankMarkets(results) {
  const byGroup = (r) => (r.insufficient ? 1 : 0);
  return [...results].sort((a, b) => byGroup(a) - byGroup(b)
    || b.pips - a.pips
    || (b.winRate ?? -1) - (a.winRate ?? -1));
}
