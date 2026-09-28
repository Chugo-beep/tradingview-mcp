/**
 * Tests de sécurité (OWASP Top 10:2025) du serveur, avec un faux TradingView Desktop.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';

const execFileP = promisify(execFile);
const PAIR_SCRIPT = fileURLToPath(new URL('../scripts/new-pairing-code.mjs', import.meta.url));

const DATA = mkdtempSync(join(tmpdir(), 'xauz-'));
process.env.XAUZ_DATA_DIR = DATA;
process.env.XAUZ_PORT = '39777';
process.env.XAUZ_REMOTE_PORT = '39778';
process.env.XAUZ_NO_NEWS = '1';

const tv = await import('../tvfeed.js');
const bars = (n, t0, step) => Array.from({ length: n }, (_, i) => [t0 + i * step, 4300 + i * 0.1, 4301 + i * 0.1, 4299 + i * 0.1, 4300.5 + i * 0.1, 10]);
let switched = [];
// Faux CDP : distingue les appels par un marqueur en tête de l'expression évaluée (commentaire
// /*XZ...*/ ajouté par tvfeed.js), pour rester fidèle au comportement réel sans dépendre de
// l'ordre exact des appels. UN SEUL graphique (OANDA:XAUUSD, résolution '15' par défaut) : pas de
// disposition multi-graphiques (l'application n'en crée jamais).
const evaluate = async (expr) => {
  const e = String(expr);
  if (e.includes('/*XZACTIVECHECK*/')) return { count: 100, firstTime: 1790000000, more: false };
  if (e.includes('/*XZACTIVEPUMP*/')) return null;
  if (e.includes('/*XZSERIESBARS*/')) return bars(100, 1790000000, 900);
  if (e.includes('/*XZSEARCH')) return false; // barre de recherche absente dans ce faux DOM : jamais utilisée pour XAUUSD (déjà affiché)
  return [];
};
tv._setCore({
  connection: { evaluate, evaluateAsync: async () => {} },
  chart: {
    getState: async () => ({ symbol: 'OANDA:XAUUSD', resolution: '15' }),
    setTimeframe: async ({ timeframe }) => { switched.push(timeframe); },
    setSymbol: async () => {},
  },
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

test('Données : lecture passive du graphique unique + bascule de résolution pour les TF manquantes', async () => {
  switched = [];
  const r = await local('/api/tv/candles?tfs=1,5,15&count=100');
  const j = await r.json();
  assert.equal(r.status, 200);
  assert.equal(j.sources['15'], 'graphique', 'la résolution déjà affichée (15) est lue sans bascule');
  assert.equal(j.sources['1'], 'bascule');
  assert.equal(j.sources['5'], 'bascule');
  assert.deepEqual(switched, ['1', '5', '15'], 'bascule sur chaque TF manquante, puis retour à la TF d\'origine');
  assert.equal(j.candles['1'].at(-1).complete, false);
});

test('Données : meta (compte total, première/dernière bougie) renvoyé avant filtrage "since"', async () => {
  const r = await local('/api/tv/candles?tfs=1&count=all');
  const j = await r.json();
  assert.equal(r.status, 200);
  assert.equal(j.meta['1'].count, 100);
  assert.equal(j.meta['1'].first, 1790000000);
  const since = 1790000000 + 60 * 60;
  const r2 = await local(`/api/tv/candles?tfs=1&count=all&since=${since}`);
  const j2 = await r2.json();
  assert.equal(j2.meta['1'].count, 100, 'meta reflète le total chargé, pas la liste filtrée par "since"');
  assert.ok(j2.candles['1'].length < j2.meta['1'].count);
});

test('A05 : /api/tv/history requiert X-XZ, verrouillé (lock) avec getCandles, absent de l\'API distante', async () => {
  assert.equal((await fetch(L + '/api/tv/history', { method: 'POST' })).status, 403);
  const r = await local('/api/tv/history', { method: 'POST' });
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.equal(j.success, true);
  assert.ok(Array.isArray(j.results));
  assert.equal(j.results.length, 1, 'un seul graphique existe : un seul résultat');
  assert.equal(j.results[0].bars, 100);
  // Absent de l'API distante : ni authentifié (401, avant même le routage) ni, une fois authentifié, une route connue (404).
  assert.ok([401, 404].includes((await remote('/api/tv/history', { method: 'POST' })).status));
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
  const since = 1790000000 + 60 * 60; // bougies de la TF '1' : pas de 900 s, 100 bougies à partir de 1790000000
  const r = await local(`/api/tv/candles?tfs=1&count=all&since=${since}`);
  const j = await r.json();
  assert.equal(r.status, 200);
  assert.ok(j.candles['1'].every((c) => c.time >= since));
  assert.equal(j.candles['1'].length, 96, 'les bougies antérieures à "since" sont exclues de la réponse');
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
  // un code manuel n'invalide pas le code de l'APK (usages différents) ; un nouveau code APK remplace l'ancien
  const r3 = await (await local('/api/admin/pairing', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ttlMin: 30, purpose: 'apk' }) })).json();
  assert.equal((await pairWith(r.code)).status, 401, 'nouveau code APK : l\'ancien code APK est invalidé');
  assert.equal((await pairWith(r2.code)).status, 200, 'le code manuel reste valable malgré le code APK');
  sec._reset();
  void r3;
});

