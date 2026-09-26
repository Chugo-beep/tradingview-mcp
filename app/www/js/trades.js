/**
 * Gestion des positions (sans IA).
 *
 * Chaque zone validée devient un ORDRE LIMITE posé sur le bord proche de la zone.
 *   Stop loss : UNIQUEMENT au niveau d'invalidation de la zone (bord opposé de C1) + marge
 *               automatique selon la catégorie (ATR). RÈGLE DURE : le risque (entrée → SL)
 *               ne doit jamais dépasser MAX_SL_PIPS (100 pips), pip = risk.pipSize. Au-delà,
 *               la zone est REFUSEE (« non viable »). La même vérification est refaite à
 *               l'entrée réelle (confirmation) : si elle dépasse 100 pips, le trade est annulé.
 *   TP1/TP2/TP3 : distances FIXES depuis l'entrée réelle, par catégorie (voir TP_LADDER) :
 *     - Scalp et Daily : +100 / +200 / +350 pips.
 *     - Swing : +100 / +400 / +600 pips (le +600 est une clôture MANUELLE, notifiée).
 *
 * Gestion : 1/3 de la position clôturé à chaque niveau (TP1, TP2, TP3/+600).
 * Gestion institutionnelle du stop (trader institutionnel, compte pérenne) :
 *   1. Pas de BE trop tôt : le stop ne passe au point mort QUE si le prix a atteint À LA FOIS
 *      TP1 ET +1R (R = distance entrée → SL initial). BE = entrée ± 3 pips (frais couverts),
 *      jamais exactement l'entrée.
 *   2. Après le BE, trailing structurel : sur les bougies de l'unité de temps de la zone
 *      (bougies de base si l'UT de la zone n'est pas disponible), chaque nouveau creux de swing
 *      (achat) / sommet de swing (vente) — fractale à 2 bougies de chaque côté, confirmée par
 *      2 bougies clôturées après elle — formé APRÈS l'entrée déplace le stop juste au-delà de ce
 *      swing (± 3 pips), uniquement si cela resserre le stop (jamais ne le desserre), et jamais
 *      derrière le niveau de BE.
 *   3. Après TP2 : le stop est au moins sur TP1 (plancher) — stop = le plus protecteur de
 *      (trailing, TP1).
 *   4. Prudence intra-bougie inchangée (stop vérifié en premier ; bougie 1 minute si disponible).
 *   TP3 (scalp/day) → trade terminé. +600 (swing) → notification de clôture, trade considéré
 *   clôturé en simulation/backtest/journal.
 * La position n'existe (et n'entre dans la balance) que lorsque le prix ARRIVE sur l'entrée.
 *
 * Résolution intra-bougie prudente : si une bougie touche le stop et un objectif,
 * la bougie 1 minute tranche ; sans elle, le stop est retenu.
 */
import { CATEGORIES, TF_SECONDS } from './engine.js';

/** Risque maximal (entrée → SL) toléré, en pips : au-delà, la zone est « non viable ». */
export const MAX_SL_PIPS = 100;

/** Échelle d'objectifs fixe (en pips depuis l'entrée), par catégorie. */
export const TP_LADDER = {
  scalping: { tp1: 100, tp2: 200, tp3: 350 },
  day: { tp1: 100, tp2: 200, tp3: 350 },
  swing: { tp1: 100, tp2: 400, tp3: 600 },
};

/** Marge de stop (× ATR) par défaut, par catégorie de trading. */
export const CATEGORY_DEFAULTS = {
  scalping: { bufAtr: 0.05 },
  day: { bufAtr: 0.1 },
  swing: { bufAtr: 0.15 },
};

