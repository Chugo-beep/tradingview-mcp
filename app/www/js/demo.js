/** Données simulées (URL ?demo=1) — uniquement pour tester l'interface sans clé API. */
import { TF_SECONDS } from './engine.js';

function rng(seed) { return () => ((seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296); }

export function demoData(settings) {
  const candles = {};
  const now = Math.floor(Date.now() / 1000);
  for (const tf of settings.timeframes) {
    const step = TF_SECONDS[tf], n = 500; // démo : nombre de bougies fixe (réglage « Bougies par TF » supprimé)
    const r = rng(Number(tf === 'D' ? 1440 : tf) * 7919);
    const vol = 1.2 * Math.sqrt(step / 60);
    // marche aléatoire générée à rebours pour que toutes les TF finissent au même prix
    let close = 4300, t = Math.floor(now / step) * step;
    const arr = [];
    for (let i = 0; i < n; i++, t -= step) {
      const c = close, drift = Math.sin(i / 37) * 0.25 * vol;
      const o = c - drift - (r() - 0.5) * 2 * vol;
      const h = Math.max(o, c) + r() * vol * 0.8, l = Math.min(o, c) - r() * vol * 0.8;
      arr.unshift({ time: t, open: o, high: h, low: l, close: c, volume: 100, complete: i > 0 });
      close = o + (r() - 0.5) * vol * 0.2;
    }
    candles[tf] = arr;
  }
  return { source: 'Démo (simulée)', symbol: 'XAUUSD', candles, errors: {} };
}
