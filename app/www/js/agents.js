/**
 * Les cinq agents du projet, en version déterministe (sans IA).
 * Même rôles et même ordre que TRADING_RULES_MASTER_PROMPT.md :
 *   1. Collecteur (candle-by-candle-reporter)
 *   2. Scanner (historical-candle-scanner)
 *   3. Calendrier économique (economic-calendar-agent)
 *   4. Historique des trades (history-agent-trades) : journal + apprentissage
 *   5. Auditeur (ultimate-trader) : revérifie chaque zone indépendamment et rend le verdict
 * Chaque agent produit un rapport horodaté avec un statut COMPLET / PARTIEL / ÉCHEC.
 */
import { detectZones, annotateHtf, TIMEFRAMES, TF_LABEL, TF_SECONDS, STATUS, normalizeCandles, CATEGORIES } from './engine.js';
import { simulateZone, planFor, advance, finalize, suggestedLot, POS, DEFAULT_RISK } from './trades.js';
import { featuresOf, buildModel, scoreZone, reviewRules, passesActive } from './learning.js';
import { marketById, marketOf, marketRisk, MARKETS, DEFAULT_MARKET } from './markets.js';
import { summarize, randomBenchmark, combineBenchmarks, benchmarkLabel } from './stats.js';
import { passesStrategy } from './ranking.js';
import { detectSmcSetups, watchedPois } from './smc.js';
import { annotateTopdown, structureMarks } from './topdown.js';
import { macroState, macroAlignment } from './macro.js';

/** Nombre maximal d'OB 5★ déjà touchés affichés par UT sur le graphique (les vierges le sont tous). */
const OB5_LAYER_PAST = 12;

/**
 * Couche « OB 5★ » (trading_agent_order_blocks.md) affichée sur le graphique quelle que soit la
 * stratégie : OB notés 5★ à leur détection, tendance validée, UT supérieure alignée, annotés de
 * leur fiabilité top-down (topdown.js). Les zones vierges sont toutes gardées ; pour les autres,
 * seules les plus récentes (historique visuel).
 */
export function ob5Layer({ candles, wantedTfs, currentPrice, opts, risk, nowT, zones = null }) {
  let zs = zones;
  if (!zs) {
    zs = [];
    for (const tf of wantedTfs) {
      if (!candles[tf]?.length) continue;
      zs = zs.concat(detectZones(candles[tf], { ...opts, timeframe: tf, currentPrice, marketId: opts.marketId }).zones);
    }
    annotateHtf(zs, candles, opts);
  }
  const strat = { htfFilter: risk?.htfFilter, sessions: risk?.sessions };
  const five = zs.filter((z) => passesStrategy(z, strat));
  annotateTopdown(five, candles, nowT);
  const out = [];
  for (const tf of wantedTfs) {
    const ofTf = five.filter((z) => z.timeframe === tf).sort((a, b) => b.c1Time - a.c1Time);
    out.push(...ofTf.filter((z) => z.viable), ...ofTf.filter((z) => !z.viable).slice(0, OB5_LAYER_PAST));
  }
  return out;
}

const MAX_CONFIG_HISTORY = 50;
const MIN_FORWARD_TRADES = 8;

const STATUS_OK = 'COMPLET', STATUS_PART = 'PARTIEL', STATUS_KO = 'ÉCHEC';
const MAX_PENDING_SEC = { scalping: 86400, day: 5 * 86400, swing: 30 * 86400 };

/**
 * Fusionne le calendrier embarqué (US, fort impact, dans history/economic-calendar-2026.md) avec
 * les annonces MAJEURES en direct de TradingView (US/EU/CN/JP, app/newsfeed.js) : dédupliquées par
 * minute + pays + titre, l'annonce en direct prime sur l'entrée embarquée en cas de doublon.
 */
export function mergeCalendarNews(cal, newsEvents) {
  const embedded = (cal?.events || []).map((e) => ({ t: e.t, title: e.title, country: 'US', source: 'embarqué' }));
  // impact moyen (major === false) : contexte macro seulement, jamais de blackout
  const live = (newsEvents || []).filter((e) => e && Number.isFinite(e.t) && e.country && e.major !== false).map((e) => ({ t: e.t, title: e.title, country: e.country, source: 'direct' }));
  const key = (e) => `${Math.floor(e.t / 60)}|${e.country}|${e.title}`;
  const byKey = new Map();
  for (const e of embedded) byKey.set(key(e), e);
  for (const e of live) byKey.set(key(e), e); // le direct prime sur l'embarqué en cas de doublon
  const events = [...byKey.values()].sort((a, b) => a.t - b.t);
  const counts = {};
  for (const e of events) counts[e.country] = (counts[e.country] || 0) + 1;
  return { events, counts, embeddedCount: embedded.length, liveCount: live.length };
}

// ── Calendrier ─────────────────────────────────────────────────────────────
/**
 * @param {string[]|null} countries  filtre le calendrier aux pays du marché analysé (blackout
 *   par marché, §7) ; `null`/omis = pas de filtre (compatibilité mono-marché XAUUSD, où toutes
 *   les annonces embarquées sont déjà US).
 */
export function makeCalendar(cal, blackoutMin, newsEvents = [], countries = null) {
  const merge = mergeCalendarNews(cal, newsEvents);
  const events = countries ? merge.events.filter((e) => countries.includes(e.country)) : merge.events;
  const ev = events.map((e) => e.t).sort((a, b) => a - b);
  const near = (t, min) => {
    let lo = 0, hi = ev.length;
    while (lo < hi) { const m = (lo + hi) >> 1; if (ev[m] < t - min * 60) lo = m + 1; else hi = m; }
    return lo < ev.length && ev[lo] <= t + min * 60;
  };
  return {
    events,
    isBlackout: (t) => blackoutMin > 0 && near(t, blackoutMin),
    hasNewsNear: (t, min) => near(t, min),
    next: (t) => events.find((e) => e.t >= t) || null,
    lastTime: ev.at(-1) ?? null,
    sources: merge,
  };
}

// ── 1. Collecteur ──────────────────────────────────────────────────────────
function isWeekendGap(a, b) {
  // marché de l'or fermé du vendredi ~21h UTC au dimanche ~22h UTC
  const da = new Date(a * 1000), db = new Date(b * 1000);
  return (da.getUTCDay() === 5 && da.getUTCHours() >= 20) || da.getUTCDay() === 6 || (db.getUTCDay() === 0) || (db.getUTCDay() === 1 && db.getUTCHours() < 1);
}

