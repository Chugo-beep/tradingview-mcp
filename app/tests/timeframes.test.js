/**
 * Phase 3 : nouvelles timeframes (W/M/12M) et résolution des marchés sur le graphique UNIQUE de
 * TradingView Desktop (barre de recherche, jamais de disposition multi-graphiques).
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const DATA = mkdtempSync(join(tmpdir(), 'xauz-tf-'));
process.env.XAUZ_DATA_DIR = DATA;
process.env.XAUZ_PORT = '39779';
process.env.XAUZ_REMOTE_PORT = '39780';
process.env.XAUZ_NO_NEWS = '1';

// symbols.json EMPOISONNÉ par l'ancien bug (tous les marchés résolus en OANDA:XAUUSD)
import { writeFileSync } from 'node:fs';
writeFileSync(join(DATA, 'symbols.json'), JSON.stringify({ US30: { symbol: 'OANDA:XAUUSD', resolvedAt: Date.now(), via: 'recherche' }, SP500: { symbol: 'OANDA:XAUUSD', resolvedAt: Date.now(), via: 'recherche' } }));
const tv = await import('../tvfeed.js');
const { TIMEFRAMES, categoryOf } = await import('../www/js/engine.js');
const { MARKETS, marketById, marketOf } = await import('../www/js/markets.js');
const { agentCollector } = await import('../www/js/agents.js');

const bars = (n, t0, step) => Array.from({ length: n }, (_, i) => [t0 + i * step, 4300 + i * 0.1, 4301 + i * 0.1, 4299 + i * 0.1, 4300.5 + i * 0.1, 10]);

// Requête (whitelistée, markets.js searchQuery) → symbole que TradingView Desktop affiche après le
// clic sur le 1er résultat, pour chaque marché du faux DOM. 'CAC40' n'a AUCUNE ligne de résultat
// (dialogue introuvable) : sert à vérifier le repli REST. 'NASDAQ' (NAS100) n'est trouvé NI par
// l'UI NI par le repli REST : sert à vérifier l'erreur « marché introuvable ».
const UI_RESULT = { XAUUSD: 'OANDA:XAUUSD', US30: 'OANDA:US30USD', DAX40: 'XETR:DAX' };
const REST_RESULT = { CAC40: 'EURONEXT:PX1', GBPUSD: 'FX:GBPUSD' };
// GBPUSD : le 1er résultat existe dans le dialogue mais le clic ne change PAS le graphique
// (reproduit le bug réel « tous les marchés résolus en OANDA:XAUUSD ») → repli REST obligatoire.
const DEAD_CLICK = new Set(['GBPUSD']);
// symboles qui s'affichent mais SANS bougies (ex. « FXCM:USDJPY » : symbole indisponible) → rejetés
const EMPTY = new Set(['FXCM:GBPUSD']);

let chartState = { symbol: 'OANDA:XAUUSD', resolution: '1' };
let setSymbolCalls = [], setTimeframeCalls = [], searchOpens = 0, searchInputs = [], searchClicks = 0, allCalls = [], keys = [];
let lastQuery = null, dialogOpen = false;
const BTN = { x: 40, y: 20 }, ROW = { x: 300, y: 200 };
const idForQuery = (q) => Object.keys(UI_RESULT).concat([...DEAD_CLICK]).find((id) => marketById(id).searchQuery === q);

const evaluate = async (expr) => {
  const e = String(expr);
  allCalls.push(e);
  if (e.includes('/*XZACTIVECHECK*/')) return { count: 100, firstTime: 1790000000, more: false };
  if (e.includes('/*XZACTIVEPUMP*/')) return null;
  if (e.includes('/*XZSERIESBARS*/')) return bars(60, 1790000000, 900);
  if (e.includes('/*XZSERIESOK*/')) return EMPTY.has(chartState.symbol) ? 0 : 60;
  if (e.includes('/*XZSEARCHPROBE*/')) return { candidates: [] };
  if (e.includes('/*XZSEARCHOPEN*/')) return { ...BTN };
  // CAC40 : le dialogue ne s'ouvre jamais (champ introuvable) → repli REST
  if (e.includes('/*XZSEARCHINPUT*/')) return dialogOpen;
  if (e.includes('/*XZSEARCHDLG*/')) return dialogOpen;
  if (e.includes('/*XZSEARCHROWS*/')) return dialogOpen && idForQuery(lastQuery) ? { ...ROW, text: lastQuery } : null;
  return [];
};
const Input = {
  dispatchMouseEvent: async ({ type, x, y }) => {
    if (type !== 'mousePressed') return;
    if (x === BTN.x && y === BTN.y) { searchOpens++; dialogOpen = true; lastQuery = null; return; }
    if (x === ROW.x && y === ROW.y && dialogOpen) {
      searchClicks++;
      const id = idForQuery(lastQuery);
      if (id && !DEAD_CLICK.has(id)) { chartState = { ...chartState, symbol: UI_RESULT[id] }; dialogOpen = false; }
    }
  },
  insertText: async ({ text }) => { lastQuery = text; searchInputs.push(text); if (text === 'CAC40') dialogOpen = false; },
  dispatchKeyEvent: async ({ type, key }) => { if (type === 'keyUp') return; keys.push(key); if (key === 'Escape') dialogOpen = false; },
};
const evaluateAsync = async (expr) => { allCalls.push(String(expr)); return null; };
const chart = {
  getState: async () => ({ ...chartState }),
  setTimeframe: async ({ timeframe }) => { setTimeframeCalls.push(timeframe); chartState.resolution = timeframe; },
  setSymbol: async ({ symbol }) => { setSymbolCalls.push(symbol); chartState.symbol = symbol; },
  symbolSearch: async ({ query }) => {
    const id = Object.keys(REST_RESULT).find((k) => marketById(k).searchQuery === query);
    // la REST renvoie d'abord un résultat INCOHÉRENT (XAUUSD) : il doit être ignoré
    return id ? { results: [{ full_name: 'OANDA:XAUUSD' }, { full_name: 'GO Markets:' + query }, { full_name: 'FXCM:GBPUSD' }, { full_name: REST_RESULT[id] }] } : { results: [] };
  },
};
tv._setSearchTimeouts({ rows: 60, settle: 1, chart: 60, enter: 60, poll: 5, dialog: 1, data: 30 });
tv._setCore({ connection: { evaluate, evaluateAsync, getClient: async () => ({ Input }) }, chart });
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

