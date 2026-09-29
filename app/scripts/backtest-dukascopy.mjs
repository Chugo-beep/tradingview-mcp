#!/usr/bin/env node
/**
 * Backtest long terme sur données historiques gratuites (Dukascopy, via le paquet npm
 * `dukascopy-node`), avec validation « walk-forward » (in-sample / out-of-sample).
 *
 * Usage :
 *   node scripts/backtest-dukascopy.mjs --market XAUUSD --from 2023-01-01 --to 2026-09-01 --mode atr
 *   node scripts/backtest-dukascopy.mjs --market XAUUSD --synthetic   (marche aléatoire, sans réseau)
 *
 * `dukascopy-node` est une dépendance OPTIONNELLE (app/package.json) : sans elle, seul --synthetic
 * fonctionne (utile pour tester le pipeline sans connexion aux serveurs Dukascopy).
 *
 * Sortie :
 *  - app/www/data/backtest-<MARKET>.json (rapport complet, servi par GET /api/backtest)
 *  - un résumé lisible en français sur la sortie standard
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { marketById } from '../www/js/markets.js';
import { rankMarket } from '../www/js/ranking.js';
import { aggregateAll, splitWalkForward, syntheticSeries, DUKASCOPY_INSTRUMENT, BACKTEST_TFS } from './backtest-lib.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const APP_DIR = resolveAppDir();
function resolveAppDir() { return join(__dirname, '..'); }

const args = process.argv.slice(2);
const argVal = (name, def) => { const i = args.indexOf(name); return i >= 0 && args[i + 1] ? args[i + 1] : def; };
const SYNTHETIC = args.includes('--synthetic');
const MARKET_ID = String(argVal('--market', 'XAUUSD')).toUpperCase();
const FROM = argVal('--from', '2023-01-01');
const TO = argVal('--to', new Date().toISOString().slice(0, 10));
const MODE = argVal('--mode', 'atr') === 'pips' ? 'pips' : 'atr';
const STRATEGY = argVal('--strategy', 'smc') === 'ob5' ? 'ob5' : 'smc'; // smc : Smart Money HTF→LTF (défaut) ; ob5 : Order Blocks 5★
const BENCHMARK_RUNS = Number(argVal('--benchmark-runs', '200')) || 200;
const SMC_OVERRIDE = (() => { try { return JSON.parse(argVal('--smc', '{}')); } catch { return {}; } })(); // ex. --smc '{"minRR":2}'
const CACHE_DIR = join(APP_DIR, '.cache-histo');
const DATA_OUT = join(APP_DIR, 'www', 'data');

function fail(msg) { console.error('Erreur : ' + msg); process.exit(1); }

const market = marketById(MARKET_ID);
if (!market) fail(`Marché inconnu : ${MARKET_ID} (voir www/js/markets.js).`);

async function loadOneMinuteSeries() {
  if (SYNTHETIC) {
    console.log(`(mode --synthetic : marche aléatoire générée localement, aucun accès réseau)`);
    return syntheticSeries({ from: FROM, to: TO, startPrice: market.id === 'XAUUSD' ? 2000 : 100, seed: 42 });
  }
  const instrument = DUKASCOPY_INSTRUMENT[market.id];
  if (!instrument) fail(`Pas de correspondance Dukascopy pour ${market.id} (scripts/backtest-lib.mjs).`);
  await mkdir(CACHE_DIR, { recursive: true });
  const cacheFile = join(CACHE_DIR, `${market.id}-${FROM}-${TO}.json`);
  try {
    const cached = JSON.parse(await readFile(cacheFile, 'utf8'));
    if (Array.isArray(cached) && cached.length) {
      console.log(`Données 1m en cache réutilisées (${cached.length} bougies) : ${cacheFile}`);
      return cached;
    }
  } catch { /* pas de cache : on télécharge */ }
  let getHistoricRates;
  try {
    ({ getHistoricRates } = await import('dukascopy-node'));
  } catch {
    fail(
      'Le paquet "dukascopy-node" n\'est pas installé (dépendance optionnelle). ' +
      'Lance « npm install » à la racine de app/, ou utilise --synthetic pour tester le pipeline hors ligne.',
    );
  }
  console.log(`Téléchargement Dukascopy : ${instrument} du ${FROM} au ${TO} (1 minute)…`);
  const rows = await getHistoricRates({
    instrument,
    dates: { from: new Date(FROM), to: new Date(TO) },
    timeframe: 'm1',
    format: 'array',
    cacheFolderPath: join(CACHE_DIR, 'raw'),
  });
  // format 'array' : [timestampMs, open, high, low, close, volume]
  const series = (rows || [])
    .map((r) => ({ time: Math.floor(Number(r[0]) / 1000), open: Number(r[1]), high: Number(r[2]), low: Number(r[3]), close: Number(r[4]), volume: Number(r[5]) || 0 }))
    .filter((c) => [c.time, c.open, c.high, c.low, c.close].every(Number.isFinite))
    .sort((a, b) => a.time - b.time);
  await writeFile(cacheFile, JSON.stringify(series), 'utf8');
  return series;
}

