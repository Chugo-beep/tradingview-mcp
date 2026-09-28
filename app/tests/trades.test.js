import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectZones } from '../www/js/engine.js';
import { simulateZone, planFor, balance, money, POS, DEFAULT_RISK, MAX_SL_PIPS, notifText, currentStop, newPosition, advance } from '../www/js/trades.js';
import { buildModel, scoreZone, reviewRules } from '../www/js/learning.js';
import { runAgents, makeCalendar, followZone, unfollowZone, setEntryLot, transitions, applyContinuousImprovement, riskGuards } from '../www/js/agents.js';

const T0 = 1789603200;
const bar = (i, o, h, l, c, complete = true) => ({ time: T0 + i * 300, open: o, high: h, low: l, close: c, complete });
// Motif d'achat de référence ; K = 0,7 rétrécit l'order block pour que le stop reste ≤ 100 pips (44,65 pips).
const K = 0.7, sc = (v) => Math.round((4275 + (v - 4275) * K) * 1000) / 1000;
const sbar = (i, o, h, l, c) => bar(i, sc(o), sc(h), sc(l), sc(c));
const pad = (swingHigh) => Array.from({ length: 40 }, (_, k) => (swingHigh && k === 30 ? bar(k - 40, 4275, swingHigh, 4274.5, 4275) : bar(k - 40, 4275, 4275.5, 4274.5, 4275)));
const setup = (swingHigh) => [...pad(swingHigh),
  sbar(0, 4275.0, 4276.0, 4273.5, 4274.0), sbar(1, 4274.0, 4274.5, 4271.765, 4273.0), sbar(2, 4273.0, 4274.0, 4272.8, 4272.5),
  sbar(3, 4272.5, 4274.0, 4272.2, 4273.0), sbar(4, 4273.0, 4273.8, 4272.4, 4272.49),
  sbar(5, 4272.495, 4274.050, 4271.675, 4271.930), sbar(6, 4271.935, 4272.485, 4266.535, 4269.455),
  sbar(7, 4269.275, 4278.140, 4269.040, 4278.140), sbar(8, 4278.290, 4286.895, 4278.290, 4285.085),
];
// niveaux attendus (K = 0,7) : entrée 4273,24 · SL 4268,775 (44,65 pips)
// TP fixes : TP1 +100 · TP2 +200 · TP3 +350 pips depuis l'entrée
const E = 4273.24, SL = 4268.775, TP1 = 4283.24, TP2 = 4293.24, TP3 = 4308.24;
const near = (a, b, eps = 1e-6) => Math.abs(a - b) < eps;
const risk = { ...DEFAULT_RISK, validated: true, entryMode: 'limit' };
const zoneOf = (c) => detectZones(c, { timeframe: '5' }).zones.find((z) => z.direction === 'BUY');
// TP1 est désormais à seulement +100 pips : la bougie d'attente doit rester sous TP1 et au-dessus de l'entrée
const wait = () => bar(9, 4278, 4280, 4276, 4279);
const fill = () => bar(10, 4279, 4280, 4269, 4272);          // touche l'entrée sans casser le SL

test('plan : SL structurel (invalidation de la zone), TP1/TP2/TP3 = échelle fixe scalp/day (+100/+200/+350)', () => {
  const p = planFor(zoneOf([...setup(), wait()]), risk);
  assert.ok(near(p.entry, E)); assert.ok(near(p.sl, SL));
  assert.ok(near(p.slPips, 44.65, 1e-3));
  assert.ok(near(p.tp1, TP1)); assert.ok(near(p.tp2, TP2)); assert.ok(near(p.tp3, TP3));
  assert.equal(p.tp1Pips, 100);
  assert.equal(p.slOk, true);
  assert.ok(near(p.slBufferPips, 3));
});

