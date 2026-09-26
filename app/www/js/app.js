import { TIMEFRAMES, TF_LABEL, TF_SECONDS, STATUS_LABEL, DEFAULT_OPTIONS, CATEGORIES, normalizeCandles } from './engine.js';
import { fetchAll, hasLocalServer, isNativeApp, pair, unpair, isPaired, remoteBase, adminApi } from './providers.js';
import { CandleChart } from './chart.js';
import { runAgents, followZone, unfollowZone, setEntryLot, transitions } from './agents.js';
import { DEFAULT_RISK, POS, POS_LABEL, MAX_SL_PIPS, CATEGORY_DEFAULTS, balance, money, notifText } from './trades.js';
import { featureLabel, valueLabel } from './learning.js';

const $ = (s) => document.querySelector(s);
const K = { settings: 'xauz.settings.v2', journal: 'xauz.journal.v1', learn: 'xauz.learn.v1', seen: 'xauz.seen.v2', watch: 'xauz.watch.v1' };
const DEMO = new URLSearchParams(location.search).has('demo');
/** Adresse Tailscale du PC, préréglée dans l'application (remplacée par www/provision.json à chaque compilation). */
const DEFAULT_REMOTE_URL = 'https://joshua.taila406c5.ts.net/';

const DEFAULT_SETTINGS = {
  remoteUrl: DEFAULT_REMOTE_URL, deviceName: 'Téléphone',
  liquidityLookback: DEFAULT_OPTIONS.liquidityLookback, fragileGapAtrRatio: DEFAULT_OPTIONS.fragileGapAtrRatio,
  liveSec: 15, timeframes: [...TIMEFRAMES], notify: true,
  risk: structuredClone(DEFAULT_RISK),
  learning: { minSamples: 8, threshold: -0.15 },
};

const load = (k, fb) => { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : fb; } catch { return fb; } };
const save = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* stockage indisponible */ } };

function loadSettings() {
  const s = { ...DEFAULT_SETTINGS, ...load(K.settings, load('xauz.settings.v1', {})) };
  s.risk = { ...structuredClone(DEFAULT_RISK), ...(s.risk || {}) };
  delete s.risk.maxSlPips; // v4 : plus de stop maximal, le stop est l'invalidation de la zone
  delete s.risk.rr; delete s.risk.slBufferPips; delete s.risk.tp1MinPips; // v6 : SL et TP entièrement automatiques
  if (!s.risk.strategyV) { s.risk.entryMode = 'confirmation'; s.risk.strategyV = 5; } // migration « 5 étoiles »
  if (!s.allTfMigrated) { s.timeframes = [...TIMEFRAMES]; s.allTfMigrated = true; } // migration : toutes les TF (1/5/15/60/240/D) activées par défaut
  s.risk.minStars = 5; // seules les zones 5★ sont valides (moins de 5★ = invalidée) ; jamais réglable
  s.learning = { ...DEFAULT_SETTINGS.learning, ...(s.learning || {}) };
  // minimisation des données : anciennes clés de fournisseurs supprimées
  for (const k of ['source', 'oandaToken', 'oandaEnv', 'twelveKey', 'pcUrl', 'pairCode']) delete s[k];
  s.risk.eurUsd = 'manual';
  if (!remoteBase(s.remoteUrl || '')) s.remoteUrl = DEFAULT_REMOTE_URL;
  delete s.count; // « Bougies par TF » supprimé : toutes les bougies chargées dans TradingView sont utilisées
  return s;
}

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
};
state.learn.disabled ||= [];
// v4 : seules les zones que l'utilisateur a marquées « suivies » restent dans le journal réel
state.journal.entries = (state.journal.entries || []).filter((j) => j.followed);

const chart = new CandleChart($('#chart'), { onZoneClick: (id) => openDetail(id) });

// ── démarrage ─────────────────────────────────────────────────────────────
async function init() {
  state.server = await hasLocalServer();
  save(K.settings, state.settings);
  try { state.cal = await (await fetch('data/calendar.json')).json(); } catch { state.cal = null; }
  bindUi();
  setupNotifications();
  renderAll();
  if (DEMO) { runOnce(); return; }
  if (!state.server) await applyProvision();
  if (!state.server && !(await isPaired())) {
    showBanner('Pour commencer, saisis le code d\'appairage affiché sur ton PC.', 'info', 'Saisir le code', openPairing);
  } else if (!state.settings.risk.validated) {
    showBanner('Valide ton lot et ton stop loss, puis appuie sur « Suivre » pour chaque trade que tu prends.', 'info', 'Lot & stop', openRisk);
  }
}

