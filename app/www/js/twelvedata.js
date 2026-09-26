/**
 * Source gratuite Twelve Data (offre Basic : 800 crédits / jour, 8 / minute, sans carte bancaire).
 * 1 requête time_series = 1 crédit. Pour tenir le quota, chaque timeframe a son propre
 * rythme de rafraîchissement et les données restent en cache entre deux lectures.
 */
import { TF_SECONDS } from './engine.js';

const BASE = 'https://api.twelvedata.com';
export const TD_INTERVAL = { '1': '1min', '5': '5min', '15': '15min', '60': '1h', '240': '4h', 'D': '1day' };
// intervalle minimal entre deux lectures d'une même timeframe (secondes)
// ≈ 480 + 144 + 96 + 24 + 12 + 4 = 760 crédits sur 24 h de marché ouvert
export const TD_REFRESH = { '1': 180, '5': 600, '15': 900, '60': 3600, '240': 7200, 'D': 21600 };
export const DAILY_LIMIT = 800;
const SAFETY = 780;
const PER_MIN = 8;

const K_CACHE = 'xauz.td.cache.v1';
const K_CREDITS = 'xauz.td.credits.v1';
const load = (k, fb) => { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : fb; } catch { return fb; } };
const save = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* quota */ } };

const cache = load(K_CACHE, {}); // tf -> { at, candles }
const minuteLog = [];

function utcDay() { return new Date().toISOString().slice(0, 10); }
export function credits() {
  const c = load(K_CREDITS, { day: utcDay(), used: 0 });
  return c.day === utcDay() ? c : { day: utcDay(), used: 0 };
}
function spend(n = 1) {
  const c = credits(); c.used += n; save(K_CREDITS, c);
  const now = Date.now(); for (let i = 0; i < n; i++) minuteLog.push(now);
}
function minuteUsed() {
  const t = Date.now() - 61000;
  while (minuteLog.length && minuteLog[0] < t) minuteLog.shift();
  return minuteLog.length;
}

/** Marché de l'or fermé : du vendredi 21 h au dimanche 22 h (UTC). */
export function marketClosed(d = new Date()) {
  const day = d.getUTCDay(), h = d.getUTCHours();
  return (day === 5 && h >= 21) || day === 6 || (day === 0 && h < 22);
}

async function tdGet(path, params, key) {
  const qs = new URLSearchParams({ ...params, apikey: key });
  const r = await fetch(`${BASE}/${path}?${qs}`, { cache: 'no-store' });
  spend(1);
  let j; try { j = await r.json(); } catch { throw new Error(`Twelve Data : réponse illisible (HTTP ${r.status})`); }
  if (j.status === 'error' || j.code) {
    const code = j.code || r.status;
    if (code === 401) throw new Error('Clé Twelve Data refusée : vérifie la clé dans les réglages.');
    if (code === 429) throw new Error('Quota Twelve Data atteint (8 / minute ou 800 / jour) : les données en cache sont utilisées.');
    if (code === 403 || code === 404) throw new Error(`Twelve Data : ${j.message || 'symbole non disponible avec cette offre'}`);
    throw new Error(`Twelve Data : ${j.message || 'erreur ' + code}`);
  }
  return j;
}

function parseSeries(j, tf) {
  const step = TF_SECONDS[tf];
  const now = Date.now() / 1000;
  const rows = (j.values || []).map((v) => ({
    time: Math.floor(Date.parse(v.datetime.replace(' ', 'T') + (v.datetime.length > 10 ? 'Z' : 'T00:00:00Z')) / 1000),
    open: +v.open, high: +v.high, low: +v.low, close: +v.close, volume: +v.volume || 0,
  })).filter((c) => Number.isFinite(c.time)).sort((a, b) => a.time - b.time);
  for (const c of rows) c.complete = c.time + step <= now;
  return rows;
}

/**
 * Bougies XAU/USD par timeframe, en respectant le quota gratuit.
 * @returns {{ candles, errors, ages }}
 */
export async function fetchTwelveData(settings, tfs) {
  const key = (settings.twelveKey || '').trim();
  if (!key) throw new Error('Ajoute ta clé Twelve Data (gratuite) dans les réglages.');
  const now = Date.now();
  const closed = marketClosed();
  const candles = {}, errors = {}, ages = {};
  // timeframes à relire, de la plus courte à la plus longue
  const due = tfs.filter((tf) => {
    const c = cache[tf];
    if (!c || c.key !== key || c.count < Math.min(settings.count, 5000)) return true;
    if (closed) return false; // week-end : pas de nouvelles bougies, on garde le cache
    return now - c.at >= TD_REFRESH[tf] * 1000;
  });
  for (const tf of due) {
    if (credits().used >= SAFETY) { errors[tf] = `quota du jour presque atteint (${credits().used}/${DAILY_LIMIT}) : cache utilisé`; continue; }
    if (minuteUsed() >= PER_MIN) break; // le reste attendra le cycle suivant
    try {
      const j = await tdGet('time_series', {
        symbol: 'XAU/USD', interval: TD_INTERVAL[tf], outputsize: String(Math.min(settings.count, 5000)), timezone: 'UTC', order: 'asc',
      }, key);
      const rows = parseSeries(j, tf);
      if (!rows.length) throw new Error('aucune bougie reçue');
      cache[tf] = { at: Date.now(), key, count: Math.min(settings.count, 5000), candles: rows };
    } catch (e) {
      errors[tf] = e.message;
      if (/refusée/.test(e.message)) throw e;
    }
  }
  save(K_CACHE, cache);
  for (const tf of tfs) {
    if (cache[tf]?.key === key) { candles[tf] = cache[tf].candles; ages[tf] = Math.round((Date.now() - cache[tf].at) / 1000); if (errors[tf] && candles[tf]) errors[tf] += ' (cache)'; }
  }
  if (!Object.keys(candles).length) throw new Error(Object.values(errors)[0] || 'Aucune donnée Twelve Data.');
  return { candles, errors, ages };
}

let eurCache = load('xauz.td.eur.v1', null);
/** EUR/USD (1 crédit, toutes les 6 heures au plus). */
export async function fetchEurUsdTD(settings) {
  const key = (settings.twelveKey || '').trim();
  if (!key) return null;
  if (eurCache && Date.now() - eurCache.at < 6 * 3600 * 1000) return eurCache.v;
  if (credits().used >= SAFETY || minuteUsed() >= PER_MIN) return eurCache?.v ?? null;
  try {
    const j = await tdGet('exchange_rate', { symbol: 'EUR/USD' }, key);
    const v = +j.rate;
    if (Number.isFinite(v) && v > 0) { eurCache = { v, at: Date.now() }; save('xauz.td.eur.v1', eurCache); return v; }
  } catch { /* taux manuel utilisé */ }
  return eurCache?.v ?? null;
}
