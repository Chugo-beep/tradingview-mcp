/**
 * Registre des marchés analysables (« analyse complète »).
 *
 * Module ES pur, sans dépendance : utilisé par le client (app.js, trades.js pour l'affichage),
 * le serveur (server.js, ranking) et tvfeed.js (bascule de graphique).
 *
 * Les valeurs de « pipValueUsdPerLot » (et donc `contractSize`, dérivé pour rester compatible avec
 * la formule historique money() = pips × pipSize × contractSize × lot) sont des DÉFAUTS INDICATIFS,
 * pour l'affichage en € uniquement : elles dépendent du courtier réel (marge, devise du compte,
 * taille de contrat CFD…) et ne doivent jamais être utilisées comme référence de calcul de risque
 * réel sans vérification auprès du courtier.
 */

/** decimals dérivés du pip : 0,0001 → 5, 0,01 → 3, 0,1 → 2, 1 → 1 (règle documentée). */
function decimalsOfPip(pip) {
  if (pip >= 1) return 1;
  if (pip >= 0.1) return 2;
  if (pip >= 0.01) return 3;
  return 5;
}

/** Fabrique une entrée du registre. */
function def({ id, label, notifLabel, tv, pip, pipValueUsdPerLot, calendarCountries, aliases = [], searchQuery, quote = 'USD', spreadPips, corrGroup }) {
  return {
    id, label, notifLabel: notifLabel || label.toUpperCase(),
    tv, pip, decimals: decimalsOfPip(pip),
    // contractSize dérivé : valeur d'un pip par lot = pip × contractSize, exprimée dans la DEVISE
    // DE COTATION (`quote`) : USD (or, indices US, EUR/USD, pétrole), EUR (DAX, CAC), JPY (USD/JPY).
    contractSize: pipValueUsdPerLot / pip,
    pipValueUsdPerLot,
    quote,
    // coût aller-retour indicatif (spread moyen hors news, en pips du marché) : déduit de chaque trade
    // simulé (backtest, classement, journal). Réglable dans l'application (« Coûts »).
    spreadPips,
    // groupe de corrélation : limite l'exposition simultanée sur des marchés qui bougent ensemble
    corrGroup: corrGroup || id,
    calendarCountries,
    // requête EXACTE envoyée à la barre de recherche TradingView Desktop (1er résultat cliqué) —
    // chaîne fixe, jamais construite depuis une entrée utilisateur (cf. tvfeed.js selectMarketViaSearch).
    searchQuery: searchQuery || id,
    aliases: [...new Set([tv, tv.split(':').pop(), id, ...aliases].filter(Boolean))],
  };
}

/** Ordre d'affichage par défaut : XAUUSD en tête (marché historique de l'application). */
export const MARKETS = [
  def({ id: 'XAUUSD', label: 'Or (XAUUSD)', notifLabel: 'GOLD', tv: 'OANDA:XAUUSD', pip: 0.10, pipValueUsdPerLot: 10, calendarCountries: ['US'], searchQuery: 'XAUUSD', spreadPips: 3, corrGroup: 'USD' }),
  def({ id: 'US30', label: 'US30', tv: 'OANDA:US30USD', pip: 1, pipValueUsdPerLot: 1, calendarCountries: ['US'], aliases: ['CAPITALCOM:US30', 'US30USD'], searchQuery: 'US30', spreadPips: 3, corrGroup: 'INDICES_US' }),
  def({ id: 'SP500', label: 'S&P 500', tv: 'OANDA:SPX500USD', pip: 1, pipValueUsdPerLot: 1, calendarCountries: ['US'], aliases: ['SPX500', 'SPX500USD', 'CAPITALCOM:US500', 'SP500'], searchQuery: 'SP500', spreadPips: 0.6, corrGroup: 'INDICES_US' }),
  def({ id: 'NAS100', label: 'Nasdaq 100', tv: 'OANDA:NAS100USD', pip: 1, pipValueUsdPerLot: 1, calendarCountries: ['US'], aliases: ['NAS100USD', 'CAPITALCOM:US100', 'NASDAQ100'], searchQuery: 'NASDAQ', spreadPips: 1.5, corrGroup: 'INDICES_US' }),
  def({ id: 'EURUSD', label: 'EUR/USD', tv: 'OANDA:EURUSD', pip: 0.0001, pipValueUsdPerLot: 10, calendarCountries: ['EU'], aliases: ['FX:EURUSD', 'FX_IDC:EURUSD'], searchQuery: 'EURUSD', spreadPips: 1, corrGroup: 'USD' }),
  def({ id: 'GBPUSD', label: 'GBP/USD', tv: 'OANDA:GBPUSD', pip: 0.0001, pipValueUsdPerLot: 10, calendarCountries: ['US'], aliases: ['FX:GBPUSD', 'FX_IDC:GBPUSD'], searchQuery: 'GBPUSD', spreadPips: 1.5, corrGroup: 'USD' }),
  // USD/JPY coté en JPY : 1 pip (0,01) × 100 000 = 1 000 JPY par lot ; valeur en USD = 1 000 / cours.
  def({ id: 'USDJPY', label: 'USD/JPY', tv: 'OANDA:USDJPY', pip: 0.01, pipValueUsdPerLot: 1000, quote: 'JPY', calendarCountries: ['JP'], aliases: ['FX:USDJPY', 'FX_IDC:USDJPY'], searchQuery: 'USDJPY', spreadPips: 1.5, corrGroup: 'USD' }),
  // DAX et CAC cotés en EUR : 1 point = 1 € par lot (convention CFD la plus courante).
  def({ id: 'DAX40', label: 'DAX 40', tv: 'OANDA:DE30EUR', pip: 1, pipValueUsdPerLot: 1, quote: 'EUR', calendarCountries: ['EU'], aliases: ['XETR:DAX', 'CAPITALCOM:DE40', 'DE30EUR', 'DE40EUR'], searchQuery: 'DAX40', spreadPips: 1.5, corrGroup: 'INDICES_EU' }),
  def({ id: 'CAC40', label: 'CAC 40', tv: 'OANDA:FR40EUR', pip: 1, pipValueUsdPerLot: 1, quote: 'EUR', calendarCountries: ['EU'], aliases: ['EURONEXT:PX1', 'CAPITALCOM:FR40', 'FR40EUR'], searchQuery: 'CAC40', spreadPips: 1.5, corrGroup: 'INDICES_EU' }),
  def({ id: 'WTI', label: 'Pétrole WTI', tv: 'OANDA:WTICOUSD', pip: 0.01, pipValueUsdPerLot: 10, calendarCountries: ['US'], aliases: ['TVC:USOIL', 'WTICOUSD', 'NYMEX:CL1!'], searchQuery: 'USOIL', spreadPips: 4, corrGroup: 'OIL' }),
  def({ id: 'BRENT', label: 'Pétrole Brent', tv: 'OANDA:BCOUSD', pip: 0.01, pipValueUsdPerLot: 10, calendarCountries: ['US'], aliases: ['TVC:UKOIL', 'BCOUSD', 'ICEEUR:B1!'], searchQuery: 'UKOIL', spreadPips: 4, corrGroup: 'OIL' }),
];