export function agentCollector({ candles, symbol, wantedTfs, now, market }) {
  const lines = [], perTf = {};
  let status = STATUS_OK;
  const mkt = market || marketById(DEFAULT_MARKET);
  // Verrou de symbole obligatoire : seul le marché whitelisté demandé peut être analysé.
  if (symbol && marketOf(symbol)?.id !== mkt.id) {
    return { agent: 'Collecteur', role: 'candle-by-candle-reporter', at: now, status: STATUS_KO, lines: [`Symbole ${symbol} ≠ ${mkt.label} (${mkt.tv}) : analyse bloquée.`], perTf };
  }
  for (const tf of wantedTfs) {
    const c = candles[tf];
    if (!c || !c.length) { perTf[tf] = { ok: false }; lines.push(`${TF_LABEL[tf]} : INDISPONIBLE`); status = STATUS_PART; continue; }
    const step = TF_SECONDS[tf];
    let gaps = 0;
    if (!['D', 'W', 'M', '12M'].includes(tf)) for (let i = 1; i < c.length; i++) if (c[i].time - c[i - 1].time > step * 3 && !isWeekendGap(c[i - 1].time, c[i].time)) gaps++;
    const live = c.at(-1).complete === false;
    const stale = now / 1000 - c.at(-1).time > Math.max(step * 3, 3600) && !isWeekendGap(c.at(-1).time, now / 1000);
    perTf[tf] = { ok: c.length >= 30 && !stale, n: c.length, from: c[0].time, to: c.at(-1).time, gaps, live, stale };
    if (!perTf[tf].ok) status = STATUS_PART;
    lines.push(`${TF_LABEL[tf]} : ${c.length} bougies, ${fmtDate(c[0].time)} → ${fmtDate(c.at(-1).time)}${gaps ? `, ${gaps} trou(s)` : ''}${live ? ', bougie en cours exclue des motifs' : ''}${stale ? ', DONNÉES ANCIENNES' : ''}`);
  }
  if (!Object.values(perTf).some((x) => x.ok)) status = STATUS_KO;
  return { agent: 'Collecteur', role: 'candle-by-candle-reporter', at: now, status, lines, perTf };
}

// ── 2. Scanner ────────────────────────────────────────────────────────────
export function agentScanner({ candles, wantedTfs, currentPrice, opts, now }) {
  if (opts.strategyMode === 'smc') return agentScannerSmc({ candles, currentPrice, opts, now });
  let zones = [];
  const lines = [];
  const rej = { liquidite: 0, imbalance: 0, egalite: 0 };
  for (const tf of wantedTfs) {
    if (!candles[tf]?.length) continue;
    const r = detectZones(candles[tf], { ...opts, timeframe: tf, currentPrice, marketId: opts.marketId });
    zones = zones.concat(r.zones);
    for (const k in rej) rej[k] += r.stats.rejected[k];
    lines.push(`${TF_LABEL[tf]} : ${r.stats.candidates} candidats → ${r.zones.length} zones (${r.zones.filter((z) => z.viable).length} viables)`);
  }
  // tendance de fond (UT supérieure) connue à la clôture de C3
  annotateHtf(zones, candles, opts);
  lines.push(`Rejets : liquidité non prouvée ${rej.liquidite}, imbalance absente ${rej.imbalance}, égalité ${rej.egalite}`);
  return { report: { agent: 'Scanner', role: 'historical-candle-scanner', at: now, status: zones.length || lines.length ? STATUS_OK : STATUS_PART, lines }, zones };
}

/** Scanner de la stratégie Smart Money HTF → LTF (smc.js). */
function agentScannerSmc({ candles, currentPrice, opts, now }) {
  const r = detectSmcSetups(candles, { marketId: opts.marketId, currentPrice, smc: opts.smc });
  const f = r.funnel;
  const lines = [
    `POI HTF (1D/1W/1Mo) : ${f.pois} détectés · ${f.touched} atteints par le prix`,
    `Dans le sens du biais HTF : ${f.biasOk} · en Discount/Premium (Fibonacci 0,5) : ${f.fibOk}`,
    `CHoCH/MSS en 15m/5m : ${f.choch} · micro-FVG/OB en Discount/Premium LTF : ${f.micro}`,
    `Setups : ${f.setups} (R:R ≥ 1:3 : ${f.rrOk}, rejetés pour R:R < 1:3 : ${f.rejectedRR})`,
  ];
  const watch = watchedPois(r.pois, currentPrice ?? 0, 6);
  if (watch.length) lines.push(`POI non mitigés à surveiller : ${watch.map((p) => `${p.kind} ${TF_LABEL[p.tf]} ${p.dir === 'BUY' ? 'achat' : 'vente'} ${p.low}–${p.high}`).join(' · ')}`);
  return { report: { agent: 'Scanner', role: 'historical-candle-scanner', at: now, status: STATUS_OK, lines }, zones: r.setups, pois: r.pois, watch, funnel: f };
}

// ── 3. Calendrier ─────────────────────────────────────────────────────────
export function agentCalendar({ cal, calendar, now }) {
  const t = now / 1000;
  const lines = [];
  let status = STATUS_OK;
  if (!cal || !cal.events?.length) {
    return { agent: 'Calendrier économique', role: 'economic-calendar-agent', at: now, status: STATUS_KO, lines: ['Calendrier 2026 absent : filtre macro inactif.'] };
  }
  const ageDays = cal.syncedAt ? (now - Date.parse(cal.syncedAt)) / 86400000 : Infinity;
  lines.push(`${cal.events.length} annonces USD à fort impact · synchronisé le ${cal.syncedAt ? new Date(cal.syncedAt).toLocaleDateString('fr-FR') : '?'}`);
  if (ageDays > 14) { status = STATUS_PART; lines.push(`Synchronisation vieille de ${Math.floor(ageDays)} jours : relancer npm run calendar:sync puis calendar:build.`); }
  if (calendar.lastTime && calendar.lastTime < t) { status = STATUS_PART; lines.push('Aucune annonce connue après aujourd\'hui : calendrier à resynchroniser.'); }
  const nx = calendar.next(t);
  if (nx) lines.push(`Prochaine : ${nx.title}, ${new Date(nx.t * 1000).toLocaleString('fr-FR', { weekday: 'short', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}`);
  if (calendar.isBlackout(t)) lines.push('⚠ Fenêtre d\'annonce en cours : aucune nouvelle entrée.');
  const src = calendar.sources;
  if (src) lines.push(`Source : calendrier embarqué (${src.embeddedCount}) + TradingView en direct (${src.liveCount}) · ${Object.entries(src.counts).map(([c, n]) => `${c} ${n}`).join(', ') || 'aucune annonce en direct'}`);
  return { agent: 'Calendrier économique', role: 'economic-calendar-agent', at: now, status, lines, blackoutNow: calendar.isBlackout(t) };
}

const fmtPips2 = (v) => `${v >= 0 ? '+' : ''}${Math.round(v)}`;

