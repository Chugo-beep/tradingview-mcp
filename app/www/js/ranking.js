/**
 * Classement des marchés pour l'« analyse complète » : backtest des zones 5★ de chaque marché sur
 * l'historique chargé, coûts (spread + glissement) déduits, statistiques honnêtes (stats.js),
 * test contre le hasard, règle d'annulation champion/challenger, et HISTORIQUE des trades simulés.
 *
 * - Note utilisée : celle connue à la clôture de C3 (`gradeAtDetection`) — ⭐4 « vierge » y est
 *   toujours vraie ; la note d'aujourd'hui excluait toute zone déjà tradée (backtest vide).
 * - Catégories : 'scalp' | 'day' | 'swing' (policyKey) — les trades Scalp sont bien comptés.
 * - Le classement n'est QU'INFORMATIF : il ne choisit jamais les marchés de l'analyse en direct
 *   (c'est l'utilisateur qui les choisit dans « Marchés »).
 *
 * Module ES pur (pas d'accès réseau/TradingView) : utilisé par scan.js après un `fullScan` de
 * tvfeed.js, par le script de backtest long terme, et testable isolément.
 */
import { TIMEFRAMES, detectZones, annotateHtf, DEFAULT_OPTIONS } from './engine.js';
import { simulateZone, planFor, POS, DEFAULT_RISK, CANCEL_POLICIES, policyKey } from './trades.js';
import { marketRisk } from './markets.js';
import { summarize, randomBenchmark, combineBenchmarks, benchmarkLabel } from './stats.js';
import { detectSmcSetups } from './smc.js';

/** Échantillon minimal de trades clôturés pour être classé avant les marchés « insuffisants ». */
export const MIN_SAMPLE_TRADES = 30;
/** Nombre maximal de trades conservés dans l'historique par marché (les plus récents). */
export const MAX_HISTORY_PER_MARKET = 400;
const POLICY_CATS = ['scalp', 'day', 'swing'];

/** Filtre de stratégie commun (backtest, classement, propositions) : 5★ à la détection, tendance, UT supérieure, séances. */
export function passesStrategy(z, strategy = {}) {
  if (z.smc) {
    if (!z.smc.valid) return false;
    if (Array.isArray(strategy.sessions) && strategy.sessions.length && z.session && !strategy.sessions.includes(z.session)) return false;
    return true;
  }
  const g = z.gradeAtDetection ?? ((z.grade || 0) + (z.stars && !z.stars.virgin ? 1 : 0));
  if (!g || g < 5 || !z.stars?.trend) return false;
  if (strategy.htfFilter !== false && z.htf?.aligned === false) return false;
  if (Array.isArray(strategy.sessions) && strategy.sessions.length && z.session && !strategy.sessions.includes(z.session)) return false;
  return true;
}

const r2 = (v) => (v == null || !Number.isFinite(v) ? v : Math.round(v * 100) / 100);
const r3 = (v) => (v == null || !Number.isFinite(v) ? v : Math.round(v * 1000) / 1000);