test('plan : SL > 100 pips → zone REFUSEE (« non viable »), quelle que soit la catégorie', () => {
  const K2 = 2, sc2 = (v) => Math.round((4275 + (v - 4275) * K2) * 1000) / 1000;
  const sbar2 = (i, o, h, l, c) => bar(i, sc2(o), sc2(h), sc2(l), sc2(c));
  const big = [...pad(), sbar2(0, 4275.0, 4276.0, 4273.5, 4274.0), sbar2(1, 4274.0, 4274.5, 4271.765, 4273.0), sbar2(2, 4273.0, 4274.0, 4272.8, 4272.5),
    sbar2(3, 4272.5, 4274.0, 4272.2, 4273.0), sbar2(4, 4273.0, 4273.8, 4272.4, 4272.49), sbar2(5, 4272.495, 4274.050, 4271.675, 4271.930),
    sbar2(6, 4271.935, 4272.485, 4266.535, 4269.455), sbar2(7, 4269.275, 4278.140, 4269.040, 4278.140), sbar2(8, 4278.290, 4286.895, 4278.290, 4285.085),
    bar(9, 4285, 4287, 4283, 4284)];
  const p = planFor(zoneOf(big), risk);
  assert.equal(Math.round(p.slPips), 122);
  assert.equal(p.slOk, false);
  assert.match(p.reason, new RegExp(`SL de 122 pips > ${MAX_SL_PIPS} pips : zone non viable`));
  assert.equal(simulateZone(zoneOf(big), big, risk).state, POS.REFUSED);
});

test('plan : SL de 101 pips (juste au-dessus du seuil) → non viable ; 100 pips exacts → valide', () => {
  const riskP = { ...DEFAULT_RISK, entryMode: 'limit' };
  // ATR nul → marge plancher fixe (3 pips) ; la hauteur de la zone fixe directement le risque en pips
  const z100 = { direction: 'BUY', zoneHigh: 99.7, zoneLow: 90.0, atr: 0, category: 'day' };
  const p100 = planFor(z100, riskP);
  assert.equal(Math.round(p100.slPips), MAX_SL_PIPS);
  assert.equal(p100.slOk, true);
  const z101 = { direction: 'BUY', zoneHigh: 99.8, zoneLow: 90.0, atr: 0, category: 'day' };
  const p101 = planFor(z101, riskP);
  assert.equal(Math.round(p101.slPips), MAX_SL_PIPS + 1);
  assert.equal(p101.slOk, false);
  assert.match(p101.reason, /SL de 101 pips > 100 pips : zone non viable/);
});

test('ordre non touché = en attente, sans P&L', () => {
  const c = [...setup(), wait()];
  const pos = simulateZone(zoneOf(c), c, risk);
  assert.equal(pos.state, POS.PENDING);
  assert.equal(pos.pips, null);
});

test('prix arrive sur l\'entrée → position ouverte, à gains / à perte selon le prix', () => {
  const c = [...setup(), wait(), fill()];
  const z = zoneOf(c);
  const pos = simulateZone(z, c, risk, { currentPrice: 4280 });
  assert.equal(pos.state, POS.OPEN);
  assert.ok(near(pos.fillPrice, E));
  assert.equal(pos.pnlSide, 'gain');
  assert.equal(simulateZone(z, c, risk, { currentPrice: 4265 }).pnlSide, 'perte');
});

test('SL touché avant TP1 → −1 R, balance en euros', () => {
  const c = [...setup(), wait(), fill(), bar(11, 4272, 4273, 4257, 4258)];
  const pos = simulateZone(zoneOf(c), c, risk);
  assert.equal(pos.state, POS.SL);
  assert.ok(near(pos.r, -1));
  const b = balance([pos], risk, 1.10);
  assert.equal(b.losses, 1);
  assert.ok(near(b.usd, -44.65, 1e-2));
});

test('TP1 (+100) et +1R atteints (même bougie) → BE (entrée + 3 pips) ; retour au BE = clôture en gain (1/3 encaissé)', () => {
  const c = [...setup(), wait(), fill(), bar(11, 4272, 4288, 4271, 4286), bar(12, 4286, 4286.5, 4269, 4270)];
  const pos = simulateZone(zoneOf(c), c, risk);
  assert.equal(pos.hits, 1);
  assert.equal(pos.beDone, true);
  assert.ok(near(pos.beLevel, E + 0.3), 'BE = entrée + 3 pips, jamais l\'entrée exacte');
  assert.equal(pos.state, POS.TP);
  assert.equal(pos.exitKind, 'TP1 puis BE');
  assert.ok(near(pos.exitPrice, E + 0.3));
  assert.ok(near(pos.pips, (100 + 2 * 3) / 3), '1/3 à TP1 (100 pips) + 2/3 sorti au BE (+3 pips)');
  assert.deepEqual(transitions(POS.PENDING, 0, pos), ['fill', 'tp1', 'be', 'closeProfit']);
});

