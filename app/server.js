#!/usr/bin/env node
/**
 * Serveur XAUUSD Zones (PC). Seule source de données : TradingView Desktop.
 *
 * Deux services, tous deux liés à 127.0.0.1 uniquement (jamais exposés directement au réseau) :
 *  - Port LOCAL  (3777) : interface PC + administration (codes d'appairage, appareils, journal).
 *  - Port DISTANT (3778) : API minimale en lecture seule pour le téléphone, publiée dans ton
 *    réseau privé Tailscale en HTTPS par « tailscale serve » (voir acces-distant.bat).
 *
 * Usage : node app/server.js [--port 3777] [--remote-port 3778] [--no-remote] [--no-open]
 */
import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { join, extname, resolve, relative, isAbsolute, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import * as sec from './security.js';
import * as news from './newsfeed.js';
import * as scan from './scan.js';
import { MARKET_IDS, DEFAULT_MARKET } from './www/js/markets.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const WWW = resolve(__dirname, 'www');
const args = process.argv.slice(2);
const argNum = (name, def) => { const i = args.indexOf(name); const n = i >= 0 ? Number(args[i + 1]) : NaN; return Number.isInteger(n) && n > 1023 && n < 65536 ? n : def; };
const PORT = argNum('--port', Number(process.env.XAUZ_PORT) || 3777);
const REMOTE_PORT = argNum('--remote-port', Number(process.env.XAUZ_REMOTE_PORT) || 3778);
const REMOTE = !args.includes('--no-remote');
const OPEN = !args.includes('--no-open');
const REQUIRE_TS = process.env.XAUZ_REQUIRE_TAILSCALE !== '0';
const INSECURE_ALLOW_PAIRING = process.env.XAUZ_INSECURE_ALLOW_PAIRING === '1';
const HOST = '127.0.0.1';
const TFS = new Set(['1', '5', '15', '60', '240', 'D', 'W', 'M', '12M']);
const MAX_COUNT = 20000; // plafond de sécurité (A05), aligné sur tvfeed.MAX_BARS
const MAX_SINCE = 4102444800; // 2100-01-01, borne haute de validation (A05)
// 'http://localhost' retiré (A02) : seule l'app Capacitor en a besoin, qui s'exécute toujours en
// 'https://localhost' (androidScheme, capacitor.config.json) ou 'capacitor://localhost' (webview iOS/desktop).
const APP_ORIGINS = new Set(['https://localhost', 'capacitor://localhost']);
const MAX_BODY = 2048;
const SERVER_STARTED_AT = Date.now();

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.webmanifest': 'application/manifest+json', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
};

function send(res, code, body, { type = 'application/json; charset=utf-8', html = false, remote = false, extra = {} } = {}) {
  if (res.headersSent) return;
  res.writeHead(code, { 'Content-Type': type, ...sec.securityHeaders({ html, remote }), ...extra });
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}

async function readJson(req) {
  if (!/^application\/json\b/i.test(req.headers['content-type'] || '')) throw Object.assign(new Error('Content-Type application/json requis'), { status: 415 });
  const chunks = []; let size = 0;
  for await (const ch of req) { size += ch.length; if (size > MAX_BODY) throw Object.assign(new Error('Requête trop volumineuse'), { status: 413 }); chunks.push(ch); }
  try { const v = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); if (typeof v !== 'object' || v === null || Array.isArray(v)) throw 0; return v; }
  catch { throw Object.assign(new Error('JSON invalide'), { status: 400 }); }
}

/** Réglages de risque envoyés avec « Analyse complète » (facultatifs, validés par liste blanche dans scan.js). */
async function applyScanRisk(req) {
  if (!/^application\/json\b/i.test(req.headers['content-type'] || '')) return;
  const body = await readJson(req);
  if (body.risk && typeof body.risk === 'object') scan.setScanRisk(body.risk);
}

