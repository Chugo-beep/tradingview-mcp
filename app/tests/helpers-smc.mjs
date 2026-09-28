import { detectSmcSetups } from '../www/js/smc.js';
import { rankMarket } from '../www/js/ranking.js';
import { marketById } from '../www/js/markets.js';
import { rng } from '../www/js/stats.js';
export function series(days, seed, p0 = 3700, vol5 = 1.6) {
  const r = rng(seed); const out = []; let p = p0; const t0 = 1.7e9 - (1.7e9 % 86400);
  let drift = 0;
  for (let i = 0; i < days * 288; i++) {
    if (i % 288 === 0) drift = (r() - 0.5) * 0.3; // régimes de tendance journaliers
    const o = p; let h = o, l = o;
    for (let k = 0; k < 5; k++) { p += (r() - 0.5 + drift * 0.2) * 2 * vol5 / Math.sqrt(5 * 0.66); h = Math.max(h, p); l = Math.min(l, p); }
    out.push({ time: t0 + i * 300, open: o, high: h, low: l, close: p, volume: Math.round(50 + r() * 100 + Math.abs(p - o) * 40), complete: true });
  }
  return out;
}
export function agg(c5, sec, align = 0) {
  const m = new Map();
  for (const c of c5) { const b = Math.floor((c.time - align) / sec) * sec + align; const x = m.get(b); if (!x) m.set(b, { time: b, open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume, complete: true }); else { x.high = Math.max(x.high, c.high); x.low = Math.min(x.low, c.low); x.close = c.close; x.volume += c.volume; } }
  return [...m.values()].sort((a, b) => a.time - b.time);
}
export function build(days, seed) {
  const c5 = series(days, seed);
  return { '5': c5, '15': agg(c5, 900), '60': agg(c5, 3600), 'D': agg(c5, 86400), 'W': agg(c5, 604800, 345600), 'M': agg(c5, 2629800) };
}
