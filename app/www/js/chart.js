/**
 * Graphique en chandeliers autonome (canvas, sans dépendance).
 * Glisser = déplacer · molette / pincement = zoom · clic sur une zone = sélection.
 */
const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
const TF_SMC_LABEL = { D: '1D', W: '1W', M: '1Mo' };

export class CandleChart {
  constructor(container, { onZoneClick } = {}) {
    this.el = container;
    this.canvas = document.createElement('canvas');
    this.canvas.style.touchAction = 'none';
    container.appendChild(this.canvas);
    this.ctx = this.canvas.getContext('2d');
    this.candles = [];
    this.zones = [];
    this.bands = [];
    this.plan = null;
    this.smc = null; // détail SMC (poi/fib) de la zone sélectionnée (rules_trading_smc.md), cf. app.js renderChart
    this.price = null;
    this.decimals = 2; // décimales d'affichage du prix (dérivées du pip du marché, cf. markets.js)
    this.emptyText = 'Aucune donnée'; // affiché quand `candles` est vide (ex. « Chargement de <marché>… » pendant une analyse ponctuelle, cf. app.js selectMarket)
    this.selectedId = null;
    this.spacing = 8;
    this.viewEnd = 0; // index (flottant) de la bougie la plus à droite
    this.rightPad = 6;
    this.hover = null;
    this.onZoneClick = onZoneClick;
    this.pointers = new Map();
    this.zoneHits = [];
    this.#bind();
    new ResizeObserver(() => this.draw()).observe(container);
  }

  setData(candles, zones = [], bands = [], price = null, { keepView = false, decimals } = {}) {
    const wasAtEnd = this.viewEnd >= this.candles.length - 1;
    this.candles = candles || [];
    this.zones = zones;
    this.bands = bands;
    this.price = price;
    if (decimals != null) this.decimals = decimals;
    if (!keepView || wasAtEnd) this.viewEnd = this.candles.length - 1 + this.rightPad;
    this.draw();
  }

  select(id) { this.selectedId = id; this.draw(); }

  focusTime(time) {
    const i = this.#indexOf(time);
    if (i == null) return;
    const w = this.#plotW() / this.spacing;
    this.viewEnd = Math.min(this.candles.length - 1 + this.rightPad, i + w * 0.6);
    this.draw();
  }

  /** « Tout voir » : ajuste l'espacement pour que toutes les bougies chargées tiennent dans la largeur visible. */
  fitAll() {
    if (!this.candles.length) return;
    const pw = this.#plotW();
    this.#setSpacing(pw / this.candles.length);
    this.viewEnd = this.candles.length - 1 + this.rightPad;
    this.draw();
  }

  // ── géométrie ─────────────────────────────────────────────────────────
  #plotW() { return this.w - 62; }
  #plotH() { return this.h - 22; }
  #x(i) { return this.#plotW() - (this.viewEnd - i) * this.spacing - this.spacing / 2; }
  #y(p) { return 8 + (this.hi - p) / (this.hi - this.lo) * (this.#plotH() - 16); }
  #priceAt(y) { return this.hi - (y - 8) / (this.#plotH() - 16) * (this.hi - this.lo); }