test('TP1, TP2 (stop sur TP1), TP3 (+350, trade terminé) atteints → 1/3 à chaque objectif', () => {
  const c = [...setup(), wait(), fill(), bar(11, 4272, 4301, 4271, 4300), bar(12, 4300, 4319, 4295, 4312)];
  const pos = simulateZone(zoneOf(c), c, risk);
  assert.equal(pos.hits, 3);
  assert.equal(pos.state, POS.TP);
  assert.ok(near(pos.pips, (100 + 200 + 350) / 3));
});

test('TP1 atteint avant l\'entrée → ordre annulé', () => {
  const c = [...setup(), bar(9, 4278, 4290, 4277, 4285)];
  assert.equal(simulateZone(zoneOf(c), c, risk).state, POS.CANCELLED);
});

test('notifications : lisibles sans ouvrir l\'application, échelle fixe', () => {
  const p = planFor(zoneOf([...setup(), wait()]), risk);
  const t = { dir: 'BUY', category: 'scalping', ...p, entryMode: 'limit' };
  const n = notifText('new', t, { tfLabel: '5m' });
  assert.equal(n.title, '🟢 ACHAT GOLD @ 4273.24');
  assert.equal(n.body, 'TP1 4283.24 · TP2 4293.24 · TP3 4308.24 · SL 4268.77');
  assert.equal(notifText('tp1', { ...t, fillPrice: E }).title, '✅ TP1 +100 atteint !');
  assert.equal(notifText('tp2', { ...t, fillPrice: E }).title, '✅ TP2 atteint ! Stop sur TP1 : 4283.24');
  assert.match(notifText('tp3', { ...t, fillPrice: E }).title, /🏁 TP3 \+350 atteint · trade terminé/);
});

test('notifications : swing → +600 pips = notification de clôture manuelle', () => {
  const z = { direction: 'BUY', zoneHigh: 4270, zoneLow: 4260, atr: 10, category: 'swing' };
  const p = planFor(z, { ...DEFAULT_RISK, entryMode: 'limit' });
  const t = { dir: 'BUY', category: 'swing', ...p, entryMode: 'limit', fillPrice: p.entry };
  const n = notifText('tp3', t);
  assert.equal(n.title, '🏁 +600 pips atteints · CLÔTURE le trade SWING');
  assert.match(n.body, /GOLD ACHAT/);
});

test('money : 1 lot, 10 pips = 100 $', () => {
  assert.equal(money(10, DEFAULT_RISK, 1, 1).usd, 100);
});

test('apprentissage : une caractéristique perdante devient une règle CANDIDATE (pas active tant qu\'elle n\'est pas acceptée)', () => {
  const samples = [];
  for (let i = 0; i < 12; i++) samples.push({ features: { session: 'Asie', tf: '5' }, r: i < 10 ? -1 : 1.5, source: 'backtest' });
  for (let i = 0; i < 12; i++) samples.push({ features: { session: 'Londres', tf: '5' }, r: i < 4 ? -1 : 1.5, source: 'backtest' });
  const m = buildModel(samples);
  assert.ok(m.rules.some((r) => r.key === 'session=Asie'));
  assert.ok(!m.rules.some((r) => r.key === 'session=Londres'));
  assert.equal(m.rules.find((r) => r.key === 'session=Asie').status, 'candidate');
  assert.equal(scoreZone(m, { session: 'Asie', tf: '5' }).blockedBy.length, 0);
  const m2 = buildModel(samples, { accepted: ['session=Asie'] });
  assert.equal(m2.rules.find((r) => r.key === 'session=Asie').status, 'active');
  assert.ok(m2.after.winRate > m2.before.winRate);
  assert.equal(scoreZone(m2, { session: 'Asie', tf: '5' }).blockedBy.length, 1);
  const m3 = buildModel(samples, { accepted: ['session=Asie'], disabled: ['session=Asie'] });
  assert.equal(m3.rules.find((r) => r.key === 'session=Asie').status, 'disabled');
  assert.equal(scoreZone(m3, { session: 'Asie', tf: '5' }).blockedBy.length, 0);
});

