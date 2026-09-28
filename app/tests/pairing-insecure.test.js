/**
 * A07 : quand XAUZ_REQUIRE_TAILSCALE=0 (vérification Tailscale désactivée), l'appairage distant
 * doit rester refusé tant que XAUZ_INSECURE_ALLOW_PAIRING=1 n'est pas explicitement défini.
 * Fichier séparé (node --test isole chaque fichier dans son propre processus) car REQUIRE_TS est
 * lu une seule fois au chargement de server.js.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const DATA = mkdtempSync(join(tmpdir(), 'xauz-insecure-'));
process.env.XAUZ_DATA_DIR = DATA;
process.env.XAUZ_PORT = '39781';
process.env.XAUZ_REMOTE_PORT = '39782';
process.env.XAUZ_NO_NEWS = '1';
process.env.XAUZ_REQUIRE_TAILSCALE = '0'; // désactive volontairement la vérification Tailscale
// XAUZ_INSECURE_ALLOW_PAIRING volontairement absent

const tv = await import('../tvfeed.js');
tv._setCore({
  connection: { evaluate: async () => [], evaluateAsync: async () => {} },
  chart: { getState: async () => ({ symbol: 'OANDA:XAUUSD', resolution: '15' }), setTimeframe: async () => {}, setSymbol: async () => {} },
});
const srv = await import('../server.js');

const R = 'http://127.0.0.1:39782';

before(async () => { srv.start(); await new Promise((r) => setTimeout(r, 300)); });
after(() => { srv.localServer.close(); srv.remoteServer.close(); });

test('A07 : REQUIRE_TAILSCALE=0 SANS XAUZ_INSECURE_ALLOW_PAIRING → appairage refusé (403), message en français', async () => {
  // Sans en-tête Tailscale (accepté puisque REQUIRE_TS=0), mais l'appairage reste bloqué.
  const r = await fetch(R + '/api/pair', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: '00000000', name: 'Test' }),
  });
  assert.equal(r.status, 403);
  const j = await r.json();
  assert.match(j.error, /[àâéèêîïôùûç]|Tailscale|XAUZ_INSECURE_ALLOW_PAIRING/i);
});

test('A07 : le reste de l\'API distante fonctionne toujours sans Tailscale (santé, pas de jeton requis)', async () => {
  assert.equal((await fetch(R + '/api/health')).status, 200);
});