// ── Amélioration continue (champion / challenger sur les règles apprises, déterministe, sans IA) ──
/** Performance (n, pips/trade) des trades clôturés du backtest, filtrés par un ensemble de règles actives. */
function summarizeUnderRules(backtest, rules, calendar, marketId) {
  const activeSet = new Set(rules);
  let n = 0, pips = 0;
  for (const { zone, pos } of backtest) {
    if (pos.state !== POS.TP && pos.state !== POS.SL) continue;
    if (activeSet.size && !passesActive(featuresOf(zone, calendar, marketId), activeSet)) continue;
    n++; pips += pos.pips ?? 0;
  }
  return { n, pipsPerTrade: n ? round(pips / n) : null };
}

/** Idem, restreint aux zones détectées après l'adoption d'une configuration (contrôle « avancé »). */
function forwardUnderConfig(backtest, config, calendar, marketId) {
  const activeSet = new Set(config.rules);
  let n = 0, pips = 0;
  for (const { zone, pos } of backtest) {
    if (pos.state !== POS.TP && pos.state !== POS.SL) continue;
    if (!(zone.c3Time > config.adoptedAt)) continue;
    if (activeSet.size && !passesActive(featuresOf(zone, calendar, marketId), activeSet)) continue;
    n++; pips += pos.pips ?? 0;
  }
  return { n, pipsPerTrade: n ? round(pips / n) : null };
}

function pushConfigHistory(learnStore, entry) {
  learnStore.configHistory ||= [];
  learnStore.configHistory.push(entry);
  if (learnStore.configHistory.length > MAX_CONFIG_HISTORY) learnStore.configHistory.splice(0, learnStore.configHistory.length - MAX_CONFIG_HISTORY);
}

/**
 * Garantie d'amélioration dans le temps (USER REQUIREMENT 3), désormais restreinte aux
 * règles apprises (le profil d'objectifs n'existe plus : TP1/TP2/TP3 sont des distances fixes) :
 * - toute adoption de règle fait avancer la version de learnStore.config et archive
 *   l'ancienne configuration dans learnStore.configHistory (borné à 50 entrées) ;
 * - si la configuration n'a pas changé, on vérifie la performance « avancée » (trades clôturés
 *   des zones détectées après l'adoption) : si elle est pire que celle validée par la
 *   configuration précédente (≥ 8 trades), on revient en arrière et on réaligne la mémoire ;
 * - anti ping-pong : les règles ainsi rejetées sont mises en QUARANTAINE (learnStore.quarantine,
 *   7 jours) pour qu'elles ne soient pas immédiatement réadoptées par reviewRules, même si
 *   l'échantillon complet leur semble encore favorable.
 */
const QUARANTINE_DAYS = 7;
export function applyContinuousImprovement(learnStore, { ruleDecisions = [], backtest, calendar, now, marketId }) {
  const nowSec = Math.floor(now / 1000);
  const cfg = learnStore.config;
  const rules = (learnStore.acceptedRules || []).filter((k) => !(learnStore.disabled || []).includes(k));
  const rulesChanged = !cfg || JSON.stringify([...(cfg.rules || [])].sort()) !== JSON.stringify([...rules].sort());

  const changeLines = [];
  const prevRules = new Set(cfg?.rules || []);
  for (const k of rules) if (!prevRules.has(k)) changeLines.push(`règle acceptée : ${k}`);
  for (const k of prevRules) if (!rules.includes(k)) changeLines.push(`règle retirée : ${k}`);

  let rollback = null;
  if (!cfg || rulesChanged) {
    if (cfg) pushConfigHistory(learnStore, { version: cfg.version, at: nowSec, change: changeLines.join(' ; ') || 'ajustement', decision: 'adopté', reason: changeLines.join(' ; ') || 'règles mises à jour', rules: cfg.rules, adoptedAt: cfg.adoptedAt, validation: cfg.validation });
    const validation = summarizeUnderRules(backtest, rules, calendar, marketId);
    learnStore.config = { version: (cfg?.version ?? 0) + 1, rules, adoptedAt: nowSec, validation };
  } else {
    const prevSnapshot = learnStore.configHistory?.at(-1);
    if (prevSnapshot?.validation?.pipsPerTrade != null) {
      const fwd = forwardUnderConfig(backtest, cfg, calendar, marketId);
      if (fwd.n >= MIN_FORWARD_TRADES && fwd.pipsPerTrade < prevSnapshot.validation.pipsPerTrade) {
        pushConfigHistory(learnStore, { version: cfg.version, at: nowSec, change: 'retour arrière', decision: 'retour arrière',
          reason: `performance avancée ${fmtPips2(fwd.pipsPerTrade)} pips/trade (${fwd.n} trades) < ${fmtPips2(prevSnapshot.validation.pipsPerTrade)} pips/trade de la configuration précédente`,
          rules: cfg.rules, adoptedAt: cfg.adoptedAt, validation: cfg.validation });
        learnStore.config = { version: cfg.version + 1, rules: prevSnapshot.rules, adoptedAt: nowSec, validation: prevSnapshot.validation };
        learnStore.acceptedRules = [...prevSnapshot.rules];
        // quarantaine (7 jours) des règles qui viennent d'échouer, pour éviter un ping-pong
        // avec la configuration suivante qui les trouverait de nouveau meilleures en échantillon complet
        const until = nowSec + QUARANTINE_DAYS * 86400;
        learnStore.quarantine ||= { rules: {} };
        learnStore.quarantine.rules ||= {};
        for (const k of cfg.rules || []) if (!(prevSnapshot.rules || []).includes(k)) learnStore.quarantine.rules[k] = until;
        rollback = { pipsPerTrade: fwd.pipsPerTrade, n: fwd.n, prevPipsPerTrade: prevSnapshot.validation.pipsPerTrade, until };
      }
    }
  }
  return { config: learnStore.config, rollback };
}

/** Lignes de rapport (agent Historique) résumant les décisions champion / challenger de l'analyse. */
function continuousImprovementLines(ci, ruleDecisions) {
  const lines = [`Configuration v${ci.config.version} (adoptée le ${fmtDate(ci.config.adoptedAt * 1000)})`];
  for (const d of ruleDecisions) lines.push(`Règle « ${d.key} » : ${d.decision} — ${d.reason}`);
  if (ci.rollback) lines.push(`⚠ Retour arrière : performance avancée ${fmtPips2(ci.rollback.pipsPerTrade)} pips/trade (${ci.rollback.n} trades) < ${fmtPips2(ci.rollback.prevPipsPerTrade)} de la configuration précédente.`);
  return lines;
}

