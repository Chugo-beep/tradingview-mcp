/**
 * Apprentissage statistique des positions (sans IA).
 *
 * Chaque position clôturée devient un échantillon décrit par des caractéristiques connues
 * AU MOMENT DE LA DÉTECTION (aucune information future). Pour chaque valeur de
 * caractéristique, on mesure l'espérance en R lissée (bayésien) et le taux de réussite.
 * Une valeur perdante de façon répétée devient une RÈGLE DE PRÉVENTION explicite,
 * appliquée par l'auditeur, comme le prévoit SELF_CORRECTION_TRAINING.md
 * (« après trois erreurs du même type, renforcer la règle »).
 */
import { TF_LABEL, CATEGORIES } from './engine.js';
import { marketById } from './markets.js';

export const FEATURE_LABEL = {
  category: 'Catégorie', tf: 'Timeframe', direction: 'Sens', gapAtr: 'Imbalance / ATR', zoneAtr: 'Hauteur de zone / ATR',
  sweepAtr: 'Profondeur du balayage / ATR', session: 'Session', trend: 'Tendance (EMA 50)', news: 'Annonce proche',
  stars: 'Étoiles à la détection', fibZone: 'Fibonacci', liqRisk: 'Liquidité au-delà de l\'OB', supertrend: 'Supertrend',
  market: 'Marché',
  poiTf: 'UT du POI', poiKind: 'Type de POI', htfOte: 'POI en OTE HTF', microKind: 'Micro-zone LTF', microOte: 'Micro-zone en OTE LTF',
};

const VALUE_LABEL = {
  direction: { BUY: 'Achat', SELL: 'Vente' },
  trend: { with: 'Dans la tendance', against: 'Contre la tendance', na: 'Indéterminée' },
  news: { yes: '± 60 min d\'une annonce', no: 'Aucune annonce' },
  fibZone: { DISCOUNT: 'Discount', PREMIUM: 'Premium', EQUILIBRIUM: 'Équilibre' },
  liqRisk: { yes: 'Poche proche (risque de balayage)', no: 'Pas de poche proche' },
  supertrend: { with: 'Aligné', against: 'Contre', range: 'Range' },
  stars: { 3: '3★', 4: '4★', 5: '5★', 2: '2★', 1: '1★' },
  htfOte: { yes: 'OTE 0,618–0,786', no: 'hors OTE' }, microOte: { yes: 'OTE 0,618–0,786', no: 'hors OTE' },
  poiKind: { OB: 'Order Block', FVG: 'Fair Value Gap' }, microKind: { OB: 'micro-OB', FVG: 'micro-FVG' },
};

const bucket = (v, edges, labels) => {
  if (v == null || !Number.isFinite(v)) return 'na';
  for (let i = 0; i < edges.length; i++) if (v < edges[i]) return labels[i];
  return labels[labels.length - 1];
};

export function sessionOf(t) {
  const h = new Date(t * 1000).getUTCHours();
  if (h < 7) return 'Asie';
  if (h < 12) return 'Londres';
  if (h < 17) return 'New York';
  return 'Clôture US';
}

/** Caractéristiques d'une zone, connues à la clôture de C3. `marketId` : marché analysé (analyse
 * complète multi-marchés) — ajoute la dimension `market` aux règles apprises ; omis (undefined/null)
 * en analyse mono-marché (compatibilité). */