test('champion / challenger (règles) : acceptée seulement si elle améliore l\'espérance sur les deux fenêtres, en gardant ≥ 60 % des échantillons', () => {
  const asieAt = new Set([0, 3, 6, 9, 12, 15, 18]); // 7/20 = 35 % filtrés (rétention 65 %)
  const samples = Array.from({ length: 20 }, (_, i) => ({ features: { session: asieAt.has(i) ? 'Asie' : 'Londres' }, r: asieAt.has(i) ? -1 : 1, t: i }));
  const rev = reviewRules(samples, [{ key: 'session=Asie' }], [], []);
  assert.ok(rev.accepted.includes('session=Asie'));
  const d = rev.decisions.find((x) => x.key === 'session=Asie');
  assert.equal(d.decision, 'adopté');
});

test('anti ping-pong (règles) : une règle en quarantaine n\'est pas réacceptée même si elle semble améliorer les deux fenêtres', () => {
  const asieAt = new Set([0, 3, 6, 9, 12, 15, 18]);
  const samples = Array.from({ length: 20 }, (_, i) => ({ features: { session: asieAt.has(i) ? 'Asie' : 'Londres' }, r: asieAt.has(i) ? -1 : 1, t: i }));
  const quarantine = { 'session=Asie': 100000 };
  const rev = reviewRules(samples, [{ key: 'session=Asie' }], [], [], quarantine, 1000);
  assert.ok(!rev.accepted.includes('session=Asie'));
  assert.match(rev.decisions.find((x) => x.key === 'session=Asie').reason, /quarantaine/);
  const rev2 = reviewRules(samples, [{ key: 'session=Asie' }], [], [], quarantine, 200000);
  assert.ok(rev2.accepted.includes('session=Asie'));
});

test('champion / challenger (règles) : retirée si elle ne sert plus (les deux fenêtres s\'améliorent sans elle)', () => {
  const asieAt = new Set([0, 3, 6, 9, 12, 15, 18]);
  const samples = Array.from({ length: 20 }, (_, i) => ({ features: { session: asieAt.has(i) ? 'Asie' : 'Londres' }, r: asieAt.has(i) ? 2 : 1, t: i }));
  const rev = reviewRules(samples, [], ['session=Asie'], []);
  assert.ok(!rev.accepted.includes('session=Asie'));
  assert.equal(rev.decisions.find((x) => x.key === 'session=Asie').decision, 'rejeté');
});

test('calendrier : fenêtre d\'annonce', () => {
  const cal = makeCalendar({ events: [{ t: 1000000, title: 'NFP' }] }, 30);
  assert.ok(cal.isBlackout(1000000 + 29 * 60));
  assert.ok(!cal.isBlackout(1000000 + 31 * 60));
});

const S = (extra = {}) => ({ timeframes: ['5'], liquidityLookback: 5, fragileGapAtrRatio: 0.1, learning: {}, risk: { ...risk, strategyMode: 'ob5', ...extra } });
const c1 = () => [...setup(), wait(), bar(10, 4278, 4280, 4277, 4279, false)];
const c2 = () => [...c1().slice(0, 50), fill(), bar(11, 4272, 4273, 4271, 4272), bar(12, 4272, 4319, 4271, 4312), bar(13, 4312, 4319, 4311, 4312, false)];
const run = (candles, journal, settings, i) => runAgents({ data: { symbol: 'OANDA:XAUUSD', candles: { '5': candles } }, settings, cal: null, learnStore: { samples: {}, disabled: [] }, journal, now: (T0 + i * 300) * 1000 });

test('pipeline des agents : une zone proposée n\'entre pas seule dans le journal réel', () => {
  const journal = { entries: [] };
  const out = run(c1(), journal, S(), 10);
  assert.equal(out.reports.length, 5);
  assert.equal(out.audited.find((a) => a.direction === 'BUY').proposal, 'PROPOSEE');
  assert.equal(journal.entries.length, 0, 'seules les zones suivies par l\'utilisateur comptent');
});

test('suivi : « J\'ai suivi » inscrit l\'ordre, le prix arrive sur l\'ordre puis sur l\'objectif (échelle fixe)', () => {
  const journal = { entries: [] };
  const settings = S();
  const out = run(c1(), journal, settings, 10);
  const z = out.audited.find((a) => a.direction === 'BUY');
  const e = followZone(journal, z, { risk: settings.risk, candles: { '5': c1() }, now: (T0 + 10 * 300) * 1000 });
  assert.equal(e.state, POS.PENDING);
  assert.equal(e.followed, true);
  assert.equal(followZone(journal, z, { risk: settings.risk, candles: {} }), null, 'pas de doublon');
  run(c2(), journal, settings, 13);
  assert.equal(journal.entries[0].state, POS.TP);
  assert.ok(journal.entries[0].pips > 0);
});