// ── 4. Historique (journal + apprentissage) ───────────────────────────────
export function agentHistory({ zones, candles, risk, calendar, learnStore, journal, learnParams, currentPrice, now, marketId }) {
  const m1 = candles['1'] || null;
  // backtest : TOUTES les zones détectées par le scanner (pas seulement les 5★ valides),
  // sans filtre d'apprentissage (pas de boucle de rétroaction) — les échantillons d'apprentissage
  // proviennent donc de l'ensemble des zones détectées, pas uniquement des zones validées 5★
  // Les échantillons d'apprentissage ne proviennent QUE des zones que la stratégie aurait réellement
  // proposées (5★ à la détection, tendance, UT supérieure, stop valide) : on apprend sur la même
  // population que celle que l'on trade.
  const backtest = [];
  const strat = { htfFilter: risk.htfFilter, sessions: risk.sessions };
  for (const z of zones) {
    const pos = simulateZone(z, candles[z.timeframe], risk, { m1, isBlackout: calendar.isBlackout, currentPrice });
    const eligible = passesStrategy(z, strat) && planFor(z, risk).slOk;
    backtest.push({ zone: z, pos, eligible });
    if (eligible && (pos.state === POS.TP || pos.state === POS.SL) && pos.r != null) {
      learnStore.samples[z.id] = { features: featuresOf(z, calendar, marketId), r: round(pos.r), source: learnStore.samples[z.id]?.source === 'reel' ? 'reel' : 'backtest', t: pos.exitTime };
    }
  }
  for (const j of journal.entries) {
    if (j.followed && (j.state === POS.TP || j.state === POS.SL) && j.features && j.r != null) learnStore.samples[j.id] = { features: j.features, r: round(j.r), source: 'reel', t: j.exitTime };
  }
  pruneSamples(learnStore, 5000);
  const allSamples = Object.values(learnStore.samples);
  learnStore.acceptedRules ||= [];
  // règles candidates au regard des échantillons actuels (statistiquement significatives, cf. buildModel)
  const candidateModel = buildModel(allSamples, { ...learnParams, disabled: learnStore.disabled || [], accepted: learnStore.acceptedRules });
  // champion / challenger : une règle candidate n'est acceptée que si elle prouve une amélioration
  // sur l'échantillon complet ET sur sa moitié la plus récente (garde-fou hors-échantillon)
  const review = reviewRules(allSamples, candidateModel.rules, learnStore.acceptedRules, learnStore.disabled || [], learnStore.quarantine?.rules || {}, Math.floor(now / 1000));
  learnStore.acceptedRules = review.accepted;
  const model = buildModel(allSamples, { ...learnParams, disabled: learnStore.disabled || [], accepted: learnStore.acceptedRules });
  model.ruleDecisions = review.decisions;
  // progression : une trace par analyse, pour mesurer si l'application devient meilleure
  learnStore.history ||= [];
  const last = learnStore.history.at(-1);
  if (!last || last.n !== model.n || last.rules !== model.rules.length) {
    learnStore.history.push({ t: now, n: model.n, rules: model.rules.filter((r) => r.active).length, winBefore: model.before.winRate, winAfter: model.after.winRate, rBefore: model.before.meanR, rAfter: model.after.meanR });
    if (learnStore.history.length > 300) learnStore.history.splice(0, learnStore.history.length - 300);
  }
  model.history = learnStore.history;
  // performance HONNÊTE de la stratégie (zones éligibles, coûts déduits) + test contre le hasard
  const perf = strategyPerformance(backtest, candles, risk);
  model.performance = perf;
  const lines = [
    `Stratégie (backtest, coûts ${fmtNum(risk.costPips)} pips déduits) : ${perf.stats.n} trades · ${perf.stats.meanR == null ? '—' : fmtR(perf.stats.meanR)}/trade${perf.stats.ciR ? ` (IC 90 % ${fmtR(perf.stats.ciR[0])} à ${fmtR(perf.stats.ciR[1])})` : ''} · drawdown max ${fmtR(-perf.stats.maxDrawdownR)}`,
    perf.stats.verdict.label,
    perf.randomLabel,
    `${model.n} positions apprises (${model.real.n} réelles, ${model.n - model.real.n} backtest, toutes zones détectées)`,
    model.before.n ? `Avant règles : ${pct(model.before.winRate)} de réussite, ${fmtR(model.before.meanR)} par trade` : 'Pas encore de position clôturée à apprendre.',
    model.after.n && model.rules.some((r) => r.active) ? `Avec les règles actives : ${pct(model.after.winRate)}, ${fmtR(model.after.meanR)} par trade (${model.after.n} trades)` : null,
    `${model.rules.filter((r) => r.active).length} règle(s) de prévention active(s), dont ${model.rules.filter((r) => r.active && r.combo).length} sur des combinaisons`,
    `Journal réel : ${journal.entries.filter((j) => j.followed).length} position(s) suivie(s) par toi`,
    model.n < 20 ? `PARTIEL : seulement ${model.n} trades clôturés appris (20 nécessaires). Fais défiler TradingView vers le passé pour charger plus d'historique.` : null,
  ].filter(Boolean);
  return { report: { agent: 'Historique des trades', role: 'history-agent-trades', at: now, status: model.n >= 20 ? STATUS_OK : STATUS_PART, lines }, backtest, model };
}

// ── 5. Auditeur ───────────────────────────────────────────────────────────
/** Revérification indépendante à partir des OHLC bruts (code distinct du scanner). */
function reverify(z, tfCandles, lookback) {
  const errs = [];
  const idx = z.c3Index;
  const [P, C1, , C3] = [tfCandles[idx - 3], tfCandles[idx - 2], tfCandles[idx - 1], tfCandles[idx]];
  if (!P || !C3 || C1.time !== z.c1Time) return ['séquence P/C1/C2/C3 introuvable'];
  const buy = z.direction === 'BUY';
  if (buy ? !(C1.close < C1.open && C3.close > C3.open) : !(C1.close > C1.open && C3.close < C3.open)) errs.push('order block non établi');
  const prior = tfCandles.slice(idx - 3 - lookback, idx - 3);
  if (prior.length < lookback) errs.push('historique insuffisant avant P');
  const lvl = buy ? Math.min(...prior.map((c) => c.low)) : Math.max(...prior.map((c) => c.high));
  if (buy ? !(P.low < lvl && P.close > lvl) : !(P.high > lvl && P.close < lvl)) errs.push('liquidité non prouvée');
  if (buy ? !(C1.high < C3.low) : !(C1.low > C3.high)) errs.push('imbalance absente');
  for (let j = idx + 1; j < tfCandles.length; j++) {
    const L = tfCandles[j];
    if (L.high >= C1.low && L.low <= C1.high) { errs.push('retest détecté'); break; }
  }
  return errs;
}