test('résolution par recherche : requête EXACTE whitelistée, 1er résultat cliqué, symbole mémorisé et reconnu par marketOf', async () => {
  searchOpens = 0; searchInputs = []; searchClicks = 0; allCalls = [];
  chartState = { symbol: 'OANDA:XAUUSD', resolution: '1' };
  const res = await tv.selectMarketViaSearch(marketById('DAX40'));
  assert.equal(res.ok, true);
  assert.equal(res.symbol, 'XETR:DAX');
  assert.equal(res.via, 'recherche');
  assert.ok(searchInputs.includes('DAX40'), 'la requête EXACTE du registre (DAX40) est envoyée à la recherche');
  assert.equal(searchClicks, 1, 'le PREMIER résultat est cliqué (vrai clic souris CDP)');
  assert.equal(dialogOpen, false, 'dialogue refermé');
});

test('régression : clic sans effet (graphique resté sur XAUUSD) → JAMAIS un succès XAUUSD, repli REST cohérent (GBPUSD)', async () => {
  chartState = { symbol: 'OANDA:XAUUSD', resolution: '1' };
  keys = [];
  const res = await tv.selectMarketViaSearch(marketById('GBPUSD'));
  assert.equal(res.ok, true);
  assert.equal(res.symbol, 'FX:GBPUSD', 'ignorés : XAUUSD (incohérent), « GO Markets:… » (nom invalide), FXCM:GBPUSD (sans bougies)');
  assert.ok(!setSymbolCalls.includes('GO Markets:GBPUSD'), 'un libellé d\'exchange avec espace n\'est jamais envoyé au graphique');
  assert.equal(res.via, 'rest');
  assert.ok(keys.includes('Enter'), 'Entrée tentée après un clic sans effet');
});

test('symbols.json empoisonné (US30 → OANDA:XAUUSD) : entrée purgée au chargement, jamais réutilisée', async () => {
  const { symbolMatchesMarket } = await import('../www/js/markets.js');
  assert.equal(symbolMatchesMarket('OANDA:XAUUSD', 'US30'), false);
  assert.equal(symbolMatchesMarket('TVC:DJI', 'US30'), true);
  assert.equal(symbolMatchesMarket('TVC:USOIL', 'BRENT'), false);
  assert.equal(marketOf('OANDA:XAUUSD').id, 'XAUUSD');
  const map = await tv.getSymbolMap();
  assert.ok(!map.US30 && !map.SP500, 'entrées incohérentes purgées');
  const onDisk = JSON.parse(readFileSync(join(DATA, 'symbols.json'), 'utf8'));
  assert.ok(!onDisk.US30 && !onDisk.SP500, 'purge persistée sur disque');
});

test('résolution par recherche : repli REST quand le dialogue est introuvable (CAC40)', async () => {
  const res = await tv.selectMarketViaSearch(marketById('CAC40'));
  assert.equal(res.ok, true);
  assert.equal(res.symbol, 'EURONEXT:PX1');
  assert.equal(res.via, 'rest');
});

test('résolution : introuvable ni par l\'UI ni par le repli REST → échec propre (NAS100)', async () => {
  const res = await tv.selectMarketViaSearch(marketById('NAS100'));
  assert.equal(res.ok, false);
});