function parseCandlesQuery(url) {
  const raw = String(url.searchParams.get('tfs') || '1,5,15,60,240,D');
  const tfs = raw.split(',').slice(0, 9);
  if (!tfs.length || !tfs.every((t) => TFS.has(t))) throw Object.assign(new Error('Paramètre tfs invalide'), { status: 400 });
  const countRaw = String(url.searchParams.get('count') || '500');
  let count;
  if (countRaw === 'all') {
    count = 'all';
  } else {
    const n = Number(countRaw);
    if (!Number.isInteger(n) || n < 50 || n > MAX_COUNT) throw Object.assign(new Error(`Paramètre count invalide (50 à ${MAX_COUNT}, ou "all")`), { status: 400 });
    count = n;
  }
  let since;
  const sinceRaw = url.searchParams.get('since');
  if (sinceRaw != null) {
    const s = Number(sinceRaw);
    if (!Number.isInteger(s) || s <= 0 || s >= MAX_SINCE) throw Object.assign(new Error('Paramètre since invalide'), { status: 400 });
    since = s;
  }
  // `market` : liste blanche du registre (www/js/markets.js), XAUUSD par défaut (A05).
  const marketRaw = url.searchParams.get('market');
  const market = marketRaw == null ? DEFAULT_MARKET : String(marketRaw).toUpperCase();
  if (!MARKET_IDS.includes(market)) throw Object.assign(new Error('Paramètre market invalide'), { status: 400 });
  return { tfs, count, since, market };
}

/** GET /api/news?since=<seq> : `since` doit être un entier ≥ 0 (liste blanche, A05). */
function parseNewsQuery(url) {
  const raw = url.searchParams.get('since');
  if (raw == null) return 0;
  if (!/^\d{1,15}$/.test(raw)) throw Object.assign(new Error('Paramètre since invalide'), { status: 400 });
  return Number(raw);
}
function newsResponse(url) {
  const since = parseNewsQuery(url);
  const st = news._state();
  return { status: 200, body: { success: true, seq: st.seq, updatedAt: st.updatedAt, events: news.eventsSince(since) } };
}

/** GET /api/backtest?market=XAUUSD : rapport JSON du dernier backtest long terme (scripts/backtest-dukascopy.mjs), s'il existe. */
async function backtestResponse(url) {
  const marketRaw = url.searchParams.get('market');
  const market = marketRaw == null ? DEFAULT_MARKET : String(marketRaw).toUpperCase();
  if (!MARKET_IDS.includes(market)) throw Object.assign(new Error('Paramètre market invalide'), { status: 400 });
  try {
    const raw = await readFile(join(WWW, 'data', `backtest-${market}.json`), 'utf8');
    return { status: 200, body: { success: true, market, report: JSON.parse(raw) } };
  } catch {
    return { status: 404, body: { success: false, error: `Aucun backtest disponible pour ${market} : lance npm run backtest.` } };
  }
}

async function tvCandles(url) {
  const { tfs, count, since, market } = parseCandlesQuery(url);
  // le graphique UNIQUE est occupé par l'analyse complète : réponse immédiate (pas d'attente de plusieurs minutes)
  if (scan.isScanRunning()) {
    const st = scan.scanStatus();
    return { status: 409, body: { success: false, busy: true, error: `Analyse complète en cours (${st.done}/${st.total}) : l'analyse en direct reprendra dès qu'elle sera terminée.` } };
  }
  const { getCandles } = await import('./tvfeed.js');
  const { status, body } = await getCandles({ tfs, count, market });
  // `since` : ne renvoie que les bougies nouvelles/modifiées (le téléphone télécharge par incréments).
  if (since != null && body?.candles) {
    const filtered = {};
    for (const [tf, arr] of Object.entries(body.candles)) filtered[tf] = arr.filter((c) => c.time >= since);
    body.candles = filtered;
  }
  return { status, body };
}

