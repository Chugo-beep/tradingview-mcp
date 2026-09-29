/**
 * Non-régression des correctifs de l'audit (anomalies trouvées en relisant la branche) :
 *  - clôture exacte des bougies mensuelles (pas d'information future dans les backtests) ;
 *  - fiabilité top-down : poids par rang d'UT, bougie de décision quand le contact a lieu sur la bougie en cours ;
 *  - journal des erreurs TradingView limité (ne noie pas le journal de sécurité).
 */
process.env.XAUZ_DATA_DIR ||= (await import('node:fs')).mkdtempSync((await import('node:path')).join((await import('node:os')).tmpdir(), 'xauz-audit-'));
process.env.XAUZ_NO_NEWS = '1';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { closeTimeOf, lastClosedIndex, TF_SECONDS } from '../www/js/engine.js';
import { evaluateTopdown, prepTopdownTf } from '../www/js/topdown.js';

const utc = (y, m, d) => Date.UTC(y, m, d) / 1000;
const monthly = [utc(2026, 0, 1), utc(2026, 1, 1), utc(2026, 2, 1), utc(2026, 3, 1)].map((time, i) => ({ time, open: 100 + i, high: 102 + i, low: 99 + i, close: 101 + i, complete: true }));

test('bougie mensuelle : close à l\'ouverture du mois suivant, jamais avant (mois de 31 jours)', () => {
  // janvier = 31 jours ; l'ancienne règle « ouverture + 30,44 j » la déclarait close le 31 janvier vers 10 h 34
  const jan31noon = utc(2026, 0, 31) + 12 * 3600;
  assert.ok(monthly[0].time + TF_SECONDS.M <= jan31noon, 'la durée moyenne déclarait janvier clos trop tôt');
  assert.equal(closeTimeOf(monthly, 0, 'M'), utc(2026, 1, 1));
  assert.equal(lastClosedIndex(monthly, 'M', jan31noon), -1, 'janvier n\'est pas clos le 31 à midi');
  assert.equal(lastClosedIndex(monthly, 'M', utc(2026, 1, 1)), 0, 'janvier est clos le 1er février');
  // février = 28 jours : clos le 1er mars (la durée moyenne le déclarait clos 2,4 jours trop tard)
  assert.equal(lastClosedIndex(monthly, 'M', utc(2026, 2, 1)), 1);
  // dernière bougie : durée nominale ; UT fixe (1D) : ouverture + durée
  assert.equal(closeTimeOf(monthly, 3, 'M'), monthly[3].time + TF_SECONDS.M);
  assert.equal(closeTimeOf([{ time: 1000 }], 0, 'D'), 1000 + 86400);
});

// structure haussière en escalier (6 bougies de hausse, 4 de repli)
function staircase(n, step, t0 = 1_700_000_000, start = 100) {
  const c = []; let p = start;
  for (let i = 0; i < n; i++) {
    const up = i % 10 < 6, o = p, cl = up ? p + 1 : p - 0.6;
    c.push({ time: t0 + i * step, open: o, high: Math.max(o, cl) + 0.2, low: Math.min(o, cl) - 0.2, close: cl, volume: 1, complete: true });
    p = cl;
  }
  return c;
}

test('fiabilité top-down : le poids d\'une UT dépend de son rang, pas des UT absentes', () => {
  const m15 = staircase(1600, 900), h4 = staircase(120, 14400, 1_700_000_000 - 100 * 14400);
  const z = { timeframe: '15', direction: 'BUY', zoneLow: m15[1200].low, zoneHigh: m15[1200].high, c1Time: m15[1200].time, gap: 0.5, atr: 1, candles: { C2: m15[1201] } };
  // 1h absente : la chaîne ne contient que 4h (rang 1, poids 1,5), jamais le poids du rang 0
  const r = evaluateTopdown(z, { '15': prepTopdownTf(m15, '15'), '240': prepTopdownTf(h4, '240') }, m15.at(-1).time + 900);
  assert.equal(r.chain.length, 1);
  assert.equal(r.chain[0].tf, '240');
  assert.equal(r.chain[0].rank, 1);
});

test('fiabilité top-down : contact sur la bougie en cours → la dernière bougie close compte pour la cassure de structure', () => {
  const m15 = staircase(700, 900);
  const c1 = 640;
  // trouve la première cassure haussière après C1 (événement de structure à l'index b)
  const L = prepTopdownTf(m15, '15');
  const ev = L.events.find((e) => e.dir === 'BUY' && e.breakIdx > c1);
  assert.ok(ev, 'une cassure haussière existe après C1');
  const closed = m15.slice(0, ev.breakIdx + 1); // la bougie de cassure est la dernière close
  const touchTime = closed.at(-1).time + 900;   // le contact a lieu sur la bougie suivante, encore en cours
  const z = { timeframe: '15', direction: 'BUY', zoneLow: m15[c1].low, zoneHigh: m15[c1].high, c1Time: m15[c1].time, gap: 0.5, atr: 1, candles: { C2: m15[c1 + 1] }, firstTouch: { time: touchTime } };
  const r = evaluateTopdown(z, { '15': prepTopdownTf(closed, '15') }, touchTime);
  assert.ok(r.localBos, 'la cassure sur la dernière bougie close est prise en compte');
  assert.equal(r.parts.localBos > 0, true);
});