  #indexOf(time) {
    const c = this.candles;
    if (!c.length) return null;
    let lo = 0, hi = c.length - 1;
    if (time <= c[0].time) return 0;
    if (time >= c[hi].time) {
      const step = c.length > 1 ? c[hi].time - c[hi - 1].time : 60;
      return hi + (time - c[hi].time) / step;
    }
    while (hi - lo > 1) { const m = (lo + hi) >> 1; if (c[m].time <= time) lo = m; else hi = m; }
    return lo;
  }

  // ── rendu ─────────────────────────────────────────────────────────────
  draw() {
    const dpr = window.devicePixelRatio || 1;
    const r = this.el.getBoundingClientRect();
    this.w = Math.max(200, r.width); this.h = Math.max(160, r.height);
    if (this.canvas.width !== Math.round(this.w * dpr) || this.canvas.height !== Math.round(this.h * dpr)) {
      this.canvas.width = Math.round(this.w * dpr); this.canvas.height = Math.round(this.h * dpr);
      this.canvas.style.width = this.w + 'px'; this.canvas.style.height = this.h + 'px';
    }
    const ctx = this.ctx;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, this.w, this.h);
    const C = {
      bg: css('--chart-bg'), grid: css('--chart-grid'), text: css('--text-2'), up: css('--candle-up'), down: css('--candle-down'),
      line: css('--border'), fg: css('--text-1'), accent: css('--accent'),
      tp: css('--gain'), sl: css('--loss'), opp: css('--opp'),
      ink: { opp: css('--opp-ink'), gain: css('--gain-ink'), loss: css('--loss-ink'), warn: css('--warn-ink'), nonval: css('--nonval-ink'), neutral: css('--text-2') },
      tone: { opp: css('--opp'), gain: css('--gain'), loss: css('--loss'), warn: css('--warn'), nonval: css('--nonval'), neutral: css('--neutral') },
    };
    ctx.fillStyle = C.bg; ctx.fillRect(0, 0, this.w, this.h);

    const c = this.candles;
    if (!c.length) {
      ctx.fillStyle = C.text; ctx.font = '13px system-ui'; ctx.textAlign = 'center';
      ctx.fillText(this.emptyText, this.w / 2, this.h / 2);
      return;
    }
    const pw = this.#plotW(), ph = this.#plotH();
    const first = Math.max(0, Math.floor(this.viewEnd - pw / this.spacing));
    const last = Math.min(c.length - 1, Math.ceil(this.viewEnd));
    let hi = -Infinity, lo = Infinity;
    for (let i = first; i <= last; i++) { hi = Math.max(hi, c[i].high); lo = Math.min(lo, c[i].low); }
    if (!Number.isFinite(hi)) { hi = c.at(-1).high; lo = c.at(-1).low; }
    if (this.plan) for (const k of ['entry', 'sl', 'tp1', 'tp2', 'tp3']) { if (this.plan[k] == null) continue; hi = Math.max(hi, this.plan[k]); lo = Math.min(lo, this.plan[k]); }
    const pad = (hi - lo) * 0.08 || 1;
    this.hi = hi + pad; this.lo = lo - pad;

    // grille + axe des prix
    ctx.font = '11px ui-monospace, SFMono-Regular, Menlo, monospace';
    const step = niceStep((this.hi - this.lo) / Math.max(3, Math.floor(ph / 48)));
    ctx.strokeStyle = C.grid; ctx.lineWidth = 1; ctx.fillStyle = C.text; ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
    for (let p = Math.ceil(this.lo / step) * step; p <= this.hi; p += step) {
      const y = Math.round(this.#y(p)) + 0.5;
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(pw, y); ctx.stroke();
      ctx.fillText(fmt(p, step, this.decimals), pw + 6, y);
    }
    // axe du temps
    ctx.textAlign = 'center'; ctx.textBaseline = 'top';
    const every = Math.max(1, Math.round(90 / this.spacing));
    for (let i = first - (first % every); i <= last; i += every) {
      if (i < 0) continue;
      const x = this.#x(i);
      ctx.beginPath(); ctx.moveTo(Math.round(x) + 0.5, 0); ctx.lineTo(Math.round(x) + 0.5, ph); ctx.stroke();
      ctx.fillText(timeLabel(c[i].time, c), x, ph + 5);
    }

    ctx.save();
    ctx.beginPath(); ctx.rect(0, 0, pw, ph); ctx.clip();

    // bandes des autres timeframes (opportunités validées)
    for (const b of this.bands) {
      const y1 = this.#y(b.zoneHigh), y2 = this.#y(b.zoneLow);
      if (y2 < 0 || y1 > ph) continue;
      ctx.fillStyle = withAlpha(C.opp, 0.07);
      ctx.fillRect(0, y1, pw, Math.max(1, y2 - y1));
      ctx.strokeStyle = withAlpha(C.opp, 0.6);
      ctx.setLineDash([2, 4]);
      ctx.strokeRect(0.5, y1 + 0.5, pw - 1, Math.max(1, y2 - y1));
      ctx.setLineDash([]);
      ctx.fillStyle = C.ink.opp;
      ctx.textAlign = 'right'; ctx.textBaseline = 'bottom'; ctx.font = '600 10px system-ui';
      ctx.fillText(`${b.direction === 'BUY' ? '▲' : '▼'} ${b.tfLabel}`, pw - 4, y1 - 1);
    }

    // SMC (rules_trading_smc.md) : POI HTF (bande translucide) et Fibonacci 0,5 HTF (ligne pointillée)
    // de la zone sélectionnée, uniquement s'ils entrent dans la plage de prix visible.
    if (this.smc) {
      const poi = this.smc.poi, fib = this.smc.fib;
      if (poi && poi.high > this.lo && poi.low < this.hi) {
        const y1 = this.#y(Math.min(poi.high, this.hi)), y2 = this.#y(Math.max(poi.low, this.lo));
        ctx.fillStyle = withAlpha(C.opp, 0.1);
        ctx.fillRect(0, y1, pw, Math.max(1, y2 - y1));
        ctx.strokeStyle = withAlpha(C.opp, 0.55); ctx.setLineDash([2, 4]);
        ctx.strokeRect(0.5, y1 + 0.5, pw - 1, Math.max(1, y2 - y1));
        ctx.setLineDash([]);
        ctx.fillStyle = C.ink.opp; ctx.font = '600 10px system-ui'; ctx.textAlign = 'left'; ctx.textBaseline = 'top';
        ctx.fillText(`POI ${TF_SMC_LABEL[poi.tf] || poi.tf}`, 4, y1 + 2);
      }
      if (fib && fib.high > fib.low) {
        const fibo5 = fib.low + 0.5 * (fib.high - fib.low);
        if (fibo5 > this.lo && fibo5 < this.hi) {
          const y = Math.round(this.#y(fibo5)) + 0.5;
          ctx.strokeStyle = withAlpha(C.fg, 0.6); ctx.lineWidth = 1; ctx.setLineDash([4, 3]);
          ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(pw, y); ctx.stroke(); ctx.setLineDash([]);
          ctx.fillStyle = C.text; ctx.font = '600 10px system-ui'; ctx.textAlign = 'left'; ctx.textBaseline = 'bottom';
          ctx.fillText('Fibo 0,5', 4, y - 2);
        }
      }
    }

    // zones de la timeframe affichée
    this.zoneHits = [];
    const sorted = [...this.zones].sort((a, b) => (a.viable - b.viable) || (a.id === this.selectedId) - (b.id === this.selectedId));
    for (const z of sorted) {
      const i1 = this.#indexOf(z.c1Time);
      const endT = z.viable ? null : (z.firstTouch?.time ?? null);
      const x1 = this.#x(i1) - this.spacing / 2;
      const x2 = endT != null ? this.#x(this.#indexOf(endT)) + this.spacing / 2 : pw;
      const y1 = this.#y(z.zoneHigh), y2 = this.#y(z.zoneLow);
      if (x2 < 0 || x1 > pw) continue;
      const tone = z.tone || 'neutral';
      const base = C.tone[tone] || C.tone.neutral;
      const sel = z.id === this.selectedId;
      const h = Math.max(1.5, y2 - y1);
      const faint = tone === 'neutral' || tone === 'nonval';
      ctx.fillStyle = withAlpha(base, sel ? 0.32 : faint ? 0.08 : 0.2);
      ctx.fillRect(x1, y1, x2 - x1, h);
      if (tone === 'nonval') hatch(ctx, x1, y1, x2 - x1, h, withAlpha(base, 0.45));
      ctx.strokeStyle = withAlpha(base, sel ? 1 : faint ? 0.7 : 0.9);
      ctx.lineWidth = sel ? 2 : 1.25;
      if (tone === 'nonval') ctx.setLineDash([5, 3]); else if (tone === 'neutral') ctx.setLineDash([2, 3]);
      ctx.strokeRect(x1 + 0.5, y1 + 0.5, x2 - x1 - 1, h);
      ctx.setLineDash([]); ctx.lineWidth = 1;
      if (x2 - x1 > 46) {
        const icon = { opp: '◷', gain: '✓', loss: '✕', warn: '⏸', nonval: '⊘', neutral: '–' }[tone];
        ctx.fillStyle = C.ink[tone] || C.text; ctx.font = '700 10px system-ui'; ctx.textAlign = 'left'; ctx.textBaseline = 'bottom';
        ctx.fillText(`${z.direction === 'BUY' ? '▲ ACHAT' : '▼ VENTE'} ${icon}${z.followed ? ' · SUIVI' : ''}`, Math.max(2, x1 + 3), y1 - 2);
      }
      this.zoneHits.push({ id: z.id, x1, x2, y1: Math.min(y1, y2) - 4, y2: Math.max(y1, y2) + 4 });
    }

    // chandeliers — sous 2 px d'espacement, corps/mèches illisibles : une simple ligne haut-bas par bougie
    const tooTight = this.spacing < 2;
    const bw = Math.max(1, Math.min(this.spacing * 0.7, this.spacing - 1));
    for (let i = first; i <= last; i++) {
      const k = c[i], x = this.#x(i);
      // bougies neutres : creuse = hausse, pleine = baisse (le vert et le rouge sont réservés aux gains et aux pertes)
      const up = k.close >= k.open;
      ctx.strokeStyle = ctx.fillStyle = up ? C.up : C.down;
      const xm = Math.round(x) + 0.5;
      if (tooTight) {
        ctx.beginPath(); ctx.moveTo(xm, this.#y(k.high)); ctx.lineTo(xm, this.#y(k.low)); ctx.stroke();
        continue;
      }
      const yo = this.#y(k.open), yc = this.#y(k.close);
      const top = Math.min(yo, yc), bh = Math.max(1, Math.abs(yc - yo));
      const bx = Math.round(x - bw / 2), bwr = Math.max(1, Math.round(bw));
      ctx.beginPath();
      if (up && bwr >= 3) {
        ctx.moveTo(xm, this.#y(k.high)); ctx.lineTo(xm, top); ctx.moveTo(xm, top + bh); ctx.lineTo(xm, this.#y(k.low)); ctx.stroke();
        ctx.strokeRect(bx + 0.5, top + 0.5, bwr - 1, Math.max(1, bh - 1));
      } else {
        ctx.moveTo(xm, this.#y(k.high)); ctx.lineTo(xm, this.#y(k.low)); ctx.stroke();
        ctx.fillRect(bx, top, bwr, bh);
      }
    }
    // plan de la position sélectionnée : entrée / stop / objectif
    const planLabels = [];
    if (this.plan) {
      const x0 = Math.max(0, this.#x(this.#indexOf(this.plan.from)) - this.spacing / 2);
      const xEnd = this.plan.exit ? this.#x(this.#indexOf(this.plan.exit)) + this.spacing / 2 : pw;
      const lines = [['tp1', C.ink.gain, [6, 3], 'TP1'], ['tp2', C.ink.gain, [3, 3], 'TP2'], ['tp3', C.ink.gain, [1, 3], 'TP3'], ['sl', C.ink.loss, [6, 3], 'SL'], ['entry', C.fg, [], 'Entrée']]
        .filter(([k]) => this.plan[k] != null && !(this.plan.strategy === 'smc' && k === 'tp3')); // SMC : pas de TP3 (== TP2)
      for (const [key, col, dash, txt] of lines) {
        const y = Math.round(this.#y(this.plan[key])) + 0.5;
        ctx.strokeStyle = col; ctx.lineWidth = key === 'entry' ? 1.5 : 1.25; ctx.setLineDash(dash);
        ctx.beginPath(); ctx.moveTo(x0, y); ctx.lineTo(xEnd, y); ctx.stroke(); ctx.setLineDash([]); ctx.lineWidth = 1;
        ctx.fillStyle = col; ctx.font = '600 10px system-ui'; ctx.textAlign = 'left'; ctx.textBaseline = 'bottom';
        ctx.fillText(txt, x0 + 3, y - 2);
        planLabels.push({ y, col, v: this.plan[key] });
      }
      if (this.plan.fill) {
        const xf = this.#x(this.#indexOf(this.plan.fill)), yf = this.#y(this.plan.entry);
        ctx.fillStyle = C.fg; ctx.beginPath(); ctx.arc(xf, yf, 3.5, 0, Math.PI * 2); ctx.fill();
      }
    }
    ctx.restore();
    for (const l of planLabels) {
      ctx.fillStyle = l.col; ctx.fillRect(pw, l.y - 8, this.w - pw, 16);
      ctx.fillStyle = css('--chart-bg'); ctx.font = '600 10px ui-monospace, monospace'; ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
      ctx.fillText(l.v.toFixed(this.decimals), pw + 5, l.y);
    }

    // prix courant
    if (this.price != null) {
      const y = Math.round(this.#y(this.price)) + 0.5;
      ctx.strokeStyle = C.accent; ctx.setLineDash([3, 3]);
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(pw, y); ctx.stroke(); ctx.setLineDash([]);
      ctx.fillStyle = C.accent; ctx.fillRect(pw, y - 9, this.w - pw, 18);
      ctx.fillStyle = css('--on-accent'); ctx.textAlign = 'left'; ctx.textBaseline = 'middle'; ctx.font = '600 11px ui-monospace, monospace';
      ctx.fillText(this.price.toFixed(this.decimals), pw + 5, y);
    }

    // réticule + OHLC
    if (this.hover && this.hover.x < pw && this.hover.y < ph) {
      const { x, y } = this.hover;
      ctx.strokeStyle = withAlpha(C.fg, 0.35); ctx.setLineDash([2, 3]);
      ctx.beginPath(); ctx.moveTo(0, y + 0.5); ctx.lineTo(pw, y + 0.5); ctx.moveTo(x + 0.5, 0); ctx.lineTo(x + 0.5, ph); ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = C.line; ctx.fillRect(pw, y - 9, this.w - pw, 18);
      ctx.fillStyle = C.fg; ctx.textAlign = 'left'; ctx.textBaseline = 'middle'; ctx.font = '11px ui-monospace, monospace';
      ctx.fillText(this.#priceAt(y).toFixed(this.decimals), pw + 5, y);
      const i = Math.round(this.viewEnd - (pw - x - this.spacing / 2) / this.spacing);
      const k = c[i];
      if (k) {
        ctx.textBaseline = 'top'; ctx.fillStyle = C.text;
        ctx.fillText(`${new Date(k.time * 1000).toLocaleString('fr-FR', { dateStyle: 'short', timeStyle: 'short' })}  O ${k.open.toFixed(this.decimals)}  H ${k.high.toFixed(this.decimals)}  L ${k.low.toFixed(this.decimals)}  C ${k.close.toFixed(this.decimals)}`, 8, 6);
      }
    }
  }

  // ── interactions ──────────────────────────────────────────────────────
  #bind() {
    const cv = this.canvas;
    const pos = (e) => { const r = cv.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; };
    let drag = null, moved = 0, pinch = null;
    cv.addEventListener('pointerdown', (e) => {
      cv.setPointerCapture(e.pointerId);
      this.pointers.set(e.pointerId, pos(e));
      if (this.pointers.size === 1) { drag = { ...pos(e), viewEnd: this.viewEnd }; moved = 0; }
      if (this.pointers.size === 2) {
        const [a, b] = [...this.pointers.values()];
        pinch = { d: Math.abs(a.x - b.x) || 1, spacing: this.spacing };
        drag = null;
      }
    });
    cv.addEventListener('pointermove', (e) => {
      const p = pos(e);
      if (this.pointers.has(e.pointerId)) this.pointers.set(e.pointerId, p);
      if (pinch && this.pointers.size === 2) {
        const [a, b] = [...this.pointers.values()];
        this.#setSpacing(pinch.spacing * (Math.abs(a.x - b.x) || 1) / pinch.d);
      } else if (drag) {
        moved += Math.abs(p.x - drag.x);
        this.viewEnd = this.#clampEnd(drag.viewEnd - (p.x - drag.x) / this.spacing);
        if (e.pointerType === 'mouse') this.hover = p;
      } else if (e.pointerType === 'mouse') {
        this.hover = p;
      }
      this.draw();
    });
    const up = (e) => {
      this.pointers.delete(e.pointerId);
      if (this.pointers.size < 2) pinch = null;
      if (drag && moved < 5) this.#click(pos(e));
      if (!this.pointers.size) drag = null;
    };
    cv.addEventListener('pointerup', up);
    cv.addEventListener('pointercancel', up);
    cv.addEventListener('pointerleave', () => { this.hover = null; this.draw(); });
    cv.addEventListener('wheel', (e) => {
      e.preventDefault();
      if (Math.abs(e.deltaX) > Math.abs(e.deltaY)) this.viewEnd = this.#clampEnd(this.viewEnd + e.deltaX / this.spacing);
      else this.#setSpacing(this.spacing * (e.deltaY < 0 ? 1.12 : 1 / 1.12));
      this.draw();
    }, { passive: false });
    cv.addEventListener('dblclick', () => { this.viewEnd = this.candles.length - 1 + this.rightPad; this.spacing = 8; this.draw(); });
  }

  #setSpacing(s) { this.spacing = Math.max(0.3, Math.min(40, s)); this.viewEnd = this.#clampEnd(this.viewEnd); this.draw(); }
  #clampEnd(v) { return Math.max(10, Math.min(this.candles.length - 1 + this.#plotW() / this.spacing * 0.8, v)); }

  #click(p) {
    const hits = this.zoneHits.filter((h) => p.x >= h.x1 && p.x <= h.x2 && p.y >= h.y1 && p.y <= h.y2);
    if (hits.length && this.onZoneClick) this.onZoneClick(hits.at(-1).id);
  }
}

function hatch(ctx, x, y, w, h, color) {
  ctx.save();
  ctx.beginPath(); ctx.rect(x, y, w, h); ctx.clip();
  ctx.strokeStyle = color; ctx.lineWidth = 1;
  ctx.beginPath();
  for (let d = -h; d < w; d += 7) { ctx.moveTo(x + d, y + h); ctx.lineTo(x + d + h, y); }
  ctx.stroke();
  ctx.restore();
}
function niceStep(raw) {
  const pow = 10 ** Math.floor(Math.log10(raw));
  const n = raw / pow;
  return (n < 1.5 ? 1 : n < 3 ? 2 : n < 7 ? 5 : 10) * pow;
}
/** Décimales de l'axe des prix : celles du marché (`decimals`), réduites si l'écart entre deux
 * graduations (`step`) est assez grand pour ne pas en avoir besoin (ex. indices à grand pas). */
function fmt(p, step, decimals = 2) { return p.toFixed(Math.min(decimals, step < 1 ? decimals : step < 10 ? 1 : 0)); }
function timeLabel(t, c) {
  const d = new Date(t * 1000);
  const span = c.length > 1 ? c[1].time - c[0].time : 60;
  if (span >= 86400 * 300) return d.toLocaleDateString('fr-FR', { year: 'numeric' });
  if (span >= 86400 * 25) return d.toLocaleDateString('fr-FR', { month: 'short', year: '2-digit' });
  if (span >= 86400) return d.toLocaleDateString('fr-FR', { day: '2-digit', month: 'short' });
  if (d.getHours() === 0 && d.getMinutes() === 0) return d.toLocaleDateString('fr-FR', { day: '2-digit', month: 'short' });
  return d.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
}
function withAlpha(color, a) {
  if (color.startsWith('#')) {
    let h = color.slice(1);
    if (h.length === 3) h = h.split('').map((x) => x + x).join('');
    const n = parseInt(h, 16);
    return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
  }
  const m = color.match(/rgba?\(([^)]+)\)/);
  if (m) { const [r, g, b] = m[1].split(',').map((x) => x.trim()); return `rgba(${r},${g},${b},${a})`; }
  return color;
}
