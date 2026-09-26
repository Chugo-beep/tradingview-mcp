/**
 * Source de données unique : TradingView Desktop du PC.
 *  - Sur le PC : serveur local (même origine, 127.0.0.1).
 *  - Sur le téléphone : API distante du PC, en HTTPS via Tailscale, avec un jeton d'appareil.
 */
import { TIMEFRAMES } from './engine.js';
import * as vault from './vault.js';

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
  let qs = `tfs=${tfs.join(',')}&count=all`;
  if (Number.isFinite(since) && since > 0) qs += `&since=${Math.floor(since)}`;
  let res;
  if (serverAvailable) {
    try { res = await call(`api/tv/candles?${qs}`, { headers: LOCAL_HEADERS }); }
    catch { throw new Error('Serveur local injoignable : relance XAUUSD-Zones.bat.'); }
  } else {
    const base = remoteBase(settings.remoteUrl);
    if (!base) throw new Error('Indique l\'adresse HTTPS du PC (https://…ts.net) dans les réglages puis appaire ce téléphone.');
    const token = await vault.get('deviceToken');
    if (!token) throw new Error('Ce téléphone n\'est pas appairé : Réglages → Connexion au PC.');
    try { res = await call(`${base}api/tv/candles?${qs}`, { headers: { Authorization: `Bearer ${token}` } }); }
    catch { throw new Error('PC injoignable : vérifie que le PC est allumé, que XAUUSD-Zones.bat tourne et que Tailscale est connecté sur les deux appareils.'); }
    if (res.r.status === 401 || res.r.status === 403) {
      if (res.r.status === 401) await vault.remove('deviceToken');
      throw new Error(res.j.error || 'Accès refusé par le PC : appaire à nouveau ce téléphone.');
    }
  }
  const { r, j } = res;
  if (!r.ok || !j.success) throw new Error(j.error || `Serveur : HTTP ${r.status}`);
  return { source: serverAvailable ? 'TradingView Desktop' : 'TradingView Desktop (PC distant)', symbol: String(j.symbol || ''), candles: j.candles || {}, errors: j.errors || {}, sources: j.sources || {} };
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
  return { expiresAt: res.j.expiresAt, secure: vault.isSecure() };
}

export async function unpair() { await vault.remove('deviceToken'); }
export async function isPaired() { return !!(await vault.get('deviceToken')); }

// ── Administration (PC uniquement) ────────────────────────────────────────
async function admin(path, method = 'GET') {
  const { r, j } = await call(`api/${path}`, { method, headers: LOCAL_HEADERS }, 60000);
  if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
  return j;
}
export const adminApi = {
  newCode: () => admin('admin/pairing', 'POST'),
  devices: () => admin('admin/devices'),
  revoke: (id) => admin(`admin/devices/${encodeURIComponent(id)}`, 'DELETE'),
  security: () => admin('admin/security'),
  remote: () => admin('admin/remote'),
  setupTv: () => admin('tv/setup', 'POST'),
};
