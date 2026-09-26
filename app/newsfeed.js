/**
 * Annonces économiques (calendrier TradingView) — impact MAJEUR uniquement, 4 pays suivis :
 * US (États-Unis), EU (zone euro), CN (Chine), JP (Japon).
 *
 * Interroge https://economic-calendar.tradingview.com/events (mêmes en-têtes que
 * scripts/sync-economic-calendar.mjs), sur une fenêtre glissante [maintenant − 1 jour,
 * maintenant + 7 jours]. Fréquence : toutes les 15 min normalement, toutes les 30 s dès qu'une
 * annonce suivie est due dans les 5 prochaines minutes, ou était due dans les 30 dernières minutes
 * sans valeur `actual` encore publiée (résultat imminent ou en retard de publication).
 *
 * Chaque champ reçu est assaini (A03/A05) : seuls les champs de la liste blanche sont conservés,
 * les chaînes sont nettoyées des caractères de contrôle et bornées en longueur, les nombres
 * doivent être finis. Un `seq` monotone croissant est incrémenté à chaque changement observable
 * (ajout, heure modifiée, `actual` publié) : le client interroge /api/news?since=<seq> pour ne
 * recevoir que les événements changés depuis son dernier appel réussi.
 */
import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import { join } from 'node:path';
import * as sec from './security.js';
import { NEWS_COUNTRIES } from './www/js/news.js';

const NEWS_FILE = () => join(sec.DATA_DIR, 'news.json');
const URL_BASE = 'https://economic-calendar.tradingview.com/events';
const WINDOW_BEFORE_MS = 24 * 3600 * 1000; // maintenant − 1 jour
const WINDOW_AFTER_MS = 7 * 24 * 3600 * 1000; // maintenant + 7 jours
const POLL_NORMAL_MS = 15 * 60 * 1000;
const POLL_FAST_MS = 30 * 1000;
const DUE_SOON_MS = 5 * 60 * 1000; // pré-alerte : annonce due dans les 5 prochaines minutes
const DUE_LATE_MS = 30 * 60 * 1000; // résultat en attente : annonce due depuis moins de 30 min, sans `actual`
const FETCH_TIMEOUT_MS = 10000;
const BACKOFF_MAX_MS = 15 * 60 * 1000;
const MAX_STR = { title: 200, country: 8, unit: 24, period: 40, id: 128 };

let fetchImpl = globalThis.fetch;
/** Pour les tests : injecte un faux `fetch`. */
export function _setFetch(fn) { fetchImpl = fn; }

// ── état en mémoire ────────────────────────────────────────────────────────
const state = {
  seq: 0,
  events: new Map(), // id -> événement assaini
  eventSeq: new Map(), // id -> seq de sa dernière modification (ajout, heure, actual publié…)
  updatedAt: null,
  consecutiveFailures: 0,
};
let loaded = false;
let timer = null;