/** Adresse du PC écrite dans l'APK à chaque compilation (installer-android) : elle prime sur l'adresse par défaut. */
async function applyProvision() {
  let pv = null;
  try { pv = await (await fetch('provision.json', { cache: 'no-store' })).json(); } catch { return; }
  const url = pv?.remoteUrl ? remoteBase(pv.remoteUrl) : null;
  if (url && url !== state.settings.remoteUrl) { state.settings.remoteUrl = url; save(K.settings, state.settings); }
}

function bindUi() {
  $('#analyseBtn').onclick = toggleLive;
  $('#settingsBtn').onclick = openSettings;
  $('#riskBtn').onclick = openRisk;
  $('#showBands').onchange = () => renderChart(true);
  segment('#catTabs', (v) => { state.cat = v; ensureTfInCat(); renderAll(false); });
  segment('#panelTabs', (v) => { state.panel = v; for (const p of ['positions', 'agents', 'learning']) $(`#pane-${p}`).hidden = p !== v; });
  segment('#stateFilter', (v) => { state.stateFilter = v; renderPositions(); });
  segment('#dirFilter', (v) => { state.dirFilter = v; renderPositions(); });
  segment('#scopeSeg', (v) => { state.scope = v; renderBalance(); renderPositions(); });
  $('#settingsForm').addEventListener('submit', onSettingsSubmit);
  $('#riskForm').addEventListener('submit', onRiskSubmit);
  $('#riskForm').addEventListener('input', riskPreview);
  bindAdmin(); bindPhone();
  $('#batteryBtn').onclick = async () => { try { await window.Capacitor.Plugins.LiveKeeper.requestBatteryExemption(); } catch { toast('Réglage batterie indisponible sur ce téléphone.'); } };
  $('#resetJournal').onclick = () => { if (confirmInline('#resetJournal')) { state.journal = { entries: [] }; save(K.journal, state.journal); renderAll(); toast('Journal effacé.'); } };
  $('#resetLearning').onclick = () => { if (confirmInline('#resetLearning')) { state.learn = { samples: {}, disabled: [], acceptedRules: [], config: null, configHistory: [], quarantine: { rules: {} } }; save(K.learn, state.learn); toast('Apprentissage réinitialisé.'); } };
  document.addEventListener('visibilitychange', () => { if (!document.hidden && state.live) runOnce(); });
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
function toggleLive() {
  state.live = !state.live;
  const b = $('#analyseBtn');
  b.classList.toggle('live', state.live);
  b.setAttribute('aria-pressed', String(state.live));
  b.querySelector('.lbl').textContent = state.live ? 'En direct' : 'Analyser';
  b.title = state.live ? 'Arrêter l\'analyse en temps réel' : 'Lancer l\'analyse en temps réel';
  clearTimeout(state.timer);
  keepAlive(state.live);
  if (state.live) runOnce();
}

function scheduleNext() {
  clearTimeout(state.timer);
  if (state.live) state.timer = setTimeout(runOnce, state.settings.liveSec * 1000);
}

/** Bougie la plus ancienne à redemander pour chaque TF activée (dernière bougie en cache − 2 bougies) ; null si le cache est incomplet (première analyse → tout retélécharger). */
function computeSince() {
  const prev = state.data?.candles;
  if (!prev) return null;
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

async function runOnce() {
  if (state.running) return;
  state.running = true;
  $('#analyseBtn').classList.add('busy');
  try {
    const s = state.settings;
    const since = DEMO ? null : computeSince();
    const data = DEMO && state.server ? await import('./demo.js').then((m) => m.demoData(s)) : await fetchAll(s, { serverAvailable: state.server, since });
    const prevCandles = state.data?.candles || {};
    const candles = {};
    for (const tf of s.timeframes) {
      if (data.errors?.[tf]) { candles[tf] = prevCandles[tf] || []; continue; } // erreur sur cette TF : on garde le cache
      const norm = normalizeCandles(data.candles?.[tf] || []);
      candles[tf] = since != null ? mergeCandles(prevCandles[tf], norm) : norm;
    }
    state.data = { ...data, candles };
    const out = runAgents({ data: state.data, settings: s, cal: state.cal, learnStore: state.learn, journal: state.journal });
    state.out = out;
    save(K.journal, state.journal);
    save(K.learn, state.learn);
    handleEvents(out);
    const errs = Object.entries(data.errors || {});
    if (DEMO) showBanner('Mode démo : données simulées, uniquement pour tester l\'interface.', 'info');
    else if (!s.risk.validated) showBanner('Valide ton lot et ton stop loss, puis appuie sur « Suivre » pour chaque trade que tu prends.', 'info', 'Lot & stop', openRisk);
    else if (out.guards?.dailyBreaker) showBanner('Pause : 2 pertes aujourd\'hui, protection du capital.', 'info');
    else if (errs.length) showBanner(`Timeframes indisponibles : ${errs.map(([tf, m]) => `${TF_LABEL[tf]} (${m})`).join(' · ')}`, 'info');
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
  state.newIds = new Set();
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
      if (!firstRun && !blocked) { notes.push(notifText('new', tpl(a), { tfLabel, reducedSize: guards?.reducedSize })); state.watch[a.id] = { state: a.pos.state, hits: 0, beDone: false, trailFrom: null }; }
    }
    // suivi des opportunités notifiées (non suivies) : TP1, BE, trailing…
    const w = state.watch[a.id];
    if (w && !followed.has(a.id)) {
      for (const type of transitions(w.state, w.hits, a.pos, w.beDone, w.trailFrom)) notes.push(notifText(type, tpl(a), { tfLabel, pips: a.pos.pips }));
      state.watch[a.id] = { state: a.pos.state, hits: a.pos.hits || 0, beDone: !!a.pos.beDone, trailFrom: a.pos.trailFrom ?? null };
      if (![POS.PENDING, POS.OPEN].includes(a.pos.state)) delete state.watch[a.id];
    }
  }
  save(K.seen, [...state.seen].slice(-3000));
  const ids = Object.keys(state.watch); if (ids.length > 200) for (const id of ids.slice(0, ids.length - 200)) delete state.watch[id];
  save(K.watch, state.watch);
  for (const ev of state.journal.events || []) {
    if (ev.type === 'new') continue;
    const j = ev.entry;
    notes.push(notifText(ev.type, { ...j, dir: j.dir }, { tfLabel: TF_LABEL[j.timeframe], pips: j.pips }));
  }
  notes.slice(0, 4).forEach((n) => toast(`${n.title} — ${n.body}`));
  if (notes.length && state.settings.notify) notify(notes);
}

let notifId = Date.now() % 1000000;
async function notify(notes) {
  try {
    const LN = window.Capacitor?.Plugins?.LocalNotifications;
    if (LN) {
      await LN.schedule({ notifications: notes.slice(0, 6).map((n) => ({
        id: ++notifId % 2147483647, title: n.title, body: n.body, largeBody: `${n.body}\n${n.detail || ''}`.trim(),
        summaryText: 'XAUUSD Zones', channelId: 'xauz_signals',
      })) });
    } else if ('Notification' in window && Notification.permission === 'granted') {
      for (const n of notes.slice(0, 6)) new Notification(n.title, { body: `${n.body}\n${n.detail || ''}`.trim(), icon: 'icons/icon.svg', tag: `${n.title}` });
    }
  } catch { /* notifications indisponibles */ }
}

/** Canal Android « Signaux de trading » : priorité haute (bannière + son). */
async function setupNotifications() {
  const LN = window.Capacitor?.Plugins?.LocalNotifications;
  if (!LN) return;
  try {
    await LN.createChannel({ id: 'xauz_signals', name: 'Signaux de trading', description: 'Opportunités, TP, BE, SL', importance: 5, visibility: 1, vibration: true });
    if (state.settings.notify) await LN.requestPermissions();
  } catch { /* */ }
}

/** Android : garde l'analyse en direct active en arrière-plan / écran éteint. */
async function keepAlive(on) {
  const LK = window.Capacitor?.Plugins?.LiveKeeper;
  if (!LK) return;
  try { if (on) await LK.start({ text: 'Analyse XAUUSD en direct · notifications actives' }); else await LK.stop(); } catch { /* */ }
}

// ── modèle de vue ────────────────────────────────────────────────────────
const inCat = (tf) => state.cat === 'all' || CATEGORIES[state.cat].tfs.includes(tf);
const visibleTfs = () => TIMEFRAMES.filter((tf) => state.settings.timeframes.includes(tf) && inCat(tf));
function ensureTfInCat() { const v = visibleTfs(); if (!v.includes(state.chartTf)) state.chartTf = v[0] || state.chartTf; }

function eurUsdRate() {
  const r = state.settings.risk;
  return r.eurUsdManual;
}
function eurOf(pips, lot) { return pips == null ? null : money(pips, state.settings.risk, eurUsdRate(), lot).eur; }

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
  return {
    id: (a || j).id, zone: a || null,
    direction: a?.direction ?? j.dir, timeframe: a?.timeframe ?? j.timeframe, category: a?.category ?? j.category,
    zoneLow: a?.zoneLow ?? j.zoneLow, zoneHigh: a?.zoneHigh ?? j.zoneHigh, c1Time: a?.c1Time ?? j.c1Time,
    plan: j ? { entry: j.entry, sl: j.sl, tp1: j.tp1 ?? j.tp, tp2: j.tp2 ?? j.tp, tp3: j.tp3 ?? j.tp, tp: j.tp3 ?? j.tp, rr: j.rr, slPips: j.slPips, tp1Pips: j.tp1Pips } : a.plan,
    proposal: a?.proposal ?? null, verdict: a?.verdict ?? null, reasons: a?.reasons ?? [], score: a?.score ?? null,
    grade: a?.grade ?? j?.grade ?? null, confluence: a?.confluence ?? [],
    lot: j?.lot ?? state.settings.risk.lot,
  };
}

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
}

