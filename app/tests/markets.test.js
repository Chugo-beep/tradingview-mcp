import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MARKETS, MARKET_IDS, DEFAULT_MARKET, marketById, marketOf, registerResolvedAlias, LIVE_CHARTS_OPTIONS, DEFAULT_LIVE_CHARTS } from '../www/js/markets.js';
import { planFor, DEFAULT_RISK, notifText } from '../www/js/trades.js';
import { detectZones } from '../www/js/engine.js';
import { rankMarket, rankMarkets, MIN_SAMPLE_TRADES, choosePolicies, summarizeWithPolicy } from '../www/js/ranking.js';

test('registre des marchés : 11 marchés, XAUUSD par défaut, décimales dérivées du pip', () => {
  assert.equal(MARKETS.length, 11);
  assert.equal(DEFAULT_MARKET, 'XAUUSD');
  assert.ok(MARKET_IDS.includes('EURUSD') && MARKET_IDS.includes('DAX40') && MARKET_IDS.includes('BRENT'));
  assert.equal(marketById('EURUSD').decimals, 5);
  assert.equal(marketById('USDJPY').decimals, 3);
  assert.equal(marketById('XAUUSD').decimals, 2);
  assert.equal(marketById('US30').decimals, 1);
  assert.equal(marketById('xauusd'), marketById('XAUUSD'), 'insensible à la casse');
});

test('marketOf : correspondance par symbole TradingView exact, alias, ou sans préfixe d\'exchange', () => {
  assert.equal(marketOf('OANDA:XAUUSD').id, 'XAUUSD');
  assert.equal(marketOf('OANDA:SPX500USD').id, 'SP500');
  assert.equal(marketOf('TVC:USOIL').id, 'WTI');
  assert.equal(marketOf('TVC:UKOIL').id, 'BRENT');
  assert.equal(marketOf('CAPITALCOM:US30').id, 'US30');
  assert.equal(marketOf('FX:EURUSD').id, 'EURUSD');
  assert.equal(marketOf('XETR:DAX').id, 'DAX40');
  assert.equal(marketOf('INEXISTANT:FOO'), null);
  assert.equal(marketOf(''), null);
});

test('marchés en direct : choisis par l\'utilisateur, 1 à 3, or par défaut', async () => {
  const { sanitizeLiveMarkets, MAX_LIVE_MARKETS, DEFAULT_LIVE_MARKETS } = await import('../www/js/markets.js');
  assert.equal(MAX_LIVE_MARKETS, 3);
  assert.deepEqual(DEFAULT_LIVE_MARKETS, ['XAUUSD']);
  assert.deepEqual(sanitizeLiveMarkets([]), ['XAUUSD']);
  assert.deepEqual(sanitizeLiveMarkets(['eurusd', 'EURUSD', 'FOO', 'DAX40', 'US30', 'WTI']), ['EURUSD', 'DAX40', 'US30']);
  assert.deepEqual(LIVE_CHARTS_OPTIONS, [1, 2, 3, 4]); // ancien réglage conservé pour compatibilité
  assert.equal(DEFAULT_LIVE_CHARTS, 2);
});

test('registerResolvedAlias : un symbole résolu dynamiquement (recherche TradingView) devient reconnu par marketOf', () => {
  assert.equal(marketOf('OANDA:DE30EURSPECIAL'), null);
  registerResolvedAlias('DAX40', 'OANDA:DE30EURSPECIAL');
  assert.equal(marketOf('OANDA:DE30EURSPECIAL').id, 'DAX40');
  assert.equal(marketOf('de30eurspecial').id, 'DAX40', 'sans préfixe, insensible à la casse');
});