export const DEFAULT_RISK = {
  lot: 0.10,             // lots
  contractSize: 100,     // onces par lot standard XAUUSD
  pipSize: 0.10,         // 1 pip = 0,10 $ sur l'or (convention la plus courante)
  entryMode: 'confirmation', // 'confirmation' : entrée sur la bougie de réaction dans l'OB ; 'limit' : ordre limite au bord de l'OB
  minStars: 5,               // seules les zones 5★ sont valides ; moins de 5★ = invalidée (non réglable)
  eurUsd: 'manual',      // taux saisi par l'utilisateur
  eurUsdManual: 1.08,
  newsBlackoutMin: 30,   // pas d'entrée ± N minutes autour d'une annonce USD à fort impact
  autoFollow: false,
  validated: false,
  validatedAt: null,
};

export const POS = {
  PENDING: 'PENDING',       // ordre en attente
  OPEN: 'OPEN',             // position ouverte
  TP: 'TP',                 // clôturée en gain (TP3, ou BE/TP1 après au moins un TP)
  SL: 'SL',                 // clôturée sur stop avant TP1
  CANCELLED: 'CANCELLED',   // annulée (TP1 atteint sans entrée, annonce macro…)
  REFUSED: 'REFUSED',       // invalidée à l'analyse (TP1 < minimum de la catégorie ou < 1 R)
};

export const POS_LABEL = {
  PENDING: 'Ordre en attente',
  OPEN: 'En position',
  TP: 'Clôturée en gain',
  SL: 'Clôturée · stop',
  CANCELLED: 'Ordre annulé',
  REFUSED: 'Invalidée',
};

const LEG = 1 / 3;
/** Marge (frais couverts) du BE et du trailing structurel : quelques pips, jamais l'entrée exacte. */
const MGMT_BUFFER_PIPS = 3;

/** Marge de stop au-delà de la zone : mini 3 pips, sinon un ratio de l'ATR plafonné à 25 % de la hauteur de zone. */
function slBuffer(zone, cat, pip) {
  const bufAtr = CATEGORY_DEFAULTS[cat]?.bufAtr ?? 0.1;
  const height = zone.zoneHigh - zone.zoneLow;
  const atrBuf = zone.atr != null ? bufAtr * zone.atr : Infinity;
  return Math.max(3 * pip, Math.min(atrBuf, 0.25 * height));
}

/** Plan de trade d'une zone : entrée, stop d'invalidation, TP1/TP2/TP3 (échelle fixe par catégorie). */
export function planFor(zone, risk) {
  const buy = zone.direction === 'BUY';
  const sgn = buy ? 1 : -1;
  const pip = risk.pipSize;
  const cat = zone.category;
  const buf = slBuffer(zone, cat, pip);
  const entry = buy ? zone.zoneHigh : zone.zoneLow;
  const sl = buy ? zone.zoneLow - buf : zone.zoneHigh + buf;
  const riskPx = Math.abs(entry - sl);
  const slPips = riskPx / pip;
  const ladder = TP_LADDER[cat] || TP_LADDER.day;
  const tp1 = entry + sgn * ladder.tp1 * pip;
  const tp2 = entry + sgn * ladder.tp2 * pip;
  const tp3 = entry + sgn * ladder.tp3 * pip;
  const tp1Pips = ladder.tp1;

  let reason = null;
  if (slPips > MAX_SL_PIPS) reason = `SL de ${Math.round(slPips)} pips > ${MAX_SL_PIPS} pips : zone non viable`;
  return {
    entry, sl, tp1, tp2, tp3, tp: tp3,
    rr: riskPx ? (ladder.tp1 * pip) / riskPx : null, rr3: riskPx ? (ladder.tp3 * pip) / riskPx : null,
    riskPx, slPips, tp1Pips,
    slOk: !reason, reason, entryMode: risk.entryMode || 'confirmation',
    slBufferPips: buf / pip, category: cat,
  };
}

export const pipsOf = (dir, entry, exit, risk) => ((dir === 'BUY' ? exit - entry : entry - exit) / risk.pipSize);

/** Valeur monétaire d'un nombre de pips. */
export function money(pips, risk, eurUsd, lot = risk.lot) {
  const usd = pips * risk.pipSize * risk.contractSize * lot;
  return { usd, eur: eurUsd ? usd / eurUsd : null };
}