function renderHeader() {
  const o = state.out;
  $('#price').textContent = o?.currentPrice != null ? fmtP(o.currentPrice) : '—';
  $('#sourceLine').textContent = state.data ? `${state.data.symbol} · ${state.data.source}` : (state.server ? 'PC · TradingView Desktop' : 'Téléphone · PC distant');
  $('#updated').textContent = o ? `analysé à ${new Date(o.analyzedAt).toLocaleTimeString('fr-FR')}` : 'pas encore analysé';
}

function renderBalance() {
  const r = state.settings.risk;
  const list = items();
  const positions = list.filter((x) => state.scope === 'reel' ? x.followed : !x.followed || x.zone).map((x) => ({ ...(state.scope === 'reel' ? x.pos : x.zone?.pos || x.pos), lot: x.lot }));
  const b = balance(positions, r, eurUsdRate());
  const sign = b.pips > 0 ? 'is-pos' : b.pips < 0 ? 'is-neg' : '';
  $('#balance').className = `balance ${sign} ${state.scope === 'reel' && !r.validated ? 'locked' : ''}`;
  const nFollowed = state.journal.entries.filter((j) => j.followed).length;
  $('#balScopeLabel').textContent = state.scope === 'reel'
    ? (r.validated ? `Mes trades suivis (${nFollowed})` : 'Lot et stop à valider avant de suivre un trade')
    : 'Backtest : toutes les zones, simulées sur l\'historique chargé';
  $('#balLot').textContent = `lot ${fmtNum(r.lot, 2)} · 1 pip = ${fmtEur(money(1, r, eurUsdRate()).eur)}`;
  $('#balPips').textContent = fmtPips(b.pips);
  $('#balEur').textContent = fmtEur(b.eur);
  $('#balRealized').innerHTML = `${fmtPips(b.realizedPips)}<small>${fmtEur(b.realizedEur)}</small>`;
  $('#balOpen').innerHTML = `${fmtPips(b.openPips)}<small>${b.open} ouverte(s)</small>`;
  $('#balWL').innerHTML = `<span class="g">✓ ${b.wins}</span> · <span class="r">✕ ${b.losses}</span><small>${b.pending} ordre(s) en attente</small>`;
  $('#balRate').innerHTML = `${b.winRate != null ? Math.round(b.winRate * 100) + ' %' : '—'}<small>${b.expectancyR != null ? fmtR(b.expectancyR) + ' / trade' : ''}</small>`;
  $('#riskBtn').classList.toggle('primary', !r.validated);
}

