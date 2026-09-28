/**
 * Réglages : valeurs par défaut, chargement et migrations. Extrait d'app.js pour la
 * maintenabilité (aucun changement de comportement, sauf les migrations explicitement demandées :
 * mode d'objectifs par défaut 'atr', et minimum d'échantillons d'apprentissage par défaut 20).
 */
import { TIMEFRAMES, DEFAULT_OPTIONS } from './engine.js';
import { DEFAULT_RISK } from './trades.js';
import { MARKET_IDS, DEFAULT_MARKET, LIVE_CHARTS_OPTIONS, DEFAULT_LIVE_CHARTS, DEFAULT_LIVE_MARKETS, sanitizeLiveMarkets } from './markets.js';
import { remoteBase } from './providers.js';

export const SETTINGS_KEY = 'xauz.settings.v2';
/** Adresse Tailscale du PC, préréglée dans l'application (remplacée par www/provision.json à chaque compilation). */
export const DEFAULT_REMOTE_URL = 'https://joshua.taila406c5.ts.net/';

export const DEFAULT_SETTINGS = {
  remoteUrl: DEFAULT_REMOTE_URL, deviceName: 'Téléphone',
  liquidityLookback: DEFAULT_OPTIONS.liquidityLookback, fragileGapAtrRatio: DEFAULT_OPTIONS.fragileGapAtrRatio,
  liveSec: 15, timeframes: [...TIMEFRAMES], notify: true,
  // Défaut de l'application : mode d'objectifs adaptatif (R et ATR). Les comptes existants sont
  // migrés une seule fois vers ce défaut (loadSettings, drapeau risk.targetModeV).
  risk: { ...structuredClone(DEFAULT_RISK), targetMode: 'atr' },
  // Défaut de l'application : 20 échantillons minimum par règle apprise (les comptes existants
  // sont relevés une seule fois s'ils étaient réglés plus bas, cf. loadSettings).
  learning: { minSamples: 20, threshold: -0.15 },
  notifyNews: true, newsAlertMin: 30, // annonces économiques (US/EU/CN/JP, impact majeur)
  market: DEFAULT_MARKET, // marché affiché (graphique/liste) — indépendant des marchés en direct
  liveCharts: DEFAULT_LIVE_CHARTS, // (obsolète, conservé pour compatibilité) remplacé par liveMarkets
  liveMarkets: [...DEFAULT_LIVE_MARKETS], // marchés de l'analyse en direct CHOISIS par l'utilisateur (1 à 3, or par défaut)
};

/**
 * @param {(key: string, fallback: any) => any} load  lecteur générique de localStorage (cf. app.js)
 */
export function loadSettings(load) {
  const s = { ...DEFAULT_SETTINGS, ...load(SETTINGS_KEY, load('xauz.settings.v1', {})) };
  s.risk = { ...structuredClone(DEFAULT_RISK), ...(s.risk || {}) };
  delete s.risk.maxSlPips; // v4 : plus de stop maximal, le stop est l'invalidation de la zone
  delete s.risk.rr; delete s.risk.slBufferPips; delete s.risk.tp1MinPips; // v6 : SL et TP entièrement automatiques
  if (!s.risk.strategyV) { s.risk.entryMode = 'confirmation'; s.risk.strategyV = 5; } // migration « 5 étoiles »
  if (!s.allTfMigrated) { s.timeframes = [...TIMEFRAMES]; s.allTfMigrated = true; } // migration : toutes les TF (1/5/15/60/240/D) activées par défaut
  s.risk.minStars = 5; // seules les zones 5★ sont valides (moins de 5★ = invalidée) ; jamais réglable
  // migration : mode d'objectifs par défaut désormais 'atr' (adaptatif) — appliquée une seule fois
  if (!s.risk.targetModeV) { s.risk.targetMode = 'atr'; s.risk.targetModeV = 1; }
  s.risk.spreadOverrides ||= {};
  s.risk.brokerOffset ||= {};
  s.risk.sessions ||= [];
  if (s.risk.htfFilter == null) s.risk.htfFilter = true;
  s.learning = { ...DEFAULT_SETTINGS.learning, ...(s.learning || {}) };
  // migration : minimum d'échantillons relevé à 20 pour les comptes existants réglés plus bas — une seule fois
  if (!s.learning.minSamplesV20) { if (s.learning.minSamples < 20) s.learning.minSamples = 20; s.learning.minSamplesV20 = true; }
  if (s.notifyNews == null) s.notifyNews = true;
  if (![5, 15, 30, 60].includes(s.newsAlertMin)) s.newsAlertMin = 30;
  // minimisation des données : anciennes clés de fournisseurs supprimées
  for (const k of ['source', 'oandaToken', 'oandaEnv', 'twelveKey', 'pcUrl', 'pairCode']) delete s[k];
  s.risk.eurUsd = 'manual';
  if (!remoteBase(s.remoteUrl || '')) s.remoteUrl = DEFAULT_REMOTE_URL;
  delete s.count; // « Bougies par TF » supprimé : toutes les bougies chargées dans TradingView sont utilisées
  if (!MARKET_IDS.includes(s.market)) s.market = DEFAULT_MARKET;
  // migration : l'ancien réglage par abonnement TradingView (tvPlan) est remplacé par le nombre
  // direct de graphiques disponibles ; les réglages existants basculent sur le nouveau défaut (2).
  if (s.tvPlan && !s.liveChartsMigrated) { s.liveCharts = DEFAULT_LIVE_CHARTS; delete s.tvPlan; }
  s.liveChartsMigrated = true;
  if (!LIVE_CHARTS_OPTIONS.includes(s.liveCharts)) s.liveCharts = DEFAULT_LIVE_CHARTS;
  // v : les marchés en direct ne sont plus pris automatiquement en tête du classement de l'analyse
  // complète ; l'utilisateur les choisit (au plus 3). Migration : l'or seul, jusqu'à son choix.
  s.liveMarkets = sanitizeLiveMarkets(s.liveMarkets);
  return s;
}
