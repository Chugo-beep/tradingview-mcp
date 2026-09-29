/**
 * Source de données unique : TradingView Desktop du PC.
 *  - Sur le PC : serveur local (même origine, 127.0.0.1).
 *  - Sur le téléphone : API distante du PC, en HTTPS via Tailscale, avec un jeton d'appareil.
 */
import { TIMEFRAMES } from './engine.js';
import * as vault from './vault.js';
import { isAndroid } from './native.js';

/** Le serveur ne renvoie ce texte que lorsqu'il rejette explicitement le jeton présenté
 * (appareil inconnu/révoqué ou appairage expiré) : dans ce cas seulement on efface le jeton local.
 * Une 401 pour une autre raison (réseau, panne, 5xx) ne doit jamais désappairer le téléphone. */
const isTokenRejected = (msg) => /inconnu ou révoqu|appairage expir/i.test(String(msg || ''));

export const isNativeApp = () => !!(window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform());
const LOCAL_HEADERS = { 'X-XZ': '1' };

/** Vrai quand l'interface est servie par le serveur du PC. */
export async function hasLocalServer() {
  if (isNativeApp() || location.protocol === 'file:') return false;
  try {
    const r = await fetch('api/health', { cache: 'no-store', headers: LOCAL_HEADERS });
    return r.ok && (await r.json()).role === 'pc';
  } catch { return false; }
}

/** Adresse du PC validée : HTTPS obligatoire (A04). */
export function remoteBase(url) {
  let u;
  try { u = new URL(String(url || '').trim()); } catch { return null; }
  if (u.protocol !== 'https:' || u.username || u.password) return null;
  return `${u.origin}/`;
}

// Lecture des bougies : le PC peut devoir changer de marché puis parcourir 9 timeframes sur le
// graphique unique (plusieurs dizaines de secondes) → délai large, et message distinct du « PC éteint ».
const CANDLES_TIMEOUT_MS = 240000;
const BUSY_MSG = 'Le PC est toujours en train de lire TradingView (changement de marché / timeframes) : l\'analyse sera relancée au prochain cycle.';
const isTimeout = (e) => e?.name === 'AbortError' || e?.name === 'TimeoutError';

async function call(url, opts = {}, timeoutMs = 45000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(url, { cache: 'no-store', credentials: 'omit', redirect: 'error', ...opts, signal: ctrl.signal });
    let j = {}; try { j = await r.json(); } catch { /* réponse vide */ }
    return { r, j };
  } finally { clearTimeout(timer); }
}

/**
 * Bougies de toutes les timeframes : toutes les bougies chargées dans TradingView (count=all).
 * `since` (secondes unix) limite la réponse aux bougies nouvelles/modifiées depuis le dernier cache
 * (le reste vient du cache local) — l'app télécharge ainsi par incréments après la première analyse.
 * @returns {Promise<{ source, symbol, candles, errors, sources }>}
 */