function renderTfTabs() {
  const tabs = $('#tfTabs');
  const viable = new Set((state.out?.audited || []).filter((a) => a.proposal === 'PROPOSEE' && a.pos.state === POS.PENDING).map((a) => a.timeframe));
  tabs.innerHTML = visibleTfs().map((tf) => `<button data-tf="${tf}" class="${tf === state.chartTf ? 'on' : ''}" role="tab" aria-selected="${tf === state.chartTf}"${viable.has(tf) ? ' aria-label="' + TF_LABEL[tf] + ', opportunité disponible"' : ''}>${TF_LABEL[tf]}${viable.has(tf) ? '<i class="dot" aria-hidden="true"></i>' : ''}</button>`).join('');
  tabs.querySelectorAll('button').forEach((b) => (b.onclick = () => { state.chartTf = b.dataset.tf; renderTfTabs(); renderChart(false); }));
}

function renderChart(keepView = true) {
  const candles = state.data?.candles?.[state.chartTf] || [];
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
  chart.setData(candles, zones, bands, state.out?.currentPrice ?? null, { keepView });
}

const TAB_EMPTY = {
  opp: '<strong>Aucune position 5★ actuellement. Attendre.</strong>Aucun order block ne passe le filtre 5 étoiles (moins de 5★ = invalidée), la règle SL ≤ 100 pips et les règles apprises. Laisse « Analyser » tourner : les nouvelles zones apparaissent ici.',
  followed: '<strong>Tu ne suis aucun trade.</strong>Dans « Opportunités », appuie sur <b>Suivre</b> quand tu prends un trade : il entre alors dans ta balance.',
  history: 'Aucun trade terminé dans l\'historique chargé.',
  nonval: 'Aucune zone écartée par l\'analyse.',
};

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
  if (!xs.length) { list.innerHTML = `<div class="empty">${TAB_EMPTY[state.stateFilter]}</div>`; return; }
  list.innerHTML = xs.slice(0, 250).map(card).join('');
  list.querySelectorAll('.pos').forEach((el) => {
    el.onclick = (e) => { if (!e.target.closest('.follow')) openDetail(el.dataset.id); };
    el.onkeydown = (e) => { if (e.key === 'Enter' && e.target === el) openDetail(el.dataset.id); };
  });
  list.querySelectorAll('.follow').forEach((b) => (b.onclick = (e) => { e.stopPropagation(); toggleFollow(b.dataset.id, b); }));
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

