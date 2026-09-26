import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectZones, analyze, STATUS } from '../www/js/engine.js';

const T0 = 1789603200; // 2026-09-17 00:00 UTC
const bar = (i, o, h, l, c, complete = true) => ({ time: T0 + i * 300, open: o, high: h, low: l, close: c, complete });

// Reproduit TRADE-20260917-0000-5-BUY du journal (history/trade-zones-2026-09-17.md)
function buySetup() {
  return [
    bar(0, 4275.0, 4276.0, 4273.5, 4274.0),
    bar(1, 4274.0, 4274.5, 4271.765, 4273.0), // niveau de liquidité
    bar(2, 4273.0, 4274.0, 4272.8, 4272.5),
    bar(3, 4272.5, 4274.0, 4272.2, 4273.0),
    bar(4, 4273.0, 4273.8, 4272.4, 4272.49),
    bar(5, 4272.495, 4274.050, 4271.675, 4271.930), // P
    bar(6, 4271.935, 4272.485, 4266.535, 4269.455), // C1
    bar(7, 4269.275, 4278.140, 4269.040, 4278.140), // C2
    bar(8, 4278.290, 4286.895, 4278.290, 4285.085), // C3
  ];
}

test('reproduit la zone BUY du journal (gap 5.805)', () => {
  const candles = [...buySetup(), bar(9, 4285, 4290, 4281, 4288)];
  const { zones } = detectZones(candles, { timeframe: '5' });
  const z = zones.find((x) => x.direction === 'BUY' && x.c1Time === T0 + 6 * 300);
  assert.ok(z, 'zone détectée');
  assert.equal(z.zoneLow, 4266.535);
  assert.equal(z.zoneHigh, 4272.485);
  assert.equal(z.gap, 5.805);
  assert.equal(z.liquidity.level, 4271.765);
  assert.equal(z.status, STATUS.VIABLE);
  assert.equal(z.entry, 4272.485);
});

test('un retest après C3 rend la zone non viable', () => {
  const candles = [...buySetup(), bar(9, 4285, 4286, 4272.0, 4280)];
  const z = detectZones(candles, { timeframe: '5' }).zones.find((x) => x.direction === 'BUY');
  assert.equal(z.status, STATUS.TOUCHEE);
  assert.equal(z.viable, false);
  assert.equal(z.firstTouch.low, 4272.0);
});

test('égalité exacte des mèches = pas d\'imbalance', () => {
  const c = buySetup();
  c[8] = bar(8, 4272.485, 4286.895, 4272.485, 4285.085);
  assert.equal(detectZones(c, { timeframe: '5' }).zones.filter((x) => x.direction === 'BUY').length, 0);
});

test('bougie en cours qui touche la zone = non viable', () => {
  const candles = [...buySetup(), bar(9, 4285, 4286, 4272.4, 4275, false)];
  const z = detectZones(candles, { timeframe: '5' }).zones.find((x) => x.direction === 'BUY');
  assert.equal(z.status, STATUS.TOUCHEE);
});

test('clôture sous la zone = cassée', () => {
  const candles = [...buySetup(), bar(9, 4285, 4286, 4260, 4262)];
  const z = detectZones(candles, { timeframe: '5' }).zones.find((x) => x.direction === 'BUY');
  assert.equal(z.status, STATUS.INVALIDEE);
});

test('liquidité non balayée = rejet', () => {
  const c = buySetup();
  c[5] = bar(5, 4272.495, 4274.050, 4271.9, 4271.930); // P.low ne passe pas sous 4271.765
  assert.equal(detectZones(c, { timeframe: '5' }).zones.filter((x) => x.direction === 'BUY').length, 0);
});

test('zone SELL symétrique (TRADE-20260917-1910-5-SELL)', () => {
  const s = [
    bar(0, 4352, 4354.5, 4351, 4353), bar(1, 4353, 4355.650, 4352, 4354), bar(2, 4354, 4355, 4353, 4354.2),
    bar(3, 4354.2, 4355.2, 4353.5, 4354.5), bar(4, 4354.5, 4355.1, 4353.9, 4354.3),
    bar(5, 4354.275, 4356.120, 4353.830, 4354.830), // P
    bar(6, 4354.805, 4355.840, 4353.595, 4354.845), // C1 haussière
    bar(7, 4354.820, 4354.820, 4349.075, 4352.130),
    bar(8, 4352.125, 4352.125, 4347.450, 4347.620), // C3
    bar(9, 4347.6, 4350, 4345, 4346),
  ];
  const z = detectZones(s, { timeframe: '5' }).zones.find((x) => x.direction === 'SELL');
  assert.ok(z);
  assert.equal(z.gap, 1.47);
  assert.equal(z.liquidity.level, 4355.65);
  assert.equal(z.status, STATUS.VIABLE);
});

test('analyze combine les timeframes et trie les viables en premier', () => {
  const r = analyze({ '5': [...buySetup(), bar(9, 4285, 4286, 4272.0, 4280)], '15': [...buySetup(), bar(9, 4285, 4290, 4281, 4288)] });
  assert.equal(r.zones[0].status, STATUS.VIABLE);
  assert.equal(r.zones[0].timeframe, '15');
});
