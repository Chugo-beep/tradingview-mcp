import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluateTopdown, prepTopdownTf, annotateTopdown, levelOf, TOPDOWN_POINTS, structureMarks } from '../www/js/topdown.js';
import { macroState, macroAlignment, titleKey, familyOf, surpriseOf } from '../www/js/macro.js';

// ── données synthétiques : tendance haussière en escalier (sommets / creux croissants) ──
function staircase(n, step, t0 = 1_700_000_000, start = 100) {
  const c = [];
  let p = start;
  for (let i = 0; i < n; i++) {
    const phase = i % 10;
    const up = phase < 6; // 6 bougies de hausse, 4 de repli : structure haussière
    const o = p, cl = up ? p + 1 : p - 0.6;
    c.push({ time: t0 + i * step, open: o, high: Math.max(o, cl) + 0.2, low: Math.min(o, cl) - 0.2, close: cl, volume: 1, complete: true });
    p = cl;
  }
  return c;
}

test('topdown : points = 100 et niveaux A/B/C/D', () => {
  assert.equal(Object.values(TOPDOWN_POINTS).reduce((a, b) => a + b, 0), 100);
  assert.equal(levelOf(100), 'A'); assert.equal(levelOf(70), 'A'); assert.equal(levelOf(69), 'B');
  assert.equal(levelOf(50), 'B'); assert.equal(levelOf(30), 'C'); assert.equal(levelOf(29), 'D');
});

test('topdown : tendance HTF haussière → OB d\'achat aligné, OB de vente non aligné', () => {
  const h1 = staircase(400, 3600);
  const m15 = staircase(1600, 900);
  const prepared = { '15': prepTopdownTf(m15, '15'), '60': prepTopdownTf(h1, '60') };
  const mid = m15[1200];
  const base = { timeframe: '15', zoneLow: mid.low, zoneHigh: mid.high, c1Time: mid.time, gap: 0.5, atr: 1, candles: { C2: mid } };
  const buy = evaluateTopdown({ ...base, direction: 'BUY' }, prepared, m15.at(-1).time + 900);
  const sell = evaluateTopdown({ ...base, direction: 'SELL' }, prepared, m15.at(-1).time + 900);
  assert.equal(buy.chain[0].tf, '60');
  assert.equal(buy.chain[0].trend, 'BUY');
  assert.ok(buy.parts.htfTrend > 0 && sell.parts.htfTrend === 0);
  assert.ok(buy.score > sell.score);
});

test('topdown : aucune information future (le résultat ne change pas si on ajoute des bougies après la décision)', () => {
  const m15 = staircase(1600, 900);
  const h1 = staircase(400, 3600);
  const touch = m15[1300];
  const z = { timeframe: '15', direction: 'BUY', zoneLow: m15[1200].low, zoneHigh: m15[1200].high, c1Time: m15[1200].time, gap: 0.5, atr: 1, candles: { C2: m15[1201] }, firstTouch: { time: touch.time } };
  // série tronquée juste avant la décision vs série complète (qui contient le futur)
  const cut = (arr, t) => arr.filter((c) => c.time < t);
  const a = evaluateTopdown(z, { '15': prepTopdownTf(cut(m15, touch.time), '15'), '60': prepTopdownTf(cut(h1, touch.time), '60') }, touch.time);
  const b = evaluateTopdown(z, { '15': prepTopdownTf(m15, '15'), '60': prepTopdownTf(h1, '60') }, touch.time);
  assert.deepEqual({ ...a, chain: a.chain.map((r) => ({ ...r })) }, { ...b, chain: b.chain.map((r) => ({ ...r })) });
});

test('topdown : annotateTopdown et structureMarks (BOS / CHoCH) fonctionnent sur des bougies brutes', () => {
  const m15 = staircase(600, 900);
  const zones = [{ timeframe: '15', direction: 'BUY', zoneLow: m15[500].low, zoneHigh: m15[500].high, c1Time: m15[500].time, gap: 0.3, atr: 1, candles: { C2: m15[501] } }];
  annotateTopdown(zones, { '15': m15 }, m15.at(-1).time);
  assert.ok(zones[0].topdown && ['A', 'B', 'C', 'D'].includes(zones[0].topdown.level));
  const marks = structureMarks(m15, '15', 5);
  assert.ok(marks.length > 0 && marks.every((m) => ['BOS', 'CHoCH'].includes(m.kind)));
});

