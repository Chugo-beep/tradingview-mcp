#!/usr/bin/env node
/**
 * Télécharge l'historique du calendrier économique TradingView (valeurs publiées, prévisions,
 * précédentes) pour mesurer l'influence réelle des annonces (scripts/build-macro-model.mjs).
 *
 * Usage : node scripts/fetch-calendar-history.mjs --from 2019-01-01 --to 2026-09-29 --countries US,EU,GB,JP,CN,DE
 * Sortie : app/.cache-histo/calendar-<from>-<to>.json (non versionné : données brutes volumineuses).
 * Seuls les événements chiffrés (valeur publiée ET prévision) et les décisions de taux sont conservés.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const APP_DIR = join(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const argVal = (n, d) => { const i = args.indexOf(n); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const FROM = argVal('--from', '2019-01-01');
const TO = argVal('--to', new Date().toISOString().slice(0, 10));
const COUNTRIES = argVal('--countries', 'US,EU,GB,JP,CN,DE');
const WEEK = 7 * 86400000;

async function fetchWindow(from, to, attempt = 1) {
  const params = new URLSearchParams({ from: from.toISOString(), to: to.toISOString(), countries: COUNTRIES });
  try {
    const r = await fetch(`https://economic-calendar.tradingview.com/events?${params}`, {
      headers: { Accept: 'application/json', Origin: 'https://www.tradingview.com', Referer: 'https://www.tradingview.com/economic-calendar/', 'User-Agent': 'Mozilla/5.0' },
      signal: AbortSignal.timeout(20000),
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const j = await r.json();
    if (j?.status !== 'ok' || !Array.isArray(j.result)) throw new Error('réponse invalide');
    return j.result;
  } catch (e) {
    if (attempt >= 4) throw e;
    await new Promise((ok) => setTimeout(ok, 1500 * attempt));
    return fetchWindow(from, to, attempt + 1);
  }
}

const num = (v) => (v == null || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));
const events = new Map();
const missing = [];
let n = 0;
for (let cur = new Date(`${FROM}T00:00:00Z`); cur < new Date(`${TO}T23:59:59Z`); cur = new Date(cur.getTime() + WEEK)) {
  const end = new Date(Math.min(cur.getTime() + WEEK, new Date(`${TO}T23:59:59Z`).getTime()));
  try {
    for (const e of await fetchWindow(cur, end)) {
      const actual = num(e.actual), forecast = num(e.forecast);
      const isRate = /interest rate decision|rate decision|deposit facility rate|main refinancing rate/i.test(e.title || '');
      if (actual == null || (forecast == null && !isRate)) continue;
      const t = Math.floor(Date.parse(e.date) / 1000);
      if (!Number.isFinite(t)) continue;
      events.set(String(e.id ?? `${t}|${e.country}|${e.title}`), {
        id: String(e.id ?? ''), t, country: e.country, title: e.title, indicator: e.indicator || null, ticker: e.ticker || null,
        actual, forecast, previous: num(e.previous), importance: Number(e.importance), unit: e.unit || null, scale: e.scale || null, period: e.period || null,
      });
    }
  } catch (err) { missing.push(`${cur.toISOString().slice(0, 10)} : ${err.message}`); }
  if (++n % 25 === 0) console.error(`… ${n} semaines, ${events.size} événements`);
  await new Promise((ok) => setTimeout(ok, 200));
}
const out = [...events.values()].sort((a, b) => a.t - b.t);
await mkdir(join(APP_DIR, '.cache-histo'), { recursive: true });
const file = join(APP_DIR, '.cache-histo', `calendar-${FROM}-${TO}.json`);
await writeFile(file, JSON.stringify({ from: FROM, to: TO, countries: COUNTRIES, missing, events: out }));
console.log(`${out.length} événements chiffrés → ${file}${missing.length ? ` · ${missing.length} semaine(s) manquante(s)` : ''}`);
