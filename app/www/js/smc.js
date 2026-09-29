/**
 * Stratégie « Smart Money HTF → LTF & Fibonacci » (rules_trading_smc.md) — déterministe, sans IA,
 * SANS information future : chaque décision n'utilise que des bougies CLÔTURÉES avant elle.
 *
 *  1. Cartographie HTF (1D, 1W, 1Mo) : POI = Order Block (dernière bougie inverse avant l'impulsion
 *     qui a cassé la structure, ou OB à prise de liquidité du moteur historique) et Fair Value Gap
 *     (écart mèche N−1 / mèche N+1 autour d'une bougie N impulsive). Un POI n'est exploitable qu'à
 *     son PREMIER contact (non mitigé auparavant) ; cassé (clôture au-delà) → abandonné.
 *  2. Fibonacci HTF : tracé sur la dernière jambe d'impulsion 1D ayant cassé la structure (BOS),
 *     0 = bas, 1 = haut. Achat : biais haussier ET POI en Discount (< 0,5) ; vente : biais baissier
 *     ET POI en Premium (> 0,5). OTE (0,618–0,786 de retracement) signalé en bonus.
 *  3. Exécution LTF (15m, 5m) : après le contact du POI, attente d'un CHoCH/MSS (clôture au-delà du
 *     dernier sommet/creux structurel, bougie de déplacement ≥ k × ATR, volume > moyenne si le flux
 *     fournit un volume), nouveau Fibonacci sur la jambe de force, ordre LIMITE sur le micro-FVG
 *     (sinon micro-OB) situé en Discount/Premium de cette jambe (OTE signalé).
 *  4. Risque : SL derrière le micro-OB / sous le micro-FVG (ou derrière le swing du CHoCH, option),
 *     TP1 = prochaine liquidité LTF 15m (sommets/creux égaux, FVG opposé, swing non pris) avec 50 %
 *     encaissés + stop au point mort, TP2 = liquidité majeure HTF (swing 1D non pris, FVG 1D opposé).
 *     R:R théorique entrée → TP2 < 1:3 → setup REJETÉ.
 *
 * Les setups sont renvoyés sous la forme des « zones » du reste de l'application (agents, backtest,
 * classement, interface), avec le détail dans `zone.smc`.
 */
import { normalizeCandles, atrSeries, TF_SECONDS, STATUS, categoryOf, sessionOfTime, detectZones } from './engine.js';

export const SMC_DEFAULTS = {
  htfTfs: ['D', 'W', 'M'],   // POI HTF
  fibTf: 'D',                // Fibonacci / biais (repli 'W')
  ltfTfs: ['15', '5'],       // exécution
  liqTf: '15',               // TP1 : liquidité LTF 15m
  swingK: 2,                 // fractales : 2 bougies de chaque côté
  atrPeriod: 14,
  impulseAtr: 1.0,           // bougie N d'un FVG HTF : corps ≥ 1 ATR
  poiLookbackBars: 300,      // POI formés dans les 300 dernières bougies de leur UT (150 → 300)
  poiActiveBars: 3,          // après le contact : fenêtre de 3 bougies HTF pour le CHoCH LTF
  chochDisplacementAtr: 0.5, // assoupli (0,8 → 0,5) après balayage in-sample (scripts/sweep-smc.mjs) : nettement plus de signaux
  volumeMult: 0,             // désactivé (1,2 → 0) : le volume forex/CFD est un volume de ticks peu fiable ; 0 = jamais bloquant
  volumeSma: 20,
  microWaitBars: 24,         // bougies LTF max. après le CHoCH pour qu'un micro-FVG/OB passe en Discount
  entryExpiryBars: 48,       // ordre limite annulé s'il n'est pas exécuté en 48 bougies LTF
  slBufferAtr: 0.1,          // marge du stop : 0,1 ATR LTF
  minStopAtr: 0.5,           // stop « serré » mais jamais sous 0,5 ATR LTF (en dessous : bruit du marché)
  stopMode: 'zone',          // 'zone' (derrière le micro-OB / le micro-FVG) | 'swing' (derrière le swing du CHoCH)
  minRR: 2,                  // R:R minimal entrée → TP2 (3 → 2) ; sans effet mesurable sur le nombre de trades du balayage
  minTp1R: 1,                // TP1 : première liquidité 15m située à au moins 1 R (sinon BE déclenché dans le bruit)
  equalTolAtr: 0.1,          // sommets/creux « égaux »
  oteLow: 0.618, oteHigh: 0.786,
};