export function agentAuditor({ backtest, candles, collector, calReport, calendar, model, risk, opts, now, marketId }) {
  const audited = [];
  const counts = { validees: 0, rejetees: 0, nonVerifiables: 0, filtrees: 0, refusees: 0, etoiles: 0 };
  const t = now / 1000;
  for (const { zone: z, pos } of backtest) {
    const reasons = [];
    let verdict = 'VALIDÉE';
    if (!collector.perTf[z.timeframe]?.ok) { verdict = 'NON VÉRIFIABLE'; reasons.push('données de la timeframe partielles'); }
    const tfC = normalizeCandles(candles[z.timeframe]);
    const errs = z.viable && !z.smc ? reverify(z, tfC, opts.liquidityLookback) : [];
    if (errs.length) { verdict = 'REJETÉE'; reasons.push(...errs.map((e) => `désaccord scanner/auditeur : ${e}`)); }
    const feats = featuresOf(z, calendar, marketId);
    const sc = scoreZone(model, feats);
    let proposal = null;
    if (z.viable && verdict === 'VALIDÉE') {
      const plan = planFor(z, risk);
      const minStars = 5; // seules les zones 5★ sont proposées ; moins de 5★ = REFUSEE (non validée)
      if (z.smc) {
        // stratégie SMC : POI HTF + Fibonacci + CHoCH + micro-zone sont garantis par la détection ;
        // restent le R:R ≥ 1:3, le coût, les séances, les règles apprises et les annonces
        if (!plan.slOk) { proposal = 'REFUSEE'; reasons.push(plan.reason); counts.refusees++; }
        else if (Array.isArray(risk.sessions) && risk.sessions.length && z.session && !risk.sessions.includes(z.session)) { proposal = 'REFUSEE'; reasons.push(`Séance ${z.session} exclue par tes réglages`); }
        else if (sc.blockedBy.length) { proposal = 'FILTREE'; reasons.push(...sc.blockedBy.map((b) => `règle apprise : ${b}`)); counts.filtrees++; }
        else if (calendar.isBlackout(t)) { proposal = 'SUSPENDUE'; reasons.push('annonce macro à fort impact imminente'); }
        else proposal = 'PROPOSEE';
      } else if (z.stars && !z.stars.trend) {
        proposal = 'REFUSEE'; counts.etoiles++;
        reasons.push(z.trend.ranging ? `⭐2 : marché en range (${z.trend.flips} changements de Supertrend)` : `⭐2 : OB contre la tendance (Supertrend ${z.trend.supertrend})`);
      } else if (z.grade != null && z.grade < minStars) {
        proposal = 'REFUSEE'; counts.etoiles++;
        const miss = [!z.stars.liquidity && '⭐3 liquidité proche au-delà de l\'OB', !z.stars.fib && `⭐5 OB en ${z.fib.zone === 'PREMIUM' ? 'Premium' : 'Discount'}`].filter(Boolean);
        reasons.push(`${z.grade}★ < ${minStars}★ exigées (${miss.join(', ')})`);
      } else if (risk.htfFilter !== false && z.htf?.aligned === false) {
        proposal = 'REFUSEE'; counts.etoiles++;
        reasons.push(`Contre la tendance de fond (${TF_LABEL[z.htf.tf]} ${z.htf.dir === 1 ? 'haussière' : 'baissière'})`);
      } else if (Array.isArray(risk.sessions) && risk.sessions.length && z.session && !risk.sessions.includes(z.session)) {
        proposal = 'REFUSEE'; reasons.push(`Séance ${z.session} exclue par tes réglages`);
      } else if (!plan.slOk) { proposal = 'REFUSEE'; reasons.push(plan.reason); counts.refusees++; }
      else if (sc.blockedBy.length) { proposal = 'FILTREE'; reasons.push(...sc.blockedBy.map((b) => `règle apprise : ${b}`)); counts.filtrees++; }
      else if (calendar.isBlackout(t)) { proposal = 'SUSPENDUE'; reasons.push('annonce macro à fort impact imminente'); }
      else proposal = 'PROPOSEE';
    }
    if (verdict === 'VALIDÉE') counts.validees++; else if (verdict === 'REJETÉE') counts.rejetees++; else counts.nonVerifiables++;
    const fullPlan = planFor(z, risk);
    audited.push({ ...z, pos, verdict, reasons, proposal, features: feats, score: sc, plan: fullPlan, market: marketId,
      lotSuggested: suggestedLot(fullPlan.slPips, risk, risk.eurUsdManual) });
  }
  // confluence multi-timeframe : même sens, zones qui se chevauchent sur d'autres UT
  for (const a of audited) {
    if (!a.viable) continue;
    a.confluence = audited.filter((b) => b !== a && b.viable && b.timeframe !== a.timeframe && b.direction === a.direction && b.zoneLow <= a.zoneHigh && b.zoneHigh >= a.zoneLow).map((b) => b.timeframe);
    a.confluence = [...new Set(a.confluence)];
  }
  const proposed = audited.filter((a) => a.proposal === 'PROPOSEE').length;
  const blocked = collector.status === STATUS_KO;
  const lines = [
    blocked ? 'Verdict impossible : collecte en échec.' : `${proposed} position(s) proposée(s) sur ${audited.filter((a) => a.viable).length} zone(s) viable(s)`,
    `Validées ${counts.validees} · rejetées ${counts.rejetees} · non vérifiables ${counts.nonVerifiables}`,
    `Sous le standard 5 étoiles (tendance, range ou < 5★) ${counts.etoiles} · SL > 100 pips (zone non viable) ${counts.refusees} · filtrées par l'apprentissage ${counts.filtrees}`,
    calReport.status !== STATUS_OK ? 'Calendrier incomplet : validation macro partielle.' : null,
    proposed ? null : 'Aucune opportunité valide pour le moment.',
  ].filter(Boolean);
  const status = blocked ? STATUS_KO : collector.status === STATUS_OK && calReport.status === STATUS_OK ? STATUS_OK : STATUS_PART;
  return { report: { agent: 'Auditeur', role: 'ultimate-trader', at: now, status, lines }, audited };
}

// ── Journal réel : seules les positions dont le prix a ATTEINT l'ordre comptent ──
/**
 * Événements à notifier entre deux états d'une position :
 * fill (entrée déclenchée), tp1, tp2, tp3, be (stop déplacé au point mort : TP1 + 1R atteints),
 * trail (stop resserré sur un nouveau swing structurel), closeProfit (clôture en gain après
 * BE/trailing), sl, cancel.
 */
export function transitions(beforeState, beforeHits, p, beforeBeDone = false, beforeTrailFrom = null) {
  const out = [];
  if (beforeState === POS.PENDING && p.state !== POS.PENDING && p.state !== POS.CANCELLED && p.state !== POS.REFUSED) out.push('fill');
  // SMC : 2 objectifs seulement (TP2 = objectif final, notifié par 'tp3')
  for (let k = beforeHits + 1; k <= Math.min(p.strategy === 'smc' ? 1 : 2, p.hits || 0); k++) out.push(`tp${k}`);
  if (!beforeBeDone && p.beDone) out.push('be');
  else if (beforeBeDone && p.trailFrom != null && p.trailFrom !== beforeTrailFrom) out.push('trail');
  if (p.state !== beforeState || (p.hits || 0) !== beforeHits) {
    if (p.state === POS.TP) out.push((p.hits || 0) >= 3 ? 'tp3' : 'closeProfit');
    else if (p.state === POS.SL) out.push('sl');
    else if (p.state === POS.CANCELLED && beforeState !== POS.CANCELLED) out.push('cancel');
  }
  return out;
}