// Motif d'achat de référence pour rankMarket : mêmes bougies que le test XAUUSD de trades.test.js
// (K = 0,7), translatées à l'échelle d'un indice pour rester géométriquement valides.
const T0 = 1789603200;
const bar = (i, o, h, l, c) => ({ time: T0 + i * 300, open: o, high: h, low: l, close: c, complete: true });
function buildSetup(base, k) {
  const sc = (v) => Math.round((base + (v - 4275) * k) * 1e6) / 1e6;
  const sbar = (i, o, h, l, c) => bar(i, sc(o), sc(h), sc(l), sc(c));
  const pad = Array.from({ length: 40 }, (_, kk) => bar(kk - 40, base, base + 0.5 * k, base - 0.5 * k, base));
  return [...pad,
    sbar(0, 4275.0, 4276.0, 4273.5, 4274.0), sbar(1, 4274.0, 4274.5, 4271.765, 4273.0), sbar(2, 4273.0, 4274.0, 4272.8, 4272.5),
    sbar(3, 4272.5, 4274.0, 4272.2, 4273.0), sbar(4, 4273.0, 4273.8, 4272.4, 4272.49),
    sbar(5, 4272.495, 4274.050, 4271.675, 4271.930), sbar(6, 4271.935, 4272.485, 4266.535, 4269.455),
    sbar(7, 4269.275, 4278.140, 4269.040, 4278.140), sbar(8, 4278.290, 4286.895, 4278.290, 4285.085),
  ];
}

test('pips par marché : planFor calcule le risque (slPips) avec le pip du marché fourni dans `risk`', () => {
  const eur = marketById('EURUSD'), dax = marketById('DAX40');
  const zone = { direction: 'BUY', category: 'day', zoneHigh: 1.10050, zoneLow: 1.09950, atr: 0.0020 };
  const pEur = planFor(zone, { ...DEFAULT_RISK, pipSize: eur.pip });
  assert.equal(Math.round(pEur.riskPx / eur.pip), Math.round(pEur.slPips));
  assert.equal(Math.round(pEur.slPips * 1e6) / 1e6, 13, 'EURUSD (pip 0,0001) : 0,0013 de risque en prix = 13 pips');
  assert.equal(Math.round(pEur.riskPx * 1e4) / 1e4, 0.0013);
  // même zone, pip DAX40 (1 point, 10 000× plus grand que le pip EURUSD) → bien moins de "pips"
  const pDax = planFor(zone, { ...DEFAULT_RISK, pipSize: dax.pip });
  assert.ok(pDax.slPips < pEur.slPips);
});

test('planFor : SL > 100 pips refuse la zone, quel que soit le pip du marché (XAUUSD)', () => {
  const gold = marketById('XAUUSD');
  const zone = { direction: 'BUY', category: 'day', zoneHigh: 4300, zoneLow: 4285, atr: 60 };
  const p = planFor(zone, { ...DEFAULT_RISK, pipSize: gold.pip });
  assert.equal(Math.round(p.slPips), 188);
  assert.equal(p.slOk, false);
  assert.match(p.reason, /188 pips > 100 pips/);
});

test('notifText : GOLD par défaut (XAUUSD, 2 décimales) ; libellé et décimales du marché sinon', () => {
  const t = { dir: 'BUY', category: 'day', entry: 1.10500, sl: 1.10000, tp1: 1.11500, tp2: 1.12500, tp3: 1.14000, slPips: 50, tp1Pips: 100, entryMode: 'limit' };
  const defTitle = notifText('new', t, { tfLabel: '1h' }).title;
  assert.match(defTitle, /GOLD/);
  assert.match(defTitle, /1\.10$/); // 2 décimales par défaut (XAUUSD)

  const eur = marketById('EURUSD');
  const n = notifText('new', t, { tfLabel: '1h', market: eur });
  assert.match(n.title, /EUR\/USD/);
  assert.doesNotMatch(n.title, /GOLD/);
  assert.match(n.title, /1\.10500$/); // 5 décimales (pip 0,0001)
});