test('suivi : zone déjà déclenchée → reprend l\'exécution simulée ; ne plus suivre la retire', () => {
  const journal = { entries: [] };
  const settings = S();
  const out = run(c2(), journal, settings, 13);
  const z = out.audited.find((a) => a.direction === 'BUY');
  assert.equal(z.pos.state, POS.TP);
  const e = followZone(journal, z, { risk: settings.risk, candles: { '5': c2() } });
  assert.equal(e.state, POS.TP);
  assert.equal(e.fillPrice, z.pos.fillPrice);
  run(c2(), journal, settings, 13);
  assert.ok(journal.entries[0].pips > 0, 'résultat calculé dans la balance réelle');
  assert.ok(setEntryLot(journal, z.id, 0.5));
  assert.equal(journal.entries[0].lot, 0.5);
  assert.ok(unfollowZone(journal, z.id));
  assert.equal(journal.entries.length, 0);
});

test('suivi automatique (option) : les zones proposées sont inscrites seules', () => {
  const journal = { entries: [] };
  run(c1(), journal, S({ autoFollow: true }), 10);
  assert.equal(journal.entries.length, 1);
  assert.equal(journal.entries[0].auto, true);
  assert.equal(journal.entries[0].followed, true);
});

test('journal : non validé = aucun ordre suivi', () => {
  const settings = { timeframes: ['5'], liquidityLookback: 5, fragileGapAtrRatio: 0.1, learning: {}, risk: { ...risk, strategyMode: 'ob5', validated: false } };
  const journal = { entries: [] };
  runAgents({ data: { symbol: 'XAUUSD', candles: { '5': c1() } }, settings, cal: null, learnStore: { samples: {} }, journal, now: (T0 + 10 * 300) * 1000 });
  assert.equal(journal.entries.length, 0);
});

test('apprentissage : une combinaison perdante (Londres + contre-tendance) devient une règle', () => {
  const samples = [];
  const add = (session, trend, r, n) => { for (let i = 0; i < n; i++) samples.push({ features: { session, trend }, r, source: 'backtest' }); };
  add('Londres', 'against', -1, 14); add('Londres', 'against', 2, 1);
  add('Londres', 'with', 2, 12); add('New York', 'against', 2, 12); add('New York', 'with', 1, 12);
  const m = buildModel(samples, { accepted: ['session + trend=Londres|against'] });
  assert.ok(m.rules.some((r) => r.key === 'session + trend=Londres|against'), 'combinaison détectée');
  assert.ok(!m.rules.some((r) => r.key === 'session=Londres'), 'Londres seule reste autorisée');
  assert.equal(scoreZone(m, { session: 'Londres', trend: 'with' }).blockedBy.length, 0);
  assert.equal(scoreZone(m, { session: 'Londres', trend: 'against' }).blockedBy.length, 1);
});

// ── Stratégie Order Blocks « 5 étoiles » ─────────────────────────────────
const conf = { ...risk, entryMode: 'confirmation' };

test('5 étoiles : le motif de référence est un OB 5★ (imbalance, tendance, liquidité, vierge, Discount)', () => {
  const z = zoneOf([...setup(), wait()]);
  assert.equal(z.grade, 5);
  assert.equal(z.trend.supertrend, 'haussier');
  assert.equal(z.fib.zone, 'DISCOUNT');
  assert.equal(z.liq.sweepBonus, true);
});

test('5 étoiles : C1 doit être la DERNIÈRE bougie inverse (C2 inverse → pas d\'OB sur C1)', () => {
  const c = setup(); c[47] = sbar(7, 4269.275, 4270, 4268.9, 4269.1); // C2 baissière
  const z = detectZones([...c, wait()], { timeframe: '5' }).zones.find((x) => x.direction === 'BUY' && x.c1Time === T0 + 6 * 300);
  assert.equal(z, undefined);
});