const round = (v, d = 5) => Math.round(v * 10 ** d) / 10 ** d;
const bull = (c) => c.close > c.open;
const bear = (c) => c.close < c.open;
const body = (c) => Math.abs(c.close - c.open);

/** Fractales confirmées : un sommet/creux en i n'est connu qu'à la clôture de i + k. */
export function fractals(c, k = 2) {
  const highs = [], lows = [];
  for (let i = k; i < c.length - k; i++) {
    let h = true, l = true;
    for (let j = 1; j <= k; j++) {
      if (!(c[i].high > c[i - j].high && c[i].high >= c[i + j].high)) h = false;
      if (!(c[i].low < c[i - j].low && c[i].low <= c[i + j].low)) l = false;
    }
    if (h) highs.push({ i, level: c[i].high, time: c[i].time, known: i + k });
    if (l) lows.push({ i, level: c[i].low, time: c[i].time, known: i + k });
  }
  return { highs, lows };
}

/**
 * Structure HTF : cassures de structure (BOS) et jambe d'impulsion. Un BOS haussier = clôture
 * au-dessus du dernier sommet de swing CONFIRMÉ ; la jambe part du plus bas atteint depuis ce sommet.
 */
export function structureEvents(c, k = 2) {
  const { highs, lows } = fractals(c, k);
  const events = [];
  let hi = 0, lo = 0, lastHigh = null, lastLow = null;
  for (let j = 0; j < c.length; j++) {
    while (hi < highs.length && highs[hi].known < j) { lastHigh = { ...highs[hi], broken: false }; hi++; }
    while (lo < lows.length && lows[lo].known < j) { lastLow = { ...lows[lo], broken: false }; lo++; }
    if (lastHigh && !lastHigh.broken && c[j].close > lastHigh.level) {
      lastHigh.broken = true;
      let a = lastHigh.i;
      for (let x = lastHigh.i; x <= j; x++) if (c[x].low < c[a].low) a = x;
      events.push({ dir: 'BUY', breakIdx: j, level: lastHigh.level, legIdx: a });
    }
    if (lastLow && !lastLow.broken && c[j].close < lastLow.level) {
      lastLow.broken = true;
      let a = lastLow.i;
      for (let x = lastLow.i; x <= j; x++) if (c[x].high > c[a].high) a = x;
      events.push({ dir: 'SELL', breakIdx: j, level: lastLow.level, legIdx: a });
    }
  }
  return { events, highs, lows };
}

/** Index de la dernière bougie de `c` entièrement clôturée à l'instant `t` (−1 si aucune). */
function lastClosedIdx(c, step, t) {
  let lo = 0, hi = c.length - 1, idx = -1;
  while (lo <= hi) { const m = (lo + hi) >> 1; if (c[m].time + step <= t) { idx = m; lo = m + 1; } else hi = m - 1; }
  return idx;
}

/**
 * Biais et Fibonacci HTF connus à l'instant t : dernière cassure de structure clôturée, jambe
 * [bas, haut] de l'impulsion (le haut / bas s'étend jusqu'à la dernière bougie clôturée).
 * Niveau 0 = bas du range, 1 = haut (Premium au-dessus de 0,5, Discount en dessous).
 */
export function fibAt(htf, t) {
  const idx = lastClosedIdx(htf.c, htf.step, t);
  if (idx < 0) return null;
  let ev = null;
  for (const e of htf.events) { if (e.breakIdx <= idx) ev = e; else break; }
  if (!ev) return null;
  let low, high;
  if (ev.dir === 'BUY') {
    low = htf.c[ev.legIdx].low; high = -Infinity;
    for (let x = ev.legIdx; x <= idx; x++) high = Math.max(high, htf.c[x].high);
  } else {
    high = htf.c[ev.legIdx].high; low = Infinity;
    for (let x = ev.legIdx; x <= idx; x++) low = Math.min(low, htf.c[x].low);
  }
  if (!(high > low)) return null;
  return { bias: ev.dir, low, high, eq: (low + high) / 2, level: (p) => (p - low) / (high - low), tf: htf.tf, breakTime: htf.c[ev.breakIdx].time };
}

