#!/usr/bin/env node
/**
 * Balayage de paramètres SMC avec discipline anti-surapprentissage.
 *  - Les variantes sont classées UNIQUEMENT sur l'in-sample (70 % début), tous marchés confondus.
 *  - L'out-of-sample (30 % fin) n'est regardé qu'ensuite, pour les meilleures variantes : il sert à valider, jamais à choisir.
 * Usage : node scripts/sweep-smc.mjs --markets XAUUSD,NAS100,US30,EURUSD --from 2019-01-01 --to 2026-09-29
 * Lit les bougies 1m dans .cache-histo (produites par backtest-dukascopy.mjs).
 */
import { readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { marketById } from '../www/js/markets.js';
import { rankMarket } from '../www/js/ranking.js';
import { aggregateAll, splitWalkForward, BACKTEST_TFS } from './backtest-lib.mjs';

const APP_DIR = join(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const argVal = (n, d) => { const i = args.indexOf(n); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const MARKETS = argVal('--markets', 'XAUUSD').split(',').map((s) => s.trim().toUpperCase());
const FROM = argVal('--from', '2019-01-01');
const TO = argVal('--to', new Date().toISOString().slice(0, 10));

const GRID = {
  minRR: [1.5, 2, 3],
  volumeMult: [0, 1.2],
  poiActiveBars: [3, 6],
  chochDisplacementAtr: [0.5, 0.8],
  poiLookbackBars: [150, 300],
  minTp1R: [0.5, 1],
};
const keys = Object.keys(GRID);
const variants = [{}];
for (const k of keys) {
  const next = [];
  for (const v of variants) for (const val of GRID[k]) next.push({ ...v, [k]: val });
  variants.splice(0, variants.length, ...next);
}

const data = {};
for (const id of MARKETS) {
  const m = marketById(id);
  const m1 = JSON.parse(await readFile(join(APP_DIR, '.cache-histo', `${id}-${FROM}-${TO}.json`), 'utf8'));
  const { inSample, outOfSample } = splitWalkForward(m1, 0.7);
  data[id] = { m, is: aggregateAll(inSample, BACKTEST_TFS), oos: aggregateAll(outOfSample, BACKTEST_TFS) };
}

function run(part, smc) {
  const rs = [];
  for (const id of MARKETS) {
    const r = rankMarket(data[id].m, data[id][part], { risk: { targetMode: 'atr', strategyMode: 'smc' }, strategy: { smc: { poiLookbackBars: 1e6, ...smc } }, benchmark: false });
    rs.push({ id, n: r.trades, exp: r.expectancyR, pf: r.profitFactor, win: r.winRate, dd: r.maxDrawdownR, sumR: (r.expectancyR ?? 0) * r.trades });
  }
  const n = rs.reduce((a, r) => a + r.n, 0);
  const sumR = rs.reduce((a, r) => a + r.sumR, 0);
  return { n, exp: n ? sumR / n : null, sumR, per: rs };
}

const t0 = Date.now();
const scored = [];
for (const [i, smc] of variants.entries()) {
  const s = run('is', smc);
  scored.push({ smc, is: s });
  if (i % 20 === 0) console.error(`… ${i + 1}/${variants.length} (${((Date.now() - t0) / 1000).toFixed(0)} s)`);
}
// sélection sur l'in-sample : ≥ 30 trades, espérance la plus élevée
const eligible = scored.filter((s) => s.is.n >= 30 && s.is.exp != null).sort((a, b) => b.is.exp - a.is.exp);
console.log(`\n${variants.length} variantes, ${eligible.length} avec ≥ 30 trades in-sample.\n`);
console.log('Top 10 (classées sur l\'IN-SAMPLE) puis validation OUT-OF-SAMPLE :\n');
for (const s of eligible.slice(0, 10)) {
  const o = run('oos', s.smc);
  console.log(JSON.stringify(s.smc));
  console.log(`  IN  : ${s.is.n} trades, espérance ${s.is.exp.toFixed(2)}R`);
  console.log(`  OOS : ${o.n} trades, espérance ${o.exp == null ? 'n/d' : o.exp.toFixed(2) + 'R'} · ${o.per.map((p) => `${p.id}:${p.n}/${p.exp == null ? 'n/d' : p.exp.toFixed(2)}`).join(' ')}`);
}
const base = run('oos', {});
console.log(`\nRéférence (réglages actuels) OOS : ${base.n} trades, espérance ${base.exp == null ? 'n/d' : base.exp.toFixed(2) + 'R'}`);
