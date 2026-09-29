/**
 * Contexte macro-économique : influence MESURÉE des annonces sur chaque marché, sans IA.
 *
 * Principe (les coefficients viennent de www/data/macro-model.json, construit par
 * scripts/build-macro-model.mjs sur l'historique 2019 → aujourd'hui, validé hors échantillon) :
 *  1. Surprise d'une annonce : z = (publié − prévu) / σ, où σ est l'écart-type historique des
 *     surprises de CE titre (NFP, CPI…). z > 0 = chiffre supérieur au consensus.
 *  2. Réaction immédiate (1 h) : β60 × z, en unités de « mouvement typique d'1 h » du marché.
 *  3. Dérive persistante : β(1 h → 1 j) et β(1 j → 3 j) × z. Seule cette dérive peut orienter un
 *     trade pris APRÈS l'annonce ; si elle n'est pas significative, l'annonce n'oriente rien.
 *
 * Cohérence chronologique (règles appliquées à chaque calcul, à l'instant `nowT`) :
 *  - seules les annonces publiées (valeur connue) avant `nowT` comptent, jamais les futures ;
 *  - une nouvelle publication d'un même indicateur REMPLACE la précédente (pas de double compte) ;
 *  - la révision du chiffre précédent (champ « précédent » ≠ chiffre publié le mois d'avant) est une
 *    information nouvelle, comptée à la date de la nouvelle publication (poids réduit) ;
 *  - les annonces publiées à la même minute forment un « paquet » (ex. NFP + chômage + salaires) :
 *    leur accord ou désaccord est mesuré ;
 *  - l'effet décroît avec l'âge de l'annonce selon le profil de dérive mesuré (nul au-delà de 3 j).
 * Liens entre annonces (points d'influence) : corrélation historique des surprises d'un indicateur
 * publié avant un autre (ex. ADP → NFP, PPI → CPI) ; sert à anticiper la surprise d'une annonce à venir.
 * Module ES pur (navigateur, APK, Node).
 */

export const MACRO_DEFAULTS = {
  revisionWeight: 0.5, // une révision compte moitié moins qu'une surprise
  neutralBand: 0.15,   // |biais| < 0,15 mouvement typique → neutre
  maxAgeDays: 3,       // au-delà : aucune influence (profil de dérive mesuré jusqu'à 3 jours)
  lookbackDays: 40,    // fenêtre de lecture des publications passées
};

const FAMILY_RE = [
  ['taux', /interest rate decision|rate decision|deposit facility|refinancing rate/i],
  ['inflation', /\b(CPI|PCE|PPI|inflation|price index|RPI)\b/i],
  ['emploi', /payroll|unemploy|jobless|claims|employment|earnings|JOLT|ADP|labou?r|wage/i],
  ['croissance', /\b(GDP|retail|industrial production|durable|factory|ISM|PMI|trade|housing|building|orders)\b/i],
  ['confiance', /sentiment|confidence|ZEW|Ifo|optimism|climate/i],
];
export const FAMILY_LABEL = { taux: 'Taux directeurs', inflation: 'Inflation', emploi: 'Emploi', croissance: 'Croissance', confiance: 'Confiance', autre: 'Autre' };

/** Famille économique d'un titre d'annonce. */
export function familyOf(title) {
  for (const [k, re] of FAMILY_RE) if (re.test(String(title || ''))) return k;
  return 'autre';
}

/** Clé stable d'un indicateur : pays + titre sans suffixe de révision (Prel, Final, Flash, Adv…). */
export function titleKey(country, title) {
  const t = String(title || '').replace(/\s+(Prel|Final|Flash|Adv|Advance|2nd Est|3rd Est|Second Estimate|Third Estimate)\b.*$/i, '').trim();
  return `${country}:${t}`;
}

/** Surprise standardisée d'une annonce (null si non mesurable). */
export function surpriseOf(ev, model) {
  const k = model?.keys?.[titleKey(ev.country, ev.title)];
  if (!k || !(k.sigma > 0) || ev.actual == null || ev.forecast == null) return null;
  return (ev.actual - ev.forecast) / k.sigma;
}

/** Fraction de dérive restante d'une annonce d'âge `ageMin` (minutes), selon le profil mesuré. */
function remainingDrift(s, ageMin) {
  let v = 0;
  if (s.d1 && ageMin < 1440) v += s.d1 * Math.min(1, (1440 - Math.max(ageMin, 60)) / 1380);
  if (s.d2 && ageMin < 4320) v += s.d2 * Math.min(1, (4320 - Math.max(ageMin, 1440)) / 2880);
  return v;
}

/**
 * État macro d'un marché à l'instant `nowT` (s).
 * @param {Array} events annonces {t, country, title, actual, forecast, previous} (ordre quelconque)
 * @returns {{ bias, level, coherence, contributions, packets, upcoming, sensitiveKeys }}
 */
