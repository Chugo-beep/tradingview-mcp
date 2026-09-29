#!/usr/bin/env node
/**
 * Construit www/data/macro-model.json : influence MESURÉE des annonces économiques sur chaque marché.
 *
 * Entrées : .cache-histo/calendar-<from>-<to>.json (scripts/fetch-calendar-history.mjs)
 *           .cache-histo/<MARCHÉ>-<from>-<to>.json (bougies 1 m Dukascopy, scripts/backtest-dukascopy.mjs)
 * Usage   : node --max-old-space-size=8192 scripts/build-macro-model.mjs --markets XAUUSD,NAS100,US30,EURUSD --from 2019-01-01 --to 2026-09-29
 *
 * Pour chaque indicateur (≥ 30 publications) et chaque marché :
 *  - surprise z = (publié − prévu) / σ robuste de l'indicateur (écrêtée à ±4) ;
 *  - rendements normalisés par le mouvement typique d'1 h du marché : réaction 0 → 1 h (b60),
 *    dérive 1 h → 1 j (d1), dérive 1 j → 3 j (d2) ;
 *  - régression rendement ~ z. Un coefficient n'est retenu que si |t| ≥ 3 sur tout l'historique
 *    (des centaines de tests : seuil strict contre les faux positifs) ET s'il garde le même signe
 *    sur les 30 % les plus récents (hors échantillon) avec |t| ≥ 2 sur les 70 % anciens.
 * Liens entre indicateurs : corrélation des surprises d'un indicateur publié dans les 12 jours
 * AVANT un autre (même filtre |t| ≥ 3 + stabilité hors échantillon).
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { titleKey, familyOf } from '../www/js/macro.js';

const APP_DIR = join(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const argVal = (n, d) => { const i = args.indexOf(n); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const MARKETS = argVal('--markets', 'XAUUSD,NAS100,US30,EURUSD').split(',').map((s) => s.trim().toUpperCase());
const FROM = argVal('--from', '2019-01-01');
const TO = argVal('--to', new Date().toISOString().slice(0, 10));
const MIN_N = 30, T_FULL = 3, T_FOREIGN = 4, T_IS = 2, SPLIT = 0.7, ZCLIP = 4;
const LINK_MIN_N = 50, LINK_T = 5;
/** Pays « domestiques » de chaque marché (a priori économique) : seuil |t| ≥ 3 ; autres pays : |t| ≥ 4. */
const HOME = { XAUUSD: ['US'], NAS100: ['US'], US30: ['US'], SP500: ['US'], WTI: ['US'], BRENT: ['US'], EURUSD: ['US', 'EU', 'DE'], GBPUSD: ['US', 'GB'], USDJPY: ['US', 'JP'], DAX40: ['EU', 'DE', 'US'], CAC40: ['EU', 'DE', 'US'] };
/** Zone économique d'un pays (les liens entre indicateurs sont limités à une même zone). */
const AREA = { US: 'US', EU: 'EU', DE: 'EU', FR: 'EU', IT: 'EU', GB: 'GB', JP: 'JP', CN: 'CN' };

