import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MARKETS, MARKET_IDS, DEFAULT_MARKET, marketById, marketOf, maxChartsFor, TV_PLANS } from '../www/js/markets.js';
import { planFor, DEFAULT_RISK, notifText } from '../www/js/trades.js';
import { detectZones } from '../www/js/engine.js';
import { rankMarket, rankMarkets, MIN_SAMPLE_TRADES } from '../www/js/ranking.js';

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

test('abonnements TradingView : nombre de graphiques maximal par plan', () => {
  assert.equal(maxChartsFor('gratuit'), 1);
  assert.equal(maxChartsFor('essential'), 2);
  assert.equal(maxChartsFor('plus'), 4);
  assert.equal(maxChartsFor('premium'), 8);
  assert.equal(maxChartsFor('expert'), 10);
  assert.equal(maxChartsFor('ultimate'), 16);
  assert.equal(maxChartsFor('inconnu'), TV_PLANS.gratuit.maxCharts);
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

test('classement : marchés à échantillon suffisant (≥ 8 trades) d\'abord, triés par pips puis taux de réussite', () => {
  const mk = (id, trades, pips, winRate) => ({ market: id, label: id, pips, trades, winRate, expectancyPips: trades ? pips / trades : null, proposals: 0, insufficient: trades < MIN_SAMPLE_TRADES, topZones: [], barsPerTf: {} });
  const list = [mk('A', 3, 500, 1), mk('B', 10, 200, 0.6), mk('C', 12, 300, 0.5), mk('D', 9, 300, 0.7)];
  const ranked = rankMarkets(list).map((r) => r.market);
  assert.deepEqual(ranked, ['D', 'C', 'B', 'A'], 'D et C partagent 300 pips : D gagne au taux de réussite ; A (échantillon insuffisant) est classé après malgré 500 pips');
});

test('rankMarket : détecte les zones 5★ et backteste sur les bougies fournies (fonctionne pour n\'importe quel marché du registre)', () => {
  const dax = marketById('DAX40');
  const candles = buildSetup(18000, 0.7 * (18000 / 4275));
  const r = rankMarket(dax, { '5': candles });
  assert.equal(r.market, 'DAX40');
  assert.ok(r.barsPerTf['5'] > 0);
  assert.equal(typeof r.trades, 'number');
});
