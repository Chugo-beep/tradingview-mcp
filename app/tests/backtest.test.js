/**
 * Backtest long terme (scripts/backtest-dukascopy.mjs) : agrégation 1 minute → timeframes de
 * l'application, découpage walk-forward, et pipeline de bout en bout sur données synthétiques.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { aggregate1mTo, aggregateAll, splitWalkForward, syntheticSeries, DUKASCOPY_INSTRUMENT, BACKTEST_TFS } from '../scripts/backtest-lib.mjs';
import { marketById, MARKET_IDS } from '../www/js/markets.js';
import { rankMarket } from '../www/js/ranking.js';

test('aggregate1mTo : 15 bougies 1m → 1 bougie 15m (OHLC correct, volume cumulé)', () => {
  const t0 = 1790000000 - (1790000000 % 900); // aligné sur un multiple de 900 s
  const m1 = Array.from({ length: 15 }, (_, i) => ({
    time: t0 + i * 60, open: 100 + i, high: 100 + i + 0.5, low: 100 + i - 0.5, close: 100 + i + 0.2, volume: 10,
  }));
  const out = aggregate1mTo(m1, '15');
  assert.equal(out.length, 1);
  const c = out[0];
  assert.equal(c.time, t0);
  assert.equal(c.open, m1[0].open);
  assert.equal(c.close, m1.at(-1).close);
  assert.equal(c.high, Math.max(...m1.map((x) => x.high)));
  assert.equal(c.low, Math.min(...m1.map((x) => x.low)));
  assert.equal(c.volume, 150);
});

test('aggregate1mTo : plusieurs intervalles, dernier marqué incomplet si non terminé', () => {
  const t0 = 3600 * 100; // multiple de 3600 (TF '60')
  const m1 = [];
  for (let i = 0; i < 90; i++) m1.push({ time: t0 + i * 60, open: 1, high: 1.1, low: 0.9, close: 1, volume: 1 }); // 1h30 de bougies
  const out = aggregate1mTo(m1, '60');
  assert.equal(out.length, 2, 'deux heures entamées');
  assert.equal(out[0].complete, true, 'la première heure est bien terminée (60 bougies 1m reçues)');
  assert.equal(out[1].complete, false, 'la seconde heure est incomplète (30 bougies 1m reçues)');
});

test('aggregateAll : agrège toutes les timeframes du backtest en une passe', () => {
  const m1 = syntheticSeries({ from: '2026-01-01', to: '2026-01-08', seed: 1 });
  const byTf = aggregateAll(m1, BACKTEST_TFS);
  for (const tf of BACKTEST_TFS) assert.ok(byTf[tf].length > 0, `timeframe ${tf} non vide`);
  // cohérence croissante : plus la TF est grande, moins il y a de bougies sur la même période
  assert.ok(byTf['D'].length < byTf['60'].length);
  assert.ok(byTf['60'].length < byTf['5'].length);
});

test('splitWalkForward : découpe 70/30 sans chevauchement, dans l\'ordre chronologique', () => {
  const m1 = syntheticSeries({ from: '2026-01-01', to: '2026-01-11', seed: 2 });
  const { inSample, outOfSample } = splitWalkForward(m1, 0.7);
  assert.equal(inSample.length + outOfSample.length, m1.length);
  assert.ok(inSample.at(-1).time <= outOfSample[0].time);
  assert.ok(Math.abs(inSample.length / m1.length - 0.7) < 0.01);
});

test('syntheticSeries : déterministe pour une même graine (seed), période cohérente avec from/to', () => {
  const a = syntheticSeries({ from: '2026-01-01', to: '2026-01-02', seed: 7 });
  const b = syntheticSeries({ from: '2026-01-01', to: '2026-01-02', seed: 7 });
  assert.deepEqual(a, b);
  assert.equal(a.length, 24 * 60, 'une bougie 1m par minute sur 1 jour');
  assert.equal(a[0].time, Math.floor(new Date('2026-01-01').getTime() / 1000));
});

test('DUKASCOPY_INSTRUMENT : une correspondance pour chacun des 11 marchés du registre', () => {
  for (const id of MARKET_IDS) assert.ok(DUKASCOPY_INSTRUMENT[id], `pas de correspondance Dukascopy pour ${id}`);
});

test('Pipeline de bout en bout (synthétique) : agrégation + rankMarket ne plante pas et renvoie une structure exploitable', () => {
  const m1 = syntheticSeries({ from: '2024-01-01', to: '2024-04-01', seed: 3 });
  const candlesByTf = aggregateAll(m1, BACKTEST_TFS);
  const market = marketById('XAUUSD');
  const r = rankMarket(market, candlesByTf, { risk: { targetMode: 'pips' }, benchmarkRuns: 20 });
  assert.equal(r.market, 'XAUUSD');
  assert.ok(Number.isFinite(r.trades));
  assert.ok(typeof r.insufficient === 'boolean');
  assert.ok(r.verdict && typeof r.verdict.label === 'string');
});