test('entrée sur réaction : prix dans l\'OB → attente, bougie haussière clôturée → entrée à sa clôture', () => {
  const c = [...setup(), wait(), bar(10, 4279, 4279.5, 4269, 4271), bar(11, 4271, 4275, 4270, 4274)];
  const pos = simulateZone(zoneOf(c), c, conf, { currentPrice: 4274 });
  assert.equal(pos.state, POS.OPEN);
  assert.equal(pos.fillPrice, 4274);
  assert.ok(near(pos.riskPips, 52.25, 1e-3));
  const waiting = simulateZone(zoneOf(c.slice(0, -1)), c.slice(0, -1), conf);
  assert.equal(waiting.state, POS.PENDING);
  assert.equal(waiting.inZone, true, 'WAIT_FOR_CONFIRMATION');
});

test('entrée sur réaction : le risque réel (entrée → SL) dépassant 100 pips annule le trade, même si le plan initial était valide', () => {
  const riskP = { ...DEFAULT_RISK, entryMode: 'confirmation' };
  const zone = { direction: 'BUY', zoneHigh: 99.7, zoneLow: 90.0, atr: 0, category: 'day' };
  const plan = planFor(zone, riskP);
  assert.equal(plan.slOk, true); // plan initial valide : 100 pips exacts
  const pos = newPosition(zone, plan);
  const candles = [
    { time: T0, open: 95, high: 99.8, low: 89.8, close: 95, complete: true }, // touche l'OB
    { time: T0 + 300, open: 95, high: 104.4, low: 94, close: 104.4, complete: true }, // réaction haussière, mais loin de l'entrée initiale
  ];
  advance(pos, candles, { pipSize: riskP.pipSize });
  assert.equal(pos.state, POS.CANCELLED);
  assert.match(pos.reason, /SL de \d+ pips > 100 pips : zone non viable/);
});

test('entrée sur réaction : OB cassé avant la réaction → pas de trade (aucune perte)', () => {
  const c = [...setup(), wait(), bar(10, 4279, 4279.5, 4269, 4271), bar(11, 4271, 4272, 4266, 4267)];
  const pos = simulateZone(zoneOf(c), c, conf);
  assert.equal(pos.state, POS.CANCELLED);
  assert.equal(pos.reason, 'OB cassé sans réaction');
});

test('pipeline : OB 5★ proposé ; TP fixe +100 pips (scalp)', () => {
  const out = run(c1(), { entries: [] }, S({ entryMode: 'confirmation', minStars: 5 }), 10);
  const z = out.audited.find((a) => a.direction === 'BUY');
  assert.equal(z.proposal, 'PROPOSEE');
  assert.ok(near(z.plan.tp1, z.plan.entry + 100 * risk.pipSize));
});

test('notifications (entrée sur réaction) : zone à surveiller, puis point d\'entrée', () => {
  const p = planFor(zoneOf([...setup(), wait()]), conf);
  const t = { dir: 'BUY', category: 'scalping', grade: 5, zoneLow: 4269.07, zoneHigh: 4273.24, ...p };
  assert.equal(notifText('new', t).title, '👀 ★★★★★ ACHAT GOLD · zone 4269.07–4273.24');
  const f = notifText('fill', { ...t, fillPrice: 4274 });
  assert.equal(f.title, '🟢 ACHAT GOLD @ 4274.00 ★★★★★');
  assert.match(f.body, /^TP1 4283\.24 · TP2 4293\.24 · TP3 4308\.24 · SL 4268\.77$/);
});

// ── Marge de stop automatique (échelle par catégorie) ─────────────────────

test('marge de stop automatique : ATR par catégorie, plancher 3 pips, plafond 25 % de la zone', () => {
  const riskP = { ...DEFAULT_RISK, entryMode: 'limit' };
  const zBase = { direction: 'BUY', zoneHigh: 4270, zoneLow: 4260 };
  // swing (bufAtr 0,15) : ATR modéré → marge = 0,15 × ATR
  const swing = { ...zBase, category: 'swing', atr: 10 };
  assert.ok(near(planFor(swing, riskP).slBufferPips, 15));
  // scalping (bufAtr 0,05) : ATR faible → le plancher de 3 pips s'applique
  const scalp = { ...zBase, category: 'scalping', atr: 1 };
  assert.ok(near(planFor(scalp, riskP).slBufferPips, 3));
  // ATR énorme mais zone étroite relativement → plafond 25 % de la hauteur de zone
  const capped = { ...zBase, category: 'swing', zoneHigh: 4265, zoneLow: 4260, atr: 1000 };
  assert.ok(near(planFor(capped, riskP).slBufferPips, 12.5));
});