/** Recalcule P&L et balance sans nouvelle collecte (après suivi / changement de lot). */
function recompute() {
  if (state.data && state.out) {
    state.out = runAgents({ data: state.data, settings: state.settings, cal: state.cal, learnStore: state.learn, journal: state.journal });
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
function dirTag(d) { return `<span class="dir"><i aria-hidden="true">${d === 'BUY' ? '▲' : '▼'}</i>${dirFr(d, true)}</span>`; }
function followBtn(it) {
  const closed = it.pos.state === POS.TP || it.pos.state === POS.SL;
  if (it.followed) return `<button type="button" class="follow on" data-id="${it.id}" aria-pressed="true" title="Appuie deux fois pour ne plus suivre">✓ Suivi</button>`;
  if (!it.zone || it.pos.state === POS.CANCELLED) return '';
  return `<button type="button" class="follow" data-id="${it.id}" aria-pressed="false">${closed ? 'Je l\'ai pris' : 'Suivre'}</button>`;
}

function card(it) {
  const st = statusOf(it);
  const p = it.pos;
  const pnl = p.pips != null
    ? `<b class="${p.pips >= 0 ? 'g' : 'r'}">${fmtPips(p.pips)}</b><small>${fmtEur(eurOf(p.pips, it.lot))}</small>`
    : `<b>${fmtP(it.plan.entry)}</b><small>entrée</small>`;
  const conf = it.score?.confidence != null ? `<span class="conf" title="Indice de fiabilité appris">fiab. ${it.score.confidence}</span>` : '';
  const reducedSize = it.proposal === 'PROPOSEE' && state.out?.guards?.reducedSize;
  return `
  <article class="pos t-${st.tone} ${it.id === state.selected ? 'sel' : ''}" data-id="${it.id}" tabindex="0" aria-label="${esc(`${dirFr(it.direction, true)} ${CATEGORIES[it.category]?.label || ''} ${TF_LABEL[it.timeframe]}, ${st.text}`)}">
    <div class="l1">${dirTag(it.direction)}${catChip(it)}${starsTag(it.grade)}${it.confluence?.length ? `<span class="badge conf-tf" title="Zone présente aussi en ${it.confluence.map((t) => TF_LABEL[t]).join(', ')}">multi-UT</span>` : ''}${state.newIds.has(it.id) ? '<span class="badge new">nouveau</span>' : ''}${reducedSize ? '<span class="badge warn" title="3 pertes consécutives : préservation du capital">taille réduite conseillée : 50 % du lot</span>' : ''}</div>
    <div class="pnl num">${pnl}</div>
    <div class="l2"><span class="st t-${st.tone}"><i aria-hidden="true">${st.icon}</i>${esc(st.text)}</span></div>
    <div class="l2 r">${conf}</div>
    <div class="l3 num lv"><span>Entrée <b>${fmtP(it.plan.entry)}</b></span><span>SL <b>${fmtP(it.plan.sl)}</b></span><span class="risk">risque ${fmtNum(it.plan.slPips, 0)} pips</span></div>
    <div class="l3 num tps">${[1, 2, 3].map((k) => `<span class="${(p.hits || 0) >= k ? 'hit' : ''}">${k === 3 && it.category === 'swing' ? 'TP3 +600 (manuel)' : `TP${k}`} ${fmtP(it.plan[`tp${k}`])}${(p.hits || 0) >= k ? ' ✓' : ''}</span>`).join('')}</div>
    <div class="act">${followBtn(it)}</div>
  </article>`;
}

function renderAgents() {
  const el = $('#agentList');
  const reps = state.out?.reports || [];
  const bad = reps.filter((r) => r.status !== 'COMPLET').length;
  $('#cntAgents').textContent = reps.length ? (bad ? `${bad} ⚠` : '✓') : '';
  if (!reps.length) { el.innerHTML = '<div class="empty">Les rapports des agents apparaissent après l\'analyse.</div>'; return; }
  el.innerHTML = reps.map((r, i) => `
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
    <div class="chips top-chips">${catChip(it)}${dirTag(it.direction)}${starsTag(it.grade)}</div>
    ${z?.stars ? starsHtml(z) : ''}
    <dl class="kv">
      ${(it.plan.entryMode || state.settings.risk.entryMode) === 'limit' ? `<dt>Entrée (ordre limite)</dt><dd class="num"><b>${fmtP(it.plan.entry)}</b></dd>` : `<dt>Zone d'entrée (OB)</dt><dd class="num"><b>${fmtP(it.zoneLow)} – ${fmtP(it.zoneHigh)}</b><small class="dd-note">Entrée à la clôture de la première bougie ${it.direction === 'BUY' ? 'haussière' : 'baissière'} dans l'OB</small></dd>`}
      <dt>Stop loss (invalidation)</dt><dd class="num">${fmtP(it.plan.sl)} (−${fmtNum(it.plan.slPips, 0)} pips = ${fmtEur(eurOf(-it.plan.slPips, it.lot))})</dd>
      ${[1, 2, 3].map((k) => {
        const d = Math.abs(it.plan[`tp${k}`] - it.plan.entry) / state.settings.risk.pipSize;
        const label = k === 3 && it.category === 'swing' ? 'TP3 (+600, manuel)' : `TP${k}`;
        return `<dt>${label}${(p.hits || 0) >= k ? ' ✓' : ''}</dt><dd class="num">${fmtP(it.plan[`tp${k}`])} (+${fmtNum(d, 0)} pips · ${fmtNum(d / it.plan.slPips, 1)} R)</dd>`;
      }).join('')}
      <dt>Gestion</dt><dd>${it.category === 'swing'
        ? '1/3 encaissé à chaque niveau · BE (± 3 pips) dès TP1 ET +1R atteints · trailing structurel (swings) après le BE · TP2 (+400) → stop ≥ TP1 · +600 pips → notification de clôture manuelle'
        : '1/3 encaissé à chaque niveau · BE (± 3 pips) dès TP1 ET +1R atteints · trailing structurel (swings) après le BE · TP2 (+200) → stop ≥ TP1 · TP3 (+350) → trade terminé'}${it.plan.slBufferPips != null ? ` · marge SL ${fmtNum(it.plan.slBufferPips, 0)} pips` : ''}</dd>
      ${p.state === POS.OPEN && p.stop != null ? `<dt>Stop actuel</dt><dd class="num"><b>${fmtP(p.stop)}</b></dd>` : ''}
      <dt>Lot</dt><dd class="num">${fmtNum(it.lot, 2)}</dd>
      ${p.fillTime ? `<dt>Prix arrivé sur l'ordre</dt><dd>${fmtT(p.fillTime)} à <span class="num">${fmtP(p.fillPrice)}</span></dd>` : ''}
      ${p.exitTime && (p.state === POS.TP || p.state === POS.SL) ? `<dt>Sortie</dt><dd>${fmtT(p.exitTime)} à <span class="num">${fmtP(p.exitPrice)}</span></dd>` : ''}
      <dt>Zone C1</dt><dd class="num">${fmtP(it.zoneLow)} – ${fmtP(it.zoneHigh)}</dd>
      ${z ? `<dt>Imbalance</dt><dd class="num">${fmtP(z.gap)}${z.atr ? ` (ATR ${fmtP(z.atr)})` : ''}${z.fragile ? ' · fragile' : ''}</dd>` : ''}
      ${it.score?.confidence != null ? `<dt>Fiabilité apprise</dt><dd>${it.score.confidence} / 100 (espérance ${fmtR(it.score.expR)})</dd>` : ''}
      ${it.verdict ? `<dt>Verdict de l'auditeur</dt><dd>${it.verdict}${it.reasons.length ? ' : ' + esc(it.reasons.join(' ; ')) : ''}</dd>` : ''}
      <dt>Suivi</dt><dd>${it.followed ? (p.fromBacktest ? 'Suivi par toi, exécution reprise de la simulation.' : 'Suivi par toi depuis l\'ordre en attente.') : 'Non suivi : résultat simulé sur l\'historique chargé.'}</dd>
    </dl>
    ${z ? `<table class="ohlc"><thead><tr><th></th><th>Heure</th><th>O</th><th>H</th><th>L</th><th>C</th></tr></thead><tbody>${rows}</tbody></table>
    <ul class="checks">
      <li>Liquidité : P.${buy ? 'low' : 'high'} ${fmtP(buy ? z.candles.P.low : z.candles.P.high)} balaie ${fmtP(z.liquidity.level)} (extrême des ${z.liquidity.lookback} bougies précédentes), clôture ${fmtP(z.candles.P.close)} ${buy ? 'au-dessus' : 'en dessous'}</li>
      <li>Order block : C1 ${buy ? 'baissière' : 'haussière'}, C3 ${buy ? 'haussière' : 'baissière'}</li>
      <li>Imbalance stricte : ${buy ? `C1.high ${fmtP(z.candles.C1.high)} &lt; C3.low ${fmtP(z.candles.C3.low)}` : `C1.low ${fmtP(z.candles.C1.low)} &gt; C3.high ${fmtP(z.candles.C3.high)}`}</li>
      <li class="${z.firstTouch ? 'info' : ''}">${z.firstTouch ? `Zone atteinte le ${fmtT(z.firstTouch.time)} : plus viable pour une nouvelle entrée` : `Aucun retest sur ${z.barsChecked} bougie(s) après C3`}</li>
    </ul>
    <div class="chips">${feats}</div>` : ''}
    <p class="hint">Positions simulées, aucun ordre n'est envoyé à un courtier. Analyse informative uniquement, pas un conseil financier personnalisé.</p>`;
  const fb = $('#zdFollow');
  if (fb) fb.onclick = () => toggleFollow(id, it.followed ? fb : null);
  const lot = $('#zdLot');
  if (lot) lot.onchange = () => { if (setEntryLot(state.journal, id, +lot.value)) { save(K.journal, state.journal); recompute(); toast('Lot du trade mis à jour.'); } };
  if (!$('#zoneDialog').open) $('#zoneDialog').showModal();
}

// ── réglages ─────────────────────────────────────────────────────────────
function openPairing() {
  openSettings();
  if (!state.server) setTimeout(() => $('#settingsForm').pairCode.focus(), 50);
}

function openSettings() {
  const f = $('#settingsForm'), s = state.settings;
  f.liquidityLookback.value = s.liquidityLookback; f.fragileGapAtrRatio.value = s.fragileGapAtrRatio;
  f.liveSec.value = String(s.liveSec); f.notify.checked = s.notify;
  f.minSamples.value = s.learning.minSamples; f.threshold.value = s.learning.threshold;
  $('#tfChecks').innerHTML = TIMEFRAMES.map((tf) => `<label><input type="checkbox" name="tf" value="${tf}" ${s.timeframes.includes(tf) ? 'checked' : ''}> ${TF_LABEL[tf]}</label>`).join('');
  $('#pcRemote').hidden = !state.server;
  $('#bgBox').hidden = !window.Capacitor?.Plugins?.LiveKeeper;
  $('#phoneRemote').hidden = state.server;
  if (state.server) refreshAdmin();
  else { f.remoteUrl.value = s.remoteUrl || ''; f.deviceName.value = s.deviceName || 'Téléphone'; f.pairCode.value = ''; refreshPairStatus(); }
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
    try { const r = await adminApi.setupTv(); toast(`TradingView préparé : ${r.charts} graphique(s) XAUUSD (${r.timeframes.map((t) => TF_LABEL[t]).join(', ')}).`); }
    catch (e) { toast(e.message); }
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
      hideBanner();
      $('#settingsDialog').close();
      if (!state.live) toggleLive();
    } catch (e) { toast(e.message); }
    refreshPairStatus();
  };
  $('#unpairBtn').onclick = async () => {
    if (!confirmInline($('#unpairBtn'))) return;
    await unpair(); toast('Jeton supprimé de ce téléphone. Pense à révoquer l\'appareil sur le PC.'); refreshPairStatus();
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
    learning: { minSamples: clamp(Math.round(+f.minSamples.value) || 8, 3, 100), threshold: clamp(+f.threshold.value || -0.15, -2, 0) },
  });
  if (s.notify) await askNotifyPermission();
  ensureTfInCat();
  save(K.settings, s);
  $('#settingsDialog').close();
  runOnce();
}

