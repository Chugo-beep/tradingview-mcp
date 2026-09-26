import { test } from 'node:test';
import assert from 'node:assert/strict';

// environnement navigateur minimal
const store = new Map();
globalThis.localStorage = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k) };
const calls = [];
globalThis.fetch = async (url) => {
  calls.push(url);
  const u = new URL(url);
  if (u.pathname.endsWith('/exchange_rate')) return { status: 200, json: async () => ({ symbol: 'EUR/USD', rate: 1.1234 }) };
  if (u.searchParams.get('apikey') === 'bad') return { status: 401, json: async () => ({ code: 401, message: 'invalid key', status: 'error' }) };
  const iv = u.searchParams.get('interval');
  const values = iv === '1day'
    ? [{ datetime: '2026-09-23', open: '4300', high: '4320', low: '4290', close: '4310' }, { datetime: '2026-09-24', open: '4310', high: '4330', low: '4300', close: '4320' }]
    : [{ datetime: '2026-09-24 10:00:00', open: '4300', high: '4301', low: '4299', close: '4300.5' }, { datetime: '2026-09-24 10:01:00', open: '4300.5', high: '4302', low: '4300', close: '4301' }];
  return { status: 200, json: async () => ({ meta: { symbol: 'XAU/USD', interval: iv }, values, status: 'ok' }) };
};

const td = await import('../www/js/twelvedata.js');

test('Twelve Data : bougies parsées en UTC, triées, 1 crédit par timeframe', async () => {
  const r = await td.fetchTwelveData({ twelveKey: 'k', count: 500 }, ['1', 'D']);
  assert.equal(r.candles['1'].length, 2);
  assert.equal(r.candles['1'][0].time, Date.UTC(2026, 8, 24, 10, 0) / 1000);
  assert.equal(r.candles['1'][1].close, 4301);
  assert.equal(r.candles.D[1].time, Date.UTC(2026, 8, 24) / 1000);
  assert.equal(td.credits().used, 2);
});

test('Twelve Data : le cache évite de redépenser des crédits', async () => {
  const before = calls.length;
  await td.fetchTwelveData({ twelveKey: 'k', count: 500 }, ['1', 'D']);
  if (!td.marketClosed()) assert.equal(calls.length, before, 'aucune nouvelle requête avant le délai de rafraîchissement');
});

test('Twelve Data : clé refusée → message clair', async () => {
  await assert.rejects(td.fetchTwelveData({ twelveKey: 'bad', count: 500 }, ['5']), /Clé Twelve Data refusée/);
});

test('Twelve Data : taux EUR/USD', async () => {
  assert.equal(await td.fetchEurUsdTD({ twelveKey: 'k' }), 1.1234);
});