function runOn(m1) {
  const candlesByTf = aggregateAll(m1, BACKTEST_TFS);
  return rankMarket(market, candlesByTf, { risk: { targetMode: MODE, strategyMode: STRATEGY }, strategy: { smc: SMC_OVERRIDE }, benchmarkRuns: BENCHMARK_RUNS });
}

function pct(n) { return n == null ? 'n/d' : `${(n * 100).toFixed(0)} %`; }
function fmtR(r) { return r == null ? 'n/d' : `${r >= 0 ? '+' : ''}${r.toFixed(2)}R`; }
function fmtCi(ci) { return ci ? `[${fmtR(ci[0])} ; ${fmtR(ci[1])}]` : 'n/d (échantillon insuffisant)'; }

function summaryLines(label, r) {
  const lines = [];
  lines.push(`### ${label}`);
  lines.push(`- Trades clôturés : **${r.trades}**${r.insufficient ? ` (insuffisant, < seuil)` : ''}`);
  lines.push(`- Taux de réussite : ${r.winRate != null ? pct(r.winRate) : 'n/d'}`);
  lines.push(`- Espérance : ${fmtR(r.expectancyR)} (IC 90 % : ${fmtCi(r.ciR)})`);
  lines.push(`- Profit factor : ${r.profitFactor ?? 'n/d'}`);
  lines.push(`- Drawdown max : ${r.maxDrawdownR != null ? fmtR(r.maxDrawdownR) : 'n/d'}`);
  lines.push(`- Plus longue série de pertes : ${r.maxLosingStreak ?? 'n/d'}`);
  lines.push(`- Verdict : **${r.verdict?.label ?? 'n/d'}**`);
  lines.push(`- Test contre le hasard : percentile ${r.randomPercentile != null ? Math.round(r.randomPercentile * 100) : 'n/d'} (${r.randomLabel ?? 'n/d'})`);
  return lines;
}

async function main() {
  const t0 = Date.now();
  const m1 = await loadOneMinuteSeries();
  if (m1.length < 200) fail(`Trop peu de bougies 1m (${m1.length}) pour un backtest exploitable.`);
  const { inSample, outOfSample } = splitWalkForward(m1, 0.7);

  const full = runOn(m1);
  const isr = runOn(inSample);
  const oos = runOn(outOfSample);

  const report = {
    market: market.id, label: market.label, mode: MODE, strategy: STRATEGY, from: FROM, to: TO,
    generatedAt: new Date().toISOString(), bars1m: m1.length, synthetic: SYNTHETIC,
    full, inSample: isr, outOfSample: oos,
  };
  await mkdir(DATA_OUT, { recursive: true });
  const outFile = join(DATA_OUT, `backtest-${market.id}.json`);
  await writeFile(outFile, JSON.stringify(report, null, 2), 'utf8');

  const lines = [];
  lines.push(`# Backtest ${market.label} (${MARKET_ID}) — ${FROM} → ${TO}`);
  lines.push('');
  lines.push(`Stratégie : **${STRATEGY === 'smc' ? 'Smart Money HTF → LTF & Fibonacci' : 'Order Blocks 5★'}**${STRATEGY === 'ob5' ? ` · mode d'objectif : **${MODE === 'atr' ? 'adaptatif (ATR/R)' : 'échelle fixe (pips)'}**` : ''}. Bougies 1 minute : ${m1.length}${SYNTHETIC ? ' (données SYNTHÉTIQUES, marche aléatoire — pipeline uniquement, ne reflète aucun marché réel)' : ' (Dukascopy, bid)'}.`);
  lines.push('');
  lines.push(...summaryLines('Période complète', full));
  lines.push('');
  lines.push(...summaryLines('In-sample (70 % — début de période)', isr));
  lines.push('');
  lines.push(...summaryLines('Out-of-sample (30 % — fin de période, jamais vue par le réglage)', oos));
  lines.push('');
  const coherent = !full.insufficient && !isr.insufficient && !oos.insufficient
    && (isr.expectancyR ?? 0) > 0 && (oos.expectancyR ?? 0) > 0;
  lines.push(`## Conclusion`);
  lines.push(coherent
    ? '- L\'avantage statistique se maintient en in-sample **et** en out-of-sample : signal cohérent, pas un simple ajustement sur le passé.'
    : '- Attention : le résultat in-sample et out-of-sample diverge (ou l\'échantillon est insuffisant) — ne pas conclure à un avantage réel sans plus de données.');
  lines.push(`- Rapport JSON complet : ${outFile}`);
  lines.push(`- Durée du backtest : ${((Date.now() - t0) / 1000).toFixed(1)} s`);
  console.log('\n' + lines.join('\n') + '\n');
}

main().catch((e) => fail(e?.stack || e?.message || String(e)));