export function macroState(events, marketId, model, nowT, opts = {}) {
  const o = { ...MACRO_DEFAULTS, ...opts };
  const sens = model?.sensitivity?.[marketId] || {};
  const lo = nowT - o.lookbackDays * 86400;
  const sorted = (events || []).filter((e) => e && Number.isFinite(e.t)).slice().sort((a, b) => a.t - b.t);
  // dernière publication (connue avant nowT) de chaque indicateur + publication précédente (révision)
  const last = new Map(), prev = new Map();
  for (const e of sorted) {
    if (e.t > nowT) break;
    if (e.t < lo - 45 * 86400 || e.actual == null) continue;
    const k = titleKey(e.country, e.title);
    if (last.has(k)) prev.set(k, last.get(k));
    last.set(k, e);
  }
  const contributions = [];
  for (const [k, e] of last) {
    if (e.t < lo) continue;
    const s = sens[k];
    const z = surpriseOf(e, model);
    const ageMin = (nowT - e.t) / 60;
    const p = prev.get(k);
    const sigma = model?.keys?.[k]?.sigma;
    const rev = p && e.previous != null && p.actual != null && sigma > 0 && Math.abs(e.previous - p.actual) > 1e-9 ? (e.previous - p.actual) / sigma : null;
    const drift = s ? remainingDrift(s, ageMin) : 0;
    const contrib = z != null && s ? drift * (z + (rev != null ? o.revisionWeight * rev : 0)) : 0;
    contributions.push({
      key: k, title: e.title, country: e.country, family: familyOf(e.title), t: e.t, actual: e.actual, forecast: e.forecast, previous: e.previous,
      z: z == null ? null : round(z, 2), revision: rev == null ? null : round(rev, 2),
      // réaction immédiate attendue (1 h), en mouvements typiques ; null si aucune réaction à 1 h n'est mesurée
      // pour cet indicateur (ex. PPI sur les indices : seul un effet persistant est mesuré)
      reaction: s?.b60 && z != null ? round(s.b60 * z, 2) : null,
      contrib: round(contrib, 3), influential: !!s,
    });
  }
  contributions.sort((a, b) => b.t - a.t);
  const active = contributions.filter((c) => c.contrib !== 0);
  const bias = active.reduce((s, c) => s + c.contrib, 0);
  const absSum = active.reduce((s, c) => s + Math.abs(c.contrib), 0);
  // cohérence : 1 = toutes les annonces poussent dans le même sens, 0 = elles s'annulent
  const coherence = absSum > 0 ? Math.abs(bias) / absSum : null;
  const level = Math.abs(bias) < o.neutralBand ? 'neutre' : bias > 0 ? 'haussier' : 'baissier';

  // paquets : annonces d'un même pays publiées à la même minute
  const byPacket = new Map();
  for (const c of contributions) {
    if (c.z == null) continue;
    const pk = `${c.country}@${Math.round(c.t / 60)}`;
    (byPacket.get(pk) || byPacket.set(pk, []).get(pk)).push(c);
  }
  const packets = [];
  for (const [, list] of byPacket) {
    const withReact = list.filter((c) => c.reaction != null);
    // un « paquet » n'a de sens que si au moins deux de ses annonces ont une réaction mesurée sur ce marché
    if (withReact.length < 2) continue;
    const net = withReact.reduce((s, c) => s + c.reaction, 0);
    const abs = withReact.reduce((s, c) => s + Math.abs(c.reaction), 0);
    packets.push({ t: list[0].t, country: list[0].country, titles: list.map((c) => c.title), net: round(net, 2), agreement: abs > 0 ? round(Math.abs(net) / abs, 2) : null });
  }
  packets.sort((a, b) => b.t - a.t);

  // annonces à venir : réaction typique + surprise anticipée par les liens historiques
  const upcoming = [];
  for (const e of sorted) {
    if (e.t <= nowT || e.t > nowT + 7 * 86400) continue;
    const k = titleKey(e.country, e.title);
    const s = sens[k];
    const leads = (model?.links || []).filter((l) => l.to === k).map((l) => {
      const src = last.get(l.from);
      const zs = src ? surpriseOf(src, model) : null;
      return src && zs != null && e.t - src.t <= 12 * 86400 ? { from: l.from, title: src.title, z: round(zs, 2), rho: l.rho, n: l.n, expected: round(l.rho * zs, 2) } : null;
    }).filter(Boolean);
    if (!s && !leads.length) continue;
    const expZ = leads.length ? leads.reduce((a, l) => a + l.expected, 0) / leads.length : null;
    upcoming.push({
      key: k, title: e.title, country: e.country, t: e.t, forecast: e.forecast,
      typicalMove: s?.b60 ? round(Math.abs(s.b60), 2) : null, // |réaction| typique pour une surprise de 1 σ
      leads, expectedZ: expZ == null ? null : round(expZ, 2),
      expectedDir: s && expZ != null && Math.abs(expZ * s.b60) >= 0.05 ? (expZ * s.b60 > 0 ? 'haussier' : 'baissier') : null,
    });
  }
  return { at: nowT, bias: round(bias, 3), level, coherence: coherence == null ? null : round(coherence, 2), contributions, packets, upcoming, sensitiveKeys: Object.keys(sens).length };
}

/** Accord entre le contexte macro et la direction d'une zone. */
export function macroAlignment(state, dir) {
  if (!state || state.level === 'neutre') return 'neutre';
  return (state.level === 'haussier') === (dir === 'BUY') ? 'favorable' : 'défavorable';
}

function round(v, d = 2) { return Math.round(v * 10 ** d) / 10 ** d; }