test('échelle fixe TP1/TP2/TP3 : scalp/day +100/+200/+350, swing +100/+400/+600 (TP3 manuel)', () => {
  const riskP = { ...DEFAULT_RISK, entryMode: 'limit' };
  const z = (cat) => ({ direction: 'BUY', zoneHigh: 4270, zoneLow: 4260, category: cat, atr: 5 });
  const scalp = planFor(z('scalping'), riskP);
  const day = planFor(z('day'), riskP);
  const swing = planFor(z('swing'), riskP);
  for (const p of [scalp, day]) {
    assert.ok(near(p.tp1, p.entry + 100 * riskP.pipSize));
    assert.ok(near(p.tp2, p.entry + 200 * riskP.pipSize));
    assert.ok(near(p.tp3, p.entry + 350 * riskP.pipSize));
  }
  assert.ok(near(swing.tp1, swing.entry + 100 * riskP.pipSize));
  assert.ok(near(swing.tp2, swing.entry + 400 * riskP.pipSize));
  assert.ok(near(swing.tp3, swing.entry + 600 * riskP.pipSize));
});

// ── Gestion institutionnelle du stop (§A) ─────────────────────────────────

test('gestion : le BE ne se déclenche que si TP1 ET +1R sont TOUS LES DEUX atteints (jamais trop tôt) ; BE = entrée + 3 pips (achat) ; après TP2 le stop est au moins sur TP1', () => {
  const bar2 = (t, h, l) => ({ time: t, open: l, high: h, low: l, close: l, complete: true });
  const pos = { dir: 'BUY', sl: 90, tp1: 95, tp2: 200, tp3: 300, fillPrice: 100, fillTime: T0, riskPx: 10, hits: 0, hitTimes: [], state: POS.OPEN };
  const ctx = { pipSize: 1 };
  // TP1 atteint seul (sans +1R) : le stop ne bouge pas
  advance(pos, [bar2(T0 + 60, 96, 99)], ctx);
  assert.equal(pos.hits, 1);
  assert.equal(pos.beDone, false, 'TP1 seul ne déclenche pas le BE : +1R manque encore');
  assert.equal(currentStop(pos), 90);
  // +1R (entrée + 10) atteint à son tour : BE déclenché, à entrée + 3 pips (jamais l'entrée exacte)
  advance(pos, [bar2(T0 + 120, 112, 101)], ctx);
  assert.equal(pos.beDone, true);
  assert.equal(pos.beLevel, 103);
  assert.equal(currentStop(pos), 103);
  // TP2 atteint : le stop est au moins sur TP1 (plancher), le plus protecteur des deux prévaut
  pos.hits = 2;
  assert.equal(currentStop(pos), 103, 'TP1 (95) < BE (103) : le BE reste le plus protecteur');
  pos.tp1 = 110;
  assert.equal(currentStop(pos), 110, 'TP1 (110) > BE (103) : le plancher TP1 prévaut');
});

test('gestion : trailing structurel après le BE — resserre le stop sur un nouveau creux de swing (achat), ne le desserre jamais', () => {
  const bar2 = (i, h, l) => ({ time: T0 + 60 * (i + 1), open: l, high: h, low: l, close: l, complete: true });
  const pos = { dir: 'BUY', sl: 90, tp1: 95, tp2: 200, tp3: 300, fillPrice: 100, fillTime: T0, riskPx: 10, hits: 1, hitTimes: [T0], reached1R: true, beDone: true, beLevel: 100, trailFrom: null, state: POS.OPEN };
  // creux de swing (fractale 2 bougies) à 105 (index 2, confirmé à l'index 4) → stop = 105 − 3 = 102
  // puis un creux plus bas à 103 (index 6, confirmé à l'index 8) : ne doit PAS desserrer le stop
  const candles = [bar2(0, 111, 110), bar2(1, 109, 108), bar2(2, 106, 105), bar2(3, 108, 107), bar2(4, 110, 109),
    bar2(5, 107, 106), bar2(6, 104, 103), bar2(7, 106, 105), bar2(8, 108, 107)];
  advance(pos, candles, { pipSize: 1 });
  assert.equal(pos.state, POS.OPEN, 'aucun stop ni objectif touché durant la séquence');
  assert.equal(pos.trailFrom, 102);
  assert.equal(currentStop(pos), 102, 'le creux plus bas (103) ne desserre pas le stop déjà remonté à 102');
});