// ── macro ──
const MODEL = {
  keys: { 'US:Inflation Rate MoM': { sigma: 0.1 }, 'US:Non Farm Payrolls': { sigma: 60 }, 'US:Unemployment Rate': { sigma: 0.1 }, 'US:PPI MoM': { sigma: 0.2 } },
  sensitivity: {
    NAS100: {
      'US:Inflation Rate MoM': { b60: -2, d1: 0, d2: 0 },
      'US:PPI MoM': { b60: 0, d1: 0, d2: -1.5 },
      'US:Non Farm Payrolls': { b60: -0.5, d1: 0, d2: 0 },
      'US:Unemployment Rate': { b60: 0.4, d1: 0, d2: 0 },
    },
  },
  links: [{ from: 'US:PPI MoM', to: 'US:Inflation Rate MoM', rho: 0.5, n: 80 }],
};
const T0 = 1_780_000_000;
const ev = (title, dt, actual, forecast, previous = null) => ({ country: 'US', title, t: T0 + dt, actual, forecast, previous });

test('macro : clés, familles, surprise standardisée', () => {
  assert.equal(titleKey('US', 'GDP Growth Rate QoQ Adv'), 'US:GDP Growth Rate QoQ');
  assert.equal(familyOf('Core PCE Price Index YoY'), 'inflation');
  assert.equal(familyOf('Fed Interest Rate Decision'), 'taux');
  assert.equal(surpriseOf(ev('Inflation Rate MoM', 0, 0.5, 0.3), MODEL).toFixed(2), '2.00');
});

test('macro : une annonce future ou non publiée ne compte jamais', () => {
  const s = macroState([ev('PPI MoM', 3600, 0.6, 0.2), ev('PPI MoM', -3600, null, 0.2)], 'NAS100', MODEL, T0);
  assert.equal(s.contributions.length, 0);
  assert.equal(s.level, 'neutre');
});

test('macro : dérive persistante (PPI) → biais, décroissance puis extinction après 3 jours', () => {
  const ppiHot = [ev('PPI MoM', -2 * 3600, 0.6, 0.2)]; // +2 σ, il y a 2 h
  const s1 = macroState(ppiHot, 'NAS100', MODEL, T0);
  assert.ok(s1.bias < 0, 'PPI supérieur aux attentes → dérive baissière mesurée');
  assert.equal(s1.level, 'baissier');
  assert.equal(macroAlignment(s1, 'SELL'), 'favorable');
  assert.equal(macroAlignment(s1, 'BUY'), 'défavorable');
  const s2 = macroState(ppiHot, 'NAS100', MODEL, T0 + 2 * 86400);
  assert.ok(Math.abs(s2.bias) < Math.abs(s1.bias), 'l\'effet décroît avec l\'âge');
  const s3 = macroState(ppiHot, 'NAS100', MODEL, T0 + 4 * 86400);
  assert.equal(s3.bias, 0, 'plus aucun effet après 3 jours');
});

test('macro : une réaction immédiate sans dérive n\'oriente pas le biais (effet intégré dans l\'heure)', () => {
  const s = macroState([ev('Inflation Rate MoM', -2 * 3600, 0.6, 0.3)], 'NAS100', MODEL, T0);
  assert.equal(s.level, 'neutre');
  assert.equal(s.contributions[0].reaction, -6); // -2 × 3 σ : réaction mesurée à la publication
});

test('macro : une nouvelle publication remplace la précédente et sa révision est comptée', () => {
  const events = [ev('PPI MoM', -35 * 86400, 0.4, 0.2), ev('PPI MoM', -3600, 0.2, 0.2, 0.8)]; // mois dernier révisé 0,4 → 0,8
  const s = macroState(events, 'NAS100', MODEL, T0);
  const ppi = s.contributions.filter((c) => c.key === 'US:PPI MoM');
  assert.equal(ppi.length, 1, 'pas de double compte');
  assert.equal(ppi[0].z, 0);
  assert.equal(ppi[0].revision, 2); // (0,8 − 0,4) / 0,2
  assert.ok(ppi[0].contrib < 0, 'révision à la hausse de l\'inflation → dérive baissière');
});

test('macro : paquet d\'annonces simultanées (accord mesuré) et surprise anticipée par les liens', () => {
  const events = [
    ev('Non Farm Payrolls', -600, 300, 180), ev('Unemployment Rate', -600, 3.6, 3.9), // les deux « emploi fort »
    ev('PPI MoM', -86400, 0.6, 0.2), ev('Inflation Rate MoM', 2 * 86400, null, 0.3),
  ];
  const s = macroState(events, 'NAS100', MODEL, T0);
  assert.equal(s.packets.length, 1);
  assert.equal(s.packets[0].agreement, 1, 'NFP fort et chômage en baisse poussent dans le même sens');
  const cpi = s.upcoming.find((u) => u.key === 'US:Inflation Rate MoM');
  assert.equal(cpi.expectedZ, 1, 'surprise PPI +2 σ × corrélation 0,5');
  assert.equal(cpi.expectedDir, 'baissier');
});