/**
 * Stop en vigueur (gestion institutionnelle) : stop initial, puis BE (dès qu'il est acquis),
 * puis le trailing structurel le plus protecteur jamais atteint (jamais desserré, jamais
 * derrière le BE), puis plancher TP1 dès TP2 atteint. Toujours le niveau le plus protecteur.
 */
export function currentStop(pos) {
  const buy = pos.dir === 'BUY';
  let stop = pos.sl;
  if (pos.beDone) {
    stop = pos.beLevel;
    if (pos.trailFrom != null) stop = buy ? Math.max(stop, pos.trailFrom) : Math.min(stop, pos.trailFrom);
  }
  if ((pos.hits || 0) >= 2) stop = buy ? Math.max(stop, pos.tp1) : Math.min(stop, pos.tp1);
  return stop;
}

/**
 * Plus haut creux de swing (achat) / plus bas sommet de swing (vente) — fractale à 2 bougies de
 * chaque côté — formé APRÈS l'entrée et confirmé (2 bougies clôturées après lui) au plus tard à
 * `uptoTime`. `null` si aucun swing qualifié.
 */
function structuralSwingLevel(swingCandles, fillTime, uptoTime, buy) {
  if (!swingCandles || swingCandles.length < 5 || fillTime == null) return null;
  let best = null;
  for (let i = 2; i < swingCandles.length - 2; i++) {
    const c = swingCandles[i];
    if (c.time <= fillTime) continue; // formé après l'entrée uniquement
    const r1 = swingCandles[i + 1], r2 = swingCandles[i + 2];
    if (r2.time > uptoTime) break; // pas encore confirmée par 2 bougies clôturées
    if (r1.complete === false || r2.complete === false) break;
    const l1 = swingCandles[i - 1], l2 = swingCandles[i - 2];
    if (buy) {
      if (c.low < l1.low && c.low < l2.low && c.low <= r1.low && c.low <= r2.low && (best == null || c.low > best)) best = c.low;
    } else if (c.high > l1.high && c.high > l2.high && c.high >= r1.high && c.high >= r2.high && (best == null || c.high < best)) {
      best = c.high;
    }
  }
  return best;
}

/** Met à jour +1R atteint, passage au BE, et trailing structurel, sur la bougie L (chronologique). */
function updateManagement(pos, L, buy, pip, ctx) {
  if (!pos.reached1R && pos.riskPx != null) {
    const target = buy ? pos.fillPrice + pos.riskPx : pos.fillPrice - pos.riskPx;
    if (buy ? L.high >= target : L.low <= target) pos.reached1R = true;
  }
  // BE uniquement si TP1 ET +1R sont TOUS LES DEUX atteints (pas de BE trop tôt)
  if (!pos.beDone && (pos.hits || 0) >= 1 && pos.reached1R) {
    pos.beDone = true;
    pos.beLevel = buy ? pos.fillPrice + MGMT_BUFFER_PIPS * pip : pos.fillPrice - MGMT_BUFFER_PIPS * pip;
  }
  if (pos.beDone) {
    const lvl = structuralSwingLevel(ctx.swingCandles, pos.fillTime, L.time, buy);
    if (lvl != null) {
      const candidate = buy ? lvl - MGMT_BUFFER_PIPS * pip : lvl + MGMT_BUFFER_PIPS * pip;
      // jamais derrière le BE
      const bounded = buy ? Math.max(candidate, pos.beLevel) : Math.min(candidate, pos.beLevel);
      // ne resserre que si plus protecteur que le trailing déjà acquis (jamais desserré)
      if (pos.trailFrom == null || (buy ? bounded > pos.trailFrom : bounded < pos.trailFrom)) pos.trailFrom = bounded;
    }
  }
}

/**
 * Fait avancer un ordre/une position sur une suite de bougies.
 * @param {object} pos  { dir, entry, sl, tp1, tp2, tp3, state, hits, fillTime, fillPrice, exitTime, exitPrice }
 * @param {Array} candles bougies triées (déjà limitées à la période à traiter)
 * @param {object} ctx { m1: bougies 1m (optionnel), tfSec, isBlackout(t) }
 */
