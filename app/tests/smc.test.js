import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from './helpers-smc.mjs';
import { detectSmcSetups, fractals, structureEvents, fibAt } from '../www/js/smc.js';
import { planFor, simulateZone, advance, newPosition, finalize, POS, DEFAULT_RISK } from '../www/js/trades.js';
import { marketById, marketRisk } from '../www/js/markets.js';
import { TF_SECONDS } from '../www/js/engine.js';

const data = build(120, 97);
const risk = { ...DEFAULT_RISK, ...marketRisk(marketById('XAUUSD')) };

test('SMC : chaque setup respecte biais HTF, Fibonacci, R:R ≥ 1:3 et l\'ordre SL < entrée < TP1 ≤ TP2', () => {
  const { setups, funnel } = detectSmcSetups(data, { marketId: 'XAUUSD' });
  assert.ok(funnel.pois > 0, 'des POI HTF sont détectés');
  for (const z of setups) {
    const m = z.smc, buy = z.direction === 'BUY';
    assert.equal(m.fib.bias, z.direction);
    if (buy) { assert.ok(m.fib.poiLevel >= 0 && m.fib.poiLevel < 0.5, 'POI en Discount'); assert.ok(m.sl < m.entry && m.entry < m.tp1 && m.tp1 <= m.tp2); }
    else { assert.ok(m.fib.poiLevel > 0.5 && m.fib.poiLevel <= 1, 'POI en Premium'); assert.ok(m.sl > m.entry && m.entry > m.tp1 && m.tp1 >= m.tp2); }
    assert.ok(m.micro.retracement >= 0.5, 'micro-zone en Discount/Premium de la jambe LTF');
    assert.equal(m.valid, m.rr >= 3);
    assert.ok(m.choch.time >= m.poi.touchTime, 'CHoCH après le contact du POI');
  }
});

test('SMC : aucune information future (setups identiques sur l\'historique tronqué)', () => {
  const opts = { marketId: 'XAUUSD', smc: { poiLookbackBars: 100000 } };
  const full = detectSmcSetups(data, opts).setups;
  const T = data['5'][Math.floor(data['5'].length * 0.7)].time;
  const cut = {};
  for (const [tf, arr] of Object.entries(data)) cut[tf] = arr.filter((c) => c.time + TF_SECONDS[tf] <= T);
  const part = new Map(detectSmcSetups(cut, opts).setups.map((z) => [z.id, z]));
  const known = full.filter((z) => z.c3Time + TF_SECONDS[z.timeframe] <= T);
  assert.ok(known.length > 0, 'au moins un setup connu avant la coupure');
  for (const z of known) {
    const p = part.get(z.id);
    assert.ok(p, `setup ${z.id} présent sur l'historique tronqué`);
    for (const k of ['entry', 'sl', 'tp1', 'tp2', 'rr']) assert.equal(p.smc[k], z.smc[k], `${k} identique`);
  }
});

test('SMC : plan = ordre limite, 50 % à TP1 puis stop au point mort, reste à TP2 ; rejet si R:R < 1:3', () => {
  const z = { id: 'x', direction: 'BUY', category: 'day', timeframe: '15', c3Time: 0, smc: { entry: 100, sl: 99, tp1: 101.5, tp2: 104, minRR: 3, expiresAt: null } };
  const p = planFor(z, { ...DEFAULT_RISK, pipSize: 0.1, costPips: 0 });
  assert.equal(p.entryMode, 'limit'); assert.equal(p.slOk, true); assert.equal(p.rr3, 4);
  const pos = newPosition(z, p);
  // exécution, TP1, retour au point mort
  const t = (i, o, h, l, c) => ({ time: i * 900, open: o, high: h, low: l, close: c, complete: true });
  advance(pos, [t(1, 100.5, 100.6, 99.9, 100.2), t(2, 100.2, 101.6, 100.1, 101.4), t(3, 101.4, 101.4, 99.95, 100)], { pipSize: 0.1 });
  assert.equal(pos.state, POS.TP); assert.equal(pos.exitKind, 'TP1 puis BE');
  const f = finalize(pos, p, null, { pipSize: 0.1 });
  // 50 % × +15 pips + 50 % × +3 pips (BE = entrée + 3 pips)
  assert.ok(Math.abs(f.pips - (0.5 * 15 + 0.5 * 3)) < 1e-9);
  const bad = planFor({ ...z, smc: { ...z.smc, tp2: 102.5 } }, { ...DEFAULT_RISK, pipSize: 0.1 });
  assert.equal(bad.slOk, false); assert.match(bad.reason, /1:3/);
});

test('SMC : un ordre limite non exécuté expire', () => {
  const z = { id: 'y', direction: 'SELL', category: 'day', timeframe: '15', c3Time: 0, smc: { entry: 100, sl: 101, tp1: 98.5, tp2: 96, minRR: 3, expiresAt: 2700 } };
  const p = planFor(z, { ...DEFAULT_RISK, pipSize: 0.1 });
  const pos = newPosition(z, p);
  advance(pos, [{ time: 900, open: 99, high: 99.5, low: 98.9, close: 99.2 }, { time: 2700, open: 99.2, high: 99.4, low: 99, close: 99.1 }], { pipSize: 0.1 });
  assert.equal(pos.state, POS.CANCELLED); assert.match(pos.reason, /expiré/);
});

test('structure HTF : un BOS n\'utilise que des swings confirmés (fractales connues 2 bougies après)', () => {
  const c = data.D;
  const { highs } = fractals(c, 2);
  for (const h of highs) assert.equal(h.known, h.i + 2);
  const { events } = structureEvents(c, 2);
  assert.ok(events.length > 0);
  const f = fibAt({ c, step: 86400, events, tf: 'D' }, c.at(-1).time + 86400);
  assert.ok(f && f.high > f.low && (f.bias === 'BUY' || f.bias === 'SELL'));
});

test('classement : la stratégie SMC est utilisée par défaut et produit son entonnoir', async () => {
  const { rankMarket } = await import('../www/js/ranking.js');
  const r = rankMarket(marketById('XAUUSD'), data, { benchmarkRuns: 5 });
  assert.equal(r.strategyMode, 'smc');
  assert.equal(r.funnel.strategy, 'smc');
  assert.equal(typeof r.trades, 'number');
});