function prep(raw, tf, atrPeriod) {
  const c = normalizeCandles(raw || []).filter((x) => x.complete !== false);
  return { tf, c, step: TF_SECONDS[tf], atr: atrSeries(c, atrPeriod) };
}

/** POI HTF (OB et FVG) d'une UT, avec leur premier contact et leur invalidation. */
export function htfPois(h, o, marketId) {
  const { c, atr, tf, step } = h;
  const pois = [];
  const n = c.length;
  const from = Math.max(1, n - o.poiLookbackBars);
  // FVG : bougie N impulsive (corps ≥ impulseAtr × ATR), écart mèche N−1 / mèche N+1
  for (let i = from; i < n - 1; i++) {
    const a = atr[i];
    if (a == null || body(c[i]) < o.impulseAtr * a) continue;
    if (bull(c[i]) && c[i + 1].low > c[i - 1].high) pois.push({ kind: 'FVG', dir: 'BUY', low: c[i - 1].high, high: c[i + 1].low, formedIdx: i + 1 });
    if (bear(c[i]) && c[i + 1].high < c[i - 1].low) pois.push({ kind: 'FVG', dir: 'SELL', low: c[i + 1].high, high: c[i - 1].low, formedIdx: i + 1 });
  }
  // OB : dernière bougie inverse avant l'impulsion qui a cassé la structure (BOS)
  for (const e of h.events) {
    if (e.breakIdx < from) continue;
    for (let x = e.breakIdx - 1; x >= e.legIdx; x--) {
      if (e.dir === 'BUY' ? bear(c[x]) : bull(c[x])) { pois.push({ kind: 'OB', dir: e.dir, low: c[x].low, high: c[x].high, formedIdx: e.breakIdx }); break; }
    }
  }
  // OB à prise de liquidité + imbalance (moteur historique) : « impulsion ayant provoqué une prise de liquidité »
  for (const z of detectZones(c, { timeframe: tf, marketId }).zones) {
    if (z.c3Index < from) continue;
    pois.push({ kind: 'OB', dir: z.direction, low: z.zoneLow, high: z.zoneHigh, formedIdx: z.c3Index, sweep: true });
  }
  // premier contact (mitigation) et invalidation (clôture au-delà du bord opposé)
  const seen = new Set();
  const out = [];
  for (const p of pois) {
    const key = `${p.kind}:${p.dir}:${round(p.low)}:${round(p.high)}`;
    if (seen.has(key) || !(p.high > p.low)) continue;
    seen.add(key);
    let touchIdx = null, invalidIdx = null;
    for (let j = p.formedIdx + 1; j < n; j++) {
      if (touchIdx == null && c[j].low <= p.high && c[j].high >= p.low) touchIdx = j;
      if (p.dir === 'BUY' ? c[j].close < p.low : c[j].close > p.high) { invalidIdx = j; break; }
    }
    out.push({
      ...p, tf, id: `${tf}:${p.kind}:${p.dir}:${c[p.formedIdx].time}:${round(p.low, 3)}`,
      formedTime: c[p.formedIdx].time + step,
      touchTime: touchIdx != null ? c[touchIdx].time : null,
      invalidTime: invalidIdx != null ? c[invalidIdx].time + step : null,
      mitigated: touchIdx != null,
    });
  }
  return out;
}