/** Base de temps du suivi réel : 1m si disponible, sinon la plus fine chargée. */
function baseCandles(candles) {
  return candles['1']?.length ? candles['1'] : candles[['5', '15', '60', '240', 'D'].find((tf) => candles[tf]?.length)];
}

function journalEntry(a, risk, now, liveTime, extra = {}) {
  return {
    id: a.id, dir: a.direction, timeframe: a.timeframe, category: a.category,
    zoneLow: a.zoneLow, zoneHigh: a.zoneHigh, c1Time: a.c1Time,
    entry: a.plan.entry, sl: a.plan.sl, tp1: a.plan.tp1, tp2: a.plan.tp2, tp3: a.plan.tp3, tp: a.plan.tp3,
    rr: a.plan.rr, slPips: a.plan.slPips, tp1Pips: a.plan.tp1Pips, hits: 0, hitTimes: [],
    riskPx: a.plan.riskPx, entryMode: a.plan.entryMode, inZone: false, grade: a.grade, stars: a.stars,
    cancelPolicy: a.plan.cancelPolicy || 'tp1', bornTime: a.c3Time ?? null, maxPendingSec: a.pos?.maxPendingSec ?? null,
    lot: risk.lot, pipSize: risk.pipSize, contractSize: risk.contractSize, market: a.market,
    quote: risk.quote, quotePrice: risk.quotePrice, costPips: a.plan.costPips ?? risk.costPips ?? 0, maxSlPips: a.plan.maxSlPips,
    tp1Pips: a.plan.tp1Pips, tp2Pips: a.plan.tp2Pips, tp3Pips: a.plan.tp3Pips, corrGroup: risk.corrGroup,
    ...(a.plan.legs ? { legs: a.plan.legs, beAtTp1: !!a.plan.beAtTp1, noTrail: !!a.plan.noTrail, expiresAt: a.plan.expiresAt ?? null, strategy: a.plan.strategy, smc: a.smc } : {}),
    features: a.features, state: POS.PENDING, createdAt: Math.floor(now / 1000), lastTime: liveTime,
    followed: true, ...extra,
  };
}

/**
 * L'utilisateur indique qu'il a suivi (pris) la zone.
 * - ordre encore en attente : suivi à partir de maintenant ;
 * - prix déjà arrivé sur l'ordre (position ouverte ou clôturée dans le backtest) :
 *   on reprend l'exécution simulée, puisque l'utilisateur déclare avoir pris ce trade.
 */
export function followZone(journal, a, { risk, candles, now = Date.now() }) {
  if (!a?.plan || journal.entries.some((j) => j.id === a.id && j.followed)) return null;
  journal.entries = journal.entries.filter((j) => j.id !== a.id); // ancienne entrée non suivie
  const base = baseCandles(candles || {});
  const liveTime = base?.length ? (base.findLast((c) => c.complete !== false) || base.at(-1)).time : Math.floor(now / 1000);
  const p = a.pos || {};
  const e = journalEntry(a, risk, now, liveTime, { followedAt: Math.floor(now / 1000) });
  if (p.state === POS.OPEN || p.state === POS.TP || p.state === POS.SL) {
    Object.assign(e, { state: p.state, riskPips: p.riskPips, fillTime: p.fillTime, fillPrice: p.fillPrice, exitTime: p.exitTime, exitPrice: p.exitPrice, exitKind: p.exitKind, hits: p.hits || 0, hitTimes: [...(p.hitTimes || [])], fromBacktest: true });
  }
  journal.entries.push(e);
  return e;
}

/** L'utilisateur retire la zone de son suivi : elle sort de la balance réelle. */
export function unfollowZone(journal, id) {
  const n = journal.entries.length;
  journal.entries = journal.entries.filter((j) => j.id !== id);
  return journal.entries.length !== n;
}

/** Change le lot réellement utilisé sur une position suivie. */
export function setEntryLot(journal, id, lot) {
  const j = journal.entries.find((x) => x.id === id);
  if (!j || !(lot > 0)) return false;
  j.lot = Math.round(Math.min(100, Math.max(0.01, lot)) * 100) / 100;
  return true;
}

export function updateJournal(journal, { audited, candles, risk, calendar, currentPrice, now }) {
  const base = baseCandles(candles);
  if (!base?.length) return journal;
  const liveTime = base.at(-1).time;
  const events = [];
  // 1. suivi automatique (option) : zones proposées, en attente, paramétrage validé
  if (risk.validated && risk.autoFollow) {
    for (const a of audited) {
      if (a.proposal !== 'PROPOSEE' || a.pos.state !== POS.PENDING) continue;
      if (journal.entries.some((j) => j.id === a.id)) continue;
      journal.entries.push(journalEntry(a, risk, now, liveTime, { auto: true }));
      events.push({ type: 'new', entry: journal.entries.at(-1) });
    }
  }
  // 2. avancer les ordres/positions avec les bougies postérieures
  for (const j of journal.entries) {
    if (j.state !== POS.PENDING && j.state !== POS.OPEN) continue;
    const before = j.state, beforeHits = j.hits || 0, beforeBeDone = !!j.beDone, beforeTrailFrom = j.trailFrom ?? null;
    const a = audited.find((x) => x.id === j.id);
    // trailing structurel (§2) : bougies de l'UT de la zone si disponibles, sinon bougies de base
    const zoneTf = candles[j.timeframe];
    const swingCandles = zoneTf?.length ? zoneTf : base;
    // un ordre posé automatiquement suit le verdict de l'auditeur ; un ordre suivi par l'utilisateur reste le sien
    if (j.state === POS.PENDING && j.auto && a && a.proposal && a.proposal !== 'PROPOSEE' && a.proposal !== 'SUSPENDUE') {
      Object.assign(j, { state: POS.CANCELLED, reason: a.reasons.at(-1) || 'plus proposée', exitTime: liveTime });
    } else if (j.state === POS.PENDING && Math.floor(now / 1000) - j.createdAt > (MAX_PENDING_SEC[j.category] || 86400 * 5)) {
      Object.assign(j, { state: POS.CANCELLED, reason: 'ordre expiré', exitTime: liveTime });
    } else {
      const pos = { ...j, dir: j.dir };
      // Entrée « confirmation » : la bougie de réaction est jugée sur l'UT de la zone (même règle
      // que le backtest). Une fois la position ouverte, suivi fin en 1 minute.
      const tfSec = TF_SECONDS[j.timeframe] || 60;
      if (pos.state === POS.PENDING && pos.entryMode === 'confirmation' && zoneTf?.length && tfSec > 60) {
        const tfClosed = normalizeCandles(zoneTf).filter((c) => c.time + tfSec - 60 > (pos.lastTime ?? 0) && c.complete !== false);
        advance(pos, tfClosed, { isBlackout: calendar.isBlackout, tfSec, pipSize: j.pipSize, swingCandles });
        // la suite (1 minute) reprend APRÈS la clôture de la bougie de réaction
        if (pos.state === POS.OPEN) pos.lastTime = pos.fillTime + tfSec - 60;
        else if (tfClosed.length) pos.lastTime = tfClosed.at(-1).time + tfSec - 60;
      }
      const closed = base.filter((c) => c.time > pos.lastTime && c.complete !== false);
      if (pos.state === POS.OPEN || pos.entryMode !== 'confirmation' || !(zoneTf?.length && tfSec > 60)) {
        advance(pos, closed, { isBlackout: calendar.isBlackout, tfSec: 60, pipSize: j.pipSize, swingCandles });
      }
      // bougie en cours : l'événement est réel (le prix l'a atteint) mais la bougie n'est pas figée
      const live = base.at(-1);
      if (live.complete === false && live.time > (pos.lastTime ?? 0) && (pos.state === POS.OPEN || (pos.state === POS.PENDING && pos.entryMode !== 'confirmation'))) {
        const probe = { ...pos };
        advance(probe, [live], { isBlackout: calendar.isBlackout, tfSec: 60, pipSize: j.pipSize, swingCandles });
        if (probe.state !== pos.state || (probe.hits || 0) !== (pos.hits || 0)) Object.assign(pos, probe);
        else pos.lastTime = closed.at(-1)?.time ?? pos.lastTime;
      }
      Object.assign(j, pos);
    }
    for (const type of transitions(before, beforeHits, j, beforeBeDone, beforeTrailFrom)) events.push({ type, entry: j });
  }
  // 3. résultats
  for (const j of journal.entries) {
    const rk = { lot: j.lot, pipSize: j.pipSize, contractSize: j.contractSize, quote: j.quote, quotePrice: j.quotePrice, costPips: j.costPips || 0 };
    const plan = { slPips: j.slPips, riskPx: j.slPips * j.pipSize };
    Object.assign(j, finalize(j, plan, currentPrice, rk));
  }
  if (journal.entries.length > 1500) journal.entries = journal.entries.slice(-1500);
  journal.events = events;
  return journal;
}

