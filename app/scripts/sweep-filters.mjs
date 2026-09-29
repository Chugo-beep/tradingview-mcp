#!/usr/bin/env node
/**
 * Compare un petit nombre de configurations nommées (stratégie, séances, filtre HTF, mode de stop)
 * en in-sample ET out-of-sample, sur plusieurs marchés. Peu de configurations = peu de risque de surapprentissage.
 * Usage : node scripts/sweep-filters.mjs --markets XAUUSD,NAS100,US30,EURUSD --from 2019-01-01 --to 2026-09-29
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

const LDN_NY = ['Londres', 'New York'];
const CONFIGS = {
  'smc actuel': { risk: { strategyMode: 'smc' } },
  'smc Londres+NY': { risk: { strategyMode: 'smc', sessions: LDN_NY } },
  'smc stop swing': { risk: { strategyMode: 'smc' }, smc: { stopMode: 'swing' } },
  'smc stop zone': { risk: { strategyMode: 'smc' }, smc: { stopMode: 'zone' } },
  'smc anciens réglages': { risk: { strategyMode: 'smc' }, smc: { stopMode: 'zone', chochDisplacementAtr: 0.8, volumeMult: 1.2, minRR: 3 } },
  'smc R:R min 3': { risk: { strategyMode: 'smc' }, smc: { minRR: 3 } },
  'smc HTF D+W seulement': { risk: { strategyMode: 'smc' }, smc: { htfTfs: ['D', 'W'] } },
  'smc LTF 15 seulement': { risk: { strategyMode: 'smc' }, smc: { ltfTfs: ['15'] } },
  'ob5 (défaut)': { risk: { strategyMode: 'ob5' } },
  'ob5 Londres+NY': { risk: { strategyMode: 'ob5', sessions: LDN_NY } },
  'ob5 sans filtre HTF': { risk: { strategyMode: 'ob5', htfFilter: false } },
  'ob5 pips': { risk: { strategyMode: 'ob5', targetMode: 'pips' } },
};

const data = {};
for (const id of MARKETS) {
  const m1 = JSON.parse(await readFile(join(APP_DIR, '.cache-histo', `${id}-${FROM}-${TO}.json`), 'utf8'));
  const { inSample, outOfSample } = splitWalkForward(m1, 0.7);
  data[id] = { m: marketById(id), is: aggregateAll(inSample, BACKTEST_TFS), oos: aggregateAll(outOfSample, BACKTEST_TFS) };
}
function run(part, cfg) {
  let n = 0, sum = 0, wins = 0; const per = [];
  for (const id of MARKETS) {
    const r = rankMarket(data[id].m, data[id][part], { risk: { targetMode: 'atr', ...cfg.risk }, strategy: { smc: { poiLookbackBars: 1e6, ...cfg.smc } }, benchmark: false });
    n += r.trades; sum += (r.expectancyR ?? 0) * r.trades; wins += (r.winRate ?? 0) * r.trades;
    per.push(`${id}:${r.trades}/${r.expectancyR == null ? 'n/d' : r.expectancyR.toFixed(2)}`);
  }
  return `${String(n).padStart(3)} trades, réussite ${n ? Math.round(100 * wins / n) : 0} %, espérance ${n ? (sum / n).toFixed(2) : 'n/d'}R  [${per.join(' ')}]`;
}
for (const [name, cfg] of Object.entries(CONFIGS)) {
  console.log(`\n== ${name}`);
  console.log(`  IN  ${run('is', cfg)}`);
  console.log(`  OOS ${run('oos', cfg)}`);
}
