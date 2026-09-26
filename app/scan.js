/**
 * « Analyse complète » : scan de tous les marchés du registre (www/js/markets.js) sur les 9
 * timeframes (www/js/engine.js TIMEFRAMES), puis classement (www/js/ranking.js), persisté dans
 * DATA_DIR/scan.json.
 *
 * Un seul scan à la fois (état en mémoire, `state.running`) ; exécuté en tâche de fond, jamais
 * bloquant pour la requête HTTP qui le déclenche. Verrouillé avec tvfeed.js (même `lock`
 * partagé) : ne chevauche jamais un getCandles en direct.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DATA_DIR } from './security.js';
import { MARKETS } from './www/js/markets.js';
import { TIMEFRAMES } from './www/js/engine.js';
import { rankMarket, rankMarkets } from './www/js/ranking.js';

const SCAN_FILE = () => join(DATA_DIR, 'scan.json');

const state = { running: false, current: null, done: 0, total: MARKETS.length * TIMEFRAMES.length, startedAt: null, finishedAt: null, errors: {} };

/** État courant (progression), pour GET /api/scan/status. */
export function scanStatus() {
  return { ...state, current: state.current ? { ...state.current } : null, errors: { ...state.errors } };
}

async function persist(payload) {
  await mkdir(DATA_DIR, { recursive: true });
  await writeFile(SCAN_FILE(), JSON.stringify(payload), 'utf8');
}

/** Dernier résultat persisté (classement), pour GET /api/scan/result. `null` si aucun scan n'a jamais terminé. */
export async function scanResult() {
  try { return JSON.parse(await readFile(SCAN_FILE(), 'utf8')); } catch { return null; }
}

/**
 * Démarre un scan complet en tâche de fond. Ne bloque jamais l'appelant : retourne aussitôt.
 * @returns {{ started: boolean, reason?: string }}
 */
export function startScan() {
  if (state.running) return { started: false, reason: 'already_running' };
  state.running = true; state.startedAt = Date.now(); state.finishedAt = null; state.done = 0; state.current = null; state.errors = {};
  runScan().catch((e) => { state.errors._scan = String(e?.message || e); }).finally(() => { state.running = false; state.finishedAt ||= Date.now(); });
  return { started: true };
}

async function runScan() {
  const { fullScan } = await import('./tvfeed.js');
  const { results } = await fullScan({
    markets: MARKETS,
    onProgress: (p) => {
      state.current = { marketId: p.marketId, marketLabel: p.marketLabel, tf: p.tf };
      state.done = p.done; state.total = p.total;
      if (p.status === 'erreur') state.errors[`${p.marketId}:${p.tf}`] = 'lecture impossible';
    },
  });
  const ranking = [];
  for (const market of MARKETS) {
    const r = results[market.id];
    if (!r || r.errors?._market) {
      ranking.push({ market: market.id, label: market.label, pips: 0, trades: 0, winRate: null, expectancyPips: null, proposals: 0, insufficient: true, topZones: [], barsPerTf: {}, error: r?.errors?._market || 'aucune donnée disponible' });
      continue;
    }
    ranking.push(rankMarket(market, r.candles));
  }
  const payload = { finishedAt: Date.now(), ranking: rankMarkets(ranking) };
  await persist(payload);
  state.finishedAt = Date.now();
}

export function isScanRunning() { return state.running; }
