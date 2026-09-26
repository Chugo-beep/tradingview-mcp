/**
 * Annonces économiques (calendrier TradingView) : interprétation déterministe, sans IA.
 * Module PUR (aucun accès réseau/DOM/horloge) : utilisable côté serveur, côté client et dans les
 * tests. Les 4 pays suivis sont US (États-Unis), EU (zone euro), CN (Chine), JP (Japon) — impact
 * MAJEUR uniquement (importance === 1).
 */

/** Pays suivis, dans l'ordre d'affichage. */
export const NEWS_COUNTRIES = ['US', 'EU', 'CN', 'JP'];

/** Emoji drapeau par pays (zone euro = drapeau européen). */
export const COUNTRY_FLAG = { US: '🇺🇸', EU: '🇪🇺', CN: '🇨🇳', JP: '🇯🇵' };

/**
 * Familles d'indicateurs US (mots-clés du titre), avec `inverse` = vrai quand une valeur PLUS
 * HAUTE que prévu traduit une économie plus FAIBLE (donc un biais dovish/haussier pour l'or) :
 * Jobless Claims et Unemployment Rate sont inverses ; tous les autres indicateurs suivis ne le
 * sont pas (une valeur plus haute = économie plus forte = biais hawkish/baissier pour l'or).
 */
const FAMILIES = [
  { key: 'inflation', re: /\b(CPI|PCE|PPI|Core Inflation|Inflation Rate)\b/i, inverse: false },
  { key: 'employment_inverse', re: /\b(Jobless Claims|Unemployment Rate)\b/i, inverse: true },
  { key: 'employment', re: /\b(Non\s?Farm Payrolls|NFP|ADP)\b/i, inverse: false },
  { key: 'growth', re: /\b(GDP|Retail Sales|ISM|PMI|Durable Goods)\b/i, inverse: false },
  { key: 'fed', re: /\b(Fed Interest Rate Decision|FOMC)\b/i, inverse: false },
];

/** Classe un titre d'indicateur US dans une famille connue, ou `null` si non reconnu. */
export function classifyIndicator(title) {
  const t = String(title || '');
  for (const f of FAMILIES) if (f.re.test(t)) return { family: f.key, inverse: f.inverse };
  return null;
}

/** `actual` vaut-il plus, moins, ou pareil que `forecast` ? `null` si l'un des deux manque. */
export function compareActualForecast(actual, forecast) {
  if (actual == null || forecast == null) return null;
  const na = Number(actual), nb = Number(forecast);
  if (Number.isFinite(na) && Number.isFinite(nb)) {
    if (Math.abs(na - nb) <= 1e-9) return 'inline';
    return na > nb ? 'above' : 'below';
  }
  const sa = String(actual).trim(), sb = String(forecast).trim();
  if (!sa || !sb) return null;
  return sa === sb ? 'inline' : null; // valeurs textuelles non numériques : seule l'égalité est déterministe
}

const COMPARISON_LABEL = { above: 'Supérieur aux attentes', below: 'Inférieur aux attentes', inline: 'Conforme aux attentes' };
export const comparisonLabel = (c) => COMPARISON_LABEL[c] || null;

/**
 * Tendance « habituelle » pour l'or (jamais une prédiction) déduite d'une annonce US, à partir de
 * la comparaison actual/forecast. `null` pour un pays autre que US, un indicateur non classé, ou
 * une comparaison en ligne avec les attentes / indisponible.
 */
export function goldTendency(country, title, comparison) {
  if (country !== 'US' || !comparison || comparison === 'inline') return null;
  const cls = classifyIndicator(title);
  if (!cls) return null;
  const bearish = comparison === 'above' ? !cls.inverse : cls.inverse;
  return bearish ? 'généralement baissier pour l\'or' : 'généralement haussier pour l\'or';
}

/** Interprétation complète d'un événement (comparaison + tendance or si applicable). */
export function interpretEvent(ev) {
  const comparison = compareActualForecast(ev.actual, ev.forecast);
  const tendency = goldTendency(ev.country, ev.title, comparison);
  const indirect = ev.country !== 'US' && comparison && comparison !== 'inline';
  return { comparison, comparisonText: comparisonLabel(comparison), tendency, indirectNote: indirect ? 'effet indirect via le dollar' : null };
}

/** Formate une valeur avec son unité/échelle TradingView (ex. 210 + "K" → "210K"). */
export function formatNewsValue(value, unit, scale) {
  if (value == null || value === '') return null;
  const n = Number(value);
  const v = Number.isFinite(n) ? (Number.isInteger(n) ? String(n) : String(Math.round(n * 100) / 100)) : String(value);
  return `${v}${scale || ''}${unit || ''}`;
}