// ── Préservation du compte (trader institutionnel, compte pérenne) ────────
/**
 * Garde-fous de préservation du compte, à partir du journal réel uniquement (le backtest par
 * zone n'est pas concerné : §B) :
 *   1. Maximum 2 positions ouvertes en même temps (suivies, y compris automatiques).
 *   2. Pas deux positions ouvertes dans le même sens sur des zones qui se chevauchent
 *      (même zone de prix ± la hauteur de la zone).
 *   3. Coupe-circuit journalier : après 2 pertes (SL) clôturées le même jour (UTC) dans le
 *      journal, plus aucune proposition/notification de nouveau trade jusqu'au lendemain.
 *   4. Après 3 pertes consécutives (journal), taille réduite conseillée (50 % du lot) sur les
 *      prochaines propositions.
 */
function moneyEur(j, eurUsd) {
  const q = (j.pips || 0) * (j.pipSize || 0) * (j.contractSize || 0) * (j.lot || 0);
  if (j.quote === 'EUR') return q;
  const usd = j.quote === 'JPY' ? q / (j.quotePrice || 150) : q;
  return eurUsd ? usd / eurUsd : usd;
}

export function riskGuards(journal, audited, now = Date.now(), opts = {}) {
  const entries = journal?.entries || [];
  const open = entries.filter((j) => j.state === POS.OPEN);
  const closed = entries.filter((j) => j.state === POS.TP || j.state === POS.SL).sort((a, b) => (a.exitTime || 0) - (b.exitTime || 0));

  const maxPositions = open.length >= 2;

  const d = new Date(now);
  const dayStartSec = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) / 1000;
  const lossesToday = closed.filter((j) => j.state === POS.SL && (j.exitTime || 0) >= dayStartSec).length;
  const dailyBreaker = lossesToday >= 2;

  let consecutiveLosses = 0;
  for (let i = closed.length - 1; i >= 0; i--) { if (closed[i].state === POS.SL) consecutiveLosses++; else break; }
  const reducedSize = consecutiveLosses >= 3;

  /** Une zone (sens + bord de prix) chevauche-t-elle une position déjà ouverte dans le même sens ? */
  const overlapsOpen = (dir, zoneLow, zoneHigh) => {
    if (zoneLow == null || zoneHigh == null) return false;
    const h = Math.max(0, zoneHigh - zoneLow);
    return open.some((j) => j.dir === dir && j.zoneLow != null && j.zoneHigh != null
      && zoneLow - h <= j.zoneHigh && zoneHigh + h >= j.zoneLow);
  };

  // exposition corrélée : au plus 1 position ouverte ou en attente suivie par groupe (or/dollar,
  // indices US, indices européens, pétrole) et par sens
  const active = entries.filter((j) => j.followed && (j.state === POS.OPEN || j.state === POS.PENDING));
  const groupOf = (j) => j.corrGroup || marketById(j.market)?.corrGroup || j.market;
  const correlated = (marketId, dir) => {
    const g = marketById(marketId)?.corrGroup || marketId;
    // USD : un achat d'or / EUR / GBP et une vente d'USD/JPY vont dans le même sens (dollar baissier)
    const usdSign = (id, d) => (id === 'USDJPY' ? (d === 'BUY' ? 1 : -1) : (d === 'BUY' ? -1 : 1));
    return active.some((j) => groupOf(j) === g && (g === 'USD' ? usdSign(j.market, j.dir) === usdSign(marketId, dir) : j.dir === dir));
  };
  // perte journalière maximale en % du capital (journal réel, coûts inclus)
  const capital = Number(opts.capital) || 0;
  const lossTodayEur = closed.filter((j) => (j.exitTime || 0) >= dayStartSec && Number.isFinite(j.pips) && j.pips < 0)
    .reduce((s, j) => s + Math.abs(moneyEur(j, opts.eurUsd)), 0);
  const dailyLossLimit = capital > 0 && opts.maxDailyLossPct > 0 && lossTodayEur >= (capital * opts.maxDailyLossPct) / 100;

  return {
    maxPositions, openCount: open.length,
    correlated, lossTodayEur, dailyLossLimit,
    dailyBreaker, lossesToday,
    reducedSize, consecutiveLosses,
    overlapsOpen,
    blockNew: maxPositions || dailyBreaker || dailyLossLimit,
  };
}