function openRisk() {
  const f = $('#riskForm'), r = state.settings.risk;
  f.lot.value = r.lot; f.pipSize.value = String(r.pipSize);
  f.eurUsdManual.value = r.eurUsdManual; f.newsBlackoutMin.value = r.newsBlackoutMin;
  f.entryMode.value = r.entryMode || 'confirmation';
  f.accept.checked = !!r.validated; f.autoFollow.checked = !!r.autoFollow;
  riskPreview();
  renderAutoPlan();
  $('#riskDialog').showModal();
}

function readRisk(f) {
  return {
    ...state.settings.risk,
    lot: clamp(+f.lot.value || 0.1, 0.01, 100), pipSize: [0.01, 0.1, 1].includes(+f.pipSize.value) ? +f.pipSize.value : 0.1,
    eurUsd: 'manual', eurUsdManual: clamp(+f.eurUsdManual.value || 1.08, 0.5, 2), autoFollow: !!f.autoFollow.checked,
    newsBlackoutMin: clamp(+f.newsBlackoutMin.value || 0, 0, 240),
    entryMode: f.entryMode.value === 'limit' ? 'limit' : 'confirmation', minStars: 5, // seules les zones 5★ sont valides
  };
}

function riskPreview() {
  const r = readRisk($('#riskForm'));
  const rate = r.eurUsdManual;
  const one = money(1, r, rate).eur;
  $('#riskPreview').innerHTML = `1 pip = <b>${fmtEur(one)}</b> · 100 pips = <b>${fmtEur(one * 100)}</b> (EUR/USD ${fmtNum(rate, 4)}). La perte possible de chaque trade est affichée dans son détail.`;
}