function sanitizeStr(v, maxLen) {
  if (v == null) return null;
  const s = String(v).replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, maxLen);
  return s || null;
}
function sanitizeNum(v) {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * Assainit un événement brut du calendrier TradingView : importance MAJEURE (1) uniquement, pays
 * dans la liste blanche, champs whitelistés. Renvoie `null` si l'événement doit être écarté.
 */
export function sanitizeEvent(raw) {
  if (!raw || typeof raw !== 'object') return null;
  if (Number(raw.importance) !== 1) return null;
  const country = sanitizeStr(raw.country, MAX_STR.country);
  if (!country || !NEWS_COUNTRIES.includes(country)) return null;
  const id = sanitizeStr(raw.id, MAX_STR.id) || null;
  const title = sanitizeStr(raw.title, MAX_STR.title);
  if (!title) return null;
  const t = Math.floor(Date.parse(raw.date) / 1000);
  if (!Number.isFinite(t) || t <= 0) return null;
  const key = id || `${t}|${country}|${title}`;
  return {
    id: key, title, country, t,
    actual: sanitizeNum(raw.actual), forecast: sanitizeNum(raw.forecast), previous: sanitizeNum(raw.previous),
    unit: sanitizeStr(raw.unit, MAX_STR.unit), scale: sanitizeStr(raw.scale, MAX_STR.unit),
    period: sanitizeStr(raw.period, MAX_STR.period),
  };
}

/**
 * Fusionne une liste d'événements bruts dans l'état en mémoire : ne garde que ceux dans la fenêtre
 * [nowMs − 1 jour, nowMs + 7 jours], incrémente `seq` à chaque ajout, changement d'heure, ou
 * publication d'un `actual` jusque-là absent.
 * @returns {{ changed: boolean }}
 */
export function _ingest(rawList, nowMs = Date.now()) {
  const lo = (nowMs - WINDOW_BEFORE_MS) / 1000, hi = (nowMs + WINDOW_AFTER_MS) / 1000;
  let changed = false;
  for (const raw of Array.isArray(rawList) ? rawList : []) {
    const ev = sanitizeEvent(raw);
    if (!ev || ev.t < lo || ev.t > hi) continue;
    const prev = state.events.get(ev.id);
    if (!prev) { state.events.set(ev.id, ev); state.eventSeq.set(ev.id, ++state.seq); changed = true; continue; }
    const actualPublished = prev.actual == null && ev.actual != null;
    const timeChanged = prev.t !== ev.t;
    const otherChanged = prev.title !== ev.title || prev.forecast !== ev.forecast || prev.previous !== ev.previous || prev.unit !== ev.unit || prev.period !== ev.period;
    if (actualPublished || timeChanged || otherChanged) { state.events.set(ev.id, ev); state.eventSeq.set(ev.id, ++state.seq); changed = true; }
  }
  // purge des événements sortis de la fenêtre (ex. plus vieux que J-1)
  for (const [id, ev] of state.events) if (ev.t < lo || ev.t > hi) { state.events.delete(id); state.eventSeq.delete(id); changed = true; }
  if (changed) state.updatedAt = new Date(nowMs).toISOString();
  return { changed };
}

/** Événements changés depuis `sinceSeq` (0 = tous), triés chronologiquement. */
export function eventsSince(sinceSeq = 0) {
  return [...state.events.values()].filter((ev) => (state.eventSeq.get(ev.id) || 0) > sinceSeq).sort((a, b) => a.t - b.t);
}

/** Accès à l'état complet (pour les routes et les tests). */
export function _state() { return { seq: state.seq, updatedAt: state.updatedAt, events: [...state.events.values()] }; }

async function loadFromDisk() {
  if (loaded) return;
  loaded = true;
  try {
    const j = JSON.parse(await readFile(NEWS_FILE(), 'utf8'));
    if (Number.isInteger(j?.seq)) state.seq = j.seq;
    if (typeof j?.updatedAt === 'string') state.updatedAt = j.updatedAt;
    if (Array.isArray(j?.events)) for (const ev of j.events) {
      const s = sanitizeEvent({ ...ev, date: new Date(ev.t * 1000).toISOString(), importance: 1 });
      if (s) { state.events.set(s.id, s); state.eventSeq.set(s.id, Number.isInteger(ev._seq) ? ev._seq : state.seq); }
    }
  } catch { /* absent ou invalide : état vide */ }
}
async function saveToDisk() {
  try {
    await mkdir(sec.DATA_DIR, { recursive: true });
    const tmp = NEWS_FILE() + '.tmp';
    const events = [...state.events.values()].map((ev) => ({ ...ev, _seq: state.eventSeq.get(ev.id) || 0 }));
    await writeFile(tmp, JSON.stringify({ seq: state.seq, updatedAt: state.updatedAt, events }));
    await rename(tmp, NEWS_FILE());
  } catch { /* la persistance ne doit jamais faire tomber le service */ }
}

/** Un seul appel réseau vers le calendrier TradingView (fenêtre glissante). */
async function fetchWindow(nowMs) {
  const from = new Date(nowMs - WINDOW_BEFORE_MS).toISOString();
  const to = new Date(nowMs + WINDOW_AFTER_MS).toISOString();
  const params = new URLSearchParams({ from, to, countries: NEWS_COUNTRIES.join(',') });
  const ctrl = new AbortController();
  const timer2 = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const r = await fetchImpl(`${URL_BASE}?${params}`, {
      signal: ctrl.signal,
      headers: { Accept: 'application/json', Origin: 'https://www.tradingview.com', Referer: 'https://www.tradingview.com/economic-calendar/', 'User-Agent': 'Mozilla/5.0' },
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const payload = await r.json();
    if (payload?.status !== 'ok' || !Array.isArray(payload.result)) throw new Error('Réponse calendrier invalide');
    return payload.result;
  } finally { clearTimeout(timer2); }
}

/** Un événement suivi est-il « imminent » (dû dans les 5 min) ou « en retard de résultat » (dû depuis < 30 min, sans actual) ? */
function needsFastPolling(nowMs) {
  const t = nowMs / 1000;
  for (const ev of state.events.values()) {
    if (ev.t >= t && ev.t - t <= DUE_SOON_MS / 1000) return true;
    if (ev.t < t && t - ev.t <= DUE_LATE_MS / 1000 && ev.actual == null) return true;
  }
  return false;
}

async function pollOnce() {
  const nowMs = Date.now();
  try {
    const raw = await fetchWindow(nowMs);
    _ingest(raw, nowMs);
    state.consecutiveFailures = 0;
    await saveToDisk();
  } catch (e) {
    state.consecutiveFailures++;
    await sec.secLog('news_fetch_failed', { msg: String(e?.message || e), attempt: state.consecutiveFailures });
  }
  scheduleNext();
}

function scheduleNext() {
  clearTimeout(timer);
  let delay = needsFastPolling(Date.now()) ? POLL_FAST_MS : POLL_NORMAL_MS;
  if (state.consecutiveFailures > 0) delay = Math.max(delay, Math.min(BACKOFF_MAX_MS, POLL_FAST_MS * 2 ** state.consecutiveFailures));
  timer = setTimeout(pollOnce, delay);
  if (typeof timer.unref === 'function') timer.unref();
}

/** Démarre le polling en tâche de fond (idempotent). */
export async function start() {
  await loadFromDisk();
  if (timer) return;
  pollOnce();
}
/** Pour les tests. */
export function _stop() { clearTimeout(timer); timer = null; }
export function _reset() { state.seq = 0; state.events.clear(); state.eventSeq.clear(); state.updatedAt = null; state.consecutiveFailures = 0; loaded = false; clearTimeout(timer); timer = null; }
