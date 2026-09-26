/**
 * Tests de sécurité (OWASP Top 10:2025) du serveur, avec un faux TradingView Desktop.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const DATA = mkdtempSync(join(tmpdir(), 'xauz-'));
process.env.XAUZ_DATA_DIR = DATA;
process.env.XAUZ_PORT = '39777';
process.env.XAUZ_REMOTE_PORT = '39778';

const tv = await import('../tvfeed.js');
const bars = (n, t0, step) => Array.from({ length: n }, (_, i) => [t0 + i * step, 4300 + i * 0.1, 4301 + i * 0.1, 4299 + i * 0.1, 4300.5 + i * 0.1, 10]);
let switched = [];
tv._setCore({
  connection: { evaluate: async () => [{ index: 0, symbol: 'OANDA:XAUUSD', interval: '1', bars: bars(120, 1790000000, 60) }, { index: 1, symbol: 'OANDA:XAUUSD', interval: '5', bars: bars(120, 1790000000, 300) }], evaluateAsync: async () => {} },
  chart: { getState: async () => ({ symbol: 'OANDA:XAUUSD', resolution: '15' }), setTimeframe: async ({ timeframe }) => { switched.push(timeframe); } },
  data: { getOhlcv: async () => ({ bars: bars(100, 1790000000, 900).map(([time, open, high, low, close, volume]) => ({ time, open, high, low, close, volume })) }) },
});
const srv = await import('../server.js');
const sec = await import('../security.js');

const L = 'http://127.0.0.1:39777', R = 'http://127.0.0.1:39778';
const TS = { 'Tailscale-User-Login': 'joshua@example.com' };
const local = (p, o = {}) => fetch(L + p, { ...o, headers: { 'X-XZ': '1', ...(o.headers || {}) } });
const remote = (p, o = {}) => fetch(R + p, { ...o, headers: { ...TS, ...(o.headers || {}) } });
const pairWith = (code, extra = {}) => remote('/api/pair', { method: 'POST', headers: { 'Content-Type': 'application/json', ...extra }, body: JSON.stringify({ code, name: 'OnePlus 13' }) });

before(async () => { srv.start(); await new Promise((r) => setTimeout(r, 300)); });
after(() => { srv.localServer.close(); srv.remoteServer.close(); });

test('A02 : en-têtes de sécurité et CSP sur la page', async () => {
  const r = await fetch(L + '/', { headers: {} });
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-security-policy'), /default-src 'self'.*object-src 'none'/);
  assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(r.headers.get('x-frame-options'), 'DENY');
  assert.equal(r.headers.get('x-powered-by'), null);
});

test('A01 : traversée de répertoire refusée', async () => {
  for (const p of ['/../server.js', '/%2e%2e/server.js', '/..%2fsecurity.js', '/js/../../package.json']) {
    const r = await fetch(L + p);
    assert.ok([403, 404].includes(r.status), `${p} → ${r.status}`);
    assert.doesNotMatch(await r.text(), /import|secLog|"name"/);
  }
});

test('A01 : DNS rebinding (Host étranger) refusé', async () => {
  const r = await new Promise((ok) => {
    import('node:http').then(({ request }) => {
      const q = request({ host: '127.0.0.1', port: 39777, path: '/api/health', headers: { Host: 'evil.example:39777', 'X-XZ': '1' } }, (res) => ok(res.statusCode));
      q.end();
    });
  });
  assert.equal(r, 421);
});

test('A01 : CSRF sur l\'API locale refusé (sans en-tête ou origine étrangère)', async () => {
  assert.equal((await fetch(L + '/api/admin/pairing', { method: 'POST' })).status, 403);
  assert.equal((await local('/api/admin/pairing', { method: 'POST', headers: { Origin: 'https://evil.example' } })).status, 403);
});

test('Données : lecture passive des graphiques + bascule pour les TF manquantes', async () => {
  switched = [];
  const r = await local('/api/tv/candles?tfs=1,5,15&count=100');
  const j = await r.json();
  assert.equal(r.status, 200);
  assert.equal(j.sources['1'], 'graphique');
  assert.equal(j.sources['5'], 'graphique');
  assert.equal(j.sources['15'], 'bascule');
  assert.deepEqual(switched, ['15', '15'], 'bascule puis retour à la TF d\'origine');
  assert.equal(j.candles['1'].at(-1).complete, false);
});

test('A05 : paramètres validés par liste blanche', async () => {
  assert.equal((await local('/api/tv/candles?tfs=1,<script>')).status, 400);
  assert.equal((await local('/api/tv/candles?tfs=1&count=99999')).status, 400);
  assert.equal((await local('/api/tv/candles?tfs=1&count=12.5')).status, 400);
});

test('A05 : count="all" (toutes les bougies) et plafond à 20 000', async () => {
  const ok = await local('/api/tv/candles?tfs=1&count=all');
  assert.equal(ok.status, 200);
  assert.equal((await local('/api/tv/candles?tfs=1&count=20000')).status, 200);
  assert.equal((await local('/api/tv/candles?tfs=1&count=20001')).status, 400);
  assert.equal((await local('/api/tv/candles?tfs=1&count=50')).status, 200);
  assert.equal((await local('/api/tv/candles?tfs=1&count=49')).status, 400);
});

test('A05 : paramètre "since" validé par liste blanche, filtre les bougies renvoyées', async () => {
  assert.equal((await local('/api/tv/candles?tfs=1&count=all&since=abc')).status, 400);
  assert.equal((await local('/api/tv/candles?tfs=1&count=all&since=0')).status, 400);
  assert.equal((await local('/api/tv/candles?tfs=1&count=all&since=12.5')).status, 400);
  assert.equal((await local('/api/tv/candles?tfs=1&count=all&since=4102444800')).status, 400);
  const since = 1790000000 + 60 * 60; // bougies de la TF '1' : pas de 60 s, 120 bougies à partir de 1790000000
  const r = await local(`/api/tv/candles?tfs=1&count=all&since=${since}`);
  const j = await r.json();
  assert.equal(r.status, 200);
  assert.ok(j.candles['1'].every((c) => c.time >= since));
  assert.equal(j.candles['1'].length, 60, 'les bougies antérieures à "since" sont exclues de la réponse');
});

test('A01 : API distante uniquement via Tailscale Serve', async () => {
  assert.equal((await fetch(R + '/api/health')).status, 403);
  assert.equal((await remote('/api/health')).status, 200);
});

test('A01 : origine étrangère refusée sur l\'API distante', async () => {
  assert.equal((await remote('/api/health', { headers: { Origin: 'https://evil.example' } })).status, 403);
  const ok = await remote('/api/health', { headers: { Origin: 'https://localhost' } });
  assert.equal(ok.headers.get('access-control-allow-origin'), 'https://localhost');
  assert.match(ok.headers.get('strict-transport-security'), /max-age=31536000/);
});

test('A07 : données refusées sans jeton ; appairage à usage unique ; révocation', async () => {
  sec._reset();
  assert.equal((await remote('/api/tv/candles?tfs=1')).status, 401);
  const { code } = await (await local('/api/admin/pairing', { method: 'POST' })).json();
  assert.match(code, /^\d{8}$/);
  assert.equal((await pairWith('00000000' === code ? '11111111' : '00000000')).status, 401);
  const ok = await pairWith(code);
  assert.equal(ok.status, 200);
  const { token, deviceId } = await ok.json();
  assert.equal(token.length, 43);
  assert.equal((await pairWith(code)).status, 401, 'code réutilisé refusé');
  const auth = { Authorization: `Bearer ${token}` };
  assert.equal((await remote('/api/tv/candles?tfs=1,5', { headers: auth })).status, 200);
  assert.equal((await remote('/api/session', { headers: { ...auth, 'Tailscale-User-Login': 'autre@example.com' } })).status, 403, 'autre compte Tailscale refusé');
  // A04 : seul le hachage est stocké
  const stored = readFileSync(join(DATA, 'devices.json'), 'utf8');
  assert.doesNotMatch(stored, new RegExp(token));
  assert.match(stored, /"hash": "[0-9a-f]{64}"/);
  assert.equal((await local(`/api/admin/devices/${deviceId}`, { method: 'DELETE' })).status, 200);
  assert.equal((await remote('/api/session', { headers: auth })).status, 401, 'jeton révoqué');
});

test('A07 : code de préconfiguration APK plafonné à 30 min', async () => {
  sec._reset();
  const t0 = Date.now();
  const r = await (await local('/api/admin/pairing', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ttlMin: 30, purpose: 'apk' }) })).json();
  assert.ok(r.expiresAt - t0 > 29 * 60000 && r.expiresAt - t0 <= 30 * 60000 + 2000);
  const r2 = await (await local('/api/admin/pairing', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ttlMin: 600 }) })).json();
  assert.ok(r2.expiresAt - Date.now() <= 10 * 60000 + 2000, 'durée hors limite → 10 min');
  assert.equal((await pairWith(r.code)).status, 401, 'nouveau code : l\'ancien est invalidé');
});

test('A07 : code grillé après 5 essais', async () => {
  sec._reset();
  const { code } = await (await local('/api/admin/pairing', { method: 'POST' })).json();
  const wrong = code === '12345678' ? '87654321' : '12345678';
  for (let i = 0; i < 5; i++) await pairWith(wrong);
  assert.equal((await pairWith(code)).status, 401);
});

test('A07 : verrouillage après 10 échecs', async () => {
  sec._reset();
  for (let i = 0; i < 10; i++) await remote('/api/session', { headers: { Authorization: 'Bearer ' + 'x'.repeat(43) } });
  assert.equal((await remote('/api/session', { headers: { Authorization: 'Bearer ' + 'y'.repeat(43) } })).status, 429);
  sec._reset();
});

test('A10 : corps trop gros, mauvais type, JSON invalide → erreurs propres', async () => {
  assert.equal((await remote('/api/pair', { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: 'x' })).status, 415);
  assert.equal((await remote('/api/pair', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{' })).status, 400);
  assert.equal((await remote('/api/pair', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: 'x'.repeat(5000) }) })).status, 413);
});

test('A09 : événements journalisés sans aucun secret', async () => {
  const log = readFileSync(join(DATA, 'security.log'), 'utf8');
  assert.match(log, /device_paired/);
  assert.match(log, /auth_fail/);
  assert.match(log, /remote_locked/);
  assert.doesNotMatch(log, /"(token|code)"/);
  assert.ok(existsSync(join(DATA, 'security.log')));
});