/** GBPUSD : calendrier US suivi (fort impact), le Royaume-Uni (GB) n'est pas encore suivi par le calendrier embarqué. */
export const GB_NOT_TRACKED_NOTE = 'Le calendrier économique du Royaume-Uni (GB) n\'est pas encore suivi : seules les annonces US sont filtrées pour GBP/USD.';

export const MARKET_IDS = MARKETS.map((m) => m.id);
export const DEFAULT_MARKET = 'XAUUSD';

const BY_ID = new Map(MARKETS.map((m) => [m.id, m]));
/** index alias (majuscule) → marché, construit une fois. */
const BY_ALIAS = new Map();
for (const m of MARKETS) for (const a of m.aliases) BY_ALIAS.set(String(a).toUpperCase(), m);

export function marketById(id) {
  return BY_ID.get(String(id || '').toUpperCase()) || null;
}

/** Réglage « Marchés analysés en direct » : un seul graphique TradingView Desktop existe toujours
 * (jamais de disposition multi-graphiques créée par l'application — abonnement de l'utilisateur
 * limité à 1) ; ce réglage détermine combien de marchés se relaient sur CE graphique unique. */
export const LIVE_CHARTS_OPTIONS = [1, 2, 3, 4];
export const DEFAULT_LIVE_CHARTS = 2;

/**
 * Marchés de l'analyse EN DIRECT : choisis par l'utilisateur (jamais imposés par le classement de
 * l'analyse complète), au plus MAX_LIVE_MARKETS, au moins un ; l'or par défaut. Ils se relaient sur
 * l'unique graphique TradingView Desktop.
 */
export const MAX_LIVE_MARKETS = 3;
export const DEFAULT_LIVE_MARKETS = ['XAUUSD'];
/** Nettoie une sélection : ids connus, sans doublon, 1 à MAX_LIVE_MARKETS, l'or si vide. */
export function sanitizeLiveMarkets(ids) {
  const out = [...new Set((Array.isArray(ids) ? ids : []).map((x) => String(x || '').toUpperCase()).filter((x) => BY_ID.has(x)))].slice(0, MAX_LIVE_MARKETS);
  return out.length ? out : [...DEFAULT_LIVE_MARKETS];
}

// alias résolus dynamiquement (barre de recherche TradingView Desktop, cf. tvfeed.js
// selectMarketViaSearch) : le symbole EXACT que ce compte TradingView utilise pour un marché ne
// figure pas forcément dans les alias statiques ci-dessus. Alimenté côté serveur après résolution,
// et côté client via GET /api/markets (registerResolvedAlias) pour que l'affichage reste correct.
const RESOLVED_ALIASES = new Map();

