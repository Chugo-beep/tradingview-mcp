import { TIMEFRAMES, TF_LABEL, TF_SECONDS, STATUS_LABEL, CATEGORIES, normalizeCandles } from './engine.js';
import { fetchAll, fetchNews, hasLocalServer, isNativeApp, pair, unpair, isPaired, remoteBase, adminApi, scanApi, marketsApi, needsFullRefetch } from './providers.js';
import { nativePlugin } from './native.js';
import { CandleChart } from './chart.js';
import { runAgents, followZone, unfollowZone, setEntryLot, transitions } from './agents.js';
import { POS, POS_LABEL, MAX_SL_PIPS, MAX_SL_ATR, CATEGORY_DEFAULTS, balance, money, notifText } from './trades.js';
import { featureLabel, valueLabel } from './learning.js';
import { NEWS_COUNTRIES, COUNTRY_FLAG, interpretEvent, formatNewsValue } from './news.js';
import { MARKETS, MARKET_IDS, DEFAULT_MARKET, marketById, MAX_LIVE_MARKETS, sanitizeLiveMarkets, registerResolvedAlias, marketRisk } from './markets.js';
import { summarize } from './stats.js';
import { drawEquityCurve } from './equity.js';
import { SETTINGS_KEY, loadSettings as loadSettingsRaw } from './settings.js';
import { nf, fmtNum, fmtPips, fmtEur, fmtR, fmtT, clamp, dirFr, esc } from './format.js';

const $ = (s) => document.querySelector(s);
const K = {
  settings: SETTINGS_KEY, journal: 'xauz.journal.v1', learn: 'xauz.learn.v1', seen: 'xauz.seen.v2', watch: 'xauz.watch.v1', burned: 'xauz.pairing.burned.v1',
  news: 'xauz.news.v1', newsSeq: 'xauz.news.seq.v1', newsSeen: 'xauz.news.seen.v1',
  approach: 'xauz.approach.v1',
};
const DEMO = new URLSearchParams(location.search).has('demo');
const SESSIONS = ['Asie', 'Londres', 'New York', 'Clôture US'];

const load = (k, fb) => { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : fb; } catch { return fb; } };
const save = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* stockage indisponible */ } };

function loadSettings() { return loadSettingsRaw(load); }

const state = {
  settings: loadSettings(),
  journal: load(K.journal, { entries: [] }),
  learn: load(K.learn, { samples: {}, disabled: [] }),
  seen: new Set(load(K.seen, [])),
  watch: load(K.watch, {}),
  server: false,
  native: isNativeApp(),
  cal: null,
  data: null,
  out: null,
  news: load(K.news, []), // événements bruts du serveur (app/newsfeed.js), fusionnés par id
  newsSeq: load(K.newsSeq, 0),
  newsSeen: load(K.newsSeen, {}), // id -> { prealerted, resultNotified }
  newsFirstRun: true,
  chartTf: '5',
  cat: 'all',
  panel: 'positions',
  stateFilter: 'opp',
  dirFilter: 'all',
  scope: 'reel',
  selected: null,
  running: false,
  live: false,
  timer: null,
  newIds: new Set(),
  lastFull: null, // horodatage (ms) du dernier téléchargement complet (sans "since") d'une timeframe
  forceFull: false, // vrai : le prochain runOnce ignore "since" (historique TradingView agrandi, ou 30 min écoulées)
  scan: { running: false, status: null, ranking: null, history: [], timer: null }, // « analyse complète » (§ Marchés)
  histFilter: { market: 'all', cat: 'all', result: 'all' }, // filtres de l'historique de l'analyse complète
  histLimit: 50, // longueur affichée de l'historique de l'analyse complète (« Voir plus » l'étend par 50)
  liveState: {}, // par marché en direct : { data, out, lastFull, forceFull } — cf. computeLiveMarkets / runOnceFor
  liveMarkets: [], // marchés actuellement en direct (mis à jour à chaque cycle quand state.live)
  listLimit: 40, // longueur affichée de la liste de trades (« Voir plus » l'étend par 40)
  lastSuccessAt: null, // horodatage (ms) de la dernière analyse réussie (fraîcheur des données)
  dataStale: false, // vrai après notification « données obsolètes » (une seule notification jusqu'au retour)
  approachNotified: new Set(load(K.approach, [])), // ids de zones déjà notifiées « le prix approche »
};
state.learn.disabled ||= [];
// v4 : seules les zones que l'utilisateur a marquées « suivies » restent dans le journal réel
state.journal.entries = (state.journal.entries || []).filter((j) => j.followed);

const chart = new CandleChart($('#chart'), { onZoneClick: (id) => openDetail(id) });
/** Préconfiguration lue une fois dans provision.json (adresse du PC + code d'appairage éventuel). */
let provisionCache = null;

// ── démarrage ─────────────────────────────────────────────────────────────
async function init() {
  state.server = await hasLocalServer();
  save(K.settings, state.settings);
  try { state.cal = await (await fetch('data/calendar.json')).json(); } catch { state.cal = null; }
  loadResolvedMarkets(); // mapping marché → symbole résolu par la recherche TradingView (affichage correct)
  bindUi();
  setupNotifications();
  renderAll();
  setInterval(renderFreshness, 1000); // en-tête « Données : il y a … » + bascule hors ligne, à la seconde
  if (!DEMO) { fetchNewsOnce(); setInterval(fetchNewsOnce, 60000); } // au moins toutes les 60 s
  if (DEMO) { runOnce(); return; }
  if (!state.server) await applyProvision();
  const paired = state.server || (await isPaired());
  if (!state.server) await refreshPairingBanner();
  if (paired && !state.settings.risk.validated) {
    showBanner('Valide ton lot et ton stop loss, puis appuie sur « Suivre » pour chaque trade que tu prends.', 'info', 'Lot & stop', openRisk);
  }
  if (!DEMO && (state.server || paired)) {
    loadScanResult();
    scanApi.status(state.settings, { serverAvailable: state.server }).then((st) => {
      state.scan.status = st; state.scan.running = !!st.running;
      if (st.running) { setScanButtonsDisabled(true); pollScan(); }
    }).catch(() => {});
  }
}

/** Adresse du PC écrite dans l'APK à chaque compilation (installer-android) : elle prime sur l'adresse par défaut.
 * Peut aussi contenir un code d'appairage à usage unique préconfiguré (pairCode/expiresAt) : dans ce cas,
 * l'appairage est tenté automatiquement, sans saisie manuelle. */
async function applyProvision() {
  let pv = null;
  try { pv = await (await fetch('provision.json', { cache: 'no-store' })).json(); } catch { return; }
  provisionCache = pv;
  const url = pv?.remoteUrl ? remoteBase(pv.remoteUrl) : null;
  if (url && url !== state.settings.remoteUrl) { state.settings.remoteUrl = url; save(K.settings, state.settings); }
  await tryAutoPair(pv);
}

/** Code d'appairage préconfiguré valide et pas encore définitivement refusé par le serveur. */
function usablePairCode(pv) {
  const code = pv?.pairCode;
  if (!code || !/^\d{8}$/.test(code)) return null;
  if (pv.expiresAt && Date.now() > pv.expiresAt) return null;
  if (load(K.burned, []).includes(code)) return null;
  return code;
}

/** Tente l'appairage automatique avec le code préconfiguré dans l'APK.
 * Un échec réseau ne « grille » pas le code (nouvelle tentative au prochain lancement ou appui sur
 * « Analyser ») ; seule une réponse explicite du serveur (code déjà utilisé, invalide, expiré…) le fait. */
async function tryAutoPair(pv) {
  if (state.server || DEMO) return false;
  if (await isPaired()) return true;
  const code = usablePairCode(pv);
  if (!code) return false;
  try {
    const r = await pair(state.settings, code);
    save(K.settings, state.settings);
    toast('Téléphone appairé automatiquement au PC.');
    syncAnalyseButtonLabel();
    await refreshPairingBanner();
    refreshPairStatus();
    return true;
  } catch (e) {
    if (!/injoignable/i.test(e.message)) {
      // le serveur a répondu (code invalide/expiré/déjà utilisé) : inutile de réessayer ce code
      save(K.burned, [...new Set([...load(K.burned, []), code])].slice(-20));
    }
    return false;
  }
}

/** Hôte affiché dans le bandeau d'appairage (adresse du PC déjà validée). */
function pairingHost() {
  try { return new URL(remoteBase(state.settings.remoteUrl) || state.settings.remoteUrl).host; } catch { return ''; }
}

/** Bandeau d'état d'appairage du téléphone (jamais affiché côté PC). */
async function refreshPairingBanner() {
  if (state.server || DEMO) return;
  if (await isPaired()) showBanner(`✓ Téléphone appairé au PC · ${pairingHost()}`, 'ok');
  else showBanner('Téléphone non appairé.', 'error', 'Saisir le code', openPairing);
}

/** Remet le bouton « Analyser » dans son état normal (après un appairage réussi). */
function syncAnalyseButtonLabel() {
  if (state.live) return;
  const b = $('#analyseBtn');
  b.classList.remove('live', 'busy');
  b.setAttribute('aria-pressed', 'false');
  b.querySelector('.lbl').textContent = 'Analyser';
  b.title = 'Lancer l\'analyse en temps réel';
}

function bindUi() {
  $('#analyseBtn').onclick = toggleLive;
  $('#scanBtn').onclick = startFullScan;
  $('#scanBtnHeader').onclick = startFullScan;
  $('#settingsBtn').onclick = openSettings;
  $('#riskBtn').onclick = openRisk;
  $('#showBands').onchange = () => renderChart(true);
  $('#fitAllBtn').onclick = () => chart.fitAll();
  segment('#catTabs', (v) => { state.cat = v; ensureTfInCat(); renderAll(false); });
  segment('#panelTabs', (v) => { state.panel = v; for (const p of ['positions', 'markets', 'agents', 'learning', 'news', 'stats']) $(`#pane-${p}`).hidden = p !== v; if (v === 'news') renderNews(); if (v === 'markets') renderMarkets(); if (v === 'stats') renderStats(); });
  segment('#stateFilter', (v) => { state.stateFilter = v; state.listLimit = 40; renderPositions(); });
  segment('#dirFilter', (v) => { state.dirFilter = v; state.listLimit = 40; renderPositions(); });
  segment('#scopeSeg', (v) => { state.scope = v; state.listLimit = 40; renderBalance(); renderPositions(); });
  $('#exportCsvBtn').onclick = exportJournalCsv;
  populateHistoryFilters();
  $('#histMarket').onchange = (e) => { state.histFilter.market = e.target.value; state.histLimit = HIST_PAGE; renderHistory(); };
  $('#histCat').onchange = (e) => { state.histFilter.cat = e.target.value; state.histLimit = HIST_PAGE; renderHistory(); };
  $('#histResult').onchange = (e) => { state.histFilter.result = e.target.value; state.histLimit = HIST_PAGE; renderHistory(); };
  $('#histExportBtn').onclick = exportHistoryCsv;
  $('#chartMarketSelect').onchange = (e) => selectMarket(e.target.value);
  $('#gotoLiveMarketsBtn').onclick = gotoLiveMarketsPicker;
  $('#settingsForm').addEventListener('submit', onSettingsSubmit);
  $('#settingsForm').strategyMode.addEventListener('change', (e) => syncStrategyModeUi(e.target.value));
  $('#riskForm').addEventListener('submit', onRiskSubmit);
  $('#riskForm').addEventListener('input', riskPreview);
  bindAdmin(); bindPhone();
  $('#batteryBtn').onclick = async () => {
    const LK = nativePlugin('LiveKeeper');
    if (!LK) { toast('Réglage batterie indisponible sur ce téléphone.'); return; }
    try { await LK.requestBatteryExemption(); } catch { toast('Réglage batterie indisponible sur ce téléphone.'); }
  };
  $('#resetJournal').onclick = () => { if (confirmInline('#resetJournal')) { state.journal = { entries: [] }; save(K.journal, state.journal); renderAll(); toast('Journal effacé.'); } };
  $('#resetLearning').onclick = () => { if (confirmInline('#resetLearning')) { state.learn = { samples: {}, disabled: [], acceptedRules: [], config: null, configHistory: [], quarantine: { rules: {} } }; save(K.learn, state.learn); toast('Apprentissage réinitialisé.'); } };
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) return;
    refreshBatteryStatus();
    if (state.live) runOnce();
  });
}

/** Double appui pour confirmer (évite les boîtes de dialogue bloquantes). */
function confirmInline(sel) {
  const b = typeof sel === 'string' ? $(sel) : sel;
  if (b.dataset.armed) { delete b.dataset.armed; b.textContent = b.dataset.label; return true; }
  b.dataset.label = b.textContent; b.dataset.armed = '1'; b.textContent = 'Appuie encore pour confirmer';
  setTimeout(() => { if (b.dataset.armed) { delete b.dataset.armed; b.textContent = b.dataset.label; } }, 3000);
  return false;
}

function segment(sel, fn) {
  $(sel).addEventListener('click', (e) => {
    const b = e.target.closest('button'); if (!b) return;
    $(sel).querySelectorAll('button').forEach((x) => { x.classList.toggle('on', x === b); if (x.hasAttribute('aria-pressed')) x.setAttribute('aria-pressed', String(x === b)); });
    fn(b.dataset.v);
  });
}

// ── analyse temps réel ───────────────────────────────────────────────────
async function toggleLive() {
  if (!state.server && !DEMO && !(await isPaired())) {
    await tryAutoPair(provisionCache); // dernière chance : code réseau-indisponible plus tôt, PC peut-être joignable maintenant
    if (!(await isPaired())) {
      state.live = false;
      const b = $('#analyseBtn');
      b.classList.remove('live', 'busy');
      b.setAttribute('aria-pressed', 'false');
      b.querySelector('.lbl').textContent = 'Non connecté';
      b.title = 'Appaire d\'abord le téléphone';
      clearTimeout(state.timer);
      keepAlive(false);
      showBanner('Appaire d\'abord le téléphone.', 'error', 'Saisir le code', openPairing);
      toast('Appaire d\'abord le téléphone.');
      openPairing();
      return;
    }
  }
  state.live = !state.live;
  const b = $('#analyseBtn');
  b.classList.toggle('live', state.live);
  b.setAttribute('aria-pressed', String(state.live));
  b.querySelector('.lbl').textContent = state.live ? 'En direct' : 'Analyser';
  b.title = state.live ? 'Arrêter l\'analyse en temps réel' : 'Lancer l\'analyse en temps réel';
  clearTimeout(state.timer);
  keepAlive(state.live);
  if (!state.live) state.liveMarkets = [];
  if (state.live) runOnce();
}

function scheduleNext() {
  clearTimeout(state.timer);
  if (state.live) state.timer = setTimeout(runOnce, state.settings.liveSec * 1000);
}

/** Bougie la plus ancienne à redemander pour chaque TF activée (dernière bougie en cache − 2 bougies) ; null si le cache est incomplet ou qu'un retéléchargement complet est dû (première analyse, historique TradingView agrandi, ou 30 min écoulées) → tout retélécharger. Un slot par marché (voir runOnceFor) : les marchés en direct simultanés ont chacun leur propre cache/curseur, jamais partagé. */
function computeSinceFor(slot) {
  const prev = slot.data?.candles;
  if (!prev) return null;
  if (slot.forceFull) { slot.forceFull = false; return null; }
  let since = null;
  for (const tf of state.settings.timeframes) {
    const arr = prev[tf];
    if (!arr || !arr.length) return null;
    const s = arr.at(-1).time - 2 * TF_SECONDS[tf];
    if (since == null || s < since) since = s;
  }
  return since;
}

/** Fusionne les nouvelles bougies dans le cache : remplace les horodatages identiques, ajoute les nouveaux, garde le tri, sans doublon. */
function mergeCandles(oldArr, newArr) {
  if (!oldArr || !oldArr.length) return newArr;
  if (!newArr || !newArr.length) return oldArr;
  const byTime = new Map(oldArr.map((c) => [c.time, c]));
  for (const c of newArr) byTime.set(c.time, c);
  return [...byTime.values()].sort((a, b) => a.time - b.time);
}