test('classement : échantillon suffisant d\'abord, trié par borne basse de l\'intervalle de confiance (R), puis R, puis pips', () => {
  const mk = (id, trades, pips, ciLo, expR) => ({ market: id, label: id, pips, trades, winRate: 0.5, expectancyR: expR, ciR: [ciLo, ciLo + 1], proposals: 0, insufficient: trades < MIN_SAMPLE_TRADES, topZones: [], barsPerTf: {} });
  const list = [mk('A', 3, 500, 2, 3), mk('B', 40, 200, -0.2, 0.3), mk('C', 50, 300, 0.1, 0.2), mk('D', 45, 100, 0.1, 0.4)];
  const ranked = rankMarkets(list).map((r) => r.market);
  assert.deepEqual(ranked, ['D', 'C', 'B', 'A'], 'D et C : même borne basse, D gagne à l\'espérance R ; A (échantillon insuffisant) classé après malgré 500 pips');
});

test('rankMarket : détecte les zones 5★ et backteste sur les bougies fournies (fonctionne pour n\'importe quel marché du registre)', () => {
  const dax = marketById('DAX40');
  const candles = buildSetup(18000, 0.7 * (18000 / 4275));
  const r = rankMarket(dax, { '5': candles }, { risk: { strategyMode: 'ob5' } });
  assert.equal(r.market, 'DAX40');
  assert.ok(r.barsPerTf['5'] > 0);
  assert.equal(typeof r.trades, 'number');
});

test('backtest : une zone 5★ à sa naissance puis retestée reste évaluée (⭐4 « vierge » jugée à la clôture de C3, pas aujourd\'hui)', () => {
  const gold = marketById('XAUUSD');
  const base = buildSetup(4275, 0.7);
  const fresh = rankMarket(gold, { '5': base }, { risk: { strategyMode: 'ob5' } });
  assert.equal(fresh.funnel.untouched5, 1, 'zone vierge 5★ proposable');
  const retested = [...base, bar(9, 4285, 4285.5, 4278, 4279), bar(10, 4279, 4279.5, 4272.8, 4274), bar(11, 4274, 4278, 4273.5, 4277.8)];
  const r = rankMarket(gold, { '5': retested }, { risk: { strategyMode: 'ob5' } });
  assert.equal(r.funnel.untouched, 0, 'la zone a été retestée : plus vierge aujourd\'hui');
  assert.equal(r.funnel.fiveAtBirth, 1, 'mais elle était 5★ à sa naissance : elle entre dans le backtest');
  assert.equal(r.proposals, 0, 'et n\'est plus proposée en direct');
});

test('règle d\'annulation : « tp1 » annule après l\'impulsion, « keep » garde la zone pour son 1er retour', async () => {
  const { detectZones } = await import('../www/js/engine.js');
  const { simulateZone, DEFAULT_RISK: R } = await import('../www/js/trades.js');
  const base = buildSetup(4275, 0.7);
  // retour dans l'OB après l'impulsion (qui a dépassé TP1), bougie de réaction haussière, puis hausse
  const c = [...base, bar(9, 4285, 4285.5, 4278, 4279), bar(10, 4279, 4279.5, 4272.8, 4274), bar(11, 4272.9, 4274.2, 4272.6, 4274.0)];
  for (let i = 12; i < 40; i++) { const o = 4274 + (i - 12) * 2; c.push(bar(i, o, o + 2.2, o - 0.3, o + 2)); }
  const z = detectZones(c, { timeframe: '5', currentPrice: c.at(-1).close }).zones[0];
  const risk = { ...R, pipSize: 0.1, contractSize: 100 };
  const a = simulateZone(z, c, { ...risk, cancelPolicy: 'tp1' }, { currentPrice: c.at(-1).close });
  const b = simulateZone(z, c, { ...risk, cancelPolicy: 'keep' }, { currentPrice: c.at(-1).close });
  assert.equal(a.state, 'CANCELLED');
  assert.match(a.reason, /TP1 atteint sans entrée/);
  assert.notEqual(b.state, 'CANCELLED', 'keep : l\'ordre attend le retour dans la zone');
  assert.ok(b.fillPrice != null, 'keep : entrée sur la bougie de réaction au retour');
});