test('gestion : après TP2 le stop est au moins sur TP1 (échelle fixe, scalp/day et swing)', () => {
  const riskP = { ...DEFAULT_RISK, entryMode: 'limit' };
  for (const cat of ['scalping', 'day', 'swing']) {
    const z = { direction: 'BUY', zoneHigh: 4270, zoneLow: 4260, category: cat, atr: 5 };
    const p = planFor(z, riskP);
    const pos = { dir: 'BUY', sl: p.sl, beDone: true, beLevel: p.entry + 0.3, trailFrom: null, tp1: p.tp1, tp2: p.tp2, hits: 2 };
    assert.equal(currentStop(pos), p.tp1); // TP1 (+100 pips) plus protecteur que le BE : plancher appliqué
  }
});

test('préservation du compte (§B) : 2 positions déjà ouvertes bloquent une 3e proposition ; coupe-circuit journalier après 2 pertes ; taille réduite après 3 pertes consécutives ; chevauchement de zones', () => {
  const nowMs = (T0 + 1000) * 1000;
  const open2 = { entries: [
    { id: 'o1', state: POS.OPEN, dir: 'BUY', zoneLow: 100, zoneHigh: 101 },
    { id: 'o2', state: POS.OPEN, dir: 'SELL', zoneLow: 200, zoneHigh: 201 },
  ] };
  const g1 = riskGuards(open2, [], nowMs);
  assert.equal(g1.maxPositions, true);
  assert.equal(g1.blockNew, true);
  assert.ok(g1.overlapsOpen('BUY', 100.5, 101.5), 'zone qui chevauche une position ouverte, même sens');
  assert.ok(!g1.overlapsOpen('SELL', 100.5, 101.5), 'sens différent : pas de conflit');
  assert.ok(!g1.overlapsOpen('BUY', 500, 501), 'zone éloignée : pas de conflit');

  const t = new Date(nowMs);
  const dayStartSec = Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), t.getUTCDate()) / 1000;
  const journalLosses = { entries: [
    { id: 'l1', state: POS.SL, exitTime: dayStartSec + 100 },
    { id: 'l2', state: POS.SL, exitTime: dayStartSec + 200 },
  ] };
  const g2 = riskGuards(journalLosses, [], nowMs);
  assert.equal(g2.lossesToday, 2);
  assert.equal(g2.dailyBreaker, true);
  assert.equal(g2.blockNew, true);

  const journal3losses = { entries: [
    { id: 'w1', state: POS.TP, exitTime: dayStartSec - 5000 },
    { id: 'l1', state: POS.SL, exitTime: dayStartSec + 10 },
    { id: 'l2', state: POS.SL, exitTime: dayStartSec + 20 },
    { id: 'l3', state: POS.SL, exitTime: dayStartSec + 30 },
  ] };
  const g3 = riskGuards(journal3losses, [], nowMs);
  assert.equal(g3.consecutiveLosses, 3);
  assert.equal(g3.reducedSize, true);
});

test('amélioration continue (règles) : retour arrière si la performance avancée est pire que la configuration précédente', () => {
  const learnStore = {
    samples: {}, disabled: [], acceptedRules: ['ruleA'],
    config: { version: 3, rules: ['ruleA'], adoptedAt: 1000, validation: { pipsPerTrade: 50, n: 20 } },
    configHistory: [{ version: 2, at: 900, change: '', decision: 'adopté', reason: '', rules: [], adoptedAt: 500, validation: { pipsPerTrade: 60, n: 30 } }],
  };
  const backtest = Array.from({ length: 8 }, (_, i) => ({
    zone: { id: `z${i}`, category: 'scalping', c3Time: 2000 + i, direction: 'BUY', atr: 1, candles: { P: { low: 100, high: 101 }, C3: { close: 100 } }, liquidity: { level: 99 } },
    pos: { state: POS.TP, pips: -5 },
  }));
  const cal = makeCalendar(null, 0);
  const res = applyContinuousImprovement(learnStore, { ruleDecisions: [], backtest, calendar: cal, now: 5000 * 1000 });
  assert.ok(res.rollback);
  assert.deepEqual(res.config.rules, []); // configuration précédente restaurée
  assert.deepEqual(learnStore.acceptedRules, []);
  // anti ping-pong : la règle rejetée par le retour arrière est mise en quarantaine
  assert.ok(learnStore.quarantine.rules.ruleA > 5000);
});