test('journal des erreurs TradingView : une ligne par message distinct, au plus toutes les 10 min', async () => {
  const { logTvError } = await import('../server.js');
  const e = new Error('JS evaluation error: TypeError: Cannot read properties of undefined (reading \'_activeChartWidgetWV\')');
  const t0 = 1_000_000_000_000;
  assert.equal(await logTvError(e, t0), true, 'premier message journalisé');
  assert.equal(await logTvError(e, t0 + 60_000), false, 'même message 1 min après : ignoré');
  assert.equal(await logTvError(new Error('connect ECONNREFUSED 127.0.0.1:9222'), t0 + 120_000), true, 'nouveau message : journalisé');
  assert.equal(await logTvError(e, t0 + 180_000), true, 'retour à l\'ancien message : journalisé (il a changé)');
  assert.equal(await logTvError(e, t0 + 180_000 + 10 * 60_000), true, 'même message après 10 min : journalisé');
});

test('serveur : port déjà utilisé → message clair et arrêt (jamais de processus fantôme)', async () => {
  const net = await import('node:net');
  const { spawn } = await import('node:child_process');
  const { fileURLToPath } = await import('node:url');
  const busy = await new Promise((ok) => { const s = net.createServer().listen(0, '127.0.0.1', () => ok(s)); });
  const port = busy.address().port;
  const server = fileURLToPath(new URL('../server.js', import.meta.url));
  const child = spawn(process.execPath, [server, '--port', String(port), '--no-remote', '--no-open', '--no-news', '--no-code'], {
    env: { ...process.env, XAUZ_DATA_DIR: process.env.XAUZ_DATA_DIR }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  child.stdout.on('data', (d) => { out += d; }); child.stderr.on('data', (d) => { out += d; });
  const code = await new Promise((ok) => { const t = setTimeout(() => { child.kill(); ok('timeout'); }, 10000); child.on('exit', (c) => { clearTimeout(t); ok(c); }); });
  busy.close();
  assert.equal(code, 1, 'le processus s\'arrête avec le code 1');
  assert.match(out, /déjà utilisé/);
  assert.doesNotMatch(out, /XAUUSD Zones \(PC\) →/, 'aucun démarrage annoncé');
});

test('/api/backtest : la synthèse renvoyée donne exactement la même confiance que le rapport complet', async () => {
  const { backtestSummary } = await import('../server.js');
  const { assessConfidence } = await import('../www/js/confidence.js');
  const { readFileSync } = await import('node:fs');
  for (const m of ['XAUUSD', 'NAS100', 'US30', 'EURUSD']) {
    const raw = JSON.parse(readFileSync(new URL(`../www/data/backtest-${m}.json`, import.meta.url), 'utf8'));
    const slim = { full: backtestSummary(raw.full), inSample: backtestSummary(raw.inSample), outOfSample: backtestSummary(raw.outOfSample) };
    assert.deepEqual(assessConfidence(slim), assessConfidence(raw), m);
    assert.equal('history' in slim.full, false, 'pas d\'historique de trades transmis');
    assert.ok(JSON.stringify(slim).length < 10_000);
  }
  assert.equal(backtestSummary(null), null);
});

test('macro : pas de « paquet » affiché si moins de deux annonces ont une réaction mesurée sur le marché', async () => {
  const { macroState } = await import('../www/js/macro.js');
  const model = { keys: { 'US:A': { sigma: 1 }, 'US:B': { sigma: 1 }, 'US:C': { sigma: 1 } }, sensitivity: { M: { 'US:A': { b60: 1, d1: 0, d2: 0 } } }, links: [] };
  const t = 1_800_000_000;
  const ev = (title) => ({ country: 'US', title, t: t - 600, actual: 2, forecast: 1 });
  assert.equal(macroState([ev('B'), ev('C')], 'M', model, t).packets.length, 0, 'aucune réaction mesurée');
  assert.equal(macroState([ev('A'), ev('B')], 'M', model, t).packets.length, 0, 'une seule réaction mesurée');
  const two = { ...model, sensitivity: { M: { 'US:A': { b60: 1, d1: 0, d2: 0 }, 'US:B': { b60: -1, d1: 0, d2: 0 } } } };
  const p = macroState([ev('A'), ev('B')], 'M', two, t).packets;
  assert.equal(p.length, 1); assert.equal(p[0].agreement, 0, 'deux réactions opposées : accord nul');
});

test('macro : un indicateur sans réaction mesurée à 1 h (seulement un effet persistant) n\'affiche pas de réaction nulle', async () => {
  const { macroState } = await import('../www/js/macro.js');
  const model = { keys: { 'US:PPI MoM': { sigma: 0.2 }, 'US:Core PPI MoM': { sigma: 0.2 } }, sensitivity: { N: { 'US:PPI MoM': { b60: 0, d1: 0, d2: -1.5 }, 'US:Core PPI MoM': { b60: 0, d1: 0, d2: -1.2 } } }, links: [] };
  const t = 1_800_000_000;
  const s = macroState([{ country: 'US', title: 'PPI MoM', t: t - 600, actual: 0.6, forecast: 0.2 }, { country: 'US', title: 'Core PPI MoM', t: t - 600, actual: 0.5, forecast: 0.2 }, { country: 'US', title: 'PPI MoM', t: t + 86400, actual: null, forecast: 0.2 }], 'N', model, t);
  assert.equal(s.contributions[0].reaction, null);
  assert.ok(s.contributions[0].contrib < 0, 'l\'effet persistant reste compté');
  assert.equal(s.packets.length, 0, 'pas de paquet sans réaction mesurée');
  assert.equal(s.upcoming[0].typicalMove, null, 'pas de « mouvement typique ±0 % »');
});