/** Liquidités au-delà de `entry` dans le sens du trade, connues à l'index `idx` (inclus). */
function liquidityTargets(h, idx, dir, entry, o, { equal = true, fvg = true } = {}) {
  const { c, atr } = h;
  if (idx < 0) return [];
  const { highs, lows } = h.fr;
  const sw = (dir === 'BUY' ? highs : lows).filter((s) => s.known <= idx);
  const untaken = sw.filter((s) => {
    for (let j = s.i + 1; j <= idx; j++) if (dir === 'BUY' ? c[j].high > s.level : c[j].low < s.level) return false;
    return true;
  });
  const out = [];
  for (const s of untaken) out.push({ level: s.level, kind: 'swing' });
  if (equal) {
    const tol = (atr[idx] || 0) * o.equalTolAtr;
    for (let a = 0; a < untaken.length; a++) for (let b = a + 1; b < untaken.length; b++) {
      if (Math.abs(untaken[a].level - untaken[b].level) <= tol) out.push({ level: dir === 'BUY' ? Math.max(untaken[a].level, untaken[b].level) : Math.min(untaken[a].level, untaken[b].level), kind: 'egaux' });
    }
  }
  if (fvg) {
    // FVG opposé non comblé : premier bord rencontré par le prix
    for (let i = Math.max(1, idx - 150); i < idx; i++) {
      if (dir === 'BUY' && c[i + 1].high < c[i - 1].low) {
        const edge = c[i + 1].high; let filled = false;
        for (let j = i + 2; j <= idx; j++) if (c[j].high >= c[i - 1].low) { filled = true; break; }
        if (!filled) out.push({ level: edge, kind: 'FVG' });
      }
      if (dir === 'SELL' && c[i + 1].low > c[i - 1].high) {
        const edge = c[i + 1].low; let filled = false;
        for (let j = i + 2; j <= idx; j++) if (c[j].low <= c[i - 1].high) { filled = true; break; }
        if (!filled) out.push({ level: edge, kind: 'FVG' });
      }
    }
  }
  return out.filter((x) => (dir === 'BUY' ? x.level > entry : x.level < entry))
    .sort((a, b) => Math.abs(a.level - entry) - Math.abs(b.level - entry));
}

/**
 * Détecte tous les setups SMC sur les bougies fournies (toutes UT).
 * @returns {{ setups: Array, pois: Array, funnel: object }}
 */