export async function fetchAll(settings, { serverAvailable, since } = {}) {
  const tfs = TIMEFRAMES.filter((tf) => settings.timeframes.includes(tf));
  let qs = `tfs=${tfs.join(',')}&count=all&market=${encodeURIComponent(settings.market || 'XAUUSD')}`;
  if (Number.isFinite(since) && since > 0) qs += `&since=${Math.floor(since)}`;
  let res;
  if (serverAvailable) {
    try { res = await call(`api/tv/candles?${qs}`, { headers: LOCAL_HEADERS }, CANDLES_TIMEOUT_MS); }
    catch (e) { throw new Error(isTimeout(e) ? BUSY_MSG : 'Serveur local injoignable : relance XAUUSD-Zones.bat.'); }
  } else {
    const base = remoteBase(settings.remoteUrl);
    if (!base) throw new Error('Indique l\'adresse HTTPS du PC (https://…ts.net) dans les réglages puis appaire ce téléphone.');
    const token = await vault.get('deviceToken');
    if (!token) throw new Error('Ce téléphone n\'est pas appairé : Réglages → Connexion au PC.');
    try { res = await call(`${base}api/tv/candles?${qs}`, { headers: { Authorization: `Bearer ${token}` } }, CANDLES_TIMEOUT_MS); }
    catch (e) { if (isTimeout(e)) throw new Error(BUSY_MSG); throw new Error('PC injoignable : vérifie que le PC est allumé, que XAUUSD-Zones.bat tourne et que Tailscale est connecté sur les deux appareils.'); }
    if (res.r.status === 401 || res.r.status === 403) {
      // ne retirer le jeton que si le serveur dit explicitement qu'il est inconnu/révoqué/expiré,
      // jamais sur une erreur réseau, une 5xx, ou un simple défaut d'en-tête (ne devrait pas arriver ici)
      if (res.r.status === 401 && isTokenRejected(res.j.error)) await vault.remove('deviceToken');
      throw new Error(res.j.error || 'Accès refusé par le PC : appaire à nouveau ce téléphone.');
    }
  }
  const { r, j } = res;
  if (!r.ok || !j.success) throw new Error(j.error || `Serveur : HTTP ${r.status}`);
  return { source: serverAvailable ? 'TradingView Desktop' : 'TradingView Desktop (PC distant)', symbol: String(j.symbol || ''), candles: j.candles || {}, errors: j.errors || {}, sources: j.sources || {}, meta: j.meta || {} };
}

/**
 * Annonces économiques MAJEURES (US/EU/CN/JP) : mêmes routes locale/distante que `fetchAll`,
 * incrémentales via `since` (numéro de séquence, 0 = tout renvoyer).
 * @returns {Promise<{ seq, events, updatedAt }>}
 */
export async function fetchNews(settings, { serverAvailable, since = 0 } = {}) {
  const qs = `since=${Math.max(0, Math.floor(since) || 0)}`;
  let res;
  if (serverAvailable) {
    res = await call(`api/news?${qs}`, { headers: LOCAL_HEADERS });
  } else {
    const base = remoteBase(settings.remoteUrl);
    if (!base) return { seq: since, events: [], updatedAt: null };
    const token = await vault.get('deviceToken');
    if (!token) return { seq: since, events: [], updatedAt: null };
    try { res = await call(`${base}api/news?${qs}`, { headers: { Authorization: `Bearer ${token}` } }); }
    catch { return { seq: since, events: [], updatedAt: null }; }
  }
  const { r, j } = res;
  if (!r.ok || !j.success) return { seq: since, events: [], updatedAt: null };
  return { seq: j.seq ?? since, events: j.events || [], updatedAt: j.updatedAt || null };
}

/**
 * Faut-il ignorer le cache incrémental (`since`) au prochain appel et retélécharger toute la
 * timeframe ? Oui quand l'historique côté serveur a grandi (première bougie plus ancienne, ou
 * nombre de bougies en hausse notable) — TradingView a chargé plus d'historique depuis la dernière
 * analyse — ou quand la dernière rafraîchissement complet remonte à plus de 30 minutes.
 * Fonction pure (testée isolément) : `cacheInfo`/`meta` = { count, first } | null, `lastFull`/`now` en ms.
 */
export function needsFullRefetch(cacheInfo, meta, lastFull, now) {
  if (!meta) return false;
  if (!cacheInfo) return true;
  if (meta.first != null && cacheInfo.first != null && meta.first < cacheInfo.first) return true;
  if (meta.count != null && cacheInfo.count != null && meta.count > cacheInfo.count + 50) return true;
  if (lastFull == null || now - lastFull >= 30 * 60 * 1000) return true;
  return false;
}

/** Téléphone : échange le code d'appairage contre un jeton, stocké dans le coffre chiffré. */
export async function pair(settings, code) {
  const base = remoteBase(settings.remoteUrl);
  if (!base) throw new Error('Adresse invalide : elle doit commencer par https://');
  if (!/^\d{8}$/.test(String(code))) throw new Error('Le code d\'appairage fait 8 chiffres.');
  let res;
  try {
    res = await call(`${base}api/pair`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: String(code), name: settings.deviceName || 'Téléphone' }),
    }, 20000);
  } catch { throw new Error('PC injoignable : vérifie l\'adresse et que Tailscale est connecté sur le téléphone.'); }
  if (!res.r.ok || !res.j.token) throw new Error(res.j.error || `Appairage refusé (HTTP ${res.r.status}).`);
  await vault.set('deviceToken', res.j.token);
  // ne jamais prétendre que l'appairage tiendra si le coffre chiffré Android est indisponible
  // (pont de plugin natif non prêt) : le jeton n'est alors gardé qu'en mémoire, perdu à la fermeture.
  if (isAndroid() && !vault.isSecure()) throw new Error('Coffre sécurisé indisponible : l\'appairage ne serait pas conservé.');
  return { expiresAt: res.j.expiresAt, secure: vault.isSecure() };
}

