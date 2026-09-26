/**
 * Phase 3 : nouvelles timeframes (W/M/12M) et marchés en direct sur panneaux dédiés (N=2).
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const DATA = mkdtempSync(join(tmpdir(), 'xauz-tf-'));
process.env.XAUZ_DATA_DIR = DATA;
process.env.XAUZ_PORT = '39779';
process.env.XAUZ_REMOTE_PORT = '39780';
process.env.XAUZ_NO_NEWS = '1';

const tv = await import('../tvfeed.js');
const { TIMEFRAMES, categoryOf } = await import('../www/js/engine.js');
const { MARKETS } = await import('../www/js/markets.js');
const { agentCollector } = await import('../www/js/agents.js');
const { marketById } = await import('../www/js/markets.js');

const bars = (n, t0, step) => Array.from({ length: n }, (_, i) => [t0 + i * step, 4300 + i * 0.1, 4301 + i * 0.1, 4299 + i * 0.1, 4300.5 + i * 0.1, 10]);

// Faux CDP : distingue les panneaux dédiés (CWC.getAll()[i]) du graphique actif, pour vérifier que
// la bascule de résolution en direct ne touche QUE le panneau visé.
let paneResSets = [], activeSwitches = [];
const paneSymbols = { 0: 'OANDA:XAUUSD', 1: 'XETR:DAX' };
const paneIntervals = { 0: '1', 1: '1' };
const evaluate = async (expr) => {
  const e = String(expr);
  if (e.includes('/*XZPANESTATE*/')) {
    const m = /\((\d+)\)$/.exec(e.trim());
    const i = m ? Number(m[1]) : 0;
    return { symbol: paneSymbols[i], interval: paneIntervals[i] };
  }
  if (e.includes('/*XZPANESETRES*/')) {
    const m = /\((\d+),\s*"([^"]+)"\)/.exec(e);
    if (m) { paneResSets.push({ idx: Number(m[1]), tf: m[2] }); paneIntervals[Number(m[1])] = m[2]; }
    return null;
  }
  if (e.includes('/*XZPANELIVECHECK*/')) return { count: 120, more: false };
  if (e.includes('/*XZPANELIVEPUMP*/')) return null;
  if (e.includes('/*XZSERIESBARS*/')) return bars(60, 1790000000, 900);
  if (e.includes('/*XZPANESINFO*/')) return [];
  if (e.includes('/*XZPANECHECK*/')) return { count: 60, firstTime: 1790000000, more: false };
  if (e.includes('/*XZPANEPUMP*/')) return null;
  return [];
};
const evaluateAsync = async (expr) => { void expr; return null; };
tv._setCore({
  connection: { evaluate, evaluateAsync },
  chart: {
    getState: async () => ({ symbol: 'OANDA:XAUUSD', resolution: '15' }),
    setTimeframe: async ({ timeframe }) => { activeSwitches.push(timeframe); },
    setSymbol: async () => {},
  },
});
const srv = await import('../server.js');
const L = 'http://127.0.0.1:39779';
const local = (p, o = {}) => fetch(L + p, { ...o, headers: { 'X-XZ': '1', ...(o.headers || {}) } });

before(async () => { srv.start(); await new Promise((r) => setTimeout(r, 300)); });
after(() => { srv.localServer.close(); srv.remoteServer.close(); });

test('nouvelles timeframes : W/M/12M whitelistées par /api/tv/candles, une TF inconnue (2W) refusée (400)', async () => {
  const r1 = await local('/api/tv/candles?tfs=W,M,12M&count=100&market=XAUUSD');
  assert.equal(r1.status, 200);
  const r2 = await local('/api/tv/candles?tfs=2W&count=100&market=XAUUSD');
  assert.equal(r2.status, 400);
});

test('catégorie : W, M et 12M sont classées « swing » (même règle SL ≤ 100 pips que 4h/1D)', () => {
  assert.equal(categoryOf('W'), 'swing');
  assert.equal(categoryOf('M'), 'swing');
  assert.equal(categoryOf('12M'), 'swing');
  assert.ok(TIMEFRAMES.includes('W') && TIMEFRAMES.includes('M') && TIMEFRAMES.includes('12M'));
});

test('analyse complète : 11 marchés × 9 timeframes (total mis à jour avec W/M/12M)', () => {
  assert.equal(MARKETS.length * TIMEFRAMES.length, 99);
});

test('collecteur : les écarts hebdomadaires/mensuels/annuels ne sont jamais signalés comme des « trous »', () => {
  const w = [];
  for (let i = 0; i < 10; i++) w.push({ time: 1700000000 + i * 604800, open: 100, high: 101, low: 99, close: 100.5, volume: 1, complete: true });
  const r = agentCollector({ candles: { W: w }, symbol: 'OANDA:XAUUSD', wantedTfs: ['W'], now: Date.now() + 1e12, market: marketById('XAUUSD') });
  assert.equal(r.perTf.W.gaps, 0);
});

test('marchés en direct (N=2) : la bascule de résolution cible le panneau dédié, jamais le graphique actif', async () => {
  paneResSets = []; activeSwitches = [];
  tv.setLiveMarkets(['XAUUSD', 'DAX40']);
  // XAUUSD (panneau 0) est déjà en '1' : aucune bascule nécessaire pour tfs=['1'].
  const r0 = await tv.getCandles({ tfs: ['1'], count: 100, market: 'XAUUSD' });
  assert.equal(r0.status, 200);
  assert.deepEqual(activeSwitches, [], 'le graphique actif ne doit jamais être touché pour un marché en direct dédié');
  // DAX40 (panneau 1) est en '1' ; on demande '5' → bascule DE CE PANNEAU SEULEMENT.
  const r1 = await tv.getCandles({ tfs: ['5'], count: 100, market: 'DAX40' });
  assert.equal(r1.status, 200);
  assert.ok(paneResSets.some((s) => s.idx === 1 && s.tf === '5'), 'le panneau 1 (DAX40) doit basculer sur 5');
  assert.ok(!paneResSets.some((s) => s.idx === 0), 'le panneau 0 (XAUUSD) ne doit pas être touché par la lecture de DAX40');
  assert.deepEqual(activeSwitches, [], 'le graphique actif ne doit jamais être touché pour un marché en direct dédié');
  tv.setLiveMarkets([]);
});