/** Backtest brut d'un marché (les deux règles d'annulation) ; `summarizeWithPolicy` en tire le résultat. */
export function rankMarket(market, candlesByTf, opts = {}) {
  const lastPrice = TIMEFRAMES.map((tf) => candlesByTf?.[tf]?.at(-1)?.close).find(Number.isFinite);
  const risk = {
    ...DEFAULT_RISK, ...(opts.risk || {}),
    ...marketRisk(market, { quotePrice: lastPrice, spreadOverride: opts.risk?.spreadOverrides?.[market.id], slippagePips: opts.risk?.slippagePips }),
    minStars: 5,
  };
  const strategy = { ...DEFAULT_OPTIONS, ...(opts.strategy || {}), htfFilter: opts.risk?.htfFilter ?? opts.strategy?.htfFilter, sessions: opts.risk?.sessions ?? opts.strategy?.sessions };
  const m1 = candlesByTf?.['1'] || null;
  const barsPerTf = {};
  const byPolicy = { tp1: [], keep: [] };
  const viableZones = [];
  // entonnoir : où les zones sont perdues (affiché dans « Marchés » pour expliquer l'absence d'opportunité)
  const funnel = { zones: 0, fiveAtBirth: 0, untouched: 0, untouched5: 0, missTrend: 0, missLiquidity: 0, missFib: 0, missHtf: 0, slTooWide: 0 };
  const all = [];
  const smcMode = (opts.risk?.strategyMode || risk.strategyMode || 'smc') === 'smc';
  for (const tf of TIMEFRAMES) {
    const c = candlesByTf?.[tf];
    if (!c || !c.length) continue;
    barsPerTf[tf] = c.length;
    if (smcMode) continue;
    const { zones } = detectZones(c, { ...strategy, timeframe: tf, currentPrice: c.at(-1).close, marketId: market.id });
    all.push(...zones);
  }
  let smcFunnel = null;
  if (smcMode) {
    const r = detectSmcSetups(candlesByTf, { marketId: market.id, smc: opts.strategy?.smc });
    all.push(...r.setups);
    smcFunnel = r.funnel;
  } else annotateHtf(all, candlesByTf, strategy);
  const templatesByTf = {};
  for (const z of all) {
    const tf = z.timeframe;
    const c = candlesByTf[tf];
    const currentPrice = c.at(-1).close;
    funnel.zones++;
    if (z.viable) {
      funnel.untouched++;
      if (!z.stars?.trend) funnel.missTrend++;
      if (!z.stars?.liquidity) funnel.missLiquidity++;
      if (!z.stars?.fib) funnel.missFib++;
      if (z.htf?.aligned === false) funnel.missHtf++;
    }
    if (!passesStrategy(z, strategy)) continue;
    funnel.fiveAtBirth++;
    const plan = planFor(z, risk);
    if (!plan.slOk) { if (z.viable) funnel.slTooWide++; continue; }
    const cat = policyKey(z.category);
    const pend = {};
    let tpl = null;
    for (const policy of CANCEL_POLICIES) {
      const pos = simulateZone(z, c, { ...risk, cancelPolicy: policy, cancelPolicyByCat: null }, { currentPrice, m1 });
      if ((pos.state === POS.TP || pos.state === POS.SL) && Number.isFinite(pos.r)) {
        byPolicy[policy].push({
          id: z.id, cat, tf, dir: z.direction, pips: r2(pos.pips), r: r3(pos.r), t: pos.exitTime ?? z.c3Time,
          fillTime: pos.fillTime, fillPrice: pos.fillPrice, exitPrice: pos.exitPrice, exitKind: pos.exitKind,
          sl: plan.sl, tp1: plan.tp1, tp2: plan.tp2, tp3: plan.tp3, zoneLow: z.zoneLow, zoneHigh: z.zoneHigh, c1Time: z.c1Time,
          costPips: pos.costPips ?? risk.costPips,
        });
        tpl ||= { riskPx: Math.abs(pos.fillPrice - plan.sl), rr: plan.rr, rr2: plan.rr2, rr3: plan.rr3, pipSize: risk.pipSize, costPips: risk.costPips };
      }
      pend[policy] = pos.state === POS.PENDING;
    }
    if (tpl) (templatesByTf[tf] ||= []).push(tpl);
    // proposition en direct : zone 5★ AUJOURD'HUI (donc encore vierge) et ordre encore en attente
    if (z.viable && z.grade >= 5) {
      funnel.untouched5++;
      viableZones.push({ cat, pending: pend, zone: { timeframe: tf, direction: z.direction, zoneLow: z.zoneLow, zoneHigh: z.zoneHigh, entry: plan.entry, sl: plan.sl, tp1: plan.tp1, grade: z.grade, c1Time: z.c1Time, distance: z.distance } });
    }
  }
  // référence « hasard » : mêmes stops et objectifs (en R), entrées et sens aléatoires (indépendant de la règle d'annulation)
  const benches = opts.benchmark === false ? [] : Object.entries(templatesByTf).map(([tf, tpl]) => randomBenchmark(candlesByTf[tf], tpl, { runs: opts.benchmarkRuns ?? 100 }));
  const bench = combineBenchmarks(benches);
  const raw = { market: market.id, label: market.label, barsPerTf, funnel: smcFunnel ? { ...smcFunnel, strategy: 'smc' } : funnel, strategyMode: smcMode ? 'smc' : 'ob5', byPolicy, viableZones, benchMeanR: bench.meanR, costPips: risk.costPips, targetMode: risk.targetMode === 'atr' ? 'atr' : 'pips' };
  return summarizeWithPolicy(raw, opts.policy);
}

/** Statistiques simples d'une liste de trades clôturés (utilisées par le choix de règle). */
export function tradeStats(list) {
  const sorted = [...list].sort((a, b) => a.t - b.t);
  let pips = 0, wins = 0, gw = 0, gl = 0, peak = 0, dd = 0, sumR = 0;
  for (const x of sorted) {
    pips += x.pips; sumR += x.r || 0;
    if (x.pips > 0) { wins++; gw += x.pips; } else gl += -x.pips;
    peak = Math.max(peak, pips); dd = Math.max(dd, peak - pips);
  }
  const n = sorted.length;
  return { n, pips: r2(pips), winRate: n ? wins / n : null, pf: gl > 0 ? r2(gw / gl) : (gw > 0 ? Infinity : null), maxDD: r2(dd), expR: n ? r3(sumR / n) : null };
}

/**
 * Applique la règle d'annulation retenue par catégorie ({scalp, day, swing} → 'tp1'|'keep', défaut
 * 'tp1') au backtest brut d'un marché : statistiques honnêtes, verdict, test contre le hasard,
 * opportunités en attente, et historique des trades simulés sous cette règle.
 */