/**
 * Analyse UN marché (glissant sur son propre curseur `since`/cache — `state.liveState[marketId]`)
 * et déclenche ses notifications. Ne touche pas au rendu : l'appelant (`runOnce`) recopie ensuite
 * le résultat du marché AFFICHÉ (`state.settings.market`) dans `state.data`/`state.out` pour que
 * tout le reste de l'UI (graphique, liste, détail…) continue de fonctionner sans changement.
 */
async function runOnceFor(marketId) {
  const s = { ...state.settings, market: marketId };
  const slot = state.liveState[marketId] || (state.liveState[marketId] = { data: null, out: null, lastFull: null, forceFull: true });
  const since = DEMO ? null : computeSinceFor(slot);
  const data = DEMO && state.server ? await import('./demo.js').then((m) => m.demoData(s)) : await fetchAll(s, { serverAvailable: state.server, since });
  const prevCandles = slot.data?.candles || {};
  const candles = {};
  for (const tf of s.timeframes) {
    if (data.errors?.[tf]) { candles[tf] = prevCandles[tf] || []; continue; } // erreur sur cette TF : on garde le cache
    const norm = normalizeCandles(data.candles?.[tf] || []);
    candles[tf] = since != null ? mergeCandles(prevCandles[tf], norm) : norm;
  }
  if (!DEMO) {
    const now = Date.now();
    if (since == null) slot.lastFull = now;
    for (const tf of s.timeframes) {
      const arr = candles[tf];
      const cacheInfo = arr?.length ? { count: arr.length, first: arr[0].time } : null;
      if (needsFullRefetch(cacheInfo, data.meta?.[tf], slot.lastFull, now)) { slot.forceFull = true; break; }
    }
  }
  slot.data = { ...data, candles };
  // journal (réel) et apprentissage sont partagés entre tous les marchés en direct (un seul compte) ;
  // seules les bougies/analyses sont propres à chaque marché.
  const out = runAgents({ data: slot.data, settings: s, cal: state.cal, learnStore: state.learn, journal: state.journal, newsEvents: state.news });
  slot.out = out;
  handleEvents(out);
  return { data: slot.data, out, errors: data.errors };
}

async function runOnce() {
  if (state.running) return;
  state.running = true;
  $('#analyseBtn').classList.add('busy');
  let last = null;
  state.newIds = new Set();
  try {
    const selected = state.settings.market;
    const liveIds = state.live ? computeLiveMarkets() : [];
    state.liveMarkets = liveIds;
    // le marché affiché est toujours analysé, même s'il n'est pas (encore) l'un des marchés en direct.
    const fetchIds = state.live ? [...new Set([...liveIds, selected])] : [selected];
    if (state.live && fetchIds.length) $('#updated').textContent = 'Vérification des marchés…'; // le graphique unique peut basculer avant la lecture
    for (const mid of fetchIds) last = await runOnceFor(mid);
    if (!DEMO) await fetchNewsOnce(); // au moins une fois par analyse (cadence ≤ 60 s)
    const sel = state.liveState[selected] || last;
    state.data = sel.data; state.out = sel.out;
    state.lastSuccessAt = Date.now();
    noteDataRecovered();
    save(K.journal, state.journal);
    save(K.learn, state.learn);
    const errs = Object.entries(sel.errors || sel.data?.errors || {});
    if (DEMO) showBanner('Mode démo : données simulées, uniquement pour tester l\'interface.', 'info');
    else if (!state.settings.risk.validated) showBanner('Valide ton lot et ton stop loss, puis appuie sur « Suivre » pour chaque trade que tu prends.', 'info', 'Lot & stop', openRisk);
    else if (sel.out.guards?.dailyBreaker) showBanner('Pause : 2 pertes aujourd\'hui, protection du capital.', 'info');
    else if (errs.length) showBanner(`Timeframes indisponibles : ${errs.map(([tf, m]) => `${TF_LABEL[tf]} (${m})`).join(' · ')}`, 'info');
    else if (!state.server) await refreshPairingBanner(); // remet le bandeau vert « appairé » après une analyse réussie
    else hideBanner();
  } catch (e) {
    showBanner(e.message, 'error', 'Réglages', openSettings);
  } finally {
    state.running = false;
    $('#analyseBtn').classList.remove('busy');
    renderAll(true);
    scheduleNext();
  }
}

/**
 * Notifications de trading, lisibles sans ouvrir l'application :
 *   nouvelle opportunité (entrée, TP1/TP2/TP3, SL), entrée déclenchée, TP1 → passer à BE,
 *   TP2 → stop sur TP1, TP3, clôture, SL, annulation.
 * Suivies : journal réel (précis à la minute). Opportunités notifiées non suivies : simulation de l'analyse.
 */
function handleEvents(out) {
  const notes = [];
  const firstRun = state.seen.size === 0;
  const followed = new Set(state.journal.entries.filter((j) => j.followed).map((j) => j.id));
  const tpl = (a, p = a.pos) => ({ dir: a.direction, category: a.category, ...a.plan, ...p, entry: a.plan.entry, sl: a.plan.sl, tp1: a.plan.tp1, tp2: a.plan.tp2, tp3: a.plan.tp3, grade: a.grade, zoneLow: a.zoneLow, zoneHigh: a.zoneHigh });
  const guards = out.guards;
  for (const a of out.audited) {
    const tfLabel = TF_LABEL[a.timeframe];
    if (a.proposal === 'PROPOSEE' && a.pos.state === POS.PENDING && !state.seen.has(a.id)) {
      state.seen.add(a.id); state.newIds.add(a.id);
      // préservation du compte (§B) : pas notifié « à prendre » si un garde-fou bloque, mais la zone reste visible
      const blocked = guards?.maxPositions || guards?.dailyBreaker || a.guardOverlap;
      if (!firstRun && !blocked) {
        const note = notifText('new', tpl(a), { tfLabel, reducedSize: guards?.reducedSize, market: out.market });
        // stratégie SMC (§5) : TP3 == TP2 (pas de 3e palier) → ne pas l'afficher dans la notification
        if (a.plan.strategy === 'smc' && note.body) note.body = note.body.replace(/\s*·\s*TP3[^·]*/, '');
        notes.push(note);
        state.watch[a.id] = { state: a.pos.state, hits: 0, beDone: false, trailFrom: null };
      }
    }
    // suivi des opportunités notifiées (non suivies) : TP1, BE, trailing…
    const w = state.watch[a.id];
    if (w && !followed.has(a.id)) {
      for (const type of transitions(w.state, w.hits, a.pos, w.beDone, w.trailFrom)) notes.push(notifText(type, tpl(a), { tfLabel, pips: a.pos.pips, market: out.market }));
      state.watch[a.id] = { state: a.pos.state, hits: a.pos.hits || 0, beDone: !!a.pos.beDone, trailFrom: a.pos.trailFrom ?? null };
      if (![POS.PENDING, POS.OPEN].includes(a.pos.state)) delete state.watch[a.id];
    }
    // approche de zone (§8) : le prix se rapproche de l'entrée (< 0,5 × ATR) sans y être encore entré
    if (a.proposal === 'PROPOSEE' && a.pos.state === POS.PENDING && !a.pos.inZone && a.atr != null && a.plan?.entry != null
      && out.currentPrice != null && !state.approachNotified.has(a.id) && Math.abs(out.currentPrice - a.plan.entry) <= 0.5 * a.atr) {
      state.approachNotified.add(a.id);
      const dec = out.market?.decimals ?? 2;
      notes.push({
        title: `👀 Le prix approche de la zone ${dirFr(a.direction, true)} ${out.market?.label || ''}`.trim(),
        body: `Entrée prévue ${a.plan.entry.toFixed(dec)} · ${tfLabel}`,
        detail: 'Zone proposée, pas encore atteinte.',
      });
    }
  }
  save(K.seen, [...state.seen].slice(-3000));
  const ids = Object.keys(state.watch); if (ids.length > 200) for (const id of ids.slice(0, ids.length - 200)) delete state.watch[id];
  save(K.watch, state.watch);
  save(K.approach, [...state.approachNotified].slice(-1000));
  for (const ev of state.journal.events || []) {
    if (ev.type === 'new') continue;
    const j = ev.entry;
    notes.push(notifText(ev.type, { ...j, dir: j.dir }, { tfLabel: TF_LABEL[j.timeframe], pips: j.pips, market: out.market }));
  }
  notes.slice(0, 4).forEach((n) => toast(`${n.title} — ${n.body}`));
  if (notes.length && state.settings.notify) notify(notes);
}

let notifId = Date.now() % 1000000;
async function notify(notes, channelId = 'xauz_signals') {
  try {
    const LN = nativePlugin('LocalNotifications');
    if (LN) {
      await LN.schedule({ notifications: notes.slice(0, 6).map((n) => ({
        id: ++notifId % 2147483647, title: n.title, body: n.body, largeBody: `${n.body}\n${n.detail || ''}`.trim(),
        summaryText: 'XAUUSD Zones', channelId,
      })) });
    } else if ('Notification' in window && Notification.permission === 'granted') {
      for (const n of notes.slice(0, 6)) new Notification(n.title, { body: `${n.body}\n${n.detail || ''}`.trim(), icon: 'icons/icon.svg', tag: `${n.title}` });
    }
  } catch { /* notifications indisponibles */ }
}

/** Canaux Android : « Signaux de trading » (priorité haute) et « Annonces économiques » (importance normale). */
async function setupNotifications() {
  const LN = nativePlugin('LocalNotifications');
  if (!LN) return;
  try {
    await LN.createChannel({ id: 'xauz_signals', name: 'Signaux de trading', description: 'Opportunités, TP, BE, SL', importance: 5, visibility: 1, vibration: true });
    await LN.createChannel({ id: 'xauz_news', name: 'Annonces économiques', description: 'Alertes avant annonce et résultats (US/EU/CN/JP, impact majeur)', importance: 4, visibility: 1, vibration: true });
    if (state.settings.notify || state.settings.notifyNews) await LN.requestPermissions();
  } catch { /* */ }
}

// ── annonces économiques (US/EU/CN/JP, impact majeur) ─────────────────────
/** Récupère les nouveaux/modifiés événements depuis le serveur (fusion par id), puis notifie. */
async function fetchNewsOnce() {
  try {
    const r = await fetchNews(state.settings, { serverAvailable: state.server, since: state.newsSeq });
    if (r.events.length) {
      const byId = new Map(state.news.map((e) => [e.id, e]));
      for (const e of r.events) byId.set(e.id, e);
      state.news = [...byId.values()];
      save(K.news, state.news);
    }
    if (r.seq != null) { state.newsSeq = r.seq; save(K.newsSeq, state.newsSeq); }
  } catch { /* silencieux : le calendrier embarqué reste disponible */ }
  processNewsNotifications();
  if (state.panel === 'news') renderNews();
  renderNewsCountdown();
}

/** Prochaine annonce majeure suivie (US/EU/CN/JP), ou `null`. */
function nextNewsEvent(now = Date.now() / 1000) {
  return state.news.filter((e) => e.t >= now).sort((a, b) => a.t - b.t)[0] || null;
}

const fmtCountdown = (sec) => {
  if (sec <= 0) return 'maintenant';
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60);
  return h > 0 ? `${h} h ${m} min` : `${m} min`;
};

function renderNewsCountdown() {
  const el = $('#nextNews');
  if (!el) return;
  const nx = nextNewsEvent();
  if (!nx) { el.textContent = ''; el.hidden = true; return; }
  el.hidden = false;
  el.textContent = `Prochaine annonce : ${COUNTRY_FLAG[nx.country] || ''} ${nx.title} dans ${fmtCountdown(Math.round(nx.t - Date.now() / 1000))}`;
}

/** Pré-alerte (N min avant) et notification de résultat (dès que `actual` est publié), 5 max par appel. */
function processNewsNotifications() {
  const now = Date.now() / 1000;
  const notes = [];
  const firstRun = state.newsFirstRun;
  state.newsFirstRun = false;
  for (const ev of [...state.news].sort((a, b) => a.t - b.t)) {
    const seen = state.newsSeen[ev.id] || {};
    const flag = COUNTRY_FLAG[ev.country] || '';
    // évite l'inondation de notifications au premier lancement pour des annonces déjà anciennes
    if (firstRun && now - ev.t > 2 * 3600) { state.newsSeen[ev.id] = { prealerted: true, resultNotified: ev.actual != null }; continue; }
    if (!seen.prealerted && ev.t > now && ev.t - now <= state.settings.newsAlertMin * 60) {
      const hhmm = new Date(ev.t * 1000).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
      const body = `Consensus ${formatNewsValue(ev.forecast, ev.unit, ev.scale) ?? '—'} · Précédent ${formatNewsValue(ev.previous, ev.unit, ev.scale) ?? '—'}`;
      notes.push({ title: `⚠️ ${hhmm} · ${flag} ${ev.title} · impact majeur`, body });
      state.newsSeen[ev.id] = { ...seen, prealerted: true };
    }
    if (!seen.resultNotified && ev.actual != null) {
      const it = interpretEvent(ev);
      const parts = [it.comparisonText, it.tendency, it.indirectNote, ev.previous != null ? `précédent ${formatNewsValue(ev.previous, ev.unit, ev.scale)}` : null].filter(Boolean);
      notes.push({ title: `📊 ${flag} ${ev.title} : ${formatNewsValue(ev.actual, ev.unit, ev.scale)} (consensus ${formatNewsValue(ev.forecast, ev.unit, ev.scale) ?? '—'})`, body: parts.join(' · ') });
      state.newsSeen[ev.id] = { ...seen, resultNotified: true };
    }
  }
  save(K.newsSeen, state.newsSeen);
  if (notes.length) {
    notes.slice(0, 5).forEach((n) => toast(`${n.title} — ${n.body}`));
    if (state.settings.notifyNews) notify(notes.slice(0, 5), 'xauz_news');
  }
}

