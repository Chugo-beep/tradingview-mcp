import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assessConfidence, confidenceLine } from '../www/js/confidence.js';

const part = (o) => ({ trades: 40, insufficient: false, expectancyR: 0.4, ciR: [0.1, 0.7], randomPercentile: 0.97, ...o });

test('pas de rapport → inconnue', () => assert.equal(assessConfidence(null).level, 'inconnue'));
test('< 30 trades → non démontrée', () => {
  const c = assessConfidence({ full: part({ trades: 12, insufficient: true }) });
  assert.equal(c.level, 'non_demontree');
  assert.match(c.reasons[0], /12/);
});
test('≥ 30 trades et espérance ≤ 0 → négative', () => {
  assert.equal(assessConfidence({ full: part({ expectancyR: -0.1 }) }).level, 'negative');
});
test('4 critères → bonne ; 3 → moyenne ; moins → faible', () => {
  const ok = { full: part(), inSample: part(), outOfSample: part() };
  assert.equal(assessConfidence(ok).level, 'bonne');
  assert.equal(assessConfidence({ ...ok, full: part({ randomPercentile: 0.6 }) }).level, 'moyenne');
  assert.equal(assessConfidence({ ...ok, full: part({ randomPercentile: 0.6, ciR: [-0.2, 0.9] }) }).level, 'faible');
  assert.equal(assessConfidence({ ...ok, outOfSample: part({ insufficient: true }), full: part({ ciR: [-0.2, 0.9] }) }).level, 'faible');
});
test('confidenceLine résume niveau, nombre de trades et espérance', () => {
  const l = confidenceLine(assessConfidence({ full: part(), inSample: part(), outOfSample: part() }));
  assert.match(l, /bonne/); assert.match(l, /40 trades/); assert.match(l, /\+0\.40R/);
});
test('sans intervalle de confiance > 0, jamais mieux que faible', () => {
  const p = part({ ciR: [-0.1, 0.9] });
  assert.equal(assessConfidence({ full: p, inSample: part(), outOfSample: part() }).level, 'faible');
});