export function featuresOf(zone, { hasNewsNear } = {}, marketId = null) {
  if (zone.smc) {
    const m = zone.smc;
    return {
      category: zone.category, tf: zone.timeframe, direction: zone.direction,
      session: sessionOf(zone.c3Time),
      news: hasNewsNear ? (hasNewsNear(zone.c3Time, 60) ? 'yes' : 'no') : 'no',
      poiTf: m.poi.tf, poiKind: m.poi.kind, htfOte: m.fib.ote ? 'yes' : 'no',
      microKind: m.micro.kind, microOte: m.micro.ote ? 'yes' : 'no',
      ...(marketId ? { market: marketId } : {}),
    };
  }
  const a = zone.atr || null;
  const { P } = zone.candles;
  const sweep = zone.direction === 'BUY' ? zone.liquidity.level - P.low : P.high - zone.liquidity.level;
  const c3 = zone.candles.C3.close;
  let trend = 'na';
  if (zone.ema50 != null) trend = (zone.direction === 'BUY' ? c3 > zone.ema50 : c3 < zone.ema50) ? 'with' : 'against';
  return {
    category: zone.category,
    tf: zone.timeframe,
    direction: zone.direction,
    gapAtr: bucket(a ? zone.gap / a : null, [0.1, 0.3, 0.6], ['< 0,1', '0,1 – 0,3', '0,3 – 0,6', '≥ 0,6']),
    zoneAtr: bucket(a ? (zone.zoneHigh - zone.zoneLow) / a : null, [0.5, 1, 2], ['< 0,5', '0,5 – 1', '1 – 2', '≥ 2']),
    sweepAtr: bucket(a ? sweep / a : null, [0.1, 0.3], ['< 0,1', '0,1 – 0,3', '≥ 0,3']),
    session: sessionOf(zone.c3Time),
    trend,
    news: hasNewsNear ? (hasNewsNear(zone.c3Time, 60) ? 'yes' : 'no') : 'no',
    ...(zone.stars ? {
      // étoiles connues à la détection (⭐4 « vierge » est vraie à la clôture de C3)
      stars: String(['imbalance', 'trend', 'liquidity', 'fib'].filter((k) => zone.stars[k]).length + 1),
      fibZone: zone.fib?.zone || 'na',
      liqRisk: zone.liq?.risk ? 'yes' : 'no',
      supertrend: zone.trend?.ranging ? 'range' : zone.trend?.aligned ? 'with' : 'against',
    } : {}),
    ...(marketId ? { market: marketId } : {}),
  };
}

export function valueLabel(feature, value) {
  if (feature.includes(SEP)) { const fs = feature.split(SEP), vs = String(value).split('|'); return fs.map((f, i) => valueLabel(f, vs[i])).join(' + '); }
  if (feature === 'tf' || feature === 'poiTf') return TF_LABEL[value] || value;
  if (feature === 'category') return CATEGORIES[value]?.label || value;
  if (feature === 'market') return marketById(value)?.label || value;
  return VALUE_LABEL[feature]?.[value] ?? value;
}

export const ruleKey = (f, v) => `${f}=${v}`;

/**
 * Combinaisons de caractéristiques apprises en plus des caractéristiques seules :
 * un piège se cache souvent dans un croisement (ex. Londres + contre-tendance).
 */
export const PAIRS = [
  ['session', 'trend'], ['session', 'direction'], ['tf', 'trend'], ['direction', 'trend'],
  ['category', 'session'], ['gapAtr', 'trend'], ['zoneAtr', 'category'], ['sweepAtr', 'trend'],
  ['stars', 'session'], ['fibZone', 'supertrend'], ['liqRisk', 'category'],
  ['poiTf', 'htfOte'], ['microKind', 'microOte'], ['session', 'poiKind'],
];
const SEP = ' + ';
/** Caractéristiques seules + combinaisons. */
export function expand(features) {
  const out = { ...features };
  for (const [a, b] of PAIRS) {
    const va = features[a], vb = features[b];
    if (va == null || vb == null || va === 'na' || vb === 'na') continue;
    out[`${a}${SEP}${b}`] = `${va}|${vb}`;
  }
  return out;
}
function featureLabel(f) { return f.includes(SEP) ? f.split(SEP).map((x) => FEATURE_LABEL[x] || x).join(' + ') : FEATURE_LABEL[f] || f; }
export { featureLabel };

/**
 * Construit le modèle à partir des échantillons { features, r, source }.
 * Les positions réelles pèsent double par rapport au backtest.
 *
 * `accepted` : règles candidates déjà validées par le mécanisme champion / challenger
 * (learnStore.acceptedRules, voir reviewRules ci-dessous). Une règle candidate qui n'y
 * figure pas encore n'est PAS active : elle n'a pas prouvé d'amélioration.
 * `disabled` (désactivation manuelle de l'utilisateur) l'emporte toujours.
 */