/** Message d'erreur sans détail interne (A10). */
function tvErrorMessage(e) {
  const m = String(e?.message || '');
  if (/Cannot find package/i.test(m)) return 'Dépendances manquantes sur le PC : lance « npm ci » à la racine du projet.';
  if (/ECONNREFUSED|CDP|No TradingView|target|fetch failed|connect/i.test(m)) return 'TradingView Desktop n\'est pas joignable : lance-le avec le port de débogage (XAUUSD-Zones.bat).';
  return 'Erreur interne du serveur.';
}

// ── Tailscale (état de l'accès distant) ──────────────────────────────────
// Tailscale peut être installé sur n'importe quel lecteur (ex. B:\\Tailscale) : on cherche, puis on mémorise.
let tsBinCache = null;
function tailscaleBin() {
  if (tsBinCache && existsSync(tsBinCache)) return tsBinCache;
  if (process.platform !== 'win32') return 'tailscale';
  const cands = [process.env.XAUZ_TAILSCALE, process.env.ProgramFiles && join(process.env.ProgramFiles, 'Tailscale', 'tailscale.exe'),
    process.env['ProgramFiles(x86)'] && join(process.env['ProgramFiles(x86)'], 'Tailscale', 'tailscale.exe'),
    process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, 'Tailscale', 'tailscale.exe')];
  for (const l of 'CDEFGHIJKLMNOPQRSTUVWXYZAB') cands.push(`${l}:\\Tailscale\\tailscale.exe`, `${l}:\\Program Files\\Tailscale\\tailscale.exe`);
  tsBinCache = cands.find((c) => c && existsSync(c)) || 'tailscale';
  return tsBinCache;
}
function run(bin, a) {
  return new Promise((ok) => execFile(bin, a, { timeout: 5000, windowsHide: true }, (err, stdout) => ok(err ? null : String(stdout))));
}
async function remoteStatus() {
  const st = await run(tailscaleBin(), ['status', '--json']);
  if (!st) return { installed: false };
  let dns = null, online = false;
  try { const j = JSON.parse(st); dns = String(j?.Self?.DNSName || '').replace(/\.$/, '') || null; online = !!j?.Self?.Online; } catch { /* */ }
  const serve = await run(tailscaleBin(), ['serve', 'status', '--json']);
  let serving = false;
  try { serving = serve ? JSON.stringify(JSON.parse(serve)).includes(`127.0.0.1:${REMOTE_PORT}`) : false; } catch { /* */ }
  return { installed: true, online, url: dns ? `https://${dns}` : null, serving, remotePort: REMOTE_PORT };
}

