import test from 'node:test';
import assert from 'node:assert/strict';
import { rankMarket } from '../www/js/ranking.js';
import { marketById, marketRisk } from '../www/js/markets.js';
import { planFor, money, suggestedLot, finalize, advance, newPosition, POS, DEFAULT_RISK } from '../www/js/trades.js';
import { summarize, verdictOf, rng, randomBenchmark, bootstrapCI } from '../www/js/stats.js';
import { annotateHtf } from '../www/js/engine.js';
import { riskGuards } from '../www/js/agents.js';

function walk(n, p0, vol, sec, seed) {
  const r = rng(seed); const out = []; let p = p0;
  for (let i = 0; i < n; i++) {
    const o = p; let h = o, l = o;
    for (let k = 0; k < 6; k++) { p += (r() - 0.5) * 2 * vol / Math.sqrt(2); h = Math.max(h, p); l = Math.min(l, p); }
    out.push({ time: 1.7e9 + i * sec, open: o, high: h, low: l, close: p, complete: true });
  }
  return out;
}

test('classement : les zones exécutées sont comptées (régression : 0 trade à cause de l\'étoile « vierge »)', () => {
  const r = rankMarket(marketById('XAUUSD'), { '5': walk(20000, 3700, 2, 300, 3), '60': walk(1700, 3700, 7, 3600, 4), '240': walk(500, 3700, 14, 14400, 5) }, { risk: { targetMode: 'pips', strategyMode: 'ob5' }, benchmarkRuns: 10 });
  assert.ok(r.trades > 0, 'au moins un trade clôturé');
  assert.equal(r.costPips, 3, 'spread XAUUSD par défaut');
  assert.ok(r.verdict && typeof r.verdict.label === 'string');
  assert.equal(r.insufficient, true, 'moins de 30 trades → insuffisant');
});

test('money : DAX coté en EUR (pas de double conversion), USD/JPY converti au cours', () => {
  const dax = { lot: 1, ...marketRisk(marketById('DAX40')) };
  assert.equal(money(10, dax, 1.1).eur, 10);
  const jpy = { lot: 1, ...marketRisk(marketById('USDJPY'), { quotePrice: 150 }) };
  const m = money(10, jpy, 1.25);
  assert.ok(Math.abs(m.usd - 10 * 1000 / 150) < 1e-9, '1 pip = 1000 JPY = 6,67 $ à 150');
  const xau = { lot: 1, ...marketRisk(marketById('XAUUSD')) };
  assert.equal(money(10, xau, 1).usd, 100);
});

test('lot conseillé : 1 % de 10 000 € sur un stop de 50 pips d\'or (+3 pips de coût) avec EUR/USD = 1', () => {
  const risk = { ...DEFAULT_RISK, ...marketRisk(marketById('XAUUSD')), capital: 10000, riskPct: 1 };
  // 1 lot : 53 pips × 10 $ = 530 € → 100 € / 530 € = 0,188… → 0,18 lot
  assert.equal(suggestedLot(50, risk, 1), 0.18);
  assert.equal(suggestedLot(50, { ...risk, capital: 0 }, 1), null);
});

test('coûts : le spread est déduit des pips et du R d\'une position exécutée', () => {
  const pos = { dir: 'BUY', state: POS.SL, fillPrice: 100, exitPrice: 99, hits: 0, riskPips: 10, costPips: 2 };
  const f = finalize(pos, { slPips: 10, riskPx: 1 }, null, { pipSize: 0.1 });
  assert.equal(f.grossPips, -10);
  assert.equal(f.pips, -12);
  assert.ok(Math.abs(f.r + 1.2) < 1e-9);
});

const zone = (over = {}) => ({ direction: 'BUY', zoneLow: 100, zoneHigh: 101, atr: 2, category: 'day', timeframe: '60', ...over });

test('mode adaptatif : objectifs en multiples de R, stop maximal en ATR', () => {
  const risk = { ...DEFAULT_RISK, pipSize: 0.1, targetMode: 'atr' };
  const p = planFor(zone(), risk);
  const R = p.entry - p.sl;
  assert.ok(Math.abs(p.tp1 - (p.entry + 1.5 * R)) < 1e-9);
  assert.ok(Math.abs(p.tp3 - (p.entry + 5 * R)) < 1e-9);
  assert.equal(p.slOk, true);
  assert.ok(Math.abs(p.maxSlPips - 50) < 1e-9, '2,5 × ATR 2 = 5 $ = 50 pips');
  const big = planFor(zone({ zoneLow: 90 }), risk);
  assert.equal(big.slOk, false, 'zone de 11 $ > 2,5 ATR');
  // mode fixe historique inchangé
  const fixed = planFor(zone(), { ...risk, targetMode: 'pips' });
  assert.ok(Math.abs(fixed.tp1 - (fixed.entry + 10)) < 1e-9, '+100 pips = +10 $');
});