/**
 * Motif de validation par marché (ticker sans préfixe d'exchange) : garantit qu'un symbole
 * résolu par la recherche correspond VRAIMENT au marché demandé (ex. US30 ne peut jamais être
 * résolu en « OANDA:XAUUSD »). Les motifs sont disjoints entre marchés.
 */
const SYMBOL_PATTERNS = {
  XAUUSD: /^XAUUSD/,
  US30: /US30|^DJI$|^DJ30|WS30|^YM1!|^YM[A-Z]\d|^DOW|^DJIA/,
  SP500: /SPX|SP500|US500|^ES1!|^ES[A-Z]\d|^SPY$/,
  NAS100: /NAS100|NDX|^NQ1!|^NQ[A-Z]\d|US100|NASDAQ|^IXIC$|^QQQ$|^USTEC/,
  EURUSD: /^EURUSD/,
  GBPUSD: /^GBPUSD/,
  USDJPY: /^USDJPY/,
  DAX40: /DAX|DE40|DE30|GER40|GER30|^FDAX|^FDXM/,
  CAC40: /CAC|FR40|FRA40|^PX1$|^FCE/,
  WTI: /USOIL|WTI|^CL1!|^CL[A-Z]\d|^MCL/,
  BRENT: /UKOIL|BRENT|^BCO|^B1!|^BRN|^UKO/,
};
/** true si `symbol` (ex. "TVC:USOIL") désigne bien le marché `market` (objet ou id). */
export function symbolMatchesMarket(symbol, market) {
  const m = typeof market === 'string' ? marketById(market) : market;
  if (!m || !symbol) return false;
  const upper = String(symbol).trim().toUpperCase();
  if (!upper) return false;
  if (m.aliases.some((a) => String(a).toUpperCase() === upper)) return true;
  const ticker = upper.includes(':') ? upper.slice(upper.indexOf(':') + 1) : upper;
  // un symbole connu (statique) d'un AUTRE marché ne peut jamais être accepté
  const staticOwner = [...BY_ALIAS.entries()].find(([a]) => a === upper || a === ticker)?.[1];
  if (staticOwner && staticOwner.id !== m.id) return false;
  const re = SYMBOL_PATTERNS[m.id];
  return !!re && re.test(ticker);
}

export function registerResolvedAlias(marketId, symbol) {
  const m = marketById(marketId);
  if (!m || !symbol) return;
  if (!symbolMatchesMarket(symbol, m)) return; // jamais d'alias incohérent (ex. US30 → XAUUSD)
  const upper = String(symbol).toUpperCase();
  RESOLVED_ALIASES.set(upper, m);
  if (upper.includes(':')) RESOLVED_ALIASES.set(upper.slice(upper.indexOf(':') + 1), m);
}

/**
 * Fait correspondre un symbole TradingView (tel que renvoyé par un graphique) à un marché du
 * registre : correspondance exacte du symbole TradingView, puis alias connus (tolérant à la
 * casse et au prefix d'exchange), puis alias résolus dynamiquement, sinon `null`. Déterministe
 * (pas de correspondance floue).
 */
export function marketOf(symbolString) {
  const s = String(symbolString || '').trim();
  if (!s) return null;
  const upper = s.toUpperCase();
  for (const m of MARKETS) if (m.tv.toUpperCase() === upper) return m;
  if (BY_ALIAS.has(upper)) return BY_ALIAS.get(upper);
  if (RESOLVED_ALIASES.has(upper)) return RESOLVED_ALIASES.get(upper);
  // sans le préfixe d'exchange (ex. "FX:EURUSD" → "EURUSD")
  const noExchange = upper.includes(':') ? upper.slice(upper.indexOf(':') + 1) : upper;
  if (BY_ALIAS.has(noExchange)) return BY_ALIAS.get(noExchange);
  if (RESOLVED_ALIASES.has(noExchange)) return RESOLVED_ALIASES.get(noExchange);
  return null;
}

/** Nombre de décimales pour l'affichage d'un prix de ce marché. */
export function decimalsOf(market) {
  return market?.decimals ?? 2;
}

/**
 * Paramètres de risque « physiques » d'un marché (jamais réglables) à fusionner dans l'objet risk :
 * pip, taille de contrat, devise de cotation, coût aller-retour par défaut.
 * `quotePrice` : cours actuel, nécessaire pour convertir un marché coté en JPY.
 */
export function marketRisk(market, { quotePrice = null, spreadOverride = null, slippagePips = 0 } = {}) {
  const m = market || marketById(DEFAULT_MARKET);
  const spread = Number.isFinite(spreadOverride) ? spreadOverride : m.spreadPips || 0;
  return {
    pipSize: m.pip, contractSize: m.contractSize, quote: m.quote || 'USD',
    quotePrice: m.quote === 'JPY' && Number.isFinite(quotePrice) ? quotePrice : null,
    costPips: Math.max(0, spread + (Number(slippagePips) || 0)),
    marketId: m.id, corrGroup: m.corrGroup,
  };
}