test('mapping résolu : persisté (DATA_DIR/symbols.json) et reconnu par marketOf sans repasser par la recherche', async () => {
  chartState = { symbol: 'OANDA:XAUUSD', resolution: '1' };
  await tv.getCandles({ tfs: ['1'], count: 100, market: 'DAX40' }); // résout DAX40 (recherche), le mémorise, puis restaure XAUUSD
  const map = await tv.getSymbolMap();
  assert.equal(map.DAX40.symbol, 'XETR:DAX');
  assert.ok(existsSync(join(DATA, 'symbols.json')));
  const onDisk = JSON.parse(readFileSync(join(DATA, 'symbols.json'), 'utf8'));
  assert.equal(onDisk.DAX40.symbol, 'XETR:DAX');
  assert.equal(marketOf('XETR:DAX').id, 'DAX40');
});

test('analyse en direct (rotation sur le graphique UNIQUE) : vérifie/bascule le symbole avant chaque lecture, jamais de disposition multi-graphiques', async () => {
  chartState = { symbol: 'OANDA:XAUUSD', resolution: '1' };
  setSymbolCalls = []; allCalls = [];
  const r0 = await tv.getCandles({ tfs: ['1'], count: 100, market: 'XAUUSD' });
  assert.equal(r0.status, 200);
  const openBefore = searchOpens;
  const r1 = await tv.getCandles({ tfs: ['1'], count: 100, market: 'DAX40' });
  assert.equal(r1.status, 200);
  assert.equal(searchOpens, openBefore, 'DAX40 est déjà mémorisé (< 24 h) : bascule directe, pas de nouvelle recherche');
  assert.ok(setSymbolCalls.includes('XETR:DAX'), 'bascule directe vers le symbole déjà résolu de DAX40');
  assert.ok(!allCalls.some((c) => c.includes('setLayout')), 'aucune disposition multi-graphiques créée');
  assert.ok(!allCalls.some((c) => /getAll\(\)\[[1-9]/.test(c)), 'aucun panneau autre que le graphique unique (actif) n\'est jamais référencé');
});

test('analyse complète : un marché introuvable sur TradingView est rapporté en erreur, les autres restent classés', async () => {
  tv._resetFailMap();
  chartState = { symbol: 'OANDA:XAUUSD', resolution: '1' };
  const { results } = await tv.fullScan({ markets: [marketById('XAUUSD'), marketById('NAS100')], tfs: ['1'], count: 100 });
  assert.ok(!results.XAUUSD.errors._market);
  assert.match(results.NAS100.errors._market, /introuvable/);
  tv._resetFailMap();
});

test('cache négatif (10 min) : un marché introuvable n\'est pas rerecherché à chaque cycle en direct ; « Vérifier les marchés » l\'ignore', async () => {
  tv._resetFailMap();
  chartState = { symbol: 'OANDA:XAUUSD', resolution: '1' };
  const before = searchOpens;
  const r1 = await tv.getCandles({ tfs: ['1'], count: 100, market: 'NAS100' });
  assert.equal(r1.status, 409);
  assert.match(r1.body.error, /introuvable.*nouvel essai à \d{2}:\d{2}/);
  const afterFirst = searchOpens;
  assert.ok(afterFirst > before, 'la première tentative interroge bien la recherche');
  const r2 = await tv.getCandles({ tfs: ['1'], count: 100, market: 'NAS100' });
  assert.equal(r2.status, 409);
  assert.equal(searchOpens, afterFirst, 'cache négatif actif : pas de nouvelle recherche dans les 10 minutes');
  assert.equal(r2.body.error, r1.body.error, 'même horaire de nouvel essai (cache figé), pas re-tenté à chaque cycle');
  const { resolved } = await tv.verifyMarkets({ markets: [marketById('NAS100')] });
  assert.ok(searchOpens > afterFirst, '« Vérifier les marchés TradingView » ignore le cache négatif et retente');
  assert.equal(resolved[0].ok, false);
  tv._resetFailMap();
});

test('journal serveur : la résolution réussie d\'un marché (par la recherche) est journalisée une fois, avec le chemin utilisé et le symbole', async () => {
  chartState = { symbol: 'OANDA:XAUUSD', resolution: '1' };
  const logged = [];
  const origLog = console.log;
  console.log = (...args) => logged.push(args.join(' '));
  try {
    await tv.getCandles({ tfs: ['1'], count: 100, market: 'US30' }); // jamais résolu auparavant dans ce fichier
  } finally { console.log = origLog; }
  const line = logged.find((l) => l.includes('US30') && l.includes('OANDA:US30USD'));
  assert.ok(line, 'la résolution de US30 est journalisée avec son symbole');
  assert.match(line, /barre de recherche/);
});