export function buildModel(samples, { minSamples = 8, prior = 5, threshold = -0.15, minLosses = 3, disabled = [], accepted = [] } = {}) {
  const w = (s) => (s.source === 'reel' ? 2 : 1);
  let W = 0, R = 0, wins = 0;
  for (const s of samples) { W += w(s); R += w(s) * s.r; if (s.r > 0) wins += w(s); }
  const globalR = W ? R / W : 0;
  const stats = {};
  for (const s of samples) {
    for (const [f, v] of Object.entries(expand(s.features))) {
      if (v === 'na') continue;
      const k = ruleKey(f, v);
      const st = (stats[k] ||= { feature: f, value: v, n: 0, w: 0, rSum: 0, wins: 0, losses: 0 });
      st.n++; st.w += w(s); st.rSum += w(s) * s.r;
      if (s.r > 0) st.wins++; else st.losses++;
    }
  }
  for (const st of Object.values(stats)) {
    st.meanR = st.rSum / st.w;
    st.smoothR = (st.rSum + prior * globalR) / (st.w + prior);
    st.winRate = st.wins / st.n;
    st.label = `${featureLabel(st.feature)} : ${valueLabel(st.feature, st.value)}`;
    st.combo = st.feature.includes(SEP);
  }
  const rules = Object.entries(stats)
    // une combinaison doit avoir plus d'exemples qu'une caractéristique seule (éviter le hasard)
    // ceci ne fait que repérer les CANDIDATES statistiquement significatives ; l'activation
    // réelle dépend du mécanisme champion / challenger (accepted) et du choix de l'utilisateur (disabled)
    .filter(([, st]) => st.n >= (st.combo ? Math.ceil(minSamples * 1.5) : minSamples) && st.losses >= minLosses && st.smoothR < threshold)
    .map(([key, st]) => {
      const isDisabled = disabled.includes(key), isAccepted = accepted.includes(key);
      return { key, ...st, active: isAccepted && !isDisabled, status: isDisabled ? 'disabled' : isAccepted ? 'active' : 'candidate' };
    })
    .sort((a, b) => a.smoothR - b.smoothR);

  // précision : échantillons qui auraient passé les règles actives
  const active = new Set(rules.filter((r) => r.active).map((r) => r.key));
  const passing = samples.filter((s) => passesActive(s.features, active));
  const summarize = (arr) => ({
    n: arr.length,
    winRate: arr.length ? arr.filter((s) => s.r > 0).length / arr.length : null,
    meanR: arr.length ? arr.reduce((a, s) => a + s.r, 0) / arr.length : null,
  });
  return {
    globalR, n: samples.length, stats, rules,
    before: summarize(samples), after: summarize(passing),
    real: summarize(samples.filter((s) => s.source === 'reel')),
    params: { minSamples, prior, threshold, minLosses },
  };
}

/** Une position passe le filtre d'un ensemble de règles actives si aucune de ses caractéristiques (seules ou combinées) n'y figure. */
export function passesActive(features, activeSet) {
  for (const [f, v] of Object.entries(expand(features))) if (activeSet.has(ruleKey(f, v))) return false;
  return true;
}

/** Performance (n, taux de rétention, espérance en R) d'un jeu d'échantillons filtré par un ensemble de règles actives. */
export function evalSamples(samples, activeSet) {
  const passing = samples.filter((s) => passesActive(s.features, activeSet));
  return {
    n: passing.length,
    retention: samples.length ? passing.length / samples.length : 1,
    meanR: passing.length ? passing.reduce((a, s) => a + s.r, 0) / passing.length : null,
  };
}

const fmtRv = (v) => (v == null ? '—' : `${v >= 0 ? '+' : ''}${v.toFixed(2)} R`);

/**
 * Champion / challenger pour les règles de prévention apprises (déterministe, sans IA).
 * - Une règle déjà acceptée est retirée si l'ENLEVER améliore l'espérance moyenne à la fois
 *   sur l'échantillon complet et sur sa moitié la plus récente (triée par sample.t) : elle ne
 *   sert plus.
 * - Une règle candidate (statistiquement significative, cf. buildModel) et non désactivée par
 *   l'utilisateur est acceptée seulement si l'AJOUTER améliore l'espérance moyenne sur les deux
 *   fenêtres tout en conservant au moins 60 % des échantillons dans chacune (éviter de tout filtrer).
 * `quarantine` : { [clé]: until (secondes) } — une règle retirée par un retour arrière (§3) ne peut
 * pas être immédiatement réacceptée (anti ping-pong), tant que `nowSec` < `until`.
 */