test('A07 : code grillé après 5 essais', async () => {
  sec._reset();
  const { code } = await (await local('/api/admin/pairing', { method: 'POST' })).json();
  const wrong = code === '12345678' ? '87654321' : '12345678';
  for (let i = 0; i < 5; i++) await pairWith(wrong);
  assert.equal((await pairWith(code)).status, 401);
});

test('A07 : code d\'appairage créé par un autre processus (scripts/new-pairing-code.mjs) accepté par le serveur, hash seul sur disque', async () => {
  sec._reset();
  const { stdout } = await execFileP(process.execPath, [PAIR_SCRIPT, '--ttl', '30', '--purpose', 'apk', '--json'], { env: { ...process.env, XAUZ_DATA_DIR: DATA } });
  const { code, expiresAt } = JSON.parse(stdout.trim());
  assert.match(code, /^\d{8}$/);
  assert.ok(expiresAt - Date.now() > 29 * 60000 && expiresAt - Date.now() <= 30 * 60000 + 2000);
  const pairingRaw = readFileSync(join(DATA, 'pairing.json'), 'utf8');
  assert.doesNotMatch(pairingRaw, new RegExp(code), 'jamais le code en clair sur disque');
  assert.match(pairingRaw, /"hash":"[0-9a-f]{64}"/);
  const r = await pairWith(code);
  assert.equal(r.status, 200, 'le serveur (processus séparé) charge le code depuis pairing.json (chargement paresseux)');
  assert.equal((await pairWith(code)).status, 401, 'usage unique : le code ne peut pas être réutilisé');
});