/** Résumé de l'échelle d'objectifs fixe (SL/TP automatiques) par catégorie. */
function autoPlanLines() {
  return Object.entries(CATEGORIES).map(([cat, c]) => {
    const bufAtr = CATEGORY_DEFAULTS[cat].bufAtr;
    const ladder = cat === 'swing' ? '+100 / +400 / +600 (le +600 est une clôture manuelle)' : '+100 / +200 / +350';
    return `<b>${c.label}</b> : TP1/TP2/TP3 fixes ${ladder} pips depuis l'entrée · marge SL ${bufAtr * 100} % ATR`;
  }).join('<br>');
}

function renderAutoPlan() {
  const el = $('#autoPlan');
  if (!el) return;
  el.innerHTML = `Le <b>stop loss</b> est placé automatiquement juste au-delà de l'order block (marge selon la catégorie, basée sur l'ATR). <b>Règle stricte :</b> le risque (entrée → SL) ne doit jamais dépasser <b>${MAX_SL_PIPS} pips</b> ; au-delà, la zone est refusée (« non viable »), y compris si l'entrée réelle après confirmation dépasse ce seuil. Les objectifs (<b>TP1, TP2, TP3</b>) sont des distances fixes depuis l'entrée, par catégorie :<br>${autoPlanLines()}`;
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
    const LN = window.Capacitor?.Plugins?.LocalNotifications;
    if (LN) { await LN.requestPermissions(); return; }
    if ('Notification' in window && Notification.permission === 'default') await Notification.requestPermission();
  } catch { /* */ }
}