export function reviewRules(samples, candidates, accepted = [], disabled = [], quarantine = {}, nowSec = 0) {
  const sorted = samples.every((s) => s.t != null) ? samples.slice().sort((a, b) => a.t - b.t) : samples;
  const half = sorted.slice(Math.ceil(sorted.length / 2));
  const active = new Set(accepted.filter((k) => !disabled.includes(k)));
  const decisions = [];
  const evalBoth = (set) => ({ full: evalSamples(sorted, set), half: evalSamples(half, set) });

  for (const key of [...active]) {
    const withIt = evalBoth(active);
    const without = new Set(active); without.delete(key);
    const withoutIt = evalBoth(without);
    if (withIt.full.n && withoutIt.full.n && withIt.half.n && withoutIt.half.n
      && withoutIt.full.meanR > withIt.full.meanR && withoutIt.half.meanR > withIt.half.meanR) {
      active.delete(key);
      decisions.push({ key, decision: 'rejeté', reason: `règle retirée : ${fmtRv(withoutIt.full.meanR)}/trade sans elle contre ${fmtRv(withIt.full.meanR)} avec (période récente : ${fmtRv(withoutIt.half.meanR)} vs ${fmtRv(withIt.half.meanR)})` });
    }
  }
  for (const r of candidates) {
    const key = r.key;
    if (active.has(key) || disabled.includes(key)) continue;
    if (quarantine[key] && quarantine[key] > nowSec) {
      decisions.push({ key, decision: 'rejeté', reason: `en quarantaine après retour arrière jusqu'au ${new Date(quarantine[key] * 1000).toLocaleDateString('fr-FR')}` });
      continue;
    }
    const without = evalBoth(active);
    const withSet = new Set(active); withSet.add(key);
    const withIt = evalBoth(withSet);
    const retentionOk = withIt.full.retention >= 0.6 && withIt.half.retention >= 0.6;
    const improves = withIt.full.n > 0 && without.full.n > 0 && withIt.half.n > 0 && without.half.n > 0
      && withIt.full.meanR > without.full.meanR && withIt.half.meanR > without.half.meanR;
    if (retentionOk && improves) {
      active.add(key);
      decisions.push({ key, decision: 'adopté', reason: `espérance ${fmtRv(withIt.full.meanR)}/trade avec la règle contre ${fmtRv(without.full.meanR)} sans (période récente : ${fmtRv(withIt.half.meanR)} vs ${fmtRv(without.half.meanR)})` });
    } else if (!retentionOk) {
      decisions.push({ key, decision: 'insuffisant', reason: `filtrerait trop d'échantillons (${Math.round(withIt.full.retention * 100)} % / ${Math.round(withIt.half.retention * 100)} % restants, minimum 60 %)` });
    } else {
      decisions.push({ key, decision: 'rejeté', reason: `pas d'amélioration prouvée (${fmtRv(withIt.full.meanR)} vs ${fmtRv(without.full.meanR)}, période récente ${fmtRv(withIt.half.meanR)} vs ${fmtRv(without.half.meanR)})` });
    }
  }
  return { accepted: [...active], decisions };
}

/** Score d'une zone : espérance estimée (R) et indice de confiance 0–100. */
export function scoreZone(model, feats) {
  if (!model || !model.n) return { expR: null, confidence: null, blockedBy: [] };
  let exp = model.globalR;
  const blockedBy = [];
  const activeRules = new Map(model.rules.filter((r) => r.active).map((r) => [r.key, r]));
  for (const [f, v] of Object.entries(expand(feats))) {
    const st = model.stats[ruleKey(f, v)];
    // les combinaisons affinent l'estimation sans compter double
    if (st) exp += (st.smoothR - model.globalR) * (st.combo ? 0.5 : 1);
    const rule = activeRules.get(ruleKey(f, v));
    if (rule) blockedBy.push(rule.label);
  }
  const confidence = Math.round(Math.max(0, Math.min(100, 50 + exp * 30)));
  return { expR: exp, confidence, blockedBy };
}
