#!/usr/bin/env node
/**
 * Calibration : la fiabilité top-down (A/B/C/D) et le contexte macro (favorable / neutre / défavorable)
 * prédisent-ils le résultat des trades ? Agrège plusieurs marchés, sépare in-sample (70 % anciens)
 * et out-of-sample (30 % récents).
 * Usage : node --max-old-space-size=8192 scripts/calibrate.mjs --markets XAUUSD,NAS100,US30,EURUSD --strategy ob5
 */
import { readFile, writeFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { marketById } from '../www/js/markets.js';
import { rankMarket } from '../www/js/ranking.js';
import { summarize } from '../www/js/stats.js';
import { aggregateAll, splitWalkForward, BACKTEST_TFS } from './backtest-lib.mjs';

const APP_DIR = join(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const argVal = (n, d) => { const i = args.indexOf(n); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const MARKETS = argVal('--markets', 'XAUUSD,NAS100,US30,EURUSD').split(',').map((s) => s.trim().toUpperCase());
const FROM = argVal('--from', '2019-01-01');
const TO = argVal('--to', '2026-09-29');
const STRATEGY = argVal('--strategy', 'ob5');
const RESEARCH = args.includes('--all-ob'); // tous les OB détectés, pas seulement les 5★
const model = JSON.parse(await readFile(join(APP_DIR, 'www', 'data', 'macro-model.json'), 'utf8'));
const cal = JSON.parse(await readFile(join(APP_DIR, '.cache-histo', `calendar-${FROM}-${TO}.json`), 'utf8'));
const macro = { model, events: cal.events };

const all = { is: [], oos: [] };
for (const id of MARKETS) {
  const m1 = JSON.parse(await readFile(join(APP_DIR, '.cache-histo', `${id}-${FROM}-${TO}.json`), 'utf8'));
  const { inSample, outOfSample } = splitWalkForward(m1, 0.7);
  for (const [part, data] of [['is', inSample], ['oos', outOfSample]]) {
    const r = rankMarket(marketById(id), aggregateAll(data, BACKTEST_TFS), {
      risk: { targetMode: 'atr', strategyMode: STRATEGY }, strategy: { smc: { poiLookbackBars: 1e6 }, research: RESEARCH }, benchmark: false, macro,
    });
    for (const x of r.history) all[part].push({ ...x, market: id });
    console.error(`${id} ${part} : ${r.trades} trades`);
  }
}
const line = (xs) => { const s = summarize(xs); return `${String(s.n).padStart(4)} trades · réussite ${s.n ? Math.round(s.winRate * 100) : 0} % · espérance ${s.n ? (s.meanR >= 0 ? '+' : '') + s.meanR.toFixed(2) : 'n/d'}R${s.ciR ? ` [IC90 ${s.ciR[0].toFixed(2)} ; ${s.ciR[1].toFixed(2)}]` : ''}`; };
for (const [label, field, values] of [['Fiabilité top-down', 'rel', ['A', 'B', 'C', 'D']], ['Contexte macro', 'macro', ['favorable', 'neutre', 'défavorable']]]) {
  console.log(`\n## ${label} (${STRATEGY})`);
  for (const part of ['is', 'oos']) {
    console.log(`  ${part === 'is' ? 'IN-SAMPLE ' : 'OUT-SAMPLE'} total : ${line(all[part])}`);
    for (const v of values) { const xs = all[part].filter((x) => x[field] === v); if (xs.length) console.log(`    ${v.padEnd(12)} ${line(xs)}`); }
  }
}
if (STRATEGY === 'ob5') {
  console.log('\n## Points top-down (score) : espérance par tranche de score, période complète');
  const both = [...all.is, ...all.oos];
  for (const [lo, hi] of [[0, 30], [30, 50], [50, 70], [70, 101]]) { const xs = both.filter((x) => x.relScore >= lo && x.relScore < hi); if (xs.length) console.log(`  score ${lo}–${hi - 1} : ${line(xs)}`); }
}

if (STRATEGY === 'ob5') {
  console.log('\n## Chaque facteur top-down : espérance avec / sans (IN puis OUT)');
  for (const k of ['htfTrend', 'htfPd', 'htfPoi', 'localBos', 'displacement', 'noCounter']) {
    const cell = (xs, yes) => { const s = summarize(xs.filter((x) => x.relParts && (x.relParts[k] > 0) === yes)); return `${String(s.n).padStart(4)} ${s.n ? (s.meanR >= 0 ? '+' : '') + s.meanR.toFixed(2) : ' n/d'}R`; };
    console.log(`  ${k.padEnd(13)} IN avec ${cell(all.is, true)} | sans ${cell(all.is, false)}   ·   OUT avec ${cell(all.oos, true)} | sans ${cell(all.oos, false)}`);
  }
  console.log('\n## Tendance HTF (part pondérée alignée) par tranche');
  for (const [lo, hi] of [[0, 1], [1, 15], [15, 25], [25, 31]]) {
    const pick = (xs) => xs.filter((x) => x.relParts && x.relParts.htfTrend >= lo && x.relParts.htfTrend < hi);
    console.log(`  points ${lo}–${hi - 1} : IN ${line(pick(all.is))} | OUT ${line(pick(all.oos))}`);
  }
}

// calibration publiée pour l'application (www/data/calibration-<stratégie>.json) : historique de chaque niveau
if (args.includes('--write')) {
  const stat = (xs) => { const s = summarize(xs); return { n: s.n, winRate: s.n ? +s.winRate.toFixed(3) : null, expectancyR: s.n ? +s.meanR.toFixed(2) : null, ciR: s.ciR ? s.ciR.map((v) => +v.toFixed(2)) : null }; };
  const byLevel = {};
  for (const v of ['A', 'B', 'C', 'D']) byLevel[v] = { inSample: stat(all.is.filter((x) => x.rel === v)), outOfSample: stat(all.oos.filter((x) => x.rel === v)) };
  const out = { builtAt: new Date().toISOString(), strategy: STRATEGY, sample: RESEARCH ? 'tous les OB détectés' : 'OB 5★', markets: MARKETS, from: FROM, to: TO, total: { inSample: stat(all.is), outOfSample: stat(all.oos) }, byLevel };
  const file = join(APP_DIR, 'www', 'data', `calibration-${STRATEGY}.json`);
  await writeFile(file, JSON.stringify(out, null, 2));
  console.log(`
Calibration → ${file}`);
}