// ── utilitaires ──────────────────────────────────────────────────────────
function showBanner(msg, kind = 'error', action, fn) {
  const b = $('#banner');
  b.className = `banner ${kind === 'info' ? 'info' : ''}`;
  b.textContent = msg;
  if (action) { const btn = document.createElement('button'); btn.className = 'btn small'; btn.textContent = action; btn.onclick = fn; b.appendChild(btn); }
  b.hidden = false;
}
function hideBanner() { $('#banner').hidden = true; }
function toast(msg) { const t = document.createElement('div'); t.className = 'toast'; t.textContent = msg; $('#toasts').appendChild(t); setTimeout(() => t.remove(), 6000); }
const nf = (d) => new Intl.NumberFormat('fr-FR', { minimumFractionDigits: d, maximumFractionDigits: d });
function fmtP(v) { return v == null ? '—' : nf(3).format(v).replace(/ /g, ' '); }
function fmtNum(v, d = 2) { return v == null || !Number.isFinite(v) ? '—' : nf(d).format(v); }
function fmtPips(v) { return v == null ? '—' : `${v > 0 ? '+' : ''}${nf(1).format(v)} pips`; }
function fmtEur(v) { return v == null || !Number.isFinite(v) ? '—' : new Intl.NumberFormat('fr-FR', { style: 'currency', currency: 'EUR', signDisplay: 'exceptZero' }).format(v); }
function fmtR(v) { return v == null || !Number.isFinite(v) ? '—' : `${v > 0 ? '+' : ''}${nf(2).format(v)} R`; }
function fmtT(t) { return new Date(t * 1000).toLocaleString('fr-FR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }); }
function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }
function dirFr(d, cap) { const s = d === 'BUY' ? 'achat' : 'vente'; return cap ? s[0].toUpperCase() + s.slice(1) : s; }
function esc(s) { return String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }
void STATUS_LABEL;

init();