// ── Service LOCAL (PC) ───────────────────────────────────────────────────
const LOCAL_HOSTS = new Set([`127.0.0.1:${PORT}`, `localhost:${PORT}`]);
const localServer = http.createServer(async (req, res) => {
  try {
    // anti « DNS rebinding » : seul un Host local est accepté
    if (!LOCAL_HOSTS.has(String(req.headers.host || '').toLowerCase())) return send(res, 421, { error: 'Hôte refusé' });
    const url = new URL(req.url, `http://${req.headers.host}`);
    if (url.pathname.startsWith('/api/')) {
      // anti-CSRF : en-tête personnalisé obligatoire (déclenche un pré-vol CORS jamais accordé) + origine locale
      const origin = req.headers.origin;
      if (req.headers['x-xz'] !== '1' || (origin && !LOCAL_HOSTS.has(origin.replace(/^https?:\/\//, '')))) {
        await sec.secLog('local_csrf_rejected', { path: url.pathname, origin: origin || '' });
        return send(res, 403, { error: 'Requête refusée' });
      }
      return await localApi(req, res, url);
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, { error: 'Méthode non autorisée' });
    return await serveStatic(url.pathname, res);
  } catch (e) {
    await sec.secLog('local_error', { msg: String(e?.message || e) });
    return send(res, e?.status || 500, { error: e?.status ? e.message : 'Erreur interne du serveur.' });
  }
});

/** Jeton d'admin local (XAUZ_LOCAL_ADMIN_TOKEN=1) : exigé sur les routes mutantes uniquement (voir security.js). */
async function requireLocalAdmin(req) {
  if (!sec.LOCAL_ADMIN_TOKEN_ENABLED) return true;
  return sec.checkLocalAdminToken(req.headers['x-xz-admin']);
}

async function localApi(req, res, url) {
  const p = url.pathname, m = req.method;
  if (p === '/api/health' && m === 'GET') {
    const { getHealth } = await import('./tvfeed.js');
    const h = getHealth();
    return send(res, 200, {
      ok: true, app: 'xauusd-zones', role: 'pc',
      lastDataAt: h.lastDataAt, lastError: h.lastError, failures: h.failures, tvRelaunches: h.tvRelaunches,
      uptimeSec: Math.round(process.uptime()),
    });
  }
  // Jeton d'admin local (désactivé par défaut) : lecture seule via l'endpoint local, mêmes
  // contrôles que le reste de l'API locale (Host + X-XZ + origine, voir localServer ci-dessus).
  if (p === '/api/admin/token' && m === 'GET' && sec.LOCAL_ADMIN_TOKEN_ENABLED) {
    return send(res, 200, { token: await sec.getLocalAdminToken() });
  }
  if (p === '/api/tv/candles' && m === 'GET') {
    try { const { status, body } = await tvCandles(url); return send(res, status, body); }
    catch (e) { if (e?.status) throw e; return send(res, 503, { success: false, error: tvErrorMessage(e) }); }
  }
  if (p === '/api/news' && m === 'GET') {
    const { status, body } = newsResponse(url);
    return send(res, status, body);
  }
  if (p === '/api/backtest' && m === 'GET') {
    const { status, body } = await backtestResponse(url);
    return send(res, status, body);
  }
  if (p === '/api/tv/setup' && m === 'POST') {
    // « Vérifier les marchés TradingView » : résout les 11 marchés sur le graphique UNIQUE via la
    // barre de recherche (jamais de disposition multi-graphiques : l'abonnement ne le permet pas).
    try { const { verifyMarkets } = await import('./tvfeed.js'); return send(res, 200, await verifyMarkets()); }
    catch { return send(res, 503, { success: false, error: 'Impossible de vérifier les marchés dans TradingView Desktop (est-il lancé ?).' }); }
  }
  if (p === '/api/tv/history' && m === 'POST') {
    try { const { loadHistory } = await import('./tvfeed.js'); return send(res, 200, { success: true, results: await loadHistory() }); }
    catch { return send(res, 503, { success: false, error: 'Impossible de charger l\'historique TradingView (est-il lancé ?).' }); }
  }
  if (p === '/api/markets' && m === 'GET') {
    const { getSymbolMap } = await import('./tvfeed.js');
    return send(res, 200, { success: true, markets: MARKET_IDS, symbols: await getSymbolMap() });
  }
  if (p === '/api/admin/pairing' && m === 'POST') {
    if (!(await requireLocalAdmin(req))) { await sec.secLog('local_admin_token_rejected', { path: p }); return send(res, 403, { error: 'Jeton d\'administration local requis' }); }
    // corps facultatif : { ttlMin: 1..30, purpose: 'apk' } (préconfiguration de l'APK à la compilation)
    const body = req.headers['content-type'] ? await readJson(req) : {};
    return send(res, 200, await sec.newPairingCode({ ttlMin: body.ttlMin, purpose: body.purpose }));
  }
  if (p === '/api/admin/devices' && m === 'GET') return send(res, 200, { devices: await sec.listDevices() });
  const dm = /^\/api\/admin\/devices\/([0-9a-f]{12})$/.exec(p);
  if (dm && m === 'DELETE') {
    if (!(await requireLocalAdmin(req))) { await sec.secLog('local_admin_token_rejected', { path: p }); return send(res, 403, { error: 'Jeton d\'administration local requis' }); }
    return send(res, (await sec.revokeDevice(dm[1])) ? 200 : 404, { ok: true });
  }
  if (p === '/api/admin/security' && m === 'GET') return send(res, 200, { events: sec.recentEvents(), alerts: sec.alerts(), locked: sec.isLocked() });
  if (p === '/api/admin/remote' && m === 'GET') return send(res, 200, REMOTE ? await remoteStatus() : { disabled: true });
  if (p === '/api/scan/start' && m === 'POST') {
    await applyScanRisk(req);
    const r = scan.startScan();
    return send(res, r.started ? 200 : 409, r.started ? { success: true } : { success: false, error: 'Une analyse complète est déjà en cours.' });
  }
  if (p === '/api/scan/status' && m === 'GET') return send(res, 200, { success: true, ...scan.scanStatus() });
  if (p === '/api/scan/result' && m === 'GET') {
    const r = await scan.scanResult();
    return send(res, r ? 200 : 404, r ? { success: true, ...r } : { success: false, error: 'Aucune analyse complète terminée pour le moment.' });
  }
  return send(res, 404, { error: 'Introuvable' });
}

async function serveStatic(pathname, res) {
  let rel;
  try { rel = decodeURIComponent(pathname); } catch { return send(res, 400, 'Requête invalide', { type: 'text/plain; charset=utf-8' }); }
  if (rel.includes('\0')) return send(res, 400, 'Requête invalide', { type: 'text/plain; charset=utf-8' });
  let file = resolve(WWW, '.' + (rel.endsWith('/') ? rel + 'index.html' : rel));
  const r = relative(WWW, file);
  if (r.startsWith('..') || isAbsolute(r)) return send(res, 403, 'Interdit', { type: 'text/plain; charset=utf-8' });
  try {
    if ((await stat(file)).isDirectory()) file = join(file, 'index.html');
    const ext = extname(file);
    if (!MIME[ext]) return send(res, 404, 'Introuvable', { type: 'text/plain; charset=utf-8' });
    return send(res, 200, await readFile(file), { type: MIME[ext], html: ext === '.html' });
  } catch {
    return send(res, 404, 'Introuvable', { type: 'text/plain; charset=utf-8' });
  }
}

// ── Service DISTANT (téléphone, via Tailscale Serve en HTTPS) ────────────
const buckets = new Map();
function rateLimited(key, max = 120, windowMs = 60000) {
  const now = Date.now();
  const b = buckets.get(key) || { n: 0, at: now };
  if (now - b.at > windowMs) { b.n = 0; b.at = now; }
  b.n++; buckets.set(key, b);
  return b.n > max;
}

const remoteServer = http.createServer(async (req, res) => {
  const origin = req.headers.origin;
  const cors = origin && APP_ORIGINS.has(origin)
    ? { 'Access-Control-Allow-Origin': origin, Vary: 'Origin', 'Access-Control-Allow-Headers': 'Authorization, Content-Type', 'Access-Control-Allow-Methods': 'GET, POST', 'Access-Control-Max-Age': '600' }
    : { Vary: 'Origin' };
  const out = (code, body) => send(res, code, body, { remote: true, extra: cors });
  try {
    if (req.method === 'OPTIONS') { res.writeHead(cors['Access-Control-Allow-Origin'] ? 204 : 403, { ...sec.securityHeaders({ remote: true }), ...cors }); return res.end(); }
    if (origin && !APP_ORIGINS.has(origin)) { await sec.secLog('remote_origin_rejected', { origin }); return out(403, { error: 'Origine refusée' }); }
    // A01 : seules les requêtes relayées par Tailscale Serve (identité du tailnet) sont acceptées
    const login = String(req.headers['tailscale-user-login'] || '').slice(0, 120) || null;
    if (REQUIRE_TS && !login) { await sec.secLog('remote_rejected_no_tailscale', {}); return out(403, { error: 'Accès uniquement via Tailscale.' }); }
    if (rateLimited(login || 'anon')) { await sec.secLog('remote_rate_limited', { login }); return out(429, { error: 'Trop de requêtes.' }); }
    const url = new URL(req.url, 'http://127.0.0.1');
    const p = url.pathname, m = req.method;

    if (p === '/api/health' && m === 'GET') return out(200, { ok: true, app: 'xauusd-zones' });
    if (p === '/api/pair' && m === 'POST') {
      // A07 : quand la vérification Tailscale est désactivée (XAUZ_REQUIRE_TAILSCALE=0), l'appairage
      // distant exige en plus une confirmation explicite (XAUZ_INSECURE_ALLOW_PAIRING=1), sinon refusé.
      if (!REQUIRE_TS && !INSECURE_ALLOW_PAIRING) {
        await sec.secLog('pair_rejected_insecure_mode', {});
        return out(403, { error: 'Appairage refusé : vérification Tailscale désactivée sans confirmation explicite (XAUZ_INSECURE_ALLOW_PAIRING=1).' });
      }
      const body = await readJson(req);
      const r = await sec.redeemPairing({ code: body.code, name: body.name, login });
      return out(r.ok ? 200 : r.status, r.ok ? { token: r.token, deviceId: r.deviceId, expiresAt: r.expiresAt } : { error: r.error });
    }
    // tout le reste exige un appareil appairé
    const auth = await sec.authenticate({ authorization: req.headers.authorization, login });
    if (!auth.ok) return out(auth.status, { error: auth.error });
    if (p === '/api/tv/candles' && m === 'GET') {
      try { const { status, body } = await tvCandles(url); return out(status, body); }
      catch (e) { if (e?.status) throw e; return out(503, { success: false, error: tvErrorMessage(e) }); }
    }
    if (p === '/api/news' && m === 'GET') {
      const { status, body } = newsResponse(url);
      return out(status, body);
    }
    if (p === '/api/backtest' && m === 'GET') {
      const { status, body } = await backtestResponse(url);
      return out(status, body);
    }
    if (p === '/api/session' && m === 'GET') return out(200, { ok: true, device: auth.device });
    if (p === '/api/markets' && m === 'GET') {
      const { getSymbolMap } = await import('./tvfeed.js');
      return out(200, { success: true, markets: MARKET_IDS, symbols: await getSymbolMap() });
    }
    if (p === '/api/scan/start' && m === 'POST') {
      // limite dédiée : 1 déclenchement distant toutes les 10 minutes par appareil (scan coûteux)
      if (rateLimited(`scan:${login || auth.device?.id || 'anon'}`, 1, 10 * 60000)) { await sec.secLog('remote_scan_rate_limited', { login }); return out(429, { error: 'Analyse complète déjà lancée récemment : réessaie dans 10 minutes.' }); }
      await applyScanRisk(req);
      const r = scan.startScan();
      return out(r.started ? 200 : 409, r.started ? { success: true } : { success: false, error: 'Une analyse complète est déjà en cours.' });
    }
    if (p === '/api/scan/status' && m === 'GET') return out(200, { success: true, ...scan.scanStatus() });
    if (p === '/api/scan/result' && m === 'GET') {
      const r = await scan.scanResult();
      return out(r ? 200 : 404, r ? { success: true, ...r } : { success: false, error: 'Aucune analyse complète terminée pour le moment.' });
    }
    return out(404, { error: 'Introuvable' });
  } catch (e) {
    if (!e?.status) await sec.secLog('remote_error', { msg: String(e?.message || e) });
    return out(e?.status || 500, { error: e?.status ? e.message : 'Erreur interne du serveur.' });
  }
});

for (const s of [localServer, remoteServer]) {
  s.requestTimeout = 60000; s.headersTimeout = 15000; s.maxHeadersCount = 50;
}

process.on('unhandledRejection', (e) => { sec.secLog('unhandled_rejection', { msg: String(e?.message || e) }); });
process.on('uncaughtException', (e) => { sec.secLog('uncaught_exception', { msg: String(e?.message || e) }); });

export function start() {
  if (!REQUIRE_TS) {
    // A01 : désactiver la vérification Tailscale ouvre l'API distante à quiconque atteint le
    // port REMOTE_PORT (ex. « tailscale serve » mal configuré, ou pas de Tailscale du tout).
    const warn = '/!\\ XAUZ_REQUIRE_TAILSCALE=0 : vérification Tailscale DÉSACTIVÉE sur l\'API distante — ' +
      'l\'appairage exige en plus XAUZ_INSECURE_ALLOW_PAIRING=1. À ne jamais utiliser en production.';
    console.warn('\n' + '!'.repeat(70)); console.warn(warn); console.warn('!'.repeat(70) + '\n');
    sec.secLog('startup_insecure_no_tailscale', {});
  }
  localServer.listen(PORT, HOST, () => {
    const local = `http://localhost:${PORT}`;
    console.log(`XAUUSD Zones (PC) → ${local}`);
    if (OPEN) openBrowser(local);
  });
  if (REMOTE) {
    remoteServer.listen(REMOTE_PORT, HOST, () => {
      console.log(`API téléphone → 127.0.0.1:${REMOTE_PORT} (publiée en HTTPS dans ton réseau Tailscale par acces-distant.bat)`);
      if (!process.argv.includes('--no-code')) {
        printPairingCode();
        // Entrée dans la fenêtre = nouveau code (l'ancien est aussitôt invalidé)
        if (process.stdin.isTTY) { process.stdin.setEncoding('utf8'); process.stdin.on('data', () => printPairingCode()); }
      }
    });
  }
  sec.secLog('server_started', { port: PORT, remotePort: REMOTE ? REMOTE_PORT : null });
  // Charge l'historique TradingView en tâche de fond (peu après le démarrage, puis toutes les 30 min) :
  // sans bloquer le démarrage du serveur, jamais superposé à un getCandles (verrou partagé dans tvfeed.js).
  import('./tvfeed.js').then(({ scheduleHistoryLoads }) => scheduleHistoryLoads()).catch(() => {});
  // Annonces économiques (calendrier TradingView) : désactivé en tests (XAUZ_NO_NEWS) et avec --no-news.
  if (!args.includes('--no-news') && process.env.XAUZ_NO_NEWS !== '1') news.start().catch(() => {});
}
/** Affiche un code d'appairage à usage unique (10 min) dans la fenêtre du serveur. */
async function printPairingCode() {
  try {
    const { code, expiresAt } = await sec.newPairingCode();
    let url = null;
    try { const st = await remoteStatus(); url = st?.url || null; } catch { /* Tailscale indisponible */ }
    const fin = new Date(expiresAt).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
    console.log('');
    const line = (t) => console.log(`  | ${t.padEnd(44)} |`);
    console.log('  +' + '-'.repeat(46) + '+');
    line(`CODE D'APPAIRAGE :  ${code.slice(0, 4)} ${code.slice(4)}`);
    line(`valable jusqu'à ${fin}, une seule fois`);
    console.log('  +' + '-'.repeat(46) + '+');
    if (url) console.log(`  Adresse du PC (déjà préréglée dans l'app) : ${url}`);
    console.log('  Nouveau code : appuie sur Entrée dans cette fenêtre.');
    console.log('');
  } catch { console.log('Code d\'appairage indisponible : lance code-appairage.bat.'); }
}

export { localServer, remoteServer };

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) start();

function openBrowser(url) {
  try {
    if (process.platform === 'win32') {
      const p = spawn('cmd', ['/c', 'start', '', 'msedge', `--app=${url}`], { detached: true, stdio: 'ignore', windowsHide: true });
      p.on('error', () => spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore' }));
      p.unref();
    } else {
      spawn(process.platform === 'darwin' ? 'open' : 'xdg-open', [url], { detached: true, stdio: 'ignore' }).on('error', () => {}).unref();
    }
  } catch { /* ignore */ }
}