export function summarizeWithPolicy(raw, policy = {}) {
  const pol = (cat) => (CANCEL_POLICIES.includes(policy?.[cat]) ? policy[cat] : 'tp1');
  const trades = [];
  for (const cat of POLICY_CATS) trades.push(...(raw.byPolicy?.[pol(cat)] || []).filter((x) => x.cat === cat));
  const st = summarize(trades);
  const benchSorted = raw.benchMeanR || [];
  const pct = benchSorted.length && Number.isFinite(st.meanR) ? benchSorted.filter((x) => x < st.meanR).length / benchSorted.length : null;
  const live = (raw.viableZones || []).filter((v) => v.pending?.[pol(v.cat)]).map((v) => v.zone).sort((a, b) => b.c1Time - a.c1Time);
  const history = trades.slice().sort((a, b) => b.t - a.t).slice(0, MAX_HISTORY_PER_MARKET)
    .map((x) => ({ ...x, market: raw.market, policy: pol(x.cat) }));
  return {
    ...raw,
    pips: r2(st.totalPips), trades: st.n, winRate: st.winRate, expectancyPips: r2(st.meanPips),
    expectancyR: r2(st.meanR), ciR: st.ciR ? st.ciR.map(r2) : null, profitFactor: r2(st.profitFactor),
    maxDrawdownR: r2(st.maxDrawdownR), maxLosingStreak: st.maxLosingStreak,
    verdict: st.verdict, randomPercentile: pct, randomLabel: benchmarkLabel(pct, st.n),
    curve: st.curve.map((p) => ({ t: p.t, r: r2(p.r) })).slice(-300),
    proposals: live.length, insufficient: st.n < MIN_SAMPLE_TRADES, topZones: live.slice(0, 5),
    history,
  };
}

/** Échantillon minimal par catégorie pour qu'une règle challenger puisse remplacer le champion. */
export const MIN_POLICY_TRADES = 30;
/**
 * Choix OBJECTIF de la règle d'annulation, par catégorie, sur les trades backtestés (coûts déduits)
 * de TOUS les marchés. Le challenger 'keep' ne remplace le champion 'tp1' que s'il est meilleur sur
 * TOUS ces critères :
 * - échantillon ≥ MIN_POLICY_TRADES (en dessous, la différence est du bruit) ;
 * - plus de pips au total ET espérance (R moyen) positive ;
 * - profit factor ≥ 1,2 et ≥ celui du champion (quand le champion a un échantillon suffisant) ;
 * - drawdown relatif (pips / drawdown max) au moins aussi bon que le champion ;
 * - toujours meilleur (pips) sur la moitié la plus RÉCENTE de l'historique.
 * Sinon le champion 'tp1' (plus prudent) reste en vigueur.
 */
export function choosePolicies(rawResults) {
  const all = { tp1: [], keep: [] };
  for (const r of rawResults) for (const p of CANCEL_POLICIES) all[p].push(...(r.byPolicy?.[p] || []));
  const policy = {}, stats = {};
  for (const cat of POLICY_CATS) {
    const A = all.tp1.filter((x) => x.cat === cat), B = all.keep.filter((x) => x.cat === cat);
    const sa = tradeStats(A), sb = tradeStats(B);
    const times = [...A, ...B].map((x) => x.t).sort((a, b) => a - b);
    const cut = times.length ? times[Math.floor(times.length / 2)] : 0;
    const ra = tradeStats(A.filter((x) => x.t >= cut)), rb = tradeStats(B.filter((x) => x.t >= cut));
    const champEnough = sa.n >= MIN_POLICY_TRADES;
    const recov = (s) => (s.maxDD > 0 ? s.pips / s.maxDD : (s.pips > 0 ? Infinity : 0));
    const checks = {
      echantillon: sb.n >= MIN_POLICY_TRADES,
      gains: sb.pips > sa.pips && (sb.expR ?? 0) > 0,
      profitFactor: (sb.pf ?? 0) >= 1.2 && (!champEnough || (sb.pf ?? 0) >= (sa.pf ?? 0)),
      risque: !champEnough || recov(sb) >= recov(sa),
      recent: rb.pips > 0 && rb.pips >= ra.pips,
    };
    const adopt = Object.values(checks).every(Boolean);
    policy[cat] = adopt ? 'keep' : 'tp1';
    stats[cat] = { champion: sa, challenger: sb, recent: { champion: ra, challenger: rb }, checks, adopted: policy[cat] };
  }
  return { policy, stats };
}

/**
 * Classe une liste de résultats : échantillon suffisant d'abord, triés par borne basse de
 * l'intervalle de confiance de l'espérance en R (le résultat le plus SOLIDE, pas le plus chanceux),
 * puis espérance en R, puis pips ; les marchés « insuffisants » ensuite. Les pips ne sont pas
 * comparables d'un marché à l'autre : le R l'est. Classement informatif uniquement.
 */
export function rankMarkets(results) {
  const byGroup = (r) => (r.insufficient ? 1 : 0);
  const lo = (r) => (r.ciR?.[0] ?? -Infinity);
  return [...results].sort((a, b) => byGroup(a) - byGroup(b)
    || lo(b) - lo(a)
    || (b.expectancyR ?? -Infinity) - (a.expectancyR ?? -Infinity)
    || (b.pips ?? 0) - (a.pips ?? 0)
    || (b.winRate ?? -1) - (a.winRate ?? -1));
}