test('stop trop serré face au spread : refusé', () => {
  const p = planFor(zone({ zoneLow: 100.9, atr: 0.2 }), { ...DEFAULT_RISK, pipSize: 0.1, costPips: 3 });
  assert.equal(p.slOk, false);
  assert.match(p.reason, /spread/);
});

test('entrée confirmation : la bougie de réaction est jugée sur l\'UT de la zone même si le 1m est disponible', () => {
  const plan = { entry: 101, sl: 99.9, tp1: 111, tp2: 121, tp3: 136, rr: 1, riskPx: 1.1, entryMode: 'confirmation', slOk: true, maxSlPips: 100 };
  const pos = newPosition({ id: 'x', direction: 'BUY' }, plan);
  // bougie 1h baissière qui touche la zone ; à l'intérieur, une bougie 1m haussière
  const H = { time: 3600, open: 102, high: 102, low: 100.5, close: 100.8, complete: true };
  const m1 = [];
  for (let i = 0; i < 60; i++) m1.push({ time: 3600 + i * 60, open: 101, high: 101.2, low: 100.5, close: i === 30 ? 101.1 : 100.9, complete: true });
  m1[30].open = 100.6; // 1m haussière
  advance(pos, [H], { m1, tfSec: 3600, pipSize: 0.1 });
  assert.equal(pos.state, POS.PENDING, 'bougie 1h baissière : pas encore de réaction');
});

test('stats : verdict prudent, intervalle bootstrap déterministe', () => {
  assert.equal(verdictOf(10, [0.1, 0.5]).level, 'insuffisant');
  assert.equal(verdictOf(150, [0.05, 0.4]).level, 'avantage');
  assert.equal(verdictOf(150, [-0.1, 0.4]).level, 'neutre');
  const xs = Array.from({ length: 50 }, (_, i) => (i % 2 ? 1 : -1));
  assert.deepEqual(bootstrapCI(xs), bootstrapCI(xs));
  const s = summarize([{ r: 1, t: 1 }, { r: -1, t: 2 }, { r: -1, t: 3 }, { r: 2, t: 4 }]);
  assert.equal(s.n, 4); assert.equal(s.maxDrawdownR, 2); assert.equal(s.maxLosingStreak, 2); assert.equal(s.profitFactor, 1.5);
});

test('référence hasard : espérance proche de 0 − coût sur une marche aléatoire', () => {
  const c = walk(6000, 3700, 2, 300, 9);
  const tpl = Array.from({ length: 40 }, () => ({ riskPx: 3, rr: 1.5, rr2: 3, rr3: 5, pipSize: 0.1, costPips: 0 }));
  const b = randomBenchmark(c, tpl, { runs: 40 });
  const m = b.meanR.reduce((a, x) => a + x, 0) / b.meanR.length;
  assert.ok(Math.abs(m) < 0.3, `moyenne ${m}`);
});

test('tendance de fond : jamais une bougie de l\'UT supérieure non clôturée à la fin de C3', () => {
  // 4h : 3 bougies haussières puis une énorme baissière qui commence AVANT la fin de C3 mais finit après
  const h4 = [];
  let p = 100;
  for (let i = 0; i < 40; i++) { h4.push({ time: i * 14400, open: p, high: p + 2, low: p - 0.5, close: p + 1.5, complete: true }); p += 1.5; }
  h4.push({ time: 40 * 14400, open: p, high: p, low: p - 80, close: p - 80, complete: true });
  const z = { direction: 'BUY', timeframe: '60', c3Time: 40 * 14400 + 3600 }; // C3 clôture pendant la 41e bougie 4h
  annotateHtf([z], { '240': h4 });
  assert.equal(z.htf.tf, '240');
  assert.equal(z.htf.dir, 1, 'la bougie 4h en cours (baissière) est ignorée');
});

test('garde-fous : exposition corrélée au dollar et perte journalière max', () => {
  const now = Date.UTC(2026, 8, 28, 12);
  const journal = { entries: [
    { followed: true, state: POS.OPEN, market: 'XAUUSD', dir: 'BUY', corrGroup: 'USD' },
    { followed: true, state: POS.SL, market: 'EURUSD', dir: 'BUY', exitTime: now / 1000 - 60, pips: -40, pipSize: 0.0001, contractSize: 100000, lot: 1, quote: 'USD' },
  ] };
  const g = riskGuards(journal, [], now, { capital: 10000, maxDailyLossPct: 3, eurUsd: 1 });
  assert.equal(g.correlated('EURUSD', 'BUY'), true, 'achat EUR/USD = même pari (dollar baissier) que l\'achat d\'or');
  assert.equal(g.correlated('USDJPY', 'SELL'), true);
  assert.equal(g.correlated('USDJPY', 'BUY'), false);
  assert.equal(g.correlated('SP500', 'BUY'), false);
  assert.equal(g.dailyLossLimit, true, '400 € perdus ≥ 3 % de 10 000 €');
  assert.equal(g.blockNew, true);
});
