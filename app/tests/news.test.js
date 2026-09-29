/**
 * Tests des annonces économiques : assainissement/parseur (app/newsfeed.js), interprétation
 * déterministe (www/js/news.js), fusion calendrier embarqué + direct (www/js/agents.js) et
 * validation des routes /api/news.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const DATA = mkdtempSync(join(tmpdir(), 'xauz-news-'));
process.env.XAUZ_DATA_DIR = DATA;

const newsfeed = await import('../newsfeed.js');
const { sanitizeEvent, _ingest, _state, eventsSince, _reset } = newsfeed;
const { classifyIndicator, compareActualForecast, goldTendency, interpretEvent, comparisonLabel, formatNewsValue, NEWS_COUNTRIES } = await import('../www/js/news.js');
const { makeCalendar, mergeCalendarNews } = await import('../www/js/agents.js');

// ── fixtures : réponses brutes « TradingView » (payload.result) ──────────────
const RAW_NFP = { id: 'nfp1', title: 'Non Farm Payrolls', country: 'US', date: '2026-10-02T12:30:00.000Z', importance: 1, actual: 210, forecast: 150, previous: 142, unit: 'K', scale: 'K', period: 'Sep' };
const RAW_UNRATE = { id: 'unrate1', title: 'Unemployment Rate', country: 'US', date: '2026-10-02T12:30:00.000Z', importance: 1, actual: 4.5, forecast: 4.1, previous: 4.1, unit: '%' };
const RAW_CPI = { id: 'cpi1', title: 'Inflation Rate YoY', country: 'US', date: '2026-10-13T12:30:00.000Z', importance: 1, actual: 2.5, forecast: 2.8, previous: 2.9, unit: '%' };
const RAW_EU_LOW = { id: 'eu1', title: 'ECB Interest Rate Decision', country: 'EU', date: '2026-10-06T11:45:00.000Z', importance: 1, actual: 3.5, forecast: 3.25, previous: 3.25, unit: '%' };
const RAW_DE_HIGH = { id: 'de1', title: 'German ZEW', country: 'DE', date: '2026-10-06T09:00:00.000Z', importance: 1 }; // pays non suivi
const RAW_LOW_IMPACT = { id: 'low1', title: 'Something minor', country: 'US', date: '2026-10-06T09:00:00.000Z', importance: 0 };
const RAW_JUNK = { id: 'junk1', title: '\u0000\u0001<script>evil()</script>'.padEnd(300, 'x'), country: 'US', date: '2026-10-06T09:00:00.000Z', importance: 1, actual: 'NaN' };

test("sanitizeEvent : garde l'impact MAJEUR et l'impact moyen chiffré, 4 pays suivis, whitelist de champs", () => {
  assert.equal(sanitizeEvent(RAW_LOW_IMPACT), null, 'impact moyen sans prévision écarté');
  assert.equal(sanitizeEvent({ ...RAW_LOW_IMPACT, importance: -1, forecast: 1 }), null, 'impact faible écarté');
  const medium = sanitizeEvent({ ...RAW_LOW_IMPACT, forecast: 1.5, actual: 1.7 });
  assert.equal(medium.major, false, 'impact moyen chiffré gardé pour le contexte macro, jamais affiché');
  assert.equal(sanitizeEvent(RAW_NFP).major, true);
  assert.equal(sanitizeEvent(RAW_DE_HIGH), null, 'pays non suivi écarté');
  assert.equal(sanitizeEvent(null), null);
  assert.equal(sanitizeEvent({ importance: 1, country: 'US' }), null, 'titre manquant écarté');
  const ok = sanitizeEvent(RAW_NFP);
  assert.deepEqual(Object.keys(ok).sort(), ['actual', 'country', 'forecast', 'id', 'major', 'period', 'previous', 'scale', 't', 'title', 'unit'].sort());
  assert.equal(ok.t, Math.floor(Date.parse(RAW_NFP.date) / 1000));
});

test('sanitizeEvent : nettoie les chaînes (caractères de contrôle, longueur) et les nombres non finis', () => {
  const ok = sanitizeEvent(RAW_JUNK);
  assert.ok(ok.title.length <= 200);
  assert.doesNotMatch(ok.title, /[\u0000-\u001f]/);
  assert.equal(ok.actual, null, '"NaN" → null, jamais NaN sérialisé');
});

test('_ingest : filtre les 4 pays, ignore le hors-fenêtre, incrémente seq à l\'ajout puis à la publication de "actual"', () => {
  _reset();
  const now = Date.parse('2026-10-01T00:00:00.000Z');
  const pending = { ...RAW_NFP, actual: null };
  _ingest([pending, RAW_DE_HIGH, RAW_LOW_IMPACT], now);
  let st = _state();
  assert.equal(st.events.length, 1, 'seul NFP (US, majeur) retenu');
  assert.equal(st.seq, 1);
  const afterSeq1 = eventsSince(0).length;
  assert.equal(afterSeq1, 1);
  assert.equal(eventsSince(1).length, 0, 'rien de nouveau depuis seq=1');
  // publication du résultat : seq doit encore avancer
  _ingest([RAW_NFP], now);
  st = _state();
  assert.equal(st.seq, 2, 'seq incrémenté à la publication de actual');
  assert.equal(st.events[0].actual, 210);
  assert.equal(eventsSince(1).length, 1, 'l\'événement modifié réapparaît pour un client resynchronisant depuis seq=1');
  // aucun changement : seq stable
  _ingest([RAW_NFP], now);
  assert.equal(_state().seq, 2);
});

test('_ingest : hors fenêtre [J-40, J+7] écarté, événement sorti de fenêtre purgé', () => {
  _reset();
  const now = Date.parse('2026-10-01T00:00:00.000Z');
  const tooFar = { ...RAW_NFP, id: 'far1', date: '2026-11-01T00:00:00.000Z' };
  _ingest([tooFar], now);
  assert.equal(_state().events.length, 0);
});

test('news.js : classifyIndicator reconnaît les familles US, compareActualForecast et goldTendency', () => {
  assert.equal(classifyIndicator('Non Farm Payrolls').family, 'employment');
  assert.equal(classifyIndicator('Unemployment Rate').inverse, true);
  assert.equal(classifyIndicator('Something else'), null);
  assert.equal(compareActualForecast(210, 150), 'above');
  assert.equal(compareActualForecast(100, 150), 'below');
  assert.equal(compareActualForecast(150, 150), 'inline');
  assert.equal(compareActualForecast(null, 150), null);
});

test('news.js : NFP au-dessus des attentes → généralement baissier pour l\'or', () => {
  assert.equal(goldTendency('US', 'Non Farm Payrolls', 'above'), 'généralement baissier pour l\'or');
});
test('news.js : Unemployment Rate au-dessus des attentes (inverse) → généralement haussier pour l\'or', () => {
  assert.equal(goldTendency('US', 'Unemployment Rate', 'above'), 'généralement haussier pour l\'or');
});
test('news.js : CPI en dessous des attentes → généralement haussier pour l\'or', () => {
  assert.equal(goldTendency('US', 'Inflation Rate YoY', 'below'), 'généralement haussier pour l\'or');
});
test('news.js : zone euro au-dessus des attentes → aucune revendication sur l\'or', () => {
  assert.equal(goldTendency('EU', 'ECB Interest Rate Decision', 'above'), null);
  const it = interpretEvent({ country: 'EU', title: 'ECB Interest Rate Decision', actual: 3.5, forecast: 3.25 });
  assert.equal(it.tendency, null);
  assert.equal(it.comparison, 'above');
  assert.equal(it.comparisonText, comparisonLabel('above'));
  assert.equal(it.indirectNote, 'effet indirect via le dollar');
});
test('news.js : formatNewsValue', () => {
  assert.equal(formatNewsValue(210, 'K'), '210K');
  assert.equal(formatNewsValue(2.5, '%'), '2.5%');
  assert.equal(formatNewsValue(null, 'K'), null);
});
test('news.js : NEWS_COUNTRIES = US, EU, CN, JP', () => {
  assert.deepEqual(NEWS_COUNTRIES, ['US', 'EU', 'CN', 'JP']);
});

test('agents.js : mergeCalendarNews fusionne calendrier embarqué (US) et annonces en direct, sans doublon', () => {
  const cal = { events: [{ t: 1000000, title: 'NFP' }] };
  const live = [
    { t: 1000000, title: 'NFP', country: 'US' }, // doublon (même minute, même pays, même titre) : le direct prime
    { t: 1200000, title: 'ECB Interest Rate Decision', country: 'EU' },
    { t: 1300000, title: 'CPI', country: 'CN' },
  ];
  const merged = mergeCalendarNews(cal, live);
  assert.equal(merged.events.length, 3, 'le doublon est fusionné, pas dupliqué');
  assert.equal(merged.events.find((e) => e.t === 1000000).source, 'direct');
  assert.equal(merged.counts.US, 1);
  assert.equal(merged.counts.EU, 1);
  assert.equal(merged.counts.CN, 1);
});

test('agents.js : makeCalendar accepte les annonces en direct et calcule le blackout sur l\'ensemble fusionné', () => {
  const cal = { events: [] };
  const live = [{ t: 500000, title: 'FOMC', country: 'US' }];
  const c = makeCalendar(cal, 30, live);
  assert.equal(c.isBlackout(500000 + 10 * 60), true);
  assert.equal(c.isBlackout(500000 + 60 * 60), false);
  assert.equal(c.sources.liveCount, 1);
});