export function advance(pos, candles, ctx = {}) {
  const buy = pos.dir === 'BUY';
  pos.hits ||= 0;
  pos.hitTimes ||= [];
  pos.beDone ||= false;
  pos.reached1R ||= false;
  // bougies servant à détecter les swings structurels : celles de l'UT de la zone si fournies
  // (ctx.swingCandles), sinon celles avancées ici (valable pour le backtest, qui avance déjà sur
  // l'UT de la zone).
  ctx.swingCandles ||= candles;
  const pip = ctx.pipSize || pos.pipSize || 0.1;
  for (const L of candles) {
    if (pos.state !== POS.PENDING && pos.state !== POS.OPEN) break;
    const sub = ctx.m1 && ctx.tfSec > 60 ? subCandles(ctx.m1, L.time, ctx.tfSec) : null;
    if (sub && sub.length) { advance(pos, sub, { ...ctx, m1: null, tfSec: 60 }); pos.lastTime = L.time; continue; }

    if (pos.state === POS.PENDING) {
      // TP1 atteint avant l'entrée : le setup s'est joué sans nous → ordre annulé
      const tpFirst = buy ? L.high >= pos.tp1 && L.low > pos.entry : L.low <= pos.tp1 && L.high < pos.entry;
      if (tpFirst) { Object.assign(pos, { state: POS.CANCELLED, reason: 'TP1 atteint sans entrée', exitTime: L.time }); break; }
      const touched = pos.inZone || (buy ? L.low <= pos.entry : L.high >= pos.entry);
      if (touched && pos.entryMode === 'confirmation') {
        // Étape 11 : le prix est revenu dans l'OB → attendre une bougie de réaction dans le sens du trade
        if (!pos.inZone) { pos.inZone = true; pos.zoneTime = L.time; }
        if (buy ? L.low <= pos.sl : L.high >= pos.sl) { Object.assign(pos, { state: POS.CANCELLED, reason: 'OB cassé sans réaction', exitTime: L.time }); break; }
        // la bougie de réaction doit être CLÔTURÉE (une bougie en cours peut encore s'inverser)
        const reaction = L.complete !== false && (buy ? L.close > L.open : L.close < L.open);
        const notTooFar = buy ? L.close <= pos.entry + 0.5 * pos.riskPx : L.close >= pos.entry - 0.5 * pos.riskPx;
        if (reaction && notTooFar) {
          if (ctx.isBlackout && ctx.isBlackout(L.time)) { Object.assign(pos, { state: POS.CANCELLED, reason: 'annonce macro à fort impact', exitTime: L.time }); break; }
          // entrée à la clôture de la bougie de réaction : le risque réel (entrée → SL) doit
          // toujours être vérifié à ≤ 100 pips, même si le plan initial était valide
          const pipSize = ctx.pipSize || 0.1;
          const riskPips = Math.abs(L.close - pos.sl) / pipSize;
          if (riskPips > MAX_SL_PIPS) { Object.assign(pos, { state: POS.CANCELLED, reason: `SL de ${Math.round(riskPips)} pips > ${MAX_SL_PIPS} pips : zone non viable`, exitTime: L.time }); break; }
          // objectifs vérifiés à partir de la bougie suivante ; risque réel (R) = entrée réelle → SL
          Object.assign(pos, { state: POS.OPEN, fillTime: L.time, fillPrice: L.close, riskPips, riskPx: Math.abs(L.close - pos.sl) });
        }
        pos.lastTime = L.time;
        continue;
      }
      if (touched) {
        if (ctx.isBlackout && ctx.isBlackout(L.time)) {
          Object.assign(pos, { state: POS.CANCELLED, reason: 'annonce macro à fort impact', exitTime: L.time });
          break;
        }
        // un ordre limite s'exécute au prix de l'ordre ou mieux (ouverture en gap)
        const fill = buy ? Math.min(pos.entry, L.open) : Math.max(pos.entry, L.open);
        Object.assign(pos, { state: POS.OPEN, fillTime: L.time, fillPrice: fill, riskPx: Math.abs(fill - pos.sl) });
        // même bougie : seul le stop est vérifié (prudence), les objectifs attendent la bougie suivante
        if (buy ? L.low <= pos.sl : L.high >= pos.sl) close(pos, pos.sl, L.time);
        pos.lastTime = L.time;
        continue;
      }
    } else if (pos.state === POS.OPEN) {
      // stop vérifié en premier (prudence intra-bougie), sur l'état acquis aux bougies précédentes
      const stop = currentStop(pos);
      const hitStop = buy ? L.low <= stop : L.high >= stop;
      if (hitStop) {
        close(pos, buy ? Math.min(stop, L.open) : Math.max(stop, L.open), L.time);
      } else {
        for (const k of [1, 2, 3]) {
          if (pos.hits >= k) continue;
          const tp = pos[`tp${k}`];
          if (buy ? L.high >= tp : L.low <= tp) { pos.hits = k; pos.hitTimes[k - 1] = L.time; } else break;
        }
        if (pos.hits >= 3) close(pos, pos.tp3, L.time);
        else updateManagement(pos, L, buy, pip, ctx); // BE (TP1 + 1R) puis trailing structurel, pour les bougies suivantes
      }
    }
    pos.lastTime = L.time;
  }
  return pos;
}