test('choosePolicies : le challenger « keep » n\'est adopté que s\'il gagne plus SANS dégrader le risque, et reste meilleur sur la période récente', () => {
  const mk = (cat, list) => list.map(([pips, r, t]) => ({ cat, pips, r, t }));
  // intraday : keep gagne nettement plus, PF et drawdown relatif meilleurs → adopté
  // intraday : 32 trades par règle (seuil 30) ; keep gagne nettement plus, PF et drawdown relatif meilleurs → adopté
  const alt = (n, win, loss) => Array.from({ length: n }, (_, i) => (i % 2 ? loss : win).concat(i + 1));
  const good = { byPolicy: {
    tp1: mk('day', alt(32, [100, 1], [-50, -1])),
    keep: mk('day', alt(32, [200, 2], [-50, -1])),
  } };
  // swing : keep gagne plus au total mais perd sur la période récente → refusé (champion conservé)
  const stale = { byPolicy: {
    tp1: mk('swing', Array.from({ length: 10 }, (_, i) => [i % 2 ? -40 : 60, i % 2 ? -1 : 1.5, i + 1])),
    keep: mk('swing', [...Array.from({ length: 6 }, (_, i) => [300, 3, i + 1]), ...Array.from({ length: 6 }, (_, i) => [-60, -1, i + 7])]),
  } };
  const { policy, stats } = choosePolicies([good, stale]);
  assert.equal(policy.day, 'keep');
  assert.equal(policy.swing, 'tp1');
  assert.equal(stats.swing.checks.recent, false);
  assert.equal(policy.scalp, 'tp1', 'aucun échantillon : champion prudent conservé');
});

test('choosePolicies : moins de 30 trades → pas d\'adoption (différence non distinguable du bruit)', () => {
  const mk = (cat, n, w) => Array.from({ length: n }, (_, i) => ({ cat, pips: i % 2 ? -50 : w, r: i % 2 ? -1 : w / 50, t: i + 1 }));
  const { policy } = choosePolicies([{ byPolicy: { tp1: mk('day', 10, 100), keep: mk('day', 10, 300) } }]);
  assert.equal(policy.day, 'tp1');
});

test('summarizeWithPolicy : les trades Scalp sont comptés et l\'historique est fourni (régression clé scalp/scalping)', () => {
  const raw = { market: 'X', label: 'X', barsPerTf: {}, funnel: {}, viableZones: [],
    byPolicy: { tp1: [{ cat: 'scalp', pips: 10, r: 1, t: 1 }, { cat: 'day', pips: -5, r: -1, t: 2 }], keep: [] } };
  const s = summarizeWithPolicy(raw, {});
  assert.equal(s.trades, 2);
  assert.equal(s.history.length, 2);
  assert.equal(s.history[0].t, 2, 'historique du plus récent au plus ancien');
  assert.equal(s.history[0].market, 'X');
});

test('summarizeWithPolicy : pips/trades du marché recalculés avec la règle retenue par catégorie', () => {
  const raw = { market: 'X', label: 'X', barsPerTf: {}, funnel: {}, viableZones: [{ cat: 'day', pending: { tp1: false, keep: true }, zone: { c1Time: 1 } }],
    byPolicy: { tp1: [{ cat: 'day', pips: 10, r: 1, t: 1 }], keep: [{ cat: 'day', pips: 30, r: 1, t: 1 }, { cat: 'day', pips: -10, r: -1, t: 2 }] } };
  const a = summarizeWithPolicy(raw, {});
  const b = summarizeWithPolicy(raw, { day: 'keep' });
  assert.equal(a.trades, 1); assert.equal(a.pips, 10); assert.equal(a.proposals, 0);
  assert.equal(b.trades, 2); assert.equal(b.pips, 20); assert.equal(b.proposals, 1);
});
