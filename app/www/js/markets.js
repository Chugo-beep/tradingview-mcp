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
function def({ id, label, notifLabel, tv, pip, pipValueUsdPerLot, calendarCountries, aliases = [] }) {
  return {
    id, label, notifLabel: notifLabel || label.toUpperCase(),
    tv, pip, decimals: decimalsOfPip(pip),
    // contractSize dérivé : pipValueUsdPerLot = pip × contractSize (formule de trades.js money()).
    contractSize: pipValueUsdPerLot / pip,
    pipValueUsdPerLot,
    calendarCountries,
    aliases: [...new Set([tv, tv.split(':').pop(), id, ...aliases].filter(Boolean))],
  };
}

/** Ordre d'affichage par défaut : XAUUSD en tête (marché historique de l'application). */
export const MARKETS = [
  def({ id: 'XAUUSD', label: 'Or (XAUUSD)', notifLabel: 'GOLD', tv: 'OANDA:XAUUSD', pip: 0.10, pipValueUsdPerLot: 10, calendarCountries: ['US'] }),
  def({ id: 'US30', label: 'US30', tv: 'OANDA:US30USD', pip: 1, pipValueUsdPerLot: 1, calendarCountries: ['US'], aliases: ['CAPITALCOM:US30', 'US30USD'] }),
  def({ id: 'SP500', label: 'S&P 500', tv: 'OANDA:SPX500USD', pip: 1, pipValueUsdPerLot: 1, calendarCountries: ['US'], aliases: ['SPX500', 'SPX500USD', 'CAPITALCOM:US500', 'SP500'] }),
  def({ id: 'NAS100', label: 'Nasdaq 100', tv: 'OANDA:NAS100USD', pip: 1, pipValueUsdPerLot: 1, calendarCountries: ['US'], aliases: ['NAS100USD', 'CAPITALCOM:US100', 'NASDAQ100'] }),
  def({ id: 'EURUSD', label: 'EUR/USD', tv: 'OANDA:EURUSD', pip: 0.0001, pipValueUsdPerLot: 10, calendarCountries: ['EU'], aliases: ['FX:EURUSD', 'FX_IDC:EURUSD'] }),
  def({ id: 'GBPUSD', label: 'GBP/USD', tv: 'OANDA:GBPUSD', pip: 0.0001, pipValueUsdPerLot: 10, calendarCountries: ['US'], aliases: ['FX:GBPUSD', 'FX_IDC:GBPUSD'] }),
  def({ id: 'USDJPY', label: 'USD/JPY', tv: 'OANDA:USDJPY', pip: 0.01, pipValueUsdPerLot: 10, calendarCountries: ['JP'], aliases: ['FX:USDJPY', 'FX_IDC:USDJPY'] }),
  def({ id: 'DAX40', label: 'DAX 40', tv: 'OANDA:DE30EUR', pip: 1, pipValueUsdPerLot: 1, calendarCountries: ['EU'], aliases: ['XETR:DAX', 'CAPITALCOM:DE40', 'DE30EUR', 'DE40EUR'] }),
  def({ id: 'CAC40', label: 'CAC 40', tv: 'OANDA:FR40EUR', pip: 1, pipValueUsdPerLot: 1, calendarCountries: ['EU'], aliases: ['EURONEXT:PX1', 'CAPITALCOM:FR40', 'FR40EUR'] }),
  def({ id: 'WTI', label: 'Pétrole WTI', tv: 'OANDA:WTICOUSD', pip: 0.01, pipValueUsdPerLot: 10, calendarCountries: ['US'], aliases: ['TVC:USOIL', 'WTICOUSD', 'NYMEX:CL1!'] }),
  def({ id: 'BRENT', label: 'Pétrole Brent', tv: 'OANDA:BCOUSD', pip: 0.01, pipValueUsdPerLot: 10, calendarCountries: ['US'], aliases: ['TVC:UKOIL', 'BCOUSD', 'ICEEUR:B1!'] }),
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

/** Abonnements TradingView → nombre de graphiques (1 par disposition) disponibles pour le compte de l'utilisateur. */
export const TV_PLANS = {
  gratuit: { label: 'Gratuit (Basic)', maxCharts: 1 },
  essential: { label: 'Essential', maxCharts: 2 },
  plus: { label: 'Plus', maxCharts: 4 },
  premium: { label: 'Premium', maxCharts: 8 },
  expert: { label: 'Expert', maxCharts: 10 },
  ultimate: { label: 'Ultimate', maxCharts: 16 },
};
export const DEFAULT_TV_PLAN = 'gratuit';
export function maxChartsFor(plan) {
  return TV_PLANS[plan]?.maxCharts ?? TV_PLANS[DEFAULT_TV_PLAN].maxCharts;
}

/** Réglage « Graphiques disponibles dans TradingView » (remplace l'ancien réglage par abonnement) :
 * nombre de marchés analysés EN DIRECT simultanément (panneaux dédiés). Défaut : 2 (compte
 * TradingView courant de l'utilisateur ⇒ 2 graphiques). */
export const LIVE_CHARTS_OPTIONS = [1, 2, 4, 8, 16];
export const DEFAULT_LIVE_CHARTS = 2;

/**
 * Fait correspondre un symbole TradingView (tel que renvoyé par un graphique) à un marché du
 * registre : correspondance exacte du symbole TradingView, puis alias connus (tolérant à la
 * casse et au prefix d'exchange), sinon `null`. Déterministe (pas de correspondance floue).
 */
export function marketOf(symbolString) {
  const s = String(symbolString || '').trim();
  if (!s) return null;
  const upper = s.toUpperCase();
  for (const m of MARKETS) if (m.tv.toUpperCase() === upper) return m;
  if (BY_ALIAS.has(upper)) return BY_ALIAS.get(upper);
  // sans le préfixe d'exchange (ex. "FX:EURUSD" → "EURUSD")
  const noExchange = upper.includes(':') ? upper.slice(upper.indexOf(':') + 1) : upper;
  if (BY_ALIAS.has(noExchange)) return BY_ALIAS.get(noExchange);
  return null;
}

/** Nombre de décimales pour l'affichage d'un prix de ce marché. */
export function decimalsOf(market) {
  return market?.decimals ?? 2;
}