function close(pos, price, time) {
  const hits = pos.hits || 0;
  const kind = hits >= 3 ? 'TP3' : hits === 2 ? 'TP2 puis stop sur TP1' : hits === 1 ? 'TP1 puis BE' : 'SL';
  Object.assign(pos, { state: hits >= 1 ? POS.TP : POS.SL, exitPrice: price, exitTime: time, exitKind: kind });
}

function subCandles(m1, start, tfSec) {
  // recherche dichotomique du début
  let lo = 0, hi = m1.length;
  while (lo < hi) { const m = (lo + hi) >> 1; if (m1[m].time < start) lo = m + 1; else hi = m; }
  if (lo >= m1.length || m1[lo].time >= start + tfSec) return null;
  const out = [];
  for (let i = lo; i < m1.length && m1[i].time < start + tfSec; i++) out.push(m1[i]);
  // la couverture doit être complète pour trancher, sinon on reste prudent sur la bougie TF
  const covered = out.length && out[0].time <= start + 60 && out.at(-1).time >= start + tfSec - 120;
  return covered ? out : null;
}

/** Position vierge à partir d'un plan. */
export function newPosition(zone, plan) {
  return {
    id: zone.id, dir: zone.direction, entry: plan.entry, sl: plan.sl,
    tp1: plan.tp1, tp2: plan.tp2, tp3: plan.tp3, tp: plan.tp3, rr: plan.rr, hits: 0, hitTimes: [],
    riskPx: plan.riskPx, entryMode: plan.entryMode, inZone: false,
    beDone: false, beLevel: null, reached1R: false, trailFrom: null,
    state: plan.slOk ? POS.PENDING : POS.REFUSED, reason: plan.slOk ? null : plan.reason,
  };
}

/**
 * Simule la position d'une zone sur l'historique chargé (backtest), depuis la bougie après C3.
 */
export function simulateZone(zone, tfCandles, risk, ctx = {}) {
  const plan = planFor(zone, risk, ctx.profile);
  const pos = newPosition(zone, plan);
  if (pos.state === POS.PENDING) {
    advance(pos, tfCandles.slice(zone.c3Index + 1), { ...ctx, tfSec: TF_SECONDS[zone.timeframe], pipSize: risk.pipSize });
  }
  return finalize(pos, plan, ctx.currentPrice, risk);
}

/** Pips d'une position gérée par tiers (TP atteints + reste au prix de sortie ou courant). */
export function positionPips(pos, exitOrCurrent, risk) {
  const hits = Math.min(3, pos.hits || 0);
  let pips = 0;
  for (let k = 1; k <= hits; k++) pips += LEG * pipsOf(pos.dir, pos.fillPrice, pos[`tp${k}`], risk);
  if (hits < 3 && exitOrCurrent != null) pips += (3 - hits) * LEG * pipsOf(pos.dir, pos.fillPrice, exitOrCurrent, risk);
  return pips;
}