const median = (a) => { const s = [...a].sort((x, y) => x - y); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
function robustSigma(xs) {
  const med = median(xs);
  const mad = median(xs.map((x) => Math.abs(x - med))) * 1.4826;
  if (mad > 0) return mad;
  const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
  const sd = Math.sqrt(xs.reduce((a, b) => a + (b - mean) ** 2, 0) / Math.max(1, xs.length - 1));
  return sd > 0 ? sd : null;
}
/** OLS y = a + b·x : pente, erreur-type, t. */
function ols(xs, ys) {
  const n = xs.length;
  if (n < 5) return null;
  const mx = xs.reduce((a, b) => a + b, 0) / n, my = ys.reduce((a, b) => a + b, 0) / n;
  let sxx = 0, sxy = 0;
  for (let i = 0; i < n; i++) { sxx += (xs[i] - mx) ** 2; sxy += (xs[i] - mx) * (ys[i] - my); }
  if (!(sxx > 0)) return null;
  const b = sxy / sxx, a = my - b * mx;
  let sse = 0;
  for (let i = 0; i < n; i++) sse += (ys[i] - a - b * xs[i]) ** 2;
  const se = Math.sqrt(sse / (n - 2) / sxx);
  return { b, se, t: se > 0 ? b / se : 0, n };
}
const r3 = (v) => Math.round(v * 1000) / 1000;

// ── calendrier : σ par indicateur ────────────────────────────────────────
const cal = JSON.parse(await readFile(join(APP_DIR, '.cache-histo', `calendar-${FROM}-${TO}.json`), 'utf8'));
const byKey = new Map();
for (const e of cal.events) {
  if (e.actual == null || e.forecast == null) continue;
  const k = titleKey(e.country, e.title);
  (byKey.get(k) || byKey.set(k, []).get(k)).push(e);
}
const keys = {};
for (const [k, list] of byKey) {
  if (list.length < MIN_N) continue;
  const sigma = robustSigma(list.map((e) => e.actual - e.forecast));
  if (!sigma) continue;
  list.sort((a, b) => a.t - b.t);
  keys[k] = { sigma: +sigma.toPrecision(4), n: list.length, family: familyOf(list[0].title), country: list[0].country, title: k.split(':').slice(1).join(':') };
}
const zOf = (e) => Math.max(-ZCLIP, Math.min(ZCLIP, (e.actual - e.forecast) / keys[titleKey(e.country, e.title)].sigma));
console.error(`${Object.keys(keys).length} indicateurs avec ≥ ${MIN_N} publications chiffrées`);

// ── sensibilité de chaque marché ─────────────────────────────────────────
function lastBarIdx(times, t) { // dernière bougie dont l'ouverture ≤ t
  let lo = 0, hi = times.length - 1, idx = -1;
  while (lo <= hi) { const m = (lo + hi) >> 1; if (times[m] <= t) { idx = m; lo = m + 1; } else hi = m - 1; }
  return idx;
}
const sensitivity = {}, moves = {};
for (const id of MARKETS) {
  let m1;
  try { m1 = JSON.parse(await readFile(join(APP_DIR, '.cache-histo', `${id}-${FROM}-${TO}.json`), 'utf8')); }
  catch { console.error(`${id} : pas de bougies 1 m en cache, ignoré`); continue; }
  const n = m1.length;
  const times = new Float64Array(n), close = new Float64Array(n);
  for (let i = 0; i < n; i++) { times[i] = m1[i].time; close[i] = m1[i].close; }
  m1 = null;
  // mouvement typique d'1 h : écart-type des rendements log sur 60 min (fenêtres disjointes)
  const rets = [];
  for (let i = 0; i + 60 < n; i += 60) if (times[i + 60] - times[i] <= 3900) rets.push(Math.log(close[i + 60] / close[i]));
  const mean = rets.reduce((a, b) => a + b, 0) / rets.length;
  const s60 = Math.sqrt(rets.reduce((a, b) => a + (b - mean) ** 2, 0) / (rets.length - 1));
  moves[id] = { sigma60: +s60.toPrecision(4) };
  const t0 = times[0], t1 = times[n - 1];
  const px = (t, maxLag) => { const i = lastBarIdx(times, t - 60); return i >= 0 && t - 60 - times[i] <= maxLag ? close[i] : null; };
  const out = {};
  for (const [k, info] of Object.entries(keys)) {
    const rows = [];
    for (const e of byKey.get(k)) {
      if (e.t < t0 + 3600 || e.t > t1 - 3 * 86400) continue;
      const p0 = px(e.t, 600), p60 = px(e.t + 3600, 600), p1 = px(e.t + 86400, 3 * 86400), p3 = px(e.t + 3 * 86400, 3 * 86400);
      if ([p0, p60, p1, p3].some((v) => v == null)) continue;
      rows.push({ t: e.t, z: zOf(e), r60: Math.log(p60 / p0) / s60, d1: Math.log(p1 / p60) / s60, d2: Math.log(p3 / p1) / s60 });
    }
    if (rows.length < MIN_N) continue;
    const cut = rows[Math.floor(rows.length * SPLIT)].t;
    const tMin = (HOME[id] || ['US']).includes(info.country) ? T_FULL : T_FOREIGN;
    const pick = (field) => {
      const full = ols(rows.map((r) => r.z), rows.map((r) => r[field]));
      const isR = rows.filter((r) => r.t < cut), oosR = rows.filter((r) => r.t >= cut);
      const is = ols(isR.map((r) => r.z), isR.map((r) => r[field]));
      const oos = ols(oosR.map((r) => r.z), oosR.map((r) => r[field]));
      const ok = full && is && oos && Math.abs(full.t) >= tMin && Math.abs(is.t) >= T_IS && Math.sign(is.b) === Math.sign(oos.b);
      return { ok, b: full?.b ?? 0, t: full?.t ?? 0, oosB: oos?.b ?? null };
    };
    const b60 = pick('r60'), d1 = pick('d1'), d2 = pick('d2');
    if (!b60.ok && !d1.ok && !d2.ok) continue;
    out[k] = {
      n: rows.length, title: info.title, country: info.country, family: info.family,
      b60: b60.ok ? r3(b60.b) : 0, t60: r3(b60.t),
      d1: d1.ok ? r3(d1.b) : 0, t1: r3(d1.t),
      d2: d2.ok ? r3(d2.b) : 0, t2: r3(d2.t),
    };
  }
  sensitivity[id] = out;
  const drift = Object.values(out).filter((s) => s.d1 || s.d2).length;
  console.error(`${id} : ${Object.keys(out).length} indicateur(s) influent(s) (réaction 1 h), dont ${drift} avec dérive persistante`);
}

// ── liens entre indicateurs (surprise de A publiée avant B) ──────────────
const links = [];
const keyList = Object.keys(keys);
for (const b of keyList) {
  const B = byKey.get(b);
  for (const a of keyList) {
    if (a === b || AREA[keys[a].country] !== AREA[keys[b].country]) continue;
    const A = byKey.get(a);
    const pairs = [];
    let j = 0;
    for (const eb of B) {
      while (j + 1 < A.length && A[j + 1].t < eb.t) j++;
      const ea = A[j];
      if (!ea || ea.t >= eb.t || eb.t - ea.t > 12 * 86400) continue;
      pairs.push({ t: eb.t, za: zOf(ea), zb: zOf(eb) });
    }
    if (pairs.length < LINK_MIN_N) continue;
    const corr = (ps) => {
      const n = ps.length; if (n < 8) return null;
      const ma = ps.reduce((s, p) => s + p.za, 0) / n, mb = ps.reduce((s, p) => s + p.zb, 0) / n;
      let sab = 0, saa = 0, sbb = 0;
      for (const p of ps) { sab += (p.za - ma) * (p.zb - mb); saa += (p.za - ma) ** 2; sbb += (p.zb - mb) ** 2; }
      const r = saa > 0 && sbb > 0 ? sab / Math.sqrt(saa * sbb) : 0;
      return { r, t: r * Math.sqrt((n - 2) / Math.max(1e-9, 1 - r * r)), n };
    };
    const cut = pairs[Math.floor(pairs.length * SPLIT)].t;
    const full = corr(pairs), is = corr(pairs.filter((p) => p.t < cut)), oos = corr(pairs.filter((p) => p.t >= cut));
    if (full && is && oos && Math.abs(full.t) >= LINK_T && Math.abs(is.t) >= T_IS && Math.sign(is.r) === Math.sign(oos.r)) {
      links.push({ from: a, to: b, rho: r3(full.r), n: full.n, t: r3(full.t) });
    }
  }
}
links.sort((x, y) => Math.abs(y.rho) - Math.abs(x.rho));
console.error(`${links.length} lien(s) entre indicateurs`);

const model = { builtAt: new Date().toISOString(), from: FROM, to: TO, method: 'OLS rendement ~ surprise ; |t| ≥ 3 (pays du marché) ou ≥ 4 (autres) + stabilité hors échantillon (30 % récents) ; liens : |t| ≥ 5, n ≥ 50, même zone économique', moves, keys, sensitivity, links };
await mkdir(join(APP_DIR, 'www', 'data'), { recursive: true });
const file = join(APP_DIR, 'www', 'data', 'macro-model.json');
await writeFile(file, JSON.stringify(model));
console.log(`Modèle macro → ${file}`);