// ── Orchestrateur ────────────────────────────────────────────────────────
export function runAgents({ data, settings, cal, learnStore, journal, newsEvents = [], macroModel = null, now = Date.now() }) {
  // Marché analysé : whitelisté (markets.js), XAUUSD par défaut (comportement historique inchangé).
  const market = marketById(settings.market || data.market) || marketById(DEFAULT_MARKET);
  // pip/contractSize sont des propriétés physiques du marché, jamais réglables par l'utilisateur.
  const lastPx = TIMEFRAMES.map((tf) => data.candles?.[tf]?.at(-1)?.close).find(Number.isFinite);
  const risk = {
    ...DEFAULT_RISK, ...settings.risk,
    ...marketRisk(market, { quotePrice: lastPx, spreadOverride: settings.risk?.spreadOverrides?.[market.id], slippagePips: settings.risk?.slippagePips }),
  };
  const opts = { ...(settings.strategy || {}), liquidityLookback: settings.liquidityLookback, fragileGapAtrRatio: settings.fragileGapAtrRatio, marketId: market.id, strategyMode: risk.strategyMode || 'smc' };
  const wantedTfs = TIMEFRAMES.filter((tf) => settings.timeframes.includes(tf));
  const candles = data.candles;
  // prix courant : dernière clôture de la plus petite TF
  let currentPrice = null, priceTime = null;
  for (const tf of TIMEFRAMES) if (candles[tf]?.length) { currentPrice = candles[tf].at(-1).close; priceTime = candles[tf].at(-1).time; break; }
  // calendrier économique filtré aux pays du marché analysé (blackout par marché, §7)
  const calendar = makeCalendar(cal, risk.newsBlackoutMin, newsEvents, market.calendarCountries);

  const collector = agentCollector({ candles, symbol: data.symbol, wantedTfs, now, market });
  const reports = [collector];
  if (collector.status === STATUS_KO) {
    return { reports, audited: [], journal, model: null, currentPrice, priceTime, analyzedAt: now, calendar, market };
  }
  const scan = agentScanner({ candles, wantedTfs, currentPrice, opts, now });
  const nowT = Math.floor(now / 1000);
  // OB 5★ + fiabilité top-down (en mode OB 5★, ce sont les zones du scanner, annotées en place)
  const ob5 = ob5Layer({ candles, wantedTfs, currentPrice, opts, risk, nowT, zones: opts.strategyMode === 'smc' ? null : scan.zones });
  // structure (BOS / CHoCH) de chaque UT, pour le graphique
  const structure = {};
  for (const tf of wantedTfs) if (candles[tf]?.length) structure[tf] = structureMarks(candles[tf], tf);
  // contexte macro : influence mesurée des annonces publiées (macro-model.json), cohérence chronologique
  const macro = macroModel ? macroState(newsEvents, market.id, macroModel, nowT) : null;
  const calReport = agentCalendar({ cal, calendar, now });
  const hist = agentHistory({ zones: scan.zones, candles, risk, calendar, learnStore, journal, learnParams: settings.learning, currentPrice, now, marketId: market.id });
  // amélioration continue : n'adopte un changement de règle que s'il est prouvé meilleur ;
  // sinon conserve la configuration courante, voire revient en arrière si sa performance baisse ensuite
  const ci = applyContinuousImprovement(learnStore, { ruleDecisions: hist.model.ruleDecisions || [], backtest: hist.backtest, calendar, now, marketId: market.id });
  hist.report.lines.push(...continuousImprovementLines(ci, hist.model.ruleDecisions || []));
  const audit = agentAuditor({ backtest: hist.backtest, candles, collector, calReport, calendar, model: hist.model, risk, opts, now, marketId: market.id });
  reports.push(scan.report, calReport, hist.report, audit.report);
  updateJournal(journal, { audited: audit.audited, candles, risk, calendar, currentPrice, now });

  const order = { PROPOSEE: 0, SUSPENDUE: 1, FILTREE: 2, REFUSEE: 3 };
  // priorité (§17) : 5★ (seule note valide), confluence multi-UT, puis récence
  audit.audited.sort((a, b) => (order[a.proposal] ?? 9) - (order[b.proposal] ?? 9) || (a.status === STATUS.VIABLE ? 0 : 1) - (b.status === STATUS.VIABLE ? 0 : 1)
    || (b.grade ?? 0) - (a.grade ?? 0) || (b.confluence?.length ?? 0) - (a.confluence?.length ?? 0) || b.c1Time - a.c1Time);
  // préservation du compte (§B) : calculée après la mise à jour du journal, sur le journal réel uniquement
  const guards = riskGuards(journal, audit.audited, now, { capital: risk.capital, maxDailyLossPct: risk.maxDailyLossPct, eurUsd: risk.eurUsdManual });
  for (const a of audit.audited) {
    if (a.proposal === 'PROPOSEE' && guards.overlapsOpen(a.direction, a.zoneLow, a.zoneHigh)) a.guardOverlap = true;
    if (a.proposal === 'PROPOSEE' && guards.correlated(market.id, a.direction)) a.guardCorrelated = true;
  }
  for (const a of audit.audited) a.macroAlign = macro ? macroAlignment(macro, a.direction) : null;
  return { reports, audited: audit.audited, journal, model: hist.model, currentPrice, priceTime, analyzedAt: now, calendar, risk, guards, market, strategyMode: opts.strategyMode, watchPois: scan.watch || [], smcFunnel: scan.funnel || null, ob5, structure, macro };
}

/** Statistiques de la stratégie sur le backtest (zones éligibles uniquement) + référence hasard. */
export function strategyPerformance(backtest, candles, risk, { runs = 60 } = {}) {
  const trades = [];
  const tplByTf = {};
  for (const { zone: z, pos, eligible } of backtest) {
    if (!eligible || (pos.state !== POS.TP && pos.state !== POS.SL) || !Number.isFinite(pos.r)) continue;
    trades.push({ r: pos.r, pips: pos.pips, t: pos.exitTime });
    const plan = planFor(z, risk);
    (tplByTf[z.timeframe] ||= []).push({ riskPx: Math.abs(pos.fillPrice - plan.sl), rr: plan.rr, rr2: plan.rr2, rr3: plan.rr3, pipSize: risk.pipSize, costPips: risk.costPips || 0 });
  }
  const stats = summarize(trades);
  const benches = Object.entries(tplByTf).map(([tf, tpl]) => randomBenchmark(normalizeCandles(candles[tf]), tpl, { runs }));
  const pct = combineBenchmarks(benches).percentileOf(stats.meanR);
  return { stats, randomPercentile: pct, randomLabel: benchmarkLabel(pct, stats.n) };
}

function pruneSamples(store, max) {
  const ids = Object.keys(store.samples);
  if (ids.length <= max) return;
  ids.sort((a, b) => (store.samples[a].t || 0) - (store.samples[b].t || 0));
  for (const id of ids.slice(0, ids.length - max)) if (store.samples[id].source !== 'reel') delete store.samples[id];
}
const round = (v) => Math.round(v * 1000) / 1000;
const pct = (v) => (v == null ? '—' : `${Math.round(v * 100)} %`);
const fmtNum = (v) => (v == null ? '0' : String(Math.round(v * 10) / 10).replace('.', ','));
const fmtR = (v) => (v == null ? '—' : `${v >= 0 ? '+' : ''}${v.toFixed(2)} R`);
const fmtDate = (t) => new Date(t * 1000).toLocaleString('fr-FR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
