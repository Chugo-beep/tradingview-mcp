/**
 * Courbe de capital (R cumulés) — mini-module canvas autonome, dessiné à la main (aucune
 * dépendance), adapté au thème (couleurs lues via getComputedStyle sur :root, comme chart.js),
 * conscient du DPR (net sur écrans Retina/Android), avec ligne zéro et zone de drawdown ombrée.
 */
const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

/**
 * @param {HTMLCanvasElement} canvas
 * @param {Array<{t:number, r:number}>} curve  points cumulés (cf. stats.js summarize().curve)
 */
export function drawEquityCurve(canvas, curve) {
  const dpr = window.devicePixelRatio || 1;
  const rect = canvas.parentElement.getBoundingClientRect();
  const w = Math.max(200, rect.width), h = Math.max(120, canvas.height ? rect.height || 160 : 160);
  const cssH = Math.max(120, rect.height || 160);
  if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(cssH * dpr)) {
    canvas.width = Math.round(w * dpr); canvas.height = Math.round(cssH * dpr);
    canvas.style.width = w + 'px'; canvas.style.height = cssH + 'px';
  }
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, cssH);

  const border = css('--border') || '#2e3440';
  const text3 = css('--text-3') || '#8a93a3';
  const gain = css('--gain') || '#6be394';
  const loss = css('--loss') || '#ef5a5a';

  const pad = { l: 8, r: 8, t: 10, b: 10 };
  const pw = w - pad.l - pad.r, ph = cssH - pad.t - pad.b;

  if (!curve || curve.length < 2) {
    ctx.fillStyle = text3;
    ctx.font = '12px system-ui, sans-serif';
    ctx.fillText('Pas assez de trades clôturés pour tracer une courbe.', pad.l, cssH / 2);
    return;
  }

  const rs = curve.map((p) => p.r);
  const lo = Math.min(0, ...rs), hi = Math.max(0, ...rs);
  const span = hi - lo || 1;
  const x = (i) => pad.l + (i / (curve.length - 1)) * pw;
  const y = (r) => pad.t + (hi - r) / span * ph;

  // ligne zéro
  ctx.strokeStyle = border; ctx.lineWidth = 1; ctx.setLineDash([4, 3]);
  ctx.beginPath(); ctx.moveTo(pad.l, y(0)); ctx.lineTo(pad.l + pw, y(0)); ctx.stroke();
  ctx.setLineDash([]);

  // zone de drawdown (ombrée entre la courbe et son plus haut jusqu'ici)
  let peak = -Infinity;
  const peaks = curve.map((p) => (peak = Math.max(peak, p.r)));
  ctx.fillStyle = `color-mix(in srgb, ${loss} 14%, transparent)`;
  ctx.beginPath();
  curve.forEach((p, i) => { const px = x(i), py = y(p.r); if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py); });
  for (let i = curve.length - 1; i >= 0; i--) ctx.lineTo(x(i), y(peaks[i]));
  ctx.closePath();
  ctx.fill();

  // courbe de capital
  ctx.strokeStyle = curve.at(-1).r >= 0 ? gain : loss;
  ctx.lineWidth = 2;
  ctx.beginPath();
  curve.forEach((p, i) => { const px = x(i), py = y(p.r); if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py); });
  ctx.stroke();

  // repères min/max en R
  ctx.fillStyle = text3;
  ctx.font = '11px ui-monospace, monospace';
  ctx.textBaseline = 'top';
  ctx.fillText(`${hi >= 0 ? '+' : ''}${hi.toFixed(1)} R`, pad.l, pad.t);
  ctx.textBaseline = 'bottom';
  ctx.fillText(`${lo >= 0 ? '+' : ''}${lo.toFixed(1)} R`, pad.l, cssH - 2);
}