/** Onglet « Annonces » : à venir (7 jours) et résultats récents (24 h). */
function renderNews() {
  const el = $('#newsBody');
  if (!el) return;
  const now = Date.now() / 1000;
  const upcoming = state.news.filter((e) => e.t >= now).sort((a, b) => a.t - b.t);
  const recent = state.news.filter((e) => e.t < now && e.t >= now - 86400).sort((a, b) => b.t - a.t);
  $('#cntNews').textContent = upcoming.length ? String(upcoming.length) : '';
  const row = (e) => {
    const it = interpretEvent(e);
    const flag = COUNTRY_FLAG[e.country] || '';
    const when = new Date(e.t * 1000).toLocaleString('fr-FR', { weekday: 'short', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
    const vals = `Consensus ${formatNewsValue(e.forecast, e.unit, e.scale) ?? '—'} · Précédent ${formatNewsValue(e.previous, e.unit, e.scale) ?? '—'}${e.actual != null ? ` · Actuel ${formatNewsValue(e.actual, e.unit, e.scale)}` : ''}`;
    const tendency = [it.comparisonText, it.tendency, it.indirectNote].filter(Boolean).join(' · ');
    return `<article class="agent"><div class="agent-head"><span class="num-i">${flag}</span><div><b>${esc(e.title)}</b><small>${esc(when)}</small></div></div><ul><li>${esc(vals)}</li>${tendency ? `<li>${esc(tendency)}</li>` : ''}</ul></article>`;
  };
  if (!upcoming.length && !recent.length) { el.innerHTML = '<div class="empty">Aucune annonce majeure (US/EU/CN/JP) dans la fenêtre suivie.</div>'; return; }
  el.innerHTML = `${upcoming.length ? `<h3>À venir</h3>${upcoming.slice(0, 30).map(row).join('')}` : ''}${recent.length ? `<h3>Résultats récents</h3>${recent.slice(0, 20).map(row).join('')}` : ''}`;
}

/** Android : garde l'analyse en direct active en arrière-plan / écran éteint ; affiche le témoin visuel. */
async function keepAlive(on) {
  const LK = nativePlugin('LiveKeeper');
  const chip = $('#bgChip');
  if (chip) chip.hidden = !(on && LK);
  if (!LK) return;
  try { if (on) await LK.start({ text: 'Analyse XAUUSD en direct · notifications actives' }); else await LK.stop(); } catch { /* */ }
  refreshBatteryStatus();
}

/** Statut de l'exemption d'optimisation batterie (rafraîchi aussi au retour au premier plan). */
async function refreshBatteryStatus() {
  const LK = nativePlugin('LiveKeeper');
  const el = $('#bgStatus');
  if (!LK || !el) return;
  try {
    const st = await LK.status();
    el.textContent = st.batteryExempt ? 'Optimisation batterie désactivée ✓' : 'Non autorisée : appuie sur le bouton ci-dessus.';
    el.classList.toggle('g', !!st.batteryExempt);
  } catch { /* indisponible */ }
}

// ── analyse complète (« Marchés ») ─────────────────────────────────────────
/** Bouton du panneau « Marchés » ET bouton d'en-tête (desktop) : toujours synchronisés. */
function setScanButtonsDisabled(v) { for (const id of ['#scanBtn', '#scanBtnHeader']) { const b = $(id); if (b) b.disabled = v; } }

/** Démarre le scan de tous les marchés (PC : route locale ; téléphone : route distante du PC). */
async function startFullScan() {
  try {
    await scanApi.start(state.settings, { serverAvailable: state.server });
    toast('Analyse complète démarrée : tous les marchés, 6 timeframes chacun. Cela prend plusieurs minutes.');
  } catch (e) {
    if (/cours|429/i.test(e.message)) toast('Une analyse complète est déjà en cours (ou vient d\'être lancée).');
    else toast(e.message);
    return;
  }
  state.scan.running = true;
  setScanButtonsDisabled(true);
  pollScan();
}

function pollScan() {
  clearTimeout(state.scan.timer);
  state.scan.timer = setTimeout(async () => {
    try {
      const st = await scanApi.status(state.settings, { serverAvailable: state.server });
      state.scan.status = st;
      state.scan.running = !!st.running;
      renderScanProgress();
      if (st.running) { pollScan(); return; }
      await loadScanResult();
    } catch { /* réseau indisponible : abandonne ce suivi, le bouton reste réactivable */ }
    setScanButtonsDisabled(false);
  }, 2000);
}

/** Symboles résolus par la recherche TradingView Desktop (un seul graphique, jamais plusieurs) : recopiés
 * dans le registre local pour que le libellé affiché reste correct pour ce compte. */
async function loadResolvedMarkets() {
  if (DEMO) return;
  try {
    const j = await marketsApi.get(state.settings, { serverAvailable: state.server });
    for (const [id, entry] of Object.entries(j.symbols || {})) if (entry?.symbol) registerResolvedAlias(id, entry.symbol);
  } catch { /* pas encore résolu, ou hors ligne : le registre statique suffit dans l'intervalle */ }
}

/** Classement persisté par le serveur (DATA_DIR/scan.json), ou `null` si aucun scan n'a encore terminé. */
async function loadScanResult() {
  try {
    const res = await scanApi.result(state.settings, { serverAvailable: state.server });
    state.scan.ranking = res.ranking || null;
    state.scan.policyStats = res.policyStats || null;
    state.scan.history = res.history || [];
    state.histLimit = 50;
    // règle d'annulation prouvée par le backtest (champion/challenger) : appliquée à l'analyse en direct
    const pol = {};
    for (const cat of ['scalp', 'day', 'swing']) pol[cat] = res.policy?.[cat] === 'keep' ? 'keep' : 'tp1';
    if (res.policy) { state.settings.risk.cancelPolicyByCat = pol; save(K.settings, state.settings); }
  } catch { /* aucun résultat pour le moment */ }
  if (state.panel === 'markets') renderMarkets();
}

function renderScanProgress() {
  const el = $('#scanProgress');
  if (!el) return;
  const st = state.scan.status;
  if (!st?.running) { el.textContent = state.scan.ranking ? `Dernière analyse complète terminée.` : ''; return; }
  const pct = st.total ? Math.round((st.done / st.total) * 100) : 0;
  el.innerHTML = `${st.done}/${st.total} · ${esc(st.current?.marketLabel || '')} · ${esc(TF_LABEL[st.current?.tf] || '')}<span class="scan-bar"><i></i></span>`;
  const bar = el.querySelector('.scan-bar i'); if (bar) bar.style.width = `${pct}%`; // CSSOM : autorisé par la CSP
}

/** Marché choisi pour l'AFFICHAGE (graphique/liste) — indépendant des marchés en direct (voir computeLiveMarkets).
 * Hors analyse en direct, si aucune donnée n'existe encore pour ce marché, lance immédiatement une
 * analyse ponctuelle (au lieu de laisser « Aucune donnée ») ; le graphique affiche « Chargement… » entre-temps. */
function selectMarket(id) {
  if (!MARKET_IDS.includes(id) || id === state.settings.market) return;
  state.settings.market = id;
  save(K.settings, state.settings);
  const ls = state.liveState[id];
  state.data = ls?.data || null; state.out = ls?.out || null;
  renderMarkets();
  toast(`Marché affiché : ${marketById(id).label}.`);
  if (state.live) { runOnce(); return; }
  if (!ls?.data) {
    chart.emptyText = `Chargement de ${marketById(id).label}…`;
    renderAll(true);
    runOnce().finally(() => { chart.emptyText = 'Aucune donnée'; });
  } else {
    renderAll(true);
  }
}

/**
 * Marchés analysés EN DIRECT simultanément : CHOISIS par l'utilisateur (jamais imposés par le
 * classement de l'analyse complète, cf. markets.js), 1 à MAX_LIVE_MARKETS (3), l'or par défaut.
 * Ils se relaient sur l'unique graphique TradingView Desktop.
 */
function computeLiveMarkets() {
  return sanitizeLiveMarkets(state.settings.liveMarkets);
}

/** Bascule un marché dans/hors la sélection « en direct » (action utilisateur uniquement) : au
 * moins 1, au plus MAX_LIVE_MARKETS. Sauvegarde immédiatement ; en direct, le prochain cycle
 * (au plus `state.settings.liveSec` secondes) utilise la nouvelle sélection. */
function toggleLiveMarket(id) {
  if (!MARKET_IDS.includes(id)) return;
  const cur = sanitizeLiveMarkets(state.settings.liveMarkets);
  if (cur.includes(id)) {
    if (cur.length <= 1) { toast('Au moins un marché doit rester en direct.'); return; }
    state.settings.liveMarkets = cur.filter((x) => x !== id);
  } else {
    if (cur.length >= MAX_LIVE_MARKETS) { toast('3 marchés maximum en direct : retire d\'abord un marché.'); return; }
    state.settings.liveMarkets = [...cur, id];
  }
  state.settings.liveMarkets = sanitizeLiveMarkets(state.settings.liveMarkets);
  save(K.settings, state.settings);
  renderMarkets();
  renderHeader();
}

/** Chips à cocher (max MAX_LIVE_MARKETS, min 1) de l'onglet « Marchés » : choix des marchés en direct. */
function renderLiveMarketsPicker() {
  const el = $('#liveMarketChips');
  if (!el) return;
  const live = sanitizeLiveMarkets(state.settings.liveMarkets);
  el.innerHTML = MARKETS.map((m) => {
    const on = live.includes(m.id);
    return `<button type="button" class="chip select ${on ? 'on' : ''}" data-live="${m.id}" aria-pressed="${on}">${on ? '✓ ' : ''}${esc(m.label)}</button>`;
  }).join('');
  el.querySelectorAll('[data-live]').forEach((b) => (b.onclick = () => toggleLiveMarket(b.dataset.live)));
  const cnt = $('#liveMarketsCount');
  if (cnt) cnt.textContent = `${live.length} / ${MAX_LIVE_MARKETS} sélectionné(s)`;
}

/** Ferme les réglages et ouvre l'onglet « Marchés » sur le sélecteur de marchés en direct
 * (remplace l'ancien réglage « liveCharts », devenu obsolète, cf. markets.js). */
function gotoLiveMarketsPicker() {
  $('#settingsDialog').close();
  $('#panelTabs').querySelectorAll('button').forEach((b) => { const on = b.dataset.v === 'markets'; b.classList.toggle('on', on); b.setAttribute('aria-pressed', String(on)); });
  state.panel = 'markets';
  for (const p of ['positions', 'markets', 'agents', 'learning', 'news', 'stats']) $(`#pane-${p}`).hidden = p !== 'markets';
  renderMarkets();
  $('#liveMarketsPicker')?.scrollIntoView({ block: 'nearest' });
}

/** Onglet « Marchés » : progression du scan, classement, et chips de sélection du marché affiché. */
/** Bloc KPI d'un résumé stats.js (§6) : n, réussite, espérance ± IC 90 %, facteur de profit,
 * drawdown max, plus longue série de pertes, verdict ; le test contre le hasard n'est affiché
 * que pour la performance de la stratégie (backtest), jamais pour le journal réel. */
function statsKpis(title, s, randomLabel) {
  return `<div class="stats-block">
    <h3>${esc(title)}</h3>
    <div class="kpis stats-kpis">
      <div class="kpi"><span>Trades</span><b>${s.n}</b><small>${s.winRate != null ? Math.round(s.winRate * 100) + ' % réussite' : '—'}</small></div>
      <div class="kpi"><span>Espérance</span><b>${fmtR(s.meanR)}</b><small>${s.ciR ? `IC 90 % ${fmtR(s.ciR[0])} à ${fmtR(s.ciR[1])}` : '—'}</small></div>
      <div class="kpi"><span>Facteur de profit</span><b>${fmtNum(s.profitFactor, 2)}</b><small>drawdown max ${fmtR(-(s.maxDrawdownR || 0))}</small></div>
      <div class="kpi"><span>Plus longue série de pertes</span><b>${s.maxLosingStreak ?? 0}</b><small>${s.n} trade(s) au total</small></div>
    </div>
    <p class="hint mt0">${esc(s.verdict?.label || '')}${randomLabel ? ` · ${esc(randomLabel)}` : ''}</p>
  </div>`;
}

/** Onglet « Stats » (§6) : performance de la stratégie (backtest) et du journal réel suivi, courbe de capital. */
function renderStats() {
  const el = $('#statsBody');
  if (!el) return;
  const perf = state.out?.model?.performance;
  const journalTrades = state.journal.entries
    .filter((j) => j.followed && (j.state === POS.TP || j.state === POS.SL) && Number.isFinite(j.r))
    .map((j) => ({ r: j.r, pips: j.pips, t: j.exitTime }));
  const journalStats = summarize(journalTrades);
  if (!perf && !journalStats.n) {
    el.innerHTML = '<div class="empty">La performance apparaît après quelques trades clôturés (backtest ou réels).</div>';
    return;
  }
  el.innerHTML = `
    <p class="hint mt0"><b>Moins de 30 trades : les chiffres ne prouvent rien.</b></p>
    ${perf ? statsKpis('Stratégie (backtest, zones éligibles, coûts déduits)', perf.stats, perf.randomLabel) : '<div class="empty small">Pas encore de backtest.</div>'}
    ${journalStats.n ? statsKpis('Ton journal réel (trades suivis)', journalStats) : '<div class="empty small">Aucun trade suivi clôturé pour le moment.</div>'}
    <h3>Courbe de capital (R cumulés)</h3>
    <div class="equity-wrap"><canvas id="equityCanvas"></canvas></div>
  `;
  const curve = journalStats.n >= 2 ? journalStats.curve : (perf?.stats?.curve || []);
  const canvas = $('#equityCanvas');
  if (canvas) drawEquityCurve(canvas, curve);
}

function renderMarkets() {
  const liveIds = computeLiveMarkets();
  const hint = $('#scanHint');
  if (hint) hint.textContent = `Analyse tous les marchés suivis (${MARKETS.length}) sur les ${TIMEFRAMES.length} timeframes, puis les classe par solidité statistique (espérance en R et sa marge d'incertitude, coûts déduits). Un seul graphique TradingView existe : chaque marché y est sélectionné (barre de recherche) le temps de sa lecture. Durée : plusieurs minutes. Ce classement est uniquement informatif : il ne choisit jamais les marchés analysés en direct, c'est toi qui les choisis ci-dessous.`;
  renderScanProgress();
  renderLiveMarketsPicker();
  const ranking = state.scan.ranking;
  const chips = $('#marketChips');
  if (chips) {
    chips.innerHTML = MARKETS.map((m) => {
      const live = liveIds.includes(m.id);
      return `<button type="button" class="chip select ${m.id === state.settings.market ? 'on' : ''}" data-market="${m.id}">${esc(m.label)}${live ? '<span class="live">● en direct</span>' : ''}</button>`;
    }).join('');
    chips.querySelectorAll('[data-market]').forEach((b) => (b.onclick = () => selectMarket(b.dataset.market)));
  }
  renderChartMarketSelect();
  const body = $('#marketsBody');
  if (body) {
    $('#cntMarkets').textContent = ranking ? String(ranking.length) : '';
    if (!ranking) { body.innerHTML = '<div class="empty">Aucune analyse complète pour le moment. Appuie sur « Analyse complète ».</div>'; }
    else {
      const pol = state.settings.risk.cancelPolicyByCat;
      const polTxt = (p) => (p === 'keep' ? 'zone gardée jusqu\'à son 1er retour' : 'annulée si TP1 atteint sans entrée');
      const policyHtml = pol ? `<div class="rr-policy">Règle d'annulation retenue par le backtest — Scalp : ${polTxt(pol.scalp)} · Intraday : ${polTxt(pol.day)} · Swing : ${polTxt(pol.swing)}</div>` : '';
      body.innerHTML = policyHtml + `<p class="hint mt0">Les pips ne sont pas comparables d'un marché à l'autre (taille de contrat différente) : seule l'espérance en R permet de comparer les marchés entre eux.</p>` + ranking.map((r, i) => {
        const live = liveIds.includes(r.market);
        return `
    <div class="rank-row ${r.insufficient ? 'insufficient' : ''}">
      <div class="rr-head"><span class="rk">#${i + 1}</span><span class="lbl">${esc(r.label)}${live ? ' · en direct' : ''}</span><button type="button" class="btn small live-toggle-btn ${live ? 'on' : ''}" data-live-toggle="${r.market}">${live ? '✓ En direct' : '+ Direct'}</button></div>
      <div class="rr-stats">
        <span><b>${fmtR(r.expectancyR)}</b>${r.ciR ? ` <small>(IC 90 % ${fmtR(r.ciR[0])} à ${fmtR(r.ciR[1])})</small>` : ''}</span>
        <span>${r.trades} trade(s)</span>
        <span>${r.winRate != null ? Math.round(r.winRate * 100) + ' % réussite' : '—'}</span>
        <span>facteur de profit ${fmtNum(r.profitFactor, 2)}</span>
        <span>${fmtPips(r.pips)} <small>(coût ${fmtNum(r.costPips, 1)} pips utilisé)</small></span>
        ${r.proposals ? `<span>${r.proposals} opportunité(s)${r.funnel?.strategy === 'smc' ? '' : ' 5★'}</span>` : ''}
      </div>
      <div class="rr-verdict">${esc(r.verdict?.label || '')}${r.randomLabel ? ` · ${esc(r.randomLabel)}` : ''}</div>
      ${r.funnel ? (r.funnel.strategy === 'smc'
        ? `<div class="rr-funnel">POI HTF ${r.funnel.pois} · atteints ${r.funnel.touched} · biais ok ${r.funnel.biasOk} · Fibo ok ${r.funnel.fibOk} · CHoCH ${r.funnel.choch} · micro-zones ${r.funnel.micro} · R:R ≥ 1:3 ${r.funnel.rrOk} (rejetés ${r.funnel.rejectedRR})</div>`
        : `<div class="rr-funnel">${r.funnel.zones} zones détectées · ${r.funnel.untouched} encore vierges · ${r.funnel.untouched5} proposable(s) en 5★ (étoiles manquantes parmi les vierges : tendance ${r.funnel.missTrend}, liquidité ${r.funnel.missLiquidity}, Fibonacci ${r.funnel.missFib}) · SL &gt; 100 pips ${r.funnel.slTooWide}</div>`) : ''}
    </div>`;
      }).join('');
      body.querySelectorAll('[data-live-toggle]').forEach((b) => (b.onclick = () => toggleLiveMarket(b.dataset.liveToggle)));
    }
  }
  renderHistory();
}

/** Sélecteur de marché du graphique (toolbar) : les 11 marchés, celui en cours de sélection
 * marqué, les marchés en direct repérés par « ● ». Change le marché AFFICHÉ (indépendant des
 * marchés en direct, cf. computeLiveMarkets) via selectMarket. */
function renderChartMarketSelect() {
  const sel = $('#chartMarketSelect');
  if (!sel) return;
  const liveIds = state.live ? state.liveMarkets : [];
  sel.innerHTML = MARKETS.map((m) => `<option value="${m.id}" ${m.id === state.settings.market ? 'selected' : ''}>${liveIds.includes(m.id) ? '● ' : ''}${esc(m.label)}</option>`).join('');
}

// ── historique de l'analyse complète (§ Marchés) ───────────────────────────
const HIST_PAGE = 50;
const CAT_LABEL_BY_KEY = { scalp: 'Scalp', day: 'Daily', swing: 'Swing' };

/** Options du filtre « marché » de l'historique (une fois, au démarrage). */
function populateHistoryFilters() {
  const sel = $('#histMarket');
  if (!sel) return;
  sel.innerHTML = '<option value="all">Tous les marchés</option>' + MARKETS.map((m) => `<option value="${m.id}">${esc(m.label)}</option>`).join('');
}

/** Trades de l'historique de l'analyse complète (state.scan.history) filtrés (marché/catégorie/résultat). */
function filteredHistory() {
  const h = state.scan.history || [];
  const f = state.histFilter;
  return h.filter((x) => (f.market === 'all' || x.market === f.market)
    && (f.cat === 'all' || x.cat === f.cat)
    && (f.result === 'all' || (f.result === 'win' ? x.pips > 0 : x.pips <= 0)));
}

/** Résumé du filtre courant : n trades, taux de réussite, somme des R (les pips ne sont pas
 * comparables d'un marché à l'autre, cf. §6 : seule la somme des R est affichée pour le total). */
function histSummaryLine(list) {
  if (!list.length) return '';
  const n = list.length;
  const wins = list.filter((x) => x.pips > 0).length;
  const sumR = list.reduce((s, x) => s + (x.r || 0), 0);
  return `${n} trade(s) · ${Math.round((wins / n) * 100)} % réussite · ${fmtR(sumR)} au total`;
}

function histRow(x) {
  const m = marketById(x.market);
  const dec = m?.decimals ?? 2;
  return `<div class="hist-row">
    <div class="hist-row-l1"><span class="hist-date">${fmtT(x.t)}</span><span>${esc(m?.label || x.market)}</span><span class="cat cat-${x.cat === 'scalp' ? 'scalping' : x.cat}">${esc(CAT_LABEL_BY_KEY[x.cat] || x.cat)} · ${TF_LABEL[x.tf] || x.tf}</span>${dirTag(x.dir)}</div>
    <div class="hist-row-l2 num"><span>${fmtP(x.fillPrice, dec)} → ${fmtP(x.exitPrice, dec)}</span><small class="hist-kind">${esc(x.exitKind || '')}</small></div>
    <div class="hist-row-l3 num"><b class="${x.pips >= 0 ? 'g' : 'r'}">${fmtPips(x.pips)}</b><span>${fmtR(x.r)}</span></div>
  </div>`;
}

function renderHistory() {
  const body = $('#histBody');
  if (!body) return;
  const all = state.scan.history || [];
  const list = filteredHistory();
  const summary = $('#histSummary');
  if (summary) summary.textContent = histSummaryLine(list);
  if (!all.length) { body.innerHTML = '<div class="empty">Lance une analyse complète pour remplir l\'historique.</div>'; return; }
  if (!list.length) { body.innerHTML = '<div class="empty">Aucun trade pour ce filtre.</div>'; return; }
  const limit = state.histLimit || HIST_PAGE;
  const shown = list.slice(0, limit);
  const more = list.length - shown.length;
  body.innerHTML = shown.map(histRow).join('') + (more > 0 ? `<button type="button" class="btn small more-btn" id="histMoreBtn">Voir plus (${more})</button>` : '');
  const moreBtn = $('#histMoreBtn');
  if (moreBtn) moreBtn.onclick = () => { state.histLimit = limit + HIST_PAGE; renderHistory(); };
}

/** Export CSV (Blob + lien temporaire, comme le journal, §9) de l'historique FILTRÉ de l'analyse complète. */
function exportHistoryCsv() {
  const rows = filteredHistory();
  if (!rows.length) { toast('Aucun trade à exporter.'); return; }
  const headers = ['marché', 'catégorie', 'UT', 'sens', 'entrée', 'sortie', 'résultat', 'pips nets', 'R', 'sortie (ISO)'];
  const csvEsc = (v) => { const s = String(v ?? ''); return /[",;\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  const lines = [headers.map(csvEsc).join(';')];
  for (const x of rows) {
    const m = marketById(x.market);
    lines.push([
      m?.label || x.market, CAT_LABEL_BY_KEY[x.cat] || x.cat, TF_LABEL[x.tf] || x.tf, x.dir,
      x.fillPrice ?? '', x.exitPrice ?? '', x.exitKind || '', x.pips ?? '', x.r ?? '',
      x.t ? new Date(x.t * 1000).toISOString() : '',
    ].map(csvEsc).join(';'));
  }
  const blob = new Blob(['﻿' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = `xauz-historique-${new Date().toISOString().slice(0, 10)}.csv`;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
  toast(`Export CSV : ${rows.length} trade(s).`);
}

// ── modèle de vue ────────────────────────────────────────────────────────
const inCat = (tf) => state.cat === 'all' || CATEGORIES[state.cat].tfs.includes(tf);
const visibleTfs = () => TIMEFRAMES.filter((tf) => state.settings.timeframes.includes(tf) && inCat(tf));
function ensureTfInCat() { const v = visibleTfs(); if (!v.includes(state.chartTf)) state.chartTf = v[0] || state.chartTf; }

function eurUsdRate() {
  const r = state.settings.risk;
  return r.eurUsdManual;
}
function eurOf(pips, lot) { return pips == null ? null : money(pips, state.out?.risk || state.settings.risk, eurUsdRate(), lot).eur; }

/** Zones affichées : celles que tu suis (journal réel) + toutes les zones auditées (simulées). */
function items() {
  const audited = state.out?.audited || [];
  const byId = new Map(audited.map((a) => [a.id, a]));
  const followedIds = new Set();
  const list = [];
  for (const j of state.journal.entries) {
    if (!j.followed) continue;
    followedIds.add(j.id);
    list.push({ ...common(byId.get(j.id), j), pos: j, real: true, followed: true });
  }
  for (const a of audited) if (!followedIds.has(a.id)) list.push({ ...common(a, null), pos: a.pos, real: false, followed: false });
  return list.filter((x) => inCat(x.timeframe));
}

function common(a, j) {
  const plan = j ? {
    entry: j.entry, sl: j.sl, tp1: j.tp1 ?? j.tp, tp2: j.tp2 ?? j.tp, tp3: j.tp3 ?? j.tp, tp: j.tp3 ?? j.tp,
    rr: j.rr, rr2: j.tp2Pips && j.slPips ? j.tp2Pips / j.slPips : null, rr3: j.tp3Pips && j.slPips ? j.tp3Pips / j.slPips : null,
    slPips: j.slPips, tp1Pips: j.tp1Pips, tp2Pips: j.tp2Pips, tp3Pips: j.tp3Pips, maxSlPips: j.maxSlPips,
    costPips: j.costPips, entryMode: j.entryMode,
  } : a.plan;
  return {
    id: (a || j).id, zone: a || null,
    direction: a?.direction ?? j.dir, timeframe: a?.timeframe ?? j.timeframe, category: a?.category ?? j.category,
    zoneLow: a?.zoneLow ?? j.zoneLow, zoneHigh: a?.zoneHigh ?? j.zoneHigh, c1Time: a?.c1Time ?? j.c1Time,
    plan,
    proposal: a?.proposal ?? null, verdict: a?.verdict ?? null, reasons: a?.reasons ?? [], score: a?.score ?? null,
    grade: a?.grade ?? j?.grade ?? null, confluence: a?.confluence ?? [],
    lot: j?.lot ?? state.settings.risk.lot,
    lotSuggested: a?.lotSuggested ?? null,
    guardCorrelated: a?.guardCorrelated ?? false, guardOverlap: a?.guardOverlap ?? false,
    market: a?.market ?? j?.market ?? state.settings.market,
    pipSize: j?.pipSize ?? null,
  };
}

/** Pip du marché de cet item, quelle que soit sa source (journal réel ou zone auditée backtest). */
function pipSizeOf(it) { return it.pipSize ?? marketById(it.market)?.pip ?? state.out?.risk?.pipSize ?? state.settings.risk.pipSize ?? 0.1; }

/** Onglet de la liste : opportunités / suivies / historique / non validées. */
function bucketOf(it) {
  if (it.followed) return 'followed';
  const st = it.pos.state, tone = statusOf(it).tone;
  if (tone === 'nonval') return 'nonval';
  if (st === POS.PENDING || st === POS.OPEN) return 'opp';
  return 'history';
}

// ── rendu ────────────────────────────────────────────────────────────────
function renderAll(keepView = true) {
  renderHeader();
  renderBalance();
  renderTfTabs();
  renderChart(keepView);
  renderPositions();
  renderAgents();
  renderLearning();
  renderNewsCountdown();
  if (state.panel === 'news') renderNews();
  if (state.panel === 'stats') renderStats();
  if (state.panel === 'markets') renderMarkets();
}

function renderHeader() {
  const o = state.out;
  $('#price').textContent = o?.currentPrice != null ? fmtP(o.currentPrice) : '—';
  const marketLabel = o?.market?.label || marketById(state.settings.market)?.label || '';
  const liveTxt = state.live && state.liveMarkets.length ? ` · En direct : ${state.liveMarkets.map((id) => marketById(id)?.label || id).join(' · ')}` : '';
  $('#sourceLine').textContent = (state.data ? `${marketLabel}${marketLabel.includes(String(state.data.symbol).split(':').pop()) ? '' : ` (${state.data.symbol})`} · ${state.data.source}` : (state.server ? `${marketLabel} · PC · TradingView Desktop` : `${marketLabel} · Téléphone · PC distant`)) + liveTxt;
  $('#liveRotateWarn').hidden = !(state.live && state.liveMarkets.length > 1);
  $('#updated').textContent = o ? `analysé à ${new Date(o.analyzedAt).toLocaleTimeString('fr-FR')}` : 'pas encore analysé';
  renderFreshness();
  renderChartMarketSelect();
}

/** Badge de fraîcheur des données (§5) : âge de la dernière analyse réussie, orange au-delà de
 * 3× l'intervalle de rafraîchissement, rouge « PC hors ligne ? » sans succès depuis 2 min en direct.
 * Rafraîchi chaque seconde (setInterval, cf. init) pour rester lisible sans nouvelle analyse. */
function renderFreshness() {
  const el = $('#freshness');
  if (!el) return;
  if (!state.lastSuccessAt) { el.textContent = ''; el.className = 'fresh'; el.hidden = true; return; }
  el.hidden = false;
  const ageSec = Math.max(0, Math.round((Date.now() - state.lastSuccessAt) / 1000));
  const refreshMs = (state.settings.liveSec || 15) * 1000;
  const staleOrange = ageSec * 1000 > 3 * refreshMs;
  const staleRed = state.live && Date.now() - state.lastSuccessAt > 120000;
  el.textContent = staleRed ? 'PC hors ligne ?' : `Données : il y a ${ageSec < 60 ? `${ageSec} s` : `${Math.round(ageSec / 60)} min`}`;
  el.className = `fresh ${staleRed ? 'red' : staleOrange ? 'orange' : ''}`;
  if (staleRed && !state.dataStale) {
    state.dataStale = true;
    toast('PC ou TradingView injoignable : plus d\'alertes tant que la connexion n\'est pas rétablie');
    if (state.settings.notify) notify([{ title: '⚠️ PC ou TradingView injoignable', body: 'Plus d\'alertes tant que la connexion n\'est pas rétablie.' }]);
  }
}

/** Notification unique de reprise après une coupure de données (§5), appelée à chaque analyse réussie. */
function noteDataRecovered() {
  if (!state.dataStale) return;
  state.dataStale = false;
  toast('Connexion rétablie : les alertes reprennent.');
  if (state.settings.notify) notify([{ title: '✅ Connexion rétablie', body: 'Les alertes de trading reprennent.' }]);
}

/** Risque (pip/valeur de contrat/coûts) du marché `mid`, à partir des positions du groupe (qui
 * portent déjà leur propre pipSize/contractSize pour les trades suivis) ou, à défaut, du registre
 * (marketRisk, §2) : le spread/glissement réglés et le cours actuel (marchés cotés en JPY) sont
 * toujours inclus, pour que les € affichés et les coûts soient corrects. */
function riskForMarket(mid, ps) {
  const m = marketById(mid) || marketById(DEFAULT_MARKET);
  const quotePrice = ps?.[0]?.quotePrice ?? (mid === state.settings.market ? state.out?.currentPrice : null) ?? null;
  const mr = marketRisk(m, {
    quotePrice, spreadOverride: state.settings.risk.spreadOverrides?.[m.id], slippagePips: state.settings.risk.slippagePips,
  });
  return {
    ...state.settings.risk, ...mr,
    pipSize: ps?.[0]?.pipSize ?? mr.pipSize, contractSize: ps?.[0]?.contractSize ?? mr.contractSize,
  };
}

function renderBalance() {
  const list = items();
  const positions = list.filter((x) => state.scope === 'reel' ? x.followed : !x.followed || x.zone).map((x) => {
    const pos = state.scope === 'reel' ? x.pos : (x.zone?.pos || x.pos);
    return { ...pos, lot: x.lot, market: pos.market ?? x.zone?.market ?? state.settings.market };
  });
  // les pips ne sont jamais additionnés entre marchés (leur pip diffère) : un groupe par marché.
  const groups = new Map();
  for (const p of positions) { const mid = p.market || DEFAULT_MARKET; if (!groups.has(mid)) groups.set(mid, []); groups.get(mid).push(p); }
  const marketIds = [...groups.keys()];
  const multi = marketIds.length > 1;
  const mainId = groups.has(state.settings.market) ? state.settings.market : (marketIds[0] || state.settings.market);
  const r = riskForMarket(mainId, groups.get(mainId));
  const b = balance(groups.get(mainId) || [], r, eurUsdRate());
  const sign = b.pips > 0 ? 'is-pos' : b.pips < 0 ? 'is-neg' : '';
  $('#balance').className = `balance ${sign} ${state.scope === 'reel' && !r.validated ? 'locked' : ''}`;
  const nFollowed = state.journal.entries.filter((j) => j.followed).length;
  $('#balScopeLabel').textContent = state.scope === 'reel'
    ? (r.validated ? `Mes trades suivis (${nFollowed})${multi ? ` · ${marketById(mainId)?.label || mainId}` : ''}` : 'Lot et stop à valider avant de suivre un trade')
    : 'Backtest : toutes les zones, simulées sur l\'historique chargé';
  $('#balLot').textContent = `lot ${fmtNum(r.lot, 2)} · 1 pip = ${fmtEur(money(1, r, eurUsdRate()).eur)}`;
  $('#balPips').textContent = fmtPips(b.pips);
  $('#balEur').textContent = fmtEur(b.eur);
  $('#balRealized').innerHTML = `${fmtPips(b.realizedPips)}<small>${fmtEur(b.realizedEur)}</small>`;
  $('#balOpen').innerHTML = `${fmtPips(b.openPips)}<small>${b.open} ouverte(s)</small>`;
  $('#balWL').innerHTML = `<span class="g">✓ ${b.wins}</span> · <span class="r">✕ ${b.losses}</span><small>${b.pending} ordre(s) en attente</small>`;
  $('#balRate').innerHTML = `${b.winRate != null ? Math.round(b.winRate * 100) + ' %' : '—'}<small>${b.expectancyR != null ? fmtR(b.expectancyR) + ' / trade' : ''}</small>`;
  $('#riskBtn').classList.toggle('primary', !r.validated);
  renderBalanceMarkets(groups, multi);
}

/** Détail par marché (sous la balance principale) : uniquement quand plusieurs marchés ont des
 * positions dans le périmètre affiché. Les pips ne sont jamais additionnés entre marchés ; seul
 * le total en € (valeur de pip par défaut de chaque marché) est sommé. */
function renderBalanceMarkets(groups, multi) {
  const el = $('#balMarkets');
  if (!el) return;
  el.hidden = !multi;
  if (!multi) { el.innerHTML = ''; return; }
  let totalEur = 0;
  const rows = [...groups.entries()].map(([mid, ps]) => {
    const rr = riskForMarket(mid, ps);
    const gb = balance(ps, rr, eurUsdRate());
    totalEur += gb.eur || 0;
    const m = marketById(mid);
    return `<div class="bal-market-row ${mid === state.settings.market ? 'active' : ''}"><span class="bmr-lbl">${esc(m?.label || mid)}</span><span class="bmr-pips">${fmtPips(gb.pips)}</span><span class="bmr-eur">${fmtEur(gb.eur)}</span></div>`;
  }).join('');
  el.innerHTML = `<div class="bal-market-total">Total tous marchés <b>${fmtEur(totalEur)}</b><small>€ uniquement (pips non additionnables entre marchés)</small></div>${rows}`;
}

function renderTfTabs() {
  const tabs = $('#tfTabs');
  const viable = new Set((state.out?.audited || []).filter((a) => a.proposal === 'PROPOSEE' && a.pos.state === POS.PENDING).map((a) => a.timeframe));
  tabs.innerHTML = visibleTfs().map((tf) => `<button data-tf="${tf}" class="${tf === state.chartTf ? 'on' : ''}" role="tab" aria-selected="${tf === state.chartTf}"${viable.has(tf) ? ' aria-label="' + TF_LABEL[tf] + ', opportunité disponible"' : ''}>${TF_LABEL[tf]}${viable.has(tf) ? '<i class="dot" aria-hidden="true"></i>' : ''}</button>`).join('');
  tabs.querySelectorAll('button').forEach((b) => (b.onclick = () => { state.chartTf = b.dataset.tf; renderTfTabs(); renderChart(false); }));
}

function renderChart(keepView = true) {
  const candles = state.data?.candles?.[state.chartTf] || [];
  const hint = $('#chartHint');
  hint.textContent = candles.length ? `${candles.length} bougies · depuis ${new Date(candles[0].time * 1000).toLocaleDateString('fr-FR')}` : '';
  const all = items();
  const byId = new Map(all.map((x) => [x.id, x]));
  const audited = state.out?.audited || [];
  const zones = audited.filter((z) => z.timeframe === state.chartTf).map((z) => {
    const it = byId.get(z.id);
    return { ...z, tone: it ? statusOf(it).tone : 'neutral', followed: !!it?.followed };
  });
  const bands = $('#showBands').checked
    ? audited.filter((z) => z.proposal === 'PROPOSEE' && z.pos.state === POS.PENDING && z.timeframe !== state.chartTf && inCat(z.timeframe)).map((z) => ({ ...z, tfLabel: TF_LABEL[z.timeframe] }))
    : [];
  const sel = all.find((x) => x.id === state.selected);
  chart.selectedId = state.selected;
  chart.plan = sel && sel.timeframe === state.chartTf ? { ...sel.plan, from: sel.c1Time, dir: sel.direction, fill: sel.pos.fillTime, exit: sel.pos.exitTime } : null;
  chart.smc = sel && sel.timeframe === state.chartTf ? sel.zone?.smc || null : null;
  chart.setData(candles, zones, bands, state.out?.currentPrice ?? null, { keepView, decimals: activeDecimals() });
}

const TAB_EMPTY = {
  followed: '<strong>Tu ne suis aucun trade.</strong>Dans « Opportunités », appuie sur <b>Suivre</b> quand tu prends un trade : il entre alors dans ta balance.',
  history: 'Aucun trade terminé dans l\'historique chargé.',
  nonval: 'Aucune zone écartée par l\'analyse.',
};
/** Texte de la liste « Opportunités » vide : dépend de la stratégie active (§4). */
function oppEmptyText() {
  if (state.settings.risk.strategyMode !== 'ob5') {
    return '<strong>Aucun setup SMC actuellement. Attendre.</strong>Aucun setup SMC : attendre qu\'un POI HTF en Discount/Premium soit atteint puis un CHoCH en 15m/5m. Laisse « Analyser » tourner : les nouveaux setups apparaissent ici.';
  }
  return '<strong>Aucune position 5★ actuellement. Attendre.</strong>Aucun order block ne passe le filtre 5 étoiles (moins de 5★ = invalidée), la tendance de fond, la limite de stop (2,5 ATR en mode adaptatif, 100 pips en mode fixe) et les règles apprises. Laisse « Analyser » tourner : les nouvelles zones apparaissent ici.';
}

function renderPositions() {
  const list = $('#posList');
  if (!state.out) {
    list.innerHTML = `<div class="empty"><strong>Appuie sur « Analyser »</strong>L'analyse démarre en temps réel : les agents collectent les bougies, détectent les zones, les auditent et suivent les positions.</div>`;
    $('#cntPos').textContent = '';
    return;
  }
  const all = items().filter((it) => state.dirFilter === 'all' || it.direction === state.dirFilter);
  const counts = { opp: 0, followed: 0, history: 0, nonval: 0 };
  for (const it of all) counts[bucketOf(it)]++;
  $('#stateFilter').querySelectorAll('button').forEach((b) => { b.querySelector('.n').textContent = counts[b.dataset.v] || '0'; });
  const openN = all.filter((it) => it.followed && it.pos.state === POS.OPEN).length;
  $('#cntPos').textContent = openN ? `${openN} en cours` : counts.opp ? String(counts.opp) : '';
  const xs = all.filter((it) => bucketOf(it) === state.stateFilter);
  const price = state.out.currentPrice;
  const rank = { [POS.OPEN]: 0, [POS.PENDING]: 1 };
  if (state.stateFilter === 'opp') xs.sort((a, b) => (rank[a.pos.state] ?? 2) - (rank[b.pos.state] ?? 2) || Math.abs(a.plan.entry - price) - Math.abs(b.plan.entry - price));
  else if (state.stateFilter === 'followed') xs.sort((a, b) => (rank[a.pos.state] ?? 2) - (rank[b.pos.state] ?? 2) || (b.pos.exitTime || b.pos.createdAt || 0) - (a.pos.exitTime || a.pos.createdAt || 0));
  else if (state.stateFilter === 'history') xs.sort((a, b) => (b.pos.pips != null) - (a.pos.pips != null) || (b.pos.exitTime || 0) - (a.pos.exitTime || 0)); // gagnants/perdants d'abord, puis annulées
  else xs.sort((a, b) => (b.c1Time || 0) - (a.c1Time || 0));
  if (!xs.length) { list.innerHTML = `<div class="empty">${state.stateFilter === 'opp' ? oppEmptyText() : TAB_EMPTY[state.stateFilter]}</div>`; return; }
  const limit = state.listLimit || 40;
  const shown = xs.slice(0, limit);
  const more = xs.length - shown.length;
  list.innerHTML = shown.map(card).join('') + (more > 0 ? `<button type="button" class="btn small more-btn" id="listMoreBtn">Voir plus (${more})</button>` : '');
  list.querySelectorAll('.pos').forEach((el) => {
    el.onclick = (e) => { if (!e.target.closest('.follow')) openDetail(el.dataset.id); };
    el.onkeydown = (e) => { if (e.key === 'Enter' && e.target === el) openDetail(el.dataset.id); };
  });
  list.querySelectorAll('.follow').forEach((b) => (b.onclick = (e) => { e.stopPropagation(); toggleFollow(b.dataset.id, b); }));
  const moreBtn = $('#listMoreBtn');
  if (moreBtn) moreBtn.onclick = () => { state.listLimit = limit + 40; renderPositions(); };
}

/** « J'ai suivi » / « Ne plus suivre ». */
function toggleFollow(id, btn) {
  const it = items().find((x) => x.id === id);
  if (!it) return;
  if (it.followed) {
    if (btn && !confirmInline(btn)) return;
    unfollowZone(state.journal, id);
    save(K.journal, state.journal);
    toast('Trade retiré de ton suivi : il ne compte plus dans ta balance.');
  } else {
    if (!state.settings.risk.validated) { toast('Valide d\'abord ton lot et ton stop loss.'); openRisk(); return; }
    if (!it.zone) return;
    const e = followZone(state.journal, it.zone, { risk: state.settings.risk, candles: state.data?.candles || {} });
    if (!e) return;
    save(K.journal, state.journal);
    const msg = e.state === POS.PENDING ? 'ordre en attente, il entrera en position quand le prix arrivera sur la zone'
      : e.state === POS.OPEN ? 'position déjà ouverte, reprise au prix d\'entrée de la zone' : 'trade déjà terminé, résultat ajouté à ta balance';
    toast(`Trade suivi : ${msg}.`);
  }
  recompute();
  if ($('#zoneDialog').open) openDetail(id);
}

/** Note personnelle (§9) sur un trade suivi, stockée sur l'entrée du journal (500 caractères max). */
function setJournalNote(id, text) {
  const j = state.journal.entries.find((x) => x.id === id);
  if (!j) return;
  j.note = String(text || '').slice(0, 500);
  save(K.journal, state.journal);
  toast('Note enregistrée.');
}

/** Export CSV (§9) du journal suivi : Blob + lien temporaire <a download> (peut ne pas déclencher
 * de téléchargement sous Capacitor Android — acceptable, cf. rapport). */
function exportJournalCsv() {
  const rows = state.journal.entries.filter((j) => j.followed);
  if (!rows.length) { toast('Aucun trade suivi à exporter.'); return; }
  const headers = ['id', 'marché', 'sens', 'UT', 'catégorie', 'entrée', 'SL', 'TP1', 'TP2', 'TP3', 'lot', 'état', 'sortie', 'pips nets', 'R', 'créé (ISO)', 'sortie (ISO)', 'note'];
  const csvEsc = (v) => { const s = String(v ?? ''); return /[",;\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  const lines = [headers.map(csvEsc).join(';')];
  for (const j of rows) {
    lines.push([
      j.id, marketById(j.market)?.label || j.market || '', j.dir, TF_LABEL[j.timeframe] || j.timeframe, CATEGORIES[j.category]?.label || j.category,
      j.entry, j.sl, j.tp1, j.tp2, j.tp3, j.lot, POS_LABEL[j.state] || j.state,
      j.exitPrice ?? '', j.pips ?? '', j.r ?? '',
      j.createdAt ? new Date(j.createdAt * 1000).toISOString() : '',
      j.exitTime ? new Date(j.exitTime * 1000).toISOString() : '',
      j.note || '',
    ].map(csvEsc).join(';'));
  }
  const blob = new Blob(['﻿' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = `xauz-journal-${new Date().toISOString().slice(0, 10)}.csv`;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
  toast(`Export CSV : ${rows.length} trade(s).`);
}

/** Recalcule P&L et balance sans nouvelle collecte (après suivi / changement de lot). */
function recompute() {
  if (state.data && state.out) {
    state.out = runAgents({ data: state.data, settings: state.settings, cal: state.cal, learnStore: state.learn, journal: state.journal, newsEvents: state.news });
    state.journal.events = [];
    save(K.journal, state.journal);
  }
  renderAll(true);
}

const ICON = { gain: '✓', loss: '✕', up: '↗', down: '↘', opp: '◷', warn: '⏸', nonval: '⊘', neutral: '–' };
/** Statut affiché : ton (couleur) + icône + texte, jamais la couleur seule (RGAA 3.1). */
function statusOf(it) {
  const p = it.pos;
  if (p.state === POS.OPEN) {
    const up = (p.pips ?? 0) >= 0;
    const h = p.hits || 0;
    const mgmt = h >= 2 ? ' · TP2 ✓ stop ≥ TP1' : p.beDone ? ' · stop au BE' : h >= 1 ? ' · TP1 ✓ (attend +1R pour le BE)' : '';
    return { tone: up ? 'gain' : 'loss', icon: up ? ICON.up : ICON.down, text: `${it.followed ? 'En position' : 'Déclenchée (simulée)'} · ${up ? 'à gains' : 'à perte'}${mgmt}` };
  }
  if (p.state === POS.TP) return { tone: 'gain', icon: ICON.gain, text: `Gagnant · ${p.exitKind || 'objectif atteint'} ${fmtR(p.r)}` };
  if (p.state === POS.SL) return { tone: 'loss', icon: ICON.loss, text: `Perdant · SL touché ${fmtR(p.r)}` };
  if (p.state === POS.PENDING) {
    if (p.inZone) return { tone: 'opp', icon: '⏳', text: `Prix dans l'OB · attends une bougie ${it.direction === 'BUY' ? 'haussière' : 'baissière'}` };
    if (it.followed) return { tone: 'opp', icon: ICON.opp, text: 'Suivi · en attente du retour du prix' };
    if (it.proposal === 'PROPOSEE') {
      // préservation du compte (§B) : la zone reste visible mais signalée, pas notifiée « à prendre »
      const g = state.out?.guards;
      if (g?.maxPositions) return { tone: 'warn', icon: ICON.warn, text: 'En attente : 2 positions déjà ouvertes' };
      if (g?.dailyBreaker) return { tone: 'warn', icon: ICON.warn, text: 'Pause : 2 pertes aujourd\'hui, protection du capital' };
      if (it.guardOverlap) return { tone: 'warn', icon: ICON.warn, text: 'En attente : position déjà ouverte sur une zone proche, même sens' };
      return { tone: 'opp', icon: ICON.opp, text: 'À surveiller · attends le retour du prix dans l\'OB' };
    }
    if (it.proposal === 'SUSPENDUE') return { tone: 'warn', icon: ICON.warn, text: 'Validée, suspendue · annonce macro' };
    if (it.proposal === 'FILTREE') return { tone: 'nonval', icon: ICON.nonval, text: 'Non validée · règle apprise' };
    if (it.proposal === 'REFUSEE') return { tone: 'nonval', icon: ICON.nonval, text: `Non validée · ${it.reasons.at(-1) || 'TP1 insuffisant'}` };
    if (it.verdict && it.verdict !== 'VALIDÉE') return { tone: 'nonval', icon: ICON.nonval, text: it.verdict === 'REJETÉE' ? 'Non validée · rejetée par l\'auditeur' : 'Non validée · données partielles' };
    return { tone: 'nonval', icon: ICON.nonval, text: 'Non validée' };
  }
  if (p.state === POS.REFUSED) return { tone: 'nonval', icon: ICON.nonval, text: `Non validée · ${p.reason || 'TP1 insuffisant'}` };
  if (p.state === POS.CANCELLED) return { tone: 'neutral', icon: ICON.neutral, text: `Annulée · ${p.reason || ''}` };
  return { tone: 'neutral', icon: ICON.neutral, text: POS_LABEL[p.state] || p.state };
}

const CAT_ICON = { scalping: '◔', day: '◑', swing: '●' };
function catChip(it) {
  const c = CATEGORIES[it.category];
  return `<span class="cat cat-${it.category}" title="${esc(c?.long || '')}"><i aria-hidden="true">${CAT_ICON[it.category] || ''}</i>${esc(c?.label || '')} · ${TF_LABEL[it.timeframe]}</span>`;
}
function starsTag(g) {
  if (g == null) return '';
  return `<span class="stars" role="img" aria-label="${g} étoiles sur 5"><span aria-hidden="true">${'★'.repeat(g)}<i>${'☆'.repeat(5 - g)}</i></span></span>`;
}
/** Chip « SMC » (remplace les étoiles 5★) : valide (R:R ≥ 1:3) ou rejeté (R:R insuffisant). */
function smcChip(zone) {
  const ok = zone?.smc?.valid !== false;
  return `<span class="cat" title="${ok ? 'Setup SMC validé (R:R ≥ 1:3)' : 'R:R insuffisant : setup rejeté'}">${ok ? '✓ SMC' : '⊘ SMC'}</span>`;
}
function dirTag(d) { return `<span class="dir"><i aria-hidden="true">${d === 'BUY' ? '▲' : '▼'}</i>${dirFr(d, true)}</span>`; }
function followBtn(it) {
  const closed = it.pos.state === POS.TP || it.pos.state === POS.SL;
  if (it.followed) return `<button type="button" class="follow on" data-id="${it.id}" aria-pressed="true" title="Appuie deux fois pour ne plus suivre">✓ Suivi</button>`;
  if (!it.zone || it.pos.state === POS.CANCELLED) return '';
  return `<button type="button" class="follow" data-id="${it.id}" aria-pressed="false">${closed ? 'Je l\'ai pris' : 'Suivre'}</button>`;
}

/** Décalage prix courtier − prix TradingView réglé pour ce marché (nul par défaut). */
function brokerOffsetOf(it) { return Number(state.settings.risk.brokerOffset?.[it.market]) || 0; }

/** Risque en € (perte au stop, coûts inclus) pour le lot suivi/proposé de cet item. */
function riskEurOf(it) {
  const r = riskForMarket(it.market);
  const pips = (it.plan.slPips || 0) + (it.plan.costPips || r.costPips || 0);
  return money(pips, r, eurUsdRate(), it.lot).eur;
}

function card(it) {
  const st = statusOf(it);
  const p = it.pos;
  const dec = marketById(it.market)?.decimals ?? activeDecimals();
  const pnl = p.pips != null
    ? `<b class="${p.pips >= 0 ? 'g' : 'r'}">${fmtPips(p.pips)}</b><small>${fmtEur(eurOf(p.pips, it.lot))}</small>`
    : `<b>${fmtP(it.plan.entry, dec)}</b><small>entrée</small>`;
  const conf = it.score?.confidence != null ? `<span class="conf" title="Indice de fiabilité appris">fiab. ${it.score.confidence}</span>` : '';
  const reducedSize = it.proposal === 'PROPOSEE' && state.out?.guards?.reducedSize;
  const offset = brokerOffsetOf(it);
  const smc = it.zone?.smc || (it.plan.strategy === 'smc' ? {} : null);
  const rr = it.plan.rr != null ? `RR1 ${fmtNum(it.plan.rr, 1)}` : '';
  const rr3 = it.plan.rr3 != null ? `RR3 ${fmtNum(it.plan.rr3, 1)}` : '';
  const rrSmc = it.plan.rr2 != null ? `R:R → TP2 1:${fmtNum(it.plan.rr2, 1)}` : '';
  const riskEur = riskEurOf(it);
  const lotLine = it.lotSuggested != null ? `<span class="lot-sugg">lot conseillé ${fmtNum(it.lotSuggested, 2)}</span>` : '';
  const tpKeys = smc ? [1, 2] : [1, 2, 3];
  return `
  <article class="pos t-${st.tone} ${it.id === state.selected ? 'sel' : ''}" data-id="${it.id}" tabindex="0" aria-label="${esc(`${dirFr(it.direction, true)} ${CATEGORIES[it.category]?.label || ''} ${TF_LABEL[it.timeframe]}, ${st.text}`)}">
    <div class="l1">${dirTag(it.direction)}${catChip(it)}${smc ? smcChip(it.zone) : starsTag(it.grade)}${it.confluence?.length ? `<span class="badge conf-tf" title="Zone présente aussi en ${it.confluence.map((t) => TF_LABEL[t]).join(', ')}">multi-UT</span>` : ''}${state.newIds.has(it.id) ? '<span class="badge new">nouveau</span>' : ''}${it.guardCorrelated ? '<span class="badge warn" title="Exposition déjà ouverte sur un marché corrélé, même sens">corrélé</span>' : ''}${reducedSize ? '<span class="badge warn" title="3 pertes consécutives : préservation du capital">taille réduite conseillée : 50 % du lot</span>' : ''}</div>
    <div class="pnl num">${pnl}</div>
    <div class="l2"><span class="st t-${st.tone}"><i aria-hidden="true">${st.icon}</i>${esc(st.text)}</span></div>
    <div class="l2 r">${conf}</div>
    <div class="l3 num lv"><span>Entrée <b>${fmtP(it.plan.entry, dec)}</b></span><span>SL <b>${fmtP(it.plan.sl, dec)}</b></span><span class="risk">risque ${fmtNum(it.plan.slPips, 0)} pips${riskEur != null ? ` = ${fmtEur(-Math.abs(riskEur))}` : ''}</span></div>
    ${offset ? `<div class="l3 num broker">chez ton courtier : entrée ${fmtP(it.plan.entry + offset, dec)}</div>` : ''}
    <div class="l3 num tps">${tpKeys.map((k) => `<span class="${(p.hits || 0) >= k ? 'hit' : ''}">${smc ? (k === 2 ? 'TP2 (final)' : 'TP1 (50 %)') : (k === 3 && it.category === 'swing' ? 'TP3 +600 (manuel)' : `TP${k}`)} ${fmtP(it.plan[`tp${k}`], dec)}${(p.hits || 0) >= k ? ' ✓' : ''}</span>`).join('')}</div>
    <div class="l3 num rrline">${smc ? rrSmc : [rr, rr3].filter(Boolean).join(' · ')}${lotLine ? ` · ${lotLine}` : ''}</div>
    <div class="act">${followBtn(it)}</div>
  </article>`;
}

/** Liste « POI HTF à surveiller » (rules_trading_smc.md §1) : POI 1D/1W/1Mo pas encore mitigés,
 * les plus proches du prix d'abord (agents.js → watchedPois, smc.js). */
function watchPoisHtml() {
  const list = state.out?.watchPois || [];
  if (state.settings.risk.strategyMode === 'ob5' || !list.length) return '';
  const price = state.out?.currentPrice;
  const dec = activeDecimals();
  const rows = list.slice(0, 8).map((p) => {
    const mid = (p.low + p.high) / 2;
    const dist = price != null ? Math.abs(price - mid) : null;
    return `<li><span class="dir"><i aria-hidden="true">${p.dir === 'BUY' ? '▲' : '▼'}</i>${dirFr(p.dir, true)}</span> ${p.kind === 'FVG' ? 'FVG' : 'OB'} ${TF_SMC_LABEL[p.tf] || p.tf} <b class="num">${fmtP(p.low, dec)} – ${fmtP(p.high, dec)}</b>${dist != null ? `<small> · à ${fmtP(dist, dec)} du prix</small>` : ''}</li>`;
  }).join('');
  return `<div class="agent watch-pois"><h3>POI HTF à surveiller</h3><ul class="checks">${rows}</ul></div>`;
}

function renderAgents() {
  const el = $('#agentList');
  const reps = state.out?.reports || [];
  const bad = reps.filter((r) => r.status !== 'COMPLET').length;
  $('#cntAgents').textContent = reps.length ? (bad ? `${bad} ⚠` : '✓') : '';
  if (!reps.length) { el.innerHTML = '<div class="empty">Les rapports des agents apparaissent après l\'analyse.</div>'; return; }
  el.innerHTML = watchPoisHtml() + reps.map((r, i) => `
    <article class="agent">
      <div class="agent-head"><span class="num-i">${i + 1}</span><div><b>${r.agent}</b><small>${r.role} · ${new Date(r.at).toLocaleTimeString('fr-FR')}</small></div><span class="pill ${r.status === 'COMPLET' ? 'ok' : r.status === 'PARTIEL' ? 'part' : 'ko'}">${r.status}</span></div>
      <ul>${r.lines.map((l) => `<li>${esc(l)}</li>`).join('')}</ul>
    </article>`).join('');
}

function renderLearning() {
  const el = $('#learnBody');
  const m = state.out?.model;
  $('#cntRules').textContent = m?.rules?.filter((r) => r.active).length ? String(m.rules.filter((r) => r.active).length) : '';
  if (!m) { el.innerHTML = '<div class="empty">L\'apprentissage se construit à chaque analyse à partir des positions clôturées (backtest et réelles).</div>'; return; }
  const kpi = (t, s) => `<div class="kpi"><span>${t}</span><b>${s.n ? Math.round(s.winRate * 100) + ' %' : '—'}</b><small>${s.n ? fmtR(s.meanR) + ' / trade · ' + s.n + ' trades' : 'pas de données'}</small></div>`;
  const rows = Object.values(m.stats).filter((s) => s.n >= 3).sort((a, b) => a.smoothR - b.smoothR);
  el.innerHTML = `
    <div class="kpis">${kpi('Sans règles', m.before)}${kpi('Avec règles actives', m.after)}${kpi('Positions réelles', m.real)}</div>
    ${progressHtml(m)}
    <p class="hint">À chaque analyse, les trades clôturés (backtest et réels) enrichissent le savoir de l'application. Les caractéristiques, et les combinaisons de caractéristiques (ex. Londres + contre-tendance), qui perdent de façon répétée deviennent des règles CANDIDATES. Une candidate n'est appliquée par l'auditeur que si le mécanisme champion / challenger prouve qu'elle améliore l'espérance, sur l'échantillon complet et sur la période récente. Les pertes de tes trades suivis comptent double.</p>
    ${continuousHtml()}
    <h3>Règles de prévention (${m.rules.filter((r) => r.active).length} active(s) sur ${m.rules.length} candidate(s))</h3>
    ${m.rules.length ? m.rules.map((r) => {
      const userEnabled = !state.learn.disabled.includes(r.key);
      const statusTxt = r.status === 'disabled' ? 'désactivée par toi' : r.status === 'active' ? 'active' : 'candidate · non appliquée (pas d\'amélioration prouvée)';
      return `<label class="rule ${r.active ? '' : 'off'}">
        <input type="checkbox" data-key="${r.key}" ${userEnabled ? 'checked' : ''}>
        <div><b>Écarter : ${esc(r.label)}</b><small>${statusTxt} · ${r.n} trades · ${Math.round(r.winRate * 100)} % de réussite · ${fmtR(r.meanR)} par trade (lissé ${fmtR(r.smoothR)})</small></div>
      </label>`;
    }).join('') : `<div class="empty small">Aucune règle candidate : il faut au moins ${m.params.minSamples} trades et ${m.params.minLosses} pertes sur une même caractéristique, avec une espérance inférieure à ${fmtR(m.params.threshold)}.</div>`}
    <h3>Performance par caractéristique</h3>
    <table class="feat"><thead><tr><th>Caractéristique</th><th>Trades</th><th>Réussite</th><th>Espérance</th></tr></thead>
    <tbody>${rows.map((s) => `<tr><td>${esc(featureLabel(s.feature))}<small>${esc(valueLabel(s.feature, s.value))}</small></td><td class="num">${s.n}</td><td class="num">${Math.round(s.winRate * 100)} %</td><td class="num ${s.smoothR >= 0 ? 'g' : 'r'}">${fmtR(s.smoothR)}</td></tr>`).join('')}</tbody></table>`;
  el.querySelectorAll('[data-w]').forEach((x) => { x.style.width = `${x.dataset.w}%`; }); // CSSOM : autorisé par la CSP
  el.querySelectorAll('.rule input').forEach((cb) => (cb.onchange = () => {
    const k = cb.dataset.key;
    state.learn.disabled = cb.checked ? state.learn.disabled.filter((x) => x !== k) : [...new Set([...state.learn.disabled, k])];
    save(K.learn, state.learn);
    toast(cb.checked ? 'Règle réactivée : appliquée à la prochaine analyse.' : 'Règle désactivée : appliquée à la prochaine analyse.');
    if (!state.live) runOnce();
  }));
}

/** Amélioration continue (USER REQUIREMENT 3) : version de la configuration (règles apprises), dernières décisions, retours arrière. */
function continuousHtml() {
  const cfg = state.learn.config;
  if (!cfg) return '<p class="hint mt0">La configuration se construit après quelques analyses.</p>';
  const hist = (state.learn.configHistory || []).slice(-5).reverse();
  return `<h3>Amélioration continue</h3>
    <p class="hint mt0">Chaque règle apprise est déterministe (champion / challenger, sans IA) et n'est appliquée que si elle est prouvée meilleure. Si sa performance se révèle ensuite pire que la configuration précédente, l'application y revient automatiquement (retour arrière). Les objectifs (TP1/TP2/TP3) sont désormais des distances fixes par catégorie, non optimisées.</p>
    <p>Configuration <b>v${cfg.version}</b> adoptée le ${fmtT(cfg.adoptedAt * 1000)}${cfg.validation?.pipsPerTrade != null ? ` · validée à ${fmtPips(cfg.validation.pipsPerTrade)} / trade sur ${cfg.validation.n} trades` : ''}</p>
    ${hist.length ? `<div class="chips">${hist.map((h) => `<span class="chip">v${h.version} · ${esc(h.decision)} — ${esc(h.reason || h.change || '')}</span>`).join('')}</div>` : ''}`;
}

/** Grille « 5 étoiles » d'un order block (trading_agent_order_blocks.md). */
function starsHtml(z) {
  const row = (ok, label, detail) => `<li class="${ok ? 'ok' : 'ko'}"><span aria-hidden="true">${ok ? '★' : '☆'}</span><div><b>${label}</b> · ${ok ? 'validé' : 'non validé'}<small>${detail}</small></div></li>`;
  const L = z.liq || {};
  return `<ul class="star-list" aria-label="Critères de l'order block">
    ${row(z.stars.imbalance, '1 · Imbalance (éliminatoire)', `C1/C3 sans contact, écart ${fmtP(z.gap)}`)}
    ${row(z.stars.trend, '2 · Tendance (éliminatoire)', `Supertrend ${z.trend.supertrend}, ${z.trend.flips} changement(s) sur 50 bougies${z.trend.ranging ? ' : range' : ''}`)}
    ${row(z.stars.liquidity, '3 · Liquidité', L.risk ? `poche au-delà de l'OB : ${[...(L.beyond || []), ...(L.equalBeyond || [])].map(fmtP).join(', ')} (risque de balayage)` : 'pas de poche proche au-delà de l\'OB')}
    ${row(z.stars.virgin, '4 · OB vierge', z.stars.virgin ? 'jamais retesté' : 'déjà touché (mitigé)')}
    ${row(z.stars.fib, '5 · Fibonacci', `${z.fib.zone === 'DISCOUNT' ? 'Discount' : z.fib.zone === 'PREMIUM' ? 'Premium' : 'Équilibre'} · 0,5 = ${fmtP(z.fib.eq)} (${fmtP(z.fib.low)} → ${fmtP(z.fib.high)})`)}
  </ul>
  <p class="hint">Bonus : OB créé juste après une prise de liquidité (P) ✓${L.before?.length ? ` · Liquidité à prendre avant l'OB : ${L.before.map(fmtP).join(', ')}` : ''}${z.confluence?.length ? ` · Confluence : ${z.confluence.map((t) => TF_LABEL[t]).join(', ')}` : ''}</p>`;
}

/** Checklist SMC (rules_trading_smc.md) : POI HTF → biais/Fibo → CHoCH → micro-zone → R:R. */
const TF_SMC_LABEL = { D: '1D', W: '1W', M: '1Mo' };
function smcChecklistHtml(z) {
  const m = z.smc;
  const buy = z.direction === 'BUY';
  const poiTf = TF_SMC_LABEL[m.poi.tf] || m.poi.tf;
  const row = (label, detail) => `<li class="ok"><span aria-hidden="true">✓</span><div><b>${label}</b><small>${detail}</small></div></li>`;
  return `<ul class="star-list" aria-label="Checklist du setup SMC">
    ${row('① POI HTF', `${m.poi.kind === 'FVG' ? 'FVG' : 'Order Block'} ${poiTf} ${fmtP(m.poi.low)} – ${fmtP(m.poi.high)} · non mitigé au contact${m.poi.sweep ? ' · prise de liquidité' : ''}`)}
    ${row('② Biais & Fibonacci HTF', `Biais ${m.fib.bias === 'BUY' ? 'achat' : 'vente'} · POI à ${fmtNum(m.fib.poiLevel, 2)} → ${m.fib.zone === 'DISCOUNT' ? 'Discount' : 'Premium'}${m.fib.ote ? ' · <span class="badge">OTE</span>' : ''} (0 = ${fmtP(m.fib.low)}, 1 = ${fmtP(m.fib.high)})`)}
    ${row('③ CHoCH / MSS LTF', `Cassure de structure à ${fmtT(m.choch.time)}, niveau ${fmtP(m.choch.level)}`)}
    ${row('④ Micro-zone LTF', `Micro-${m.micro.kind === 'FVG' ? 'FVG' : 'OB'} · retracement ${fmtNum(m.micro.retracement * 100, 0)} %${m.micro.ote ? ' · <span class="badge">OTE</span>' : ''}`)}
    <li class="${z.stars.rr ? 'ok' : 'ko'}"><span aria-hidden="true">${z.stars.rr ? '✓' : '✕'}</span><div><b>⑤ R:R entrée → TP2</b> · ${z.stars.rr ? 'validé' : 'rejeté'}<small>1:${fmtNum(m.rr, 2)} (minimum requis 1:${m.minRR})</small></div></li>
  </ul>
  <p class="hint">${z.stars.rr ? 'Setup validé : ordre limite en attente sur la micro-zone.' : (m.reason || 'R:R insuffisant : setup rejeté.')}${z.confluence?.length ? ` · Confluence : ${z.confluence.map((t) => TF_LABEL[t]).join(', ')}` : ''}</p>`;
}

/** Progression de l'apprentissage d'une analyse à l'autre. */
function progressHtml(m) {
  const h = m.history || [];
  if (h.length < 2) return '<p class="hint">La progression apparaît après quelques analyses : chaque analyse ajoute les trades clôturés au savoir de l\'application.</p>';
  const first = h[0], last = h.at(-1);
  const pct = (v) => (v == null ? '—' : `${Math.round(v * 100)} %`);
  const gain = last.winAfter != null && first.winAfter != null ? Math.round((last.winAfter - first.winAfter) * 100) : null;
  return `<div class="progress">
    <div><b>${last.n}</b> trades appris en ${h.length} analyses · <b>${last.rules}</b> règle(s) active(s)</div>
    <div>Réussite avec règles : ${pct(first.winAfter)} → <b>${pct(last.winAfter)}</b>${gain != null ? ` (${gain >= 0 ? '+' : ''}${gain} pts)` : ''} · espérance ${fmtR(first.rAfter)} → <b>${fmtR(last.rAfter)}</b></div>
    <div class="bar" role="img" aria-label="Réussite actuelle ${pct(last.winAfter)}"><i data-w="${Math.round((last.winAfter || 0) * 100)}"></i></div>
  </div>`;
}

// ── détail ───────────────────────────────────────────────────────────────
function openDetail(id) {
  const it = items().find((x) => x.id === id) || (() => { const s = state.scope; state.scope = s === 'reel' ? 'backtest' : 'reel'; const r = items().find((x) => x.id === id); state.scope = s; return r; })();
  if (!it) return;
  state.selected = id;
  if (it.timeframe !== state.chartTf && inCat(it.timeframe)) state.chartTf = it.timeframe;
  renderTfTabs(); renderChart(true); renderPositions();
  chart.focusTime(it.c1Time);
  const z = it.zone, p = it.pos, buy = it.direction === 'BUY';
  const st = statusOf(it);
  const rows = z ? ['P', 'C1', 'C2', 'C3'].map((k) => { const c = z.candles[k]; return `<tr><td>${k}</td><td>${fmtT(c.time)}</td><td class="num">${fmtP(c.open)}</td><td class="num">${fmtP(c.high)}</td><td class="num">${fmtP(c.low)}</td><td class="num">${fmtP(c.close)}</td></tr>`; }).join('') : '';
  const feats = z?.features ? Object.entries(z.features).map(([f, v]) => `<span class="chip">${esc(featureLabel(f))} : ${esc(valueLabel(f, v))}</span>`).join('') : '';
  $('#zdTitle').textContent = `${dirFr(it.direction, true)} · ${CATEGORIES[it.category]?.label || ''} ${TF_LABEL[it.timeframe]}`;
  const canFollow = it.zone && p.state !== POS.CANCELLED;
  $('#zdBody').innerHTML = `
    <div class="st-big t-${st.tone}"><i aria-hidden="true">${st.icon}</i><div>${esc(st.text)}${p.pips != null ? `<span class="num">${fmtPips(p.pips)} = ${fmtEur(eurOf(p.pips, it.lot))}</span>` : ''}</div></div>
    <div class="follow-box ${it.followed ? 'on' : ''}">
      <div class="fb-txt">${it.followed ? '<b>✓ Tu suis ce trade</b><small>Il compte dans ta balance « Mes trades ».</small>' : `<b>As-tu pris ce trade ?</b><small>${canFollow ? 'Marque-le pour qu\'il entre dans ta balance.' : 'Ordre annulé : il ne peut plus être suivi.'}</small>`}</div>
      ${it.followed ? `<label class="lot-in">Lot <input type="number" id="zdLot" min="0.01" max="100" step="0.01" value="${it.lot}"></label><button type="button" class="btn" id="zdFollow">Ne plus suivre</button>` : canFollow ? `<button type="button" class="btn primary big" id="zdFollow">J'ai suivi cette zone</button>` : ''}
    </div>
    <div class="chips top-chips">${catChip(it)}${dirTag(it.direction)}${z?.smc ? smcChip(z) : starsTag(it.grade)}</div>
    ${z?.smc ? smcChecklistHtml(z) : (z?.stars ? starsHtml(z) : '')}
    <dl class="kv">
      ${(it.plan.entryMode || state.settings.risk.entryMode) === 'limit' ? `<dt>Entrée (ordre limite)</dt><dd class="num"><b>${fmtP(it.plan.entry)}</b></dd>` : `<dt>Zone d'entrée (OB)</dt><dd class="num"><b>${fmtP(it.zoneLow)} – ${fmtP(it.zoneHigh)}</b><small class="dd-note">Entrée à la clôture de la première bougie ${it.direction === 'BUY' ? 'haussière' : 'baissière'} dans l'OB</small></dd>`}
      ${brokerOffsetOf(it) ? `<dt>Chez ton courtier</dt><dd class="num">entrée ${fmtP(it.plan.entry + brokerOffsetOf(it))} · SL ${fmtP(it.plan.sl + brokerOffsetOf(it))} · TP1 ${fmtP(it.plan.tp1 + brokerOffsetOf(it))}<small class="dd-note">Décalage réglé : ${fmtNum(brokerOffsetOf(it), Math.max(1, activeDecimals()))}</small></dd>` : ''}
      <dt>Stop loss (invalidation)</dt><dd class="num">${fmtP(it.plan.sl)} (−${fmtNum(it.plan.slPips, 0)} pips = ${fmtEur(eurOf(-it.plan.slPips, it.lot))})</dd>
      ${(z?.smc ? [1, 2] : [1, 2, 3]).map((k) => {
        const d = Math.abs(it.plan[`tp${k}`] - it.plan.entry) / pipSizeOf(it);
        const label = z?.smc
          ? (k === 1 ? `TP1 (50 % + stop au point mort)${z.smc.tp1Kind ? ` · ${z.smc.tp1Kind}` : ''}` : `TP2 (objectif final)${z.smc.tp2Kind ? ` · ${z.smc.tp2Kind}` : ''}`)
          : (k === 3 && it.category === 'swing' ? 'TP3 (+600, manuel)' : `TP${k}`);
        return `<dt>${label}${(p.hits || 0) >= k ? ' ✓' : ''}</dt><dd class="num">${fmtP(it.plan[`tp${k}`])} (+${fmtNum(d, 0)} pips · ${fmtNum(d / it.plan.slPips, 1)} R)</dd>`;
      }).join('')}
      <dt>Gestion</dt><dd>${z?.smc
        ? `50 % encaissés à TP1 + stop au point mort · reste (50 %) jusqu'à TP2 (objectif final) · aucun trailing · ordre limite expirant le ${fmtT(z.smc.expiresAt)}`
        : it.category === 'swing'
        ? '1/3 encaissé à chaque niveau · BE (± 3 pips) dès TP1 ET +1R atteints · trailing structurel (swings) après le BE · TP2 (+400) → stop ≥ TP1 · +600 pips → notification de clôture manuelle'
        : '1/3 encaissé à chaque niveau · BE (± 3 pips) dès TP1 ET +1R atteints · trailing structurel (swings) après le BE · TP2 (+200) → stop ≥ TP1 · TP3 (+350) → trade terminé'}${it.plan.slBufferPips != null && !it.smc ? ` · marge SL ${fmtNum(it.plan.slBufferPips, 0)} pips` : ''}</dd>
      ${p.state === POS.OPEN && p.stop != null ? `<dt>Stop actuel</dt><dd class="num"><b>${fmtP(p.stop)}</b></dd>` : ''}
      <dt>Lot</dt><dd class="num">${fmtNum(it.lot, 2)}${it.lotSuggested != null ? ` <small class="dd-note">lot conseillé ${fmtNum(it.lotSuggested, 2)} (risque ${fmtNum(state.settings.risk.riskPct, 1)} % du capital)</small>` : ''}</dd>
      ${p.fillTime ? `<dt>Prix arrivé sur l'ordre</dt><dd>${fmtT(p.fillTime)} à <span class="num">${fmtP(p.fillPrice)}</span></dd>` : ''}
      ${p.exitTime && (p.state === POS.TP || p.state === POS.SL) ? `<dt>Sortie</dt><dd>${fmtT(p.exitTime)} à <span class="num">${fmtP(p.exitPrice)}</span></dd>` : ''}
      <dt>${z?.smc ? 'Micro-zone LTF' : 'Zone C1'}</dt><dd class="num">${fmtP(it.zoneLow)} – ${fmtP(it.zoneHigh)}</dd>
      ${z && !z.smc ? `<dt>Imbalance</dt><dd class="num">${fmtP(z.gap)}${z.atr ? ` (ATR ${fmtP(z.atr)})` : ''}${z.fragile ? ' · fragile' : ''}</dd>` : ''}
      ${it.score?.confidence != null ? `<dt>Fiabilité apprise</dt><dd>${it.score.confidence} / 100 (espérance ${fmtR(it.score.expR)})</dd>` : ''}
      ${it.verdict ? `<dt>Verdict de l'auditeur</dt><dd>${esc(it.verdict)}${it.reasons.length ? ' : ' + esc(it.reasons.join(' ; ')) : ''}</dd>` : ''}
      <dt>Suivi</dt><dd>${it.followed ? (p.fromBacktest ? 'Suivi par toi, exécution reprise de la simulation.' : 'Suivi par toi depuis l\'ordre en attente.') : 'Non suivi : résultat simulé sur l\'historique chargé.'}</dd>
    </dl>
    ${it.followed ? `<label class="note-in">Note<textarea id="zdNote" maxlength="500" rows="2" placeholder="Notes personnelles sur ce trade…">${esc(p.note || '')}</textarea></label>` : ''}
    ${z && !z.smc ? `<table class="ohlc"><thead><tr><th></th><th>Heure</th><th>O</th><th>H</th><th>L</th><th>C</th></tr></thead><tbody>${rows}</tbody></table>
    ${z.smc ? '' : `<ul class="checks">
      <li>Liquidité : P.${buy ? 'low' : 'high'} ${fmtP(buy ? z.candles.P.low : z.candles.P.high)} balaie ${fmtP(z.liquidity.level)} (extrême des ${z.liquidity.lookback} bougies précédentes), clôture ${fmtP(z.candles.P.close)} ${buy ? 'au-dessus' : 'en dessous'}</li>
      <li>Order block : C1 ${buy ? 'baissière' : 'haussière'}, C3 ${buy ? 'haussière' : 'baissière'}</li>
      <li>Imbalance stricte : ${buy ? `C1.high ${fmtP(z.candles.C1.high)} &lt; C3.low ${fmtP(z.candles.C3.low)}` : `C1.low ${fmtP(z.candles.C1.low)} &gt; C3.high ${fmtP(z.candles.C3.high)}`}</li>
      <li class="${z.firstTouch ? 'info' : ''}">${z.firstTouch ? `Zone atteinte le ${fmtT(z.firstTouch.time)} : plus viable pour une nouvelle entrée` : `Aucun retest sur ${z.barsChecked} bougie(s) après C3`}</li>
    </ul>`}
    <div class="chips">${feats}</div>` : ''}
    <p class="hint">Positions simulées, aucun ordre n'est envoyé à un courtier. Analyse informative uniquement, pas un conseil financier personnalisé.</p>`;
  const fb = $('#zdFollow');
  if (fb) fb.onclick = () => toggleFollow(id, it.followed ? fb : null);
  const lot = $('#zdLot');
  if (lot) lot.onchange = () => { if (setEntryLot(state.journal, id, +lot.value)) { save(K.journal, state.journal); recompute(); toast('Lot du trade mis à jour.'); } };
  const noteEl = $('#zdNote');
  if (noteEl) noteEl.onchange = () => { setJournalNote(id, noteEl.value); };
  if (!$('#zoneDialog').open) $('#zoneDialog').showModal();
}

/** Bascule l'affichage des réglages « Stratégie » selon le mode choisi (SMC recommandée / OB5 historique) :
 * les réglages qui n'ont d'effet que sur l'ancienne stratégie 5★ (mode d'objectifs, filtre de tendance)
 * sont masqués en mode SMC (déterministe, sans ces réglages). */
function syncStrategyModeUi(mode) {
  const smc = mode !== 'ob5';
  const ob5 = $('#ob5OnlySettings'); if (ob5) ob5.hidden = smc;
  const hs = $('#strategyHintSmc'); if (hs) hs.hidden = !smc;
  const ho = $('#strategyHintOb5'); if (ho) ho.hidden = smc;
}

// ── réglages ─────────────────────────────────────────────────────────────
function openPairing() {
  openSettings();
  if (!state.server) setTimeout(() => $('#settingsForm').pairCode.focus(), 50);
}

function openSettings() {
  const f = $('#settingsForm'), s = state.settings, r = s.risk;
  f.liquidityLookback.value = s.liquidityLookback; f.fragileGapAtrRatio.value = s.fragileGapAtrRatio;
  f.liveSec.value = String(s.liveSec); f.notify.checked = s.notify;
  f.notifyNews.checked = s.notifyNews; f.newsAlertMin.value = String(s.newsAlertMin);
  f.minSamples.value = s.learning.minSamples; f.threshold.value = s.learning.threshold;
  $('#tfChecks').innerHTML = TIMEFRAMES.map((tf) => `<label><input type="checkbox" name="tf" value="${tf}" ${s.timeframes.includes(tf) ? 'checked' : ''}> ${TF_LABEL[tf]}</label>`).join('');
  // Risque & coûts (§1, §2)
  f.capital.value = r.capital; f.riskPct.value = r.riskPct; f.maxDailyLossPct.value = r.maxDailyLossPct;
  f.slippagePips.value = r.slippagePips;
  const mkt = marketById(s.market) || marketById(DEFAULT_MARKET);
  $('#riskMarketLabel').textContent = mkt.label;
  f.spreadOverride.placeholder = `défaut ${fmtNum(mkt.spreadPips, 1)}`;
  f.spreadOverride.value = r.spreadOverrides?.[mkt.id] ?? '';
  f.brokerOffset.value = r.brokerOffset?.[mkt.id] ?? '';
  // Stratégie (§1) : stratégie active, mode d'objectifs, filtre de tendance, séances
  f.strategyMode.value = r.strategyMode === 'ob5' ? 'ob5' : 'smc';
  syncStrategyModeUi(f.strategyMode.value);
  f.targetMode.value = r.targetMode === 'pips' ? 'pips' : 'atr';
  f.htfFilter.checked = r.htfFilter !== false;
  $('#sessionChecks').innerHTML = SESSIONS.map((sess) => `<label><input type="checkbox" name="sessions" value="${esc(sess)}" ${r.sessions?.includes(sess) ? 'checked' : ''}> ${esc(sess)}</label>`).join('');
  $('#pcRemote').hidden = !state.server;
  $('#bgBox').hidden = !nativePlugin('LiveKeeper');
  if (!$('#bgBox').hidden) refreshBatteryStatus();
  $('#phoneRemote').hidden = state.server;
  if (state.server) refreshAdmin();
  else { f.remoteUrl.value = s.remoteUrl || ''; f.deviceName.value = s.deviceName || 'Téléphone'; f.pairCode.value = usablePairCode(provisionCache) || ''; refreshPairStatus(); }
  $('#settingsDialog').showModal();
}

// ── PC : administration de l'accès distant ───────────────────────────────
async function refreshAdmin() {
  try {
    const st = await adminApi.remote();
    const box = $('#remoteStatus');
    if (st.disabled) box.textContent = 'Accès distant désactivé (--no-remote).';
    else if (!st.installed) box.innerHTML = '<b>Tailscale non installé.</b> Installe-le sur ce PC et sur le téléphone (même compte), puis lance <code>acces-distant.bat</code>.';
    else if (!st.serving) box.innerHTML = `Tailscale connecté${st.online ? '' : ' (hors ligne)'}, mais l'API téléphone n'est pas publiée : lance <code>acces-distant.bat</code>.`;
    else box.innerHTML = `✓ Accès distant actif. Adresse à saisir sur le téléphone :<br><b class="num sel-all">${esc(st.url)}</b>`;
    box.className = `status-box ${st.serving ? 'ok' : 'warn'}`;
  } catch { $('#remoteStatus').textContent = 'État de l\'accès distant indisponible.'; }
  try {
    const { devices } = await adminApi.devices();
    const el = $('#deviceList');
    el.innerHTML = devices.length ? devices.map((d) => `<div class="mini-row"><div><b>${esc(d.name)}</b><small>${esc(d.login || '')} · appairé le ${new Date(d.createdAt).toLocaleDateString('fr-FR')} · vu ${new Date(d.lastSeen).toLocaleString('fr-FR')}${d.expired ? ' · EXPIRÉ' : ''}</small></div><button type="button" class="btn small" data-revoke="${esc(d.id)}">Révoquer</button></div>`).join('') : '<small class="hint">Aucun appareil autorisé.</small>';
    el.querySelectorAll('[data-revoke]').forEach((b) => (b.onclick = async () => {
      if (!confirmInline(b)) return;
      try { await adminApi.revoke(b.dataset.revoke); toast('Appareil révoqué : il n\'a plus accès au PC.'); } catch (e) { toast(e.message); }
      refreshAdmin();
    }));
  } catch { /* */ }
  try {
    const sec = await adminApi.security();
    $('#secLog').innerHTML = (sec.locked ? '<div class="mini-row alert">⚠ Accès distant verrouillé 15 min après trop d\'échecs.</div>' : '')
      + (sec.alerts ? `<div class="mini-row alert">⚠ ${sec.alerts} événement(s) suspect(s) sur 24 h.</div>` : '')
      + (sec.events.slice(0, 12).map((ev) => `<div class="mini-row"><small>${esc(new Date(ev.t).toLocaleString('fr-FR'))} · <b>${esc(EVENT_FR[ev.event] || ev.event)}</b>${ev.login ? ' · ' + esc(ev.login) : ''}${ev.name ? ' · ' + esc(ev.name) : ''}</small></div>`).join('') || '<small class="hint">Aucun événement.</small>');
  } catch { /* */ }
}
const EVENT_FR = {
  server_started: 'Serveur démarré', pairing_code_created: 'Code d\'appairage créé', device_paired: 'Appareil appairé', device_revoked: 'Appareil révoqué',
  pair_fail_bad_code: 'Code d\'appairage erroné', pair_fail_no_code: 'Appairage sans code valide', pairing_code_burned: 'Code annulé (trop d\'essais)',
  auth_fail_missing: 'Accès sans jeton', auth_fail_unknown_token: 'Jeton inconnu', auth_fail_expired: 'Jeton expiré', auth_fail_login_mismatch: 'Compte Tailscale différent',
  remote_locked: 'Accès distant verrouillé', remote_rate_limited: 'Trop de requêtes', remote_origin_rejected: 'Origine refusée',
  remote_rejected_no_tailscale: 'Accès hors Tailscale refusé', local_csrf_rejected: 'Requête locale suspecte refusée', pair_rejected_max_devices: 'Trop d\'appareils',
};

function bindAdmin() {
  $('#newCodeBtn').onclick = async () => {
    try {
      const { code, expiresAt } = await adminApi.newCode();
      const box = $('#pairCodeBox');
      box.hidden = false;
      box.innerHTML = `Code : <b class="num">${esc(code.slice(0, 4))} ${esc(code.slice(4))}</b><small>À saisir sur le téléphone avant ${new Date(expiresAt).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })} · usage unique</small>`;
      setTimeout(() => { box.hidden = true; box.textContent = ''; }, Math.max(0, expiresAt - Date.now()));
      refreshAdmin();
    } catch (e) { toast(e.message); }
  };
  $('#setupTvBtn').onclick = async () => {
    const b = $('#setupTvBtn');
    if (!confirmInline(b)) return;
    b.disabled = true;
    try {
      const r = await adminApi.setupTv(); // « Vérifier les marchés TradingView » : résout les 11 marchés sur le graphique UNIQUE (recherche), n'en crée jamais un second.
      const ok = r.resolved.filter((x) => x.ok).length;
      const bad = r.resolved.filter((x) => !x.ok);
      toast(bad.length
        ? `${ok}/${r.resolved.length} marchés reconnus sur TradingView. Introuvable(s) : ${bad.map((x) => x.label).join(', ')}.`
        : `Les ${ok} marchés suivis sont reconnus sur TradingView Desktop (1 seul graphique, aucun panneau créé).`);
    } catch (e) { toast(e.message); }
    b.disabled = false;
  };
  $('#loadHistoryBtn').onclick = async () => {
    const b = $('#loadHistoryBtn');
    b.disabled = true;
    try {
      const r = await adminApi.loadHistory();
      const detail = (r.results || []).map((x) => `${TF_LABEL[x.interval] || x.interval} ${x.bars}`).join(' · ');
      toast(detail ? `Historique chargé : ${detail}.` : 'Aucun graphique XAUUSD à charger.');
    } catch (e) { toast(e.message); }
    b.disabled = false;
  };
}

// ── téléphone : appairage ────────────────────────────────────────────────
async function refreshPairStatus() {
  const paired = await isPaired();
  $('#pairStatus').textContent = paired ? '✓ Ce téléphone est appairé (jeton chiffré dans le Keystore Android).' : 'Non appairé.';
  $('#unpairBtn').hidden = !paired;
}
function bindPhone() {
  $('#settingsForm').pairCode.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); $('#pairBtn').click(); } });
  $('#pairBtn').onclick = async () => {
    const f = $('#settingsForm');
    const url = f.remoteUrl.value.trim();
    if (!remoteBase(url)) { toast('Adresse invalide : elle doit commencer par https://'); return; }
    state.settings.remoteUrl = remoteBase(url);
    state.settings.deviceName = f.deviceName.value.trim().slice(0, 40) || 'Téléphone';
    save(K.settings, state.settings);
    try {
      const r = await pair(state.settings, f.pairCode.value.trim());
      f.pairCode.value = '';
      toast(r.secure ? 'Téléphone connecté au PC.' : 'Connecté pour cette session uniquement (coffre chiffré indisponible).');
      syncAnalyseButtonLabel();
      await refreshPairingBanner();
      $('#settingsDialog').close();
      if (!state.live) toggleLive();
    } catch (e) { toast(e.message); }
    refreshPairStatus();
  };
  $('#unpairBtn').onclick = async () => {
    if (!confirmInline($('#unpairBtn'))) return;
    await unpair(); toast('Jeton supprimé de ce téléphone. Pense à révoquer l\'appareil sur le PC.'); refreshPairStatus();
    await refreshPairingBanner();
  };
}

async function onSettingsSubmit(e) {
  e.preventDefault();
  const f = e.target, s = state.settings;
  const tfs = [...f.querySelectorAll('input[name=tf]:checked')].map((x) => x.value).filter((x) => TIMEFRAMES.includes(x));
  if (!state.server && f.remoteUrl.value.trim()) {
    const b = remoteBase(f.remoteUrl.value);
    if (!b) { toast('Adresse invalide : elle doit commencer par https://'); return; }
    s.remoteUrl = b; s.deviceName = f.deviceName.value.trim().slice(0, 40) || 'Téléphone';
  }
  Object.assign(s, {
    liquidityLookback: clamp(Math.round(+f.liquidityLookback.value) || 5, 1, 100),
    fragileGapAtrRatio: clamp(+f.fragileGapAtrRatio.value || 0, 0, 2),
    liveSec: [5, 10, 15, 30, 60].includes(+f.liveSec.value) ? +f.liveSec.value : 15,
    timeframes: tfs.length ? tfs : [...TIMEFRAMES], notify: f.notify.checked,
    notifyNews: f.notifyNews.checked, newsAlertMin: [5, 15, 30, 60].includes(+f.newsAlertMin.value) ? +f.newsAlertMin.value : 30,
    learning: { minSamples: clamp(Math.round(+f.minSamples.value) || 8, 3, 100), threshold: clamp(+f.threshold.value || -0.15, -2, 0), minSamplesV20: true },
  });
  // Risque & coûts, Stratégie (§1, §2) : capital/risque/coûts/décalage courtier/mode d'objectifs/tendance/séances
  const mkt = marketById(s.market) || marketById(DEFAULT_MARKET);
  const spreadOverrides = { ...(s.risk.spreadOverrides || {}) };
  const brokerOffset = { ...(s.risk.brokerOffset || {}) };
  if (f.spreadOverride.value.trim() === '') delete spreadOverrides[mkt.id]; else spreadOverrides[mkt.id] = clamp(+f.spreadOverride.value || 0, 0, 200);
  if (f.brokerOffset.value.trim() === '' || +f.brokerOffset.value === 0) delete brokerOffset[mkt.id]; else brokerOffset[mkt.id] = +f.brokerOffset.value;
  const sessions = [...f.querySelectorAll('input[name=sessions]:checked')].map((x) => x.value).filter((x) => SESSIONS.includes(x));
  Object.assign(s.risk, {
    capital: clamp(+f.capital.value || 1000, 1, 10000000),
    riskPct: clamp(+f.riskPct.value || 1, 0.1, 20),
    maxDailyLossPct: clamp(+f.maxDailyLossPct.value || 3, 0.5, 100),
    slippagePips: clamp(+f.slippagePips.value || 0, 0, 50),
    spreadOverrides, brokerOffset, sessions,
    strategyMode: f.strategyMode.value === 'ob5' ? 'ob5' : 'smc',
    htfFilter: !!f.htfFilter.checked,
    targetMode: f.targetMode.value === 'pips' ? 'pips' : 'atr', targetModeV: 1,
  });
  if (s.notify || s.notifyNews) await askNotifyPermission();
  ensureTfInCat();
  save(K.settings, s);
  $('#settingsDialog').close();
  runOnce();
}

function openRisk() {
  const f = $('#riskForm'), r = state.settings.risk;
  const smc = r.strategyMode !== 'ob5';
  f.lot.value = r.lot;
  f.eurUsdManual.value = r.eurUsdManual; f.newsBlackoutMin.value = r.newsBlackoutMin;
  f.entryMode.value = r.entryMode || 'confirmation';
  f.accept.checked = !!r.validated; f.autoFollow.checked = !!r.autoFollow;
  $('#riskObInfo').hidden = smc;
  $('#riskSmcInfo').hidden = !smc;
  $('#slHintOb5').hidden = smc;
  $('#slHintSmc').hidden = !smc;
  riskPreview();
  renderAutoPlan();
  $('#riskDialog').showModal();
}

/** Le pip et la taille de contrat ne sont plus réglables ici : ce sont des propriétés du marché
 * (markets.js, §2) — fusionnées via marketRisk(...) dans le risque effectif (riskForMarket/runAgents). */
function readRisk(f) {
  return {
    ...state.settings.risk,
    lot: clamp(+f.lot.value || 0.1, 0.01, 100),
    eurUsd: 'manual', eurUsdManual: clamp(+f.eurUsdManual.value || 1.08, 0.5, 2), autoFollow: !!f.autoFollow.checked,
    newsBlackoutMin: clamp(+f.newsBlackoutMin.value || 0, 0, 240),
    entryMode: f.entryMode.value === 'limit' ? 'limit' : 'confirmation', minStars: 5, // seules les zones 5★ sont valides
  };
}

function riskPreview() {
  const r = readRisk($('#riskForm'));
  const rate = r.eurUsdManual;
  const mr = marketRisk(marketById(state.settings.market), { quotePrice: state.out?.currentPrice, spreadOverride: r.spreadOverrides?.[state.settings.market], slippagePips: r.slippagePips });
  const one = money(1, { ...r, ...mr }, rate).eur;
  $('#riskPreview').innerHTML = `1 pip = <b>${fmtEur(one)}</b> · 100 pips = <b>${fmtEur(one * 100)}</b> (EUR/USD ${fmtNum(rate, 4)}, ${esc(marketById(state.settings.market)?.label || '')}). La perte possible de chaque trade est affichée dans son détail.`;
}

/** Résumé de l'échelle d'objectifs fixe (SL/TP automatiques) par catégorie. */
function autoPlanLines() {
  const adaptive = state.settings.risk.targetMode !== 'pips';
  return Object.entries(CATEGORIES).map(([cat, c]) => {
    const bufAtr = CATEGORY_DEFAULTS[cat].bufAtr;
    let ladder;
    if (adaptive) {
      ladder = cat === 'swing' ? '1,5 R / 4 R / 6 R (adaptatif, selon le stop réel)' : '1,5 R / 3 R / 5 R (adaptatif, selon le stop réel)';
    } else {
      ladder = cat === 'swing' ? '+100 / +400 / +600 (le +600 est une clôture manuelle)' : '+100 / +200 / +350';
    }
    return `<b>${c.label}</b> : TP1/TP2/TP3 ${ladder} depuis l'entrée · marge SL ${bufAtr * 100} % ATR`;
  }).join('<br>');
}

function renderAutoPlan() {
  const el = $('#autoPlan');
  if (!el) return;
  if (state.settings.risk.strategyMode !== 'ob5') {
    el.innerHTML = `Stratégie active : <b>Smart Money HTF → LTF &amp; Fibonacci</b>. Le stop et les objectifs (TP1, TP2) sont calculés setup par setup (voir le détail de chaque zone) : stop derrière la micro-zone LTF, TP1 = liquidité 15m (50 % + BE), TP2 = liquidité HTF. Aucun setup avec R:R entrée → TP2 inférieur à <b>1:3</b> n'est proposé.`;
    return;
  }
  const adaptive = state.settings.risk.targetMode !== 'pips';
  const maxSl = adaptive ? `${fmtNum(state.settings.risk.maxSlAtr ?? MAX_SL_ATR, 1)} × ATR de l'unité de temps de la zone` : `${MAX_SL_PIPS} pips`;
  el.innerHTML = `Le <b>stop loss</b> est placé automatiquement juste au-delà de l'order block (marge selon la catégorie, basée sur l'ATR). <b>Règle stricte :</b> le risque (entrée → SL) ne doit jamais dépasser <b>${maxSl}</b> ; au-delà, la zone est refusée (« non viable »), y compris si l'entrée réelle après confirmation dépasse ce seuil. Mode d'objectifs actuel : <b>${adaptive ? 'adaptatif (R et ATR)' : 'échelle fixe en pips'}</b> (réglable dans « Réglages » → « Stratégie »). Les objectifs (<b>TP1, TP2, TP3</b>) par catégorie :<br>${autoPlanLines()}`;
}

function onRiskSubmit(e) {
  e.preventDefault();
  const f = e.target;
  if (!f.accept.checked) return;
  state.settings.risk = { ...readRisk(f), validated: true, validatedAt: new Date().toISOString() };
  save(K.settings, state.settings);
  $('#riskDialog').close();
  toast(state.settings.risk.autoFollow ? 'Paramétrage validé : toutes les opportunités validées seront suivies.' : 'Paramétrage validé : appuie sur « Suivre » pour chaque trade que tu prends.');
  runOnce();
}

async function askNotifyPermission() {
  try {
    const LN = nativePlugin('LocalNotifications');
    if (LN) { await LN.requestPermissions(); return; }
    if ('Notification' in window && Notification.permission === 'default') await Notification.requestPermission();
  } catch { /* */ }
}

// ── utilitaires ──────────────────────────────────────────────────────────
function showBanner(msg, kind = 'error', action, fn) {
  const b = $('#banner');
  b.className = `banner ${kind === 'info' ? 'info' : kind === 'ok' ? 'ok' : ''}`;
  b.textContent = msg;
  if (action) { const btn = document.createElement('button'); btn.className = 'btn small'; btn.textContent = action; btn.onclick = fn; b.appendChild(btn); }
  b.hidden = false;
}
function hideBanner() { $('#banner').hidden = true; }
function toast(msg) { const t = document.createElement('div'); t.className = 'toast'; t.textContent = msg; $('#toasts').appendChild(t); setTimeout(() => t.remove(), 6000); }
/** Décimales du marché en cours (dérivées de son pip, cf. markets.js) : 2 (XAUUSD) par défaut. */
function activeDecimals() { return (state.out?.market || marketById(state.settings.market))?.decimals ?? 2; }
function fmtP(v, decimals = activeDecimals()) { return v == null ? '—' : nf(decimals).format(v).replace(/ /g, ' '); }
void STATUS_LABEL;

init();