/** Calcule pips / R / état « à gains » ou « à perte ». */
export function finalize(pos, plan, currentPrice, risk) {
  const out = { ...pos, slPips: plan.slPips, riskPx: plan.riskPx };
  if (pos.state === POS.TP || pos.state === POS.SL) {
    out.pips = positionPips(pos, pos.exitPrice, risk);
    out.realized = true;
  } else if (pos.state === POS.OPEN && currentPrice != null) {
    out.pips = positionPips(pos, currentPrice, risk);
    out.realized = false;
  } else {
    out.pips = null;
  }
  if (out.pips != null) {
    // R rapporté au risque réellement pris (entrée sur réaction → stop parfois plus court)
    out.r = out.pips / (pos.riskPips || plan.slPips);
    out.pnlSide = out.pips > 0 ? 'gain' : out.pips < 0 ? 'perte' : 'neutre';
  }
  out.stop = pos.state === POS.OPEN ? currentStop(pos) : null;
  return out;
}

/** Somme des positions : pips, €, gagnantes/perdantes. */
export function balance(positions, risk, eurUsd) {
  const b = { pips: 0, realizedPips: 0, openPips: 0, eur: 0, usd: 0, realizedEur: 0, openEur: 0, wins: 0, losses: 0, open: 0, pending: 0, rSum: 0, closed: 0 };
  for (const p of positions) {
    if (p.state === POS.PENDING) b.pending++;
    if (p.pips == null) continue;
    const m = money(p.pips, risk, eurUsd, p.lot ?? risk.lot);
    b.pips += p.pips; b.usd += m.usd; b.eur += m.eur ?? 0;
    if (p.realized) {
      b.realizedPips += p.pips; b.realizedEur += m.eur ?? 0; b.closed++; b.rSum += p.r;
      if (p.pips > 0) b.wins++; else b.losses++;
    } else { b.openPips += p.pips; b.openEur += m.eur ?? 0; b.open++; }
  }
  b.winRate = b.closed ? b.wins / b.closed : null;
  b.expectancyR = b.closed ? b.rSum / b.closed : null;
  return b;
}

// ── Notifications : messages courts, lisibles sans ouvrir l'application ─────
const px = (v) => (v == null ? '—' : Number(v).toFixed(2));
const catShort = (c) => CATEGORIES[c]?.label || '';

/**
 * Message d'une notification. Le titre suffit à agir ; le corps donne tous les niveaux.
 * @param {string} type  new | fill | tp1 | tp2 | tp3 | be | trail | closeProfit | sl | cancel
 */