export async function unpair() { await vault.remove('deviceToken'); }
export async function isPaired() { return !!(await vault.get('deviceToken')); }

// ── Administration (PC uniquement) ────────────────────────────────────────
async function admin(path, method = 'GET', body) {
  const opts = { method, headers: LOCAL_HEADERS };
  if (body !== undefined) { opts.headers = { ...LOCAL_HEADERS, 'Content-Type': 'application/json' }; opts.body = JSON.stringify(body); }
  const { r, j } = await call(`api/${path}`, opts, 60000);
  if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
  return j;
}
export const adminApi = {
  newCode: () => admin('admin/pairing', 'POST'),
  devices: () => admin('admin/devices'),
  revoke: (id) => admin(`admin/devices/${encodeURIComponent(id)}`, 'DELETE'),
  security: () => admin('admin/security'),
  remote: () => admin('admin/remote'),
  setupTv: () => admin('tv/setup', 'POST'), // « Vérifier les marchés TradingView » : résolution par recherche, UN SEUL graphique
  loadHistory: () => admin('tv/history', 'POST'),
};

/** « Analyse complète » (PC ou téléphone via le PC distant) : mêmes routes locale/distante que fetchAll. */
async function scanCall(path, settings, { serverAvailable }, method = 'GET', payload = null) {
  const bodyOpts = payload ? { body: JSON.stringify(payload) } : {};
  const jsonHdr = payload ? { 'Content-Type': 'application/json' } : {};
  if (serverAvailable) {
    const { r, j } = await call(`api/${path}`, { method, headers: { ...LOCAL_HEADERS, ...jsonHdr }, ...bodyOpts }, 60000);
    if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
    return j;
  }
  const base = remoteBase(settings.remoteUrl);
  if (!base) throw new Error('Indique l\'adresse HTTPS du PC dans les réglages.');
  const token = await vault.get('deviceToken');
  if (!token) throw new Error('Ce téléphone n\'est pas appairé : Réglages → Connexion au PC.');
  const { r, j } = await call(`${base}api/${path}`, { method, headers: { Authorization: `Bearer ${token}`, ...jsonHdr }, ...bodyOpts }, 60000);
  if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
  return j;
}
/** Réglages de stratégie transmis au scan (jamais de données personnelles : pas de capital ni de journal). */
const scanRiskOf = (settings) => {
  const r = settings.risk || {};
  return { strategyMode: r.strategyMode, targetMode: r.targetMode, maxSlAtr: r.maxSlAtr, slippagePips: r.slippagePips, spreadOverrides: r.spreadOverrides, htfFilter: r.htfFilter, sessions: r.sessions, entryMode: r.entryMode };
};
export const scanApi = {
  start: (settings, opts) => scanCall('scan/start', settings, opts, 'POST', { risk: scanRiskOf(settings) }),
  status: (settings, opts) => scanCall('scan/status', settings, opts, 'GET'),
  result: (settings, opts) => scanCall('scan/result', settings, opts, 'GET'),
};

/** Rapport de backtest d'un marché (alimente l'indicateur de confiance), PC ou téléphone via le PC. */
export const backtestApi = { get: (settings, market, opts) => scanCall(`backtest?market=${encodeURIComponent(market)}`, settings, opts, 'GET') };

/** Mapping marché → symbole TradingView résolu par la recherche (PC ou téléphone via le PC distant), pour l'affichage. */
export const marketsApi = { get: (settings, opts) => scanCall('markets', settings, opts, 'GET') };