test('A07 : un fichier pairing.json plus récent (écrit par un autre processus) prime sur le pairing en mémoire', async () => {
  sec._reset();
  await (await local('/api/admin/pairing', { method: 'POST' })).json(); // code en mémoire du serveur
  const newCode = '13572468';
  writeFileSync(join(DATA, 'pairing.json'), JSON.stringify({
    hash: createHash('sha256').update(newCode).digest('hex'), expiresAt: Date.now() + 60000, attempts: 0, purpose: 'apk', createdAt: Date.now() + 60000,
  }));
  assert.equal((await pairWith(newCode)).status, 200, 'le code plus récent, déposé sur disque par un autre processus, est accepté');
  sec._reset();
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

test('A05 : /api/news validation ("since" invalide → 400) et authentification distante', async () => {
  assert.equal((await local('/api/news?since=abc')).status, 400);
  const ok = await local('/api/news');
  const j = await ok.json();
  assert.equal(ok.status, 200);
  assert.equal(j.success, true);
  assert.ok(Array.isArray(j.events));
  assert.equal((await fetch(R + '/api/news')).status, 403, 'hors Tailscale');
  assert.equal((await remote('/api/news')).status, 401, 'sans jeton');
});

test('A07 : ré-appairer le même téléphone remplace son ancienne entrée (pas de saturation à 5 appareils)', async () => {
  sec._reset();
  const code = async () => (await (await local('/api/admin/pairing', { method: 'POST' })).json()).code;
  for (let i = 0; i < 7; i++) assert.equal((await pairWith(await code())).status, 200, `appairage n°${i + 1}`);
  const { devices } = await (await local('/api/admin/devices')).json();
  assert.equal(devices.filter((d) => d.name === 'OnePlus 13').length, 1, 'une seule entrée pour ce téléphone');
});

test('A05 : /api/tv/candles valide le paramètre "market" par liste blanche (registre markets.js)', async () => {
  const ok = await local('/api/tv/candles?tfs=1&count=100&market=XAUUSD');
  assert.equal(ok.status, 200);
  assert.equal((await ok.json()).market, 'XAUUSD');
  assert.equal((await local('/api/tv/candles?tfs=1&count=100')).status, 200, 'market omis → XAUUSD par défaut');
  assert.equal((await local('/api/tv/candles?tfs=1&count=100&market=FOO')).status, 400);
  assert.equal((await local('/api/tv/candles?tfs=1&count=100&market=<script>')).status, 400);
});

test('Analyse complète : POST /api/scan/start exige X-XZ localement, refuse un second scan (409), et publie un classement', async () => {
  sec._reset();
  assert.equal((await fetch(L + '/api/scan/start', { method: 'POST' })).status, 403, 'sans X-XZ');
  const start = await local('/api/scan/start', { method: 'POST' });
  assert.equal(start.status, 200);
  assert.equal((await start.json()).success, true);
  const dup = await local('/api/scan/start', { method: 'POST' });
  assert.equal(dup.status, 409, 'un scan est déjà en cours');
  // attend la fin du scan (fond de tâche), puis vérifie le classement persisté
  let statusJson = null;
  for (let i = 0; i < 100; i++) {
    statusJson = await (await local('/api/scan/status')).json();
    if (!statusJson.running) break;
    await new Promise((r) => setTimeout(r, 50));
  }
  assert.equal(statusJson.running, false, 'le scan doit se terminer dans le délai du test');
  const res = await local('/api/scan/result');
  assert.equal(res.status, 200);
  const j = await res.json();
  assert.equal(j.success, true);
  assert.equal(j.ranking.length, 11, 'un classement pour chacun des 11 marchés du registre');
  assert.ok(j.ranking.some((r) => r.market === 'XAUUSD'));
});

test('Analyse complète : la route distante exige un jeton, est limitée à 1 déclenchement / 10 min, absente sans Tailscale', async () => {
  sec._reset();
  assert.equal((await fetch(R + '/api/scan/start', { method: 'POST' })).status, 403, 'hors Tailscale');
  assert.equal((await remote('/api/scan/start', { method: 'POST' })).status, 401, 'sans jeton');
  const { code } = await (await local('/api/admin/pairing', { method: 'POST' })).json();
  const paired = await pairWith(code);
  const { token } = await paired.json();
  const auth = { Authorization: `Bearer ${token}` };
  const first = await remote('/api/scan/start', { method: 'POST', headers: auth });
  assert.ok([200, 409].includes(first.status));
  const second = await remote('/api/scan/start', { method: 'POST', headers: auth });
  assert.equal(second.status, 429, 'un second déclenchement distant avant 10 minutes est refusé');
  // laisse le scan en cours se terminer avant le test suivant
  for (let i = 0; i < 100; i++) {
    const s = await (await local('/api/scan/status')).json();
    if (!s.running) break;
    await new Promise((r) => setTimeout(r, 50));
  }
  sec._reset();
});