export function notifText(type, t, extra = {}) {
  const buy = t.dir === 'BUY';
  const side = buy ? '🟢 ACHAT' : '🔴 VENTE';
  const tag = `${catShort(t.category)} ${extra.tfLabel || ''}`.trim();
  const pips = extra.pips != null ? `${extra.pips > 0 ? '+' : ''}${Math.round(extra.pips)} pips` : '';
  const stars = t.grade ? `${'★'.repeat(t.grade)}${'☆'.repeat(5 - t.grade)} ` : '';
  const levels = `TP1 ${px(t.tp1)} · TP2 ${px(t.tp2)} · TP3 ${px(t.tp3)} · SL ${px(t.sl)}`;
  const confirm = (t.entryMode || 'confirmation') === 'confirmation';
  // préservation du compte (§B4) : après 3 pertes consécutives, taille réduite conseillée
  const reduced = extra.reducedSize ? ' · taille réduite conseillée : 50 % du lot' : '';
  switch (type) {
    case 'new': return confirm ? {
      title: `👀 ${stars}${buy ? 'ACHAT' : 'VENTE'} GOLD · zone ${px(t.zoneLow ?? Math.min(t.entry, t.sl))}–${px(t.zoneHigh ?? Math.max(t.entry, t.sl))}`,
      body: `Attends le retour du prix et une bougie ${buy ? 'haussière' : 'baissière'} · SL ${px(t.sl)} · TP1 ${px(t.tp1)}`,
      detail: `Order block ${tag} · une 2e notification donnera le point d'entrée${reduced}`,
    } : {
      title: `${side} GOLD @ ${px(t.entry)} ${stars}`.trim(),
      body: levels,
      detail: `Ordre limite ${buy ? 'd\'achat' : 'de vente'} · ${tag} · risque ${Math.round(t.slPips)} pips · TP1 +${Math.round(t.tp1Pips)} pips${reduced}`,
    };
    case 'fill': return confirm ? {
      title: `${side} GOLD @ ${px(t.fillPrice ?? t.entry)} ${stars}`.trim(),
      body: levels,
      detail: `Réaction confirmée dans l'order block · ${tag} · entre maintenant`,
    } : { title: `▶ Entrée déclenchée · ${buy ? 'ACHAT' : 'VENTE'} GOLD ${px(t.fillPrice ?? t.entry)}`, body: `SL ${px(t.sl)} · TP1 ${px(t.tp1)}`, detail: tag };
    case 'tp1': return { title: `✅ TP1 +100 atteint !`, body: `GOLD ${buy ? 'ACHAT' : 'VENTE'} · stop inchangé jusqu'à +1R · prochain TP2 ${px(t.tp2)}`, detail: tag };
    case 'tp2': return { title: `✅ TP2 atteint ! Stop sur TP1 : ${px(t.tp1)}`, body: `GOLD ${buy ? 'ACHAT' : 'VENTE'} · reste TP3 ${px(t.tp3)}`, detail: tag };
    case 'tp3': return t.category === 'swing'
      ? { title: `🏁 +600 pips atteints · CLÔTURE le trade SWING`, body: `GOLD ${buy ? 'ACHAT' : 'VENTE'} · entrée ${px(t.fillPrice ?? t.entry)} → ${px(t.tp3)}`, detail: tag }
      : { title: `🏁 TP3 +350 atteint · trade terminé ${pips}`, body: `GOLD ${buy ? 'ACHAT' : 'VENTE'} · entrée ${px(t.fillPrice ?? t.entry)} → ${px(t.tp3)}`, detail: tag };
    // 'be' : le stop VIENT d'être déplacé au point mort (TP1 + 1R tous deux atteints) — la position reste ouverte
    case 'be': return { title: `🛡️ Passer à BE : ${px(t.beLevel ?? currentStop(t))} (TP1 + 1R atteints)`, body: `GOLD ${buy ? 'ACHAT' : 'VENTE'} · stop protégé, frais couverts`, detail: tag };
    // 'trail' : le stop vient d'être resserré sur un nouveau swing structurel (après le BE)
    case 'trail': return { title: `🔒 ${buy ? 'Remonter' : 'Descendre'} le stop à ${px(currentStop(t))}`, body: `GOLD ${buy ? 'ACHAT' : 'VENTE'} · nouveau swing structurel`, detail: tag };
    // 'closeProfit' : clôture en gain après BE/trailing (anciennement nommé 'be')
    case 'closeProfit': return { title: `⚖️ Clôturé en gain ${pips}`, body: `GOLD ${buy ? 'ACHAT' : 'VENTE'} · ${t.exitKind || 'stop protégé'} à ${px(t.exitPrice)}`, detail: tag };
    case 'sl': return { title: `🛑 SL touché · ${buy ? 'ACHAT' : 'VENTE'} GOLD ${pips}`, body: `Sortie ${px(t.exitPrice)} · perte analysée pour les prochains trades`, detail: tag };
    case 'cancel': return { title: `⛔ Annule l'ordre ${buy ? 'd\'ACHAT' : 'de VENTE'} GOLD ${px(t.entry)}`, body: `Motif : ${t.reason || 'zone invalidée'}`, detail: tag };
    default: return { title: 'XAUUSD Zones', body: '', detail: '' };
  }
}

export { CATEGORIES };