export function detectSmcSetups(candlesByTf, opts = {}) {
  const o = { ...SMC_DEFAULTS, ...(opts.smc || {}) };
  const marketId = opts.marketId || 'tf';
  const H = {};
  for (const tf of new Set([...o.htfTfs, o.fibTf, 'W', o.liqTf, ...o.ltfTfs])) {
    if (!candlesByTf?.[tf]?.length) continue;
    const h = prep(candlesByTf[tf], tf, o.atrPeriod);
    if (h.c.length < 10) continue;
    const st = structureEvents(h.c, o.swingK);
    h.events = st.events; h.fr = { highs: st.highs, lows: st.lows };
    H[tf] = h;
  }
  const fibH = H[o.fibTf] || H.W;
  const funnel = { pois: 0, touched: 0, biasOk: 0, fibOk: 0, choch: 0, micro: 0, rrOk: 0, setups: 0, rejectedRR: 0 };
  const pois = [];
  for (const tf of o.htfTfs) if (H[tf]) pois.push(...htfPois(H[tf], o, marketId));
  funnel.pois = pois.length;
  const setups = [];
  if (!fibH) return { setups, pois, funnel };
  const dHtf = H.D || fibH; // TP2 : liquidité majeure 1D
  const liqH = H[o.liqTf];
  const seenMicro = new Set();

  for (const poi of pois) {
    if (poi.touchTime == null) continue;
    funnel.touched++;
    const buy = poi.dir === 'BUY';
    const windowEnd = Math.min(poi.touchTime + o.poiActiveBars * TF_SECONDS[poi.tf], poi.invalidTime ?? Infinity);
    let poiCounted = false;
    for (const ltf of o.ltfTfs) {
      const L = H[ltf];
      if (!L) continue;
      const c = L.c, n = c.length;
      // contact réel du POI en LTF (dans la bougie HTF de contact ou après)
      let s = -1;
      for (let i = 0; i < n; i++) {
        if (c[i].time < poi.touchTime) continue;
        if (c[i].time >= windowEnd) break;
        if (c[i].time >= poi.formedTime && c[i].low <= poi.high && c[i].high >= poi.low) { s = i; break; }
      }
      if (s < 0) continue;
      // biais + Fibonacci HTF connus au contact
      const fib = fibAt(fibH, c[s].time);
      if (!fib || fib.bias !== poi.dir) continue;
      if (!poiCounted && !poi._bias) { funnel.biasOk++; poi._bias = true; }
      const mid = (poi.low + poi.high) / 2;
      const lvl = fib.level(mid);
      const priceLvl = fib.level(c[s].close);
      // dans le range de la jambe HTF (0–1) : sous 0 (achat) / au-dessus de 1 (vente), l'impulsion est effacée
      const fibOk = buy ? lvl >= 0 && lvl < 0.5 && priceLvl >= 0 && priceLvl < 0.5 : lvl > 0.5 && lvl <= 1 && priceLvl > 0.5 && priceLvl <= 1;
      if (!fibOk) continue;
      if (!poiCounted) { funnel.fibOk++; poiCounted = true; }
      const htfOte = buy ? lvl >= 1 - o.oteHigh && lvl <= 1 - o.oteLow : lvl >= o.oteLow && lvl <= o.oteHigh;
      // CHoCH / MSS : clôture au-delà du dernier sommet (achat) / creux (vente) structurel confirmé
      const sw = buy ? L.fr.highs : L.fr.lows;
      let choch = null;
      for (let i = s; i < n && c[i].time < windowEnd; i++) {
        if (buy ? c[i].close < poi.low : c[i].close > poi.high) break; // POI rejeté en LTF
        let ref = null;
        for (const x of sw) { if (x.known < i) ref = x; else break; }
        if (!ref) continue;
        const broke = buy ? c[i].close > ref.level && bull(c[i]) : c[i].close < ref.level && bear(c[i]);
        if (!broke) continue;
        const a = L.atr[i];
        if (a == null || body(c[i]) < o.chochDisplacementAtr * a) continue;
        let volOk = true, avg = 0, cnt = 0;
        for (let j = Math.max(0, i - o.volumeSma); j < i; j++) { avg += c[j].volume || 0; cnt++; }
        avg = cnt ? avg / cnt : 0;
        if (avg > 0) volOk = (c[i].volume || 0) >= o.volumeMult * avg;
        if (!volOk) continue;
        choch = { i, level: ref.level, time: c[i].time };
        break;
      }
      if (!choch) continue;
      funnel.choch++;
      // jambe de force LTF : du creux (achat) / sommet (vente) atteint depuis le contact jusqu'à la cassure
      let a = s;
      for (let x = s; x <= choch.i; x++) if (buy ? c[x].low < c[a].low : c[x].high > c[a].high) a = x;
      // micro-FVG / micro-OB, évalués bougie après bougie (le haut/bas de la jambe s'étend), sans futur
      let pick = null;
      for (let cIdx = choch.i + 1; cIdx < Math.min(n, choch.i + 1 + o.microWaitBars); cIdx++) {
        let legHi = -Infinity, legLo = Infinity;
        for (let x = a; x <= cIdx; x++) { legHi = Math.max(legHi, c[x].high); legLo = Math.min(legLo, c[x].low); }
        const range = legHi - legLo;
        if (!(range > 0)) continue;
        const cands = [];
        for (let k = a + 1; k + 1 <= cIdx; k++) {
          // invalidation complète du FVG : au-delà de la bougie N−1 qui l'a ouvert (origine du déplacement)
          if (buy && c[k + 1].low > c[k - 1].high && bull(c[k])) cands.push({ kind: 'FVG', low: c[k - 1].high, high: c[k + 1].low, formed: k + 1, sl: c[k - 1].low });
          if (!buy && c[k + 1].high < c[k - 1].low && bear(c[k])) cands.push({ kind: 'FVG', low: c[k + 1].high, high: c[k - 1].low, formed: k + 1, sl: c[k - 1].high });
        }
        for (let x = choch.i - 1; x >= a; x--) {
          if (buy ? bear(c[x]) : bull(c[x])) { cands.push({ kind: 'OB', low: c[x].low, high: c[x].high, formed: choch.i, sl: buy ? c[x].low : c[x].high }); break; }
        }
        const ok = [];
        for (const z of cands) {
          // jamais revisitée depuis sa formation (sinon l'ordre aurait déjà été exécuté)
          let visited = false;
          for (let j = z.formed + 1; j <= cIdx; j++) if (buy ? c[j].low <= z.high : c[j].high >= z.low) { visited = true; break; }
          if (visited) continue;
          const zm = (z.low + z.high) / 2;
          const retr = buy ? (legHi - zm) / range : (zm - legLo) / range;
          if (retr < 0.5) continue; // doit être en Discount (achat) / Premium (vente) de la jambe LTF
          ok.push({ ...z, retr, ote: retr >= o.oteLow && retr <= o.oteHigh });
        }
        if (ok.length) {
          // micro-FVG prioritaire, puis le plus proche du cœur de l'OTE (0,705)
          ok.sort((x, y) => (x.kind === 'FVG' ? 0 : 1) - (y.kind === 'FVG' ? 0 : 1) || Math.abs(x.retr - 0.705) - Math.abs(y.retr - 0.705));
          pick = { ...ok[0], confIdx: cIdx, legHi, legLo };
          break;
        }
      }
      if (!pick) continue;
      funnel.micro++;
      const microKey = `${ltf}:${pick.kind}:${c[pick.formed].time}:${poi.dir}`;
      if (seenMicro.has(microKey)) continue; // même micro-zone déclenchée par deux POI : une seule fois
      seenMicro.add(microKey);
      const atrL = L.atr[pick.confIdx] || 0;
      const buf = o.slBufferAtr * atrL;
      const entry = buy ? pick.high : pick.low;
      let sl = o.stopMode === 'swing'
        ? (buy ? c[a].low - buf : c[a].high + buf)
        : (buy ? pick.sl - buf : pick.sl + buf);
      if (Math.abs(entry - sl) < o.minStopAtr * atrL) sl = buy ? entry - o.minStopAtr * atrL : entry + o.minStopAtr * atrL;
      const R = Math.abs(entry - sl);
      if (!(R > 0)) continue;
      const confTime = c[pick.confIdx].time + L.step; // clôture de la bougie de confirmation
      // TP2 : liquidité majeure 1D (swing non pris ou FVG 1D opposé), connue à la confirmation
      const dIdx = lastClosedIdx(dHtf.c, dHtf.step, confTime);
      const t2 = liquidityTargets(dHtf, dIdx, poi.dir, entry, o, { equal: false, fvg: true });
      let tp2 = t2[0]?.level ?? null;
      let tp2Kind = t2[0]?.kind ? `${t2[0].kind} 1D` : null;
      if (tp2 == null && (buy ? fib.high > entry : fib.low < entry)) { tp2 = buy ? fib.high : fib.low; tp2Kind = 'extrême de la jambe HTF'; }
      if (tp2 == null) continue;
      // TP1 : prochaine liquidité LTF 15m (sommets/creux égaux, FVG opposé, swing non pris)
      let tp1 = null, tp1Kind = null;
      if (liqH) {
        const lIdx = lastClosedIdx(liqH.c, liqH.step, confTime);
        const t1 = liquidityTargets(liqH, lIdx, poi.dir, entry, o).filter((x) => (buy ? x.level < tp2 : x.level > tp2) && Math.abs(x.level - entry) >= o.minTp1R * R);
        if (t1.length) { tp1 = t1[0].level; tp1Kind = `${t1[0].kind === 'egaux' ? 'sommets/creux égaux' : t1[0].kind} 15m`; }
      }
      if (tp1 == null) { tp1 = buy ? Math.min(entry + Math.max(o.minTp1R, 1.5) * R, (entry + tp2) / 2) : Math.max(entry - Math.max(o.minTp1R, 1.5) * R, (entry + tp2) / 2); tp1Kind = 'aucune liquidité 15m : 1,5 R'; }
      const rr = Math.abs(tp2 - entry) / R;
      const rrOk = rr >= o.minRR;
      if (rrOk) funnel.rrOk++; else funnel.rejectedRR++;
      // statut de l'ordre limite après la confirmation
      let fill = null, broken = null;
      for (let j = pick.confIdx + 1; j < n; j++) {
        if (!fill && (buy ? c[j].low <= entry : c[j].high >= entry)) fill = c[j];
        if (buy ? c[j].close < sl : c[j].close > sl) { broken = c[j]; break; }
        if (fill) break;
      }
      const currentPrice = opts.currentPrice ?? c[n - 1].close;
      let status;
      if (fill) status = STATUS.TOUCHEE;
      else if (broken) status = STATUS.INVALIDEE;
      else if (buy ? currentPrice < pick.low : currentPrice > pick.high) status = STATUS.DEPASSEE;
      else status = STATUS.VIABLE;
      const expired = !fill && n - 1 - pick.confIdx > o.entryExpiryBars;
      if (status === STATUS.VIABLE && expired) status = STATUS.DEPASSEE;
      const C = (i) => ({ time: c[i].time, open: c[i].open, high: c[i].high, low: c[i].low, close: c[i].close });
      setups.push({
        id: `${marketId}:${ltf}-smc-${c[pick.formed].time}-${poi.dir}`,
        strategy: 'smc',
        direction: poi.dir, timeframe: ltf, category: categoryOf(ltf),
        status, viable: status === STATUS.VIABLE,
        zoneLow: round(pick.low), zoneHigh: round(pick.high), entry: round(entry), invalidation: round(sl),
        gap: round(pick.high - pick.low), atr: round(atrL), fragile: false,
        c1Time: c[pick.formed].time, c3Index: pick.confIdx, c3Time: c[pick.confIdx].time,
        session: sessionOfTime(c[pick.confIdx].time),
        grade: rrOk ? 5 : 4, gradeAtDetection: rrOk ? 5 : 4,
        stars: { poi: true, fib: true, choch: true, micro: true, rr: rrOk },
        htf: { tf: fib.tf, dir: buy ? 1 : -1, aligned: true },
        candles: { P: C(a), C1: C(Math.max(a, pick.formed - 2)), C2: C(Math.max(a, pick.formed - 1)), C3: C(pick.confIdx) },
        liquidity: { level: round(buy ? pick.legLo : pick.legHi), refTime: c[a].time, lookback: 0 },
        liqTargets: [round(tp1), round(tp2)],
        distance: round(buy ? currentPrice - entry : entry - currentPrice),
        firstTouch: fill ? C(c.indexOf(fill)) : null, brokenBy: broken ? C(c.indexOf(broken)) : null,
        smc: {
          valid: rrOk,
          poi: { id: poi.id, tf: poi.tf, kind: poi.kind, low: round(poi.low), high: round(poi.high), sweep: !!poi.sweep, touchTime: c[s].time },
          fib: { tf: fib.tf, bias: fib.bias, low: round(fib.low), high: round(fib.high), poiLevel: round(lvl, 3), zone: lvl < 0.5 ? 'DISCOUNT' : 'PREMIUM', ote: htfOte },
          choch: { time: choch.time, level: round(choch.level) },
          leg: { low: round(pick.legLo), high: round(pick.legHi), from: c[a].time },
          micro: { kind: pick.kind, retracement: round(pick.retr, 3), ote: pick.ote },
          entry: round(entry), sl: round(sl), tp1: round(tp1), tp2: round(tp2), tp1Kind, tp2Kind,
          rr: round(rr, 2), minRR: o.minRR, stopMode: o.stopMode,
          expiresAt: confTime + o.entryExpiryBars * L.step,
          reason: rrOk ? null : `R:R ${round(rr, 2)} < 1:${o.minRR} : setup rejeté`,
        },
      });
      funnel.setups++;
    }
  }
  return { setups, pois, funnel };
}

/** POI HTF encore NON mitigés, les plus proches du prix d'abord (affichage « zones à surveiller »). */
export function watchedPois(pois, price, limit = 10) {
  return pois.filter((p) => !p.mitigated && p.invalidTime == null)
    .sort((a, b) => Math.abs((a.low + a.high) / 2 - price) - Math.abs((b.low + b.high) / 2 - price))
    .slice(0, limit);
}
