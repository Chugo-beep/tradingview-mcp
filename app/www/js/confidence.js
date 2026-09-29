/**
 * Indicateur de confiance : mesure à quel point le BACKTEST long terme d'un marché justifie de faire
 * confiance à la stratégie sur ce marché. Ce n'est PAS une probabilité de gain du trade : c'est un
 * niveau de preuve statistique, volontairement sévère.
 *
 * Niveaux (du plus fiable au moins fiable) :
 *  - bonne         : les 4 critères ci-dessous sont remplis ;
 *  - moyenne       : 3 critères sur 4, dont l'intervalle de confiance > 0 ;
 *  - faible        : espérance positive mais preuves insuffisantes (1 ou 2 critères) ;
 *  - negative      : ≥ 30 trades et espérance ≤ 0 → la stratégie perd sur ce marché ;
 *  - non_demontree : < 30 trades → aucune conclusion possible ;
 *  - inconnue      : pas de rapport de backtest pour ce marché.
 * Critères : espérance in-sample > 0 · espérance out-of-sample > 0 · borne basse de l'IC 90 % > 0 ·
 * résultat au-dessus de 95 % des tirages aléatoires.
 */
export const MIN_TRADES = 30;

export const CONFIDENCE_LABEL = {
  bonne: 'Confiance bonne',
  moyenne: 'Confiance moyenne',
  faible: 'Confiance faible',
  negative: 'Confiance nulle (perdant)',
  non_demontree: 'Confiance non démontrée',
  inconnue: 'Confiance inconnue',
};
const SCORE = { bonne: 4, moyenne: 3, faible: 2, non_demontree: 1, negative: 0, inconnue: 0 };
const fmtR = (v) => (v == null ? 'n/d' : `${v >= 0 ? '+' : ''}${v.toFixed(2)}R`);

/** @param {object|null} report rapport `backtest-<MARCHÉ>.json` (full / inSample / outOfSample). */
export function assessConfidence(report) {
  const f = report?.full;
  if (!f) return { level: 'inconnue', score: 0, label: CONFIDENCE_LABEL.inconnue, n: 0, expectancyR: null, reasons: ['Aucun backtest pour ce marché : lance « npm run backtest ».'] };
  const n = f.trades ?? 0;
  const base = { n, expectancyR: f.expectancyR ?? null, winRate: f.winRate ?? null };
  if (n < MIN_TRADES) {
    return { ...base, level: 'non_demontree', score: 1, label: CONFIDENCE_LABEL.non_demontree,
      reasons: [`Seulement ${n} trade(s) simulé(s) : il en faut ${MIN_TRADES} pour conclure.`] };
  }
  if ((f.expectancyR ?? 0) <= 0) {
    return { ...base, level: 'negative', score: 0, label: CONFIDENCE_LABEL.negative,
      reasons: [`Espérance ${fmtR(f.expectancyR)} sur ${n} trades : la stratégie perd sur ce marché.`] };
  }
  const isOk = !report.inSample?.insufficient && (report.inSample?.expectancyR ?? 0) > 0;
  const oosOk = !report.outOfSample?.insufficient && (report.outOfSample?.expectancyR ?? 0) > 0;
  const ciOk = Array.isArray(f.ciR) && f.ciR[0] > 0;
  const rndOk = (f.randomPercentile ?? 0) >= 0.95;
  const pts = [isOk, oosOk, ciOk, rndOk].filter(Boolean).length;
  const level = pts >= 4 ? 'bonne' : pts === 3 && ciOk ? 'moyenne' : 'faible'; // sans IC > 0, jamais mieux que « faible »
  const reasons = [
    `${n} trades, espérance ${fmtR(f.expectancyR)}${f.ciR ? ` (IC 90 % : ${fmtR(f.ciR[0])} à ${fmtR(f.ciR[1])})` : ''}.`,
    `${isOk ? '✓' : '✕'} période d'apprentissage positive · ${oosOk ? '✓' : '✕'} période de validation positive · ${ciOk ? '✓' : '✕'} intervalle de confiance > 0 · ${rndOk ? '✓' : '✕'} bat 95 % du hasard.`,
  ];
  return { ...base, level, score: SCORE[level], label: CONFIDENCE_LABEL[level], reasons };
}

/** Phrase courte pour une notification ou une carte. */
export function confidenceLine(c) {
  if (!c) return '';
  const stat = c.n ? ` (${c.n} trades simulés${c.expectancyR != null ? `, ${fmtR(c.expectancyR)}` : ''})` : '';
  return `${c.label}${stat}`;
}
