/**
 * Watchdog TradingView Desktop : la fonction pure `shouldRelaunch` (aucun I/O), qui décide si une
 * relance automatique doit avoir lieu (seuil d'échecs consécutifs + limite de fréquence).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shouldRelaunch, FAILURE_THRESHOLD, RELAUNCH_MIN_INTERVAL_MS } from '../watchdog.js';

test('shouldRelaunch : pas de relance sous le seuil d\'échecs', () => {
  assert.equal(shouldRelaunch({ failures: 0 }), false);
  assert.equal(shouldRelaunch({ failures: FAILURE_THRESHOLD - 1 }), false);
});

test('shouldRelaunch : relance au seuil, jamais avant', () => {
  assert.equal(shouldRelaunch({ failures: FAILURE_THRESHOLD, lastRelaunchAt: 0 }, 1_000_000), true);
  assert.equal(shouldRelaunch({ failures: FAILURE_THRESHOLD + 5, lastRelaunchAt: 0 }, 1_000_000), true);
});

test('shouldRelaunch : au plus une fois toutes les 10 minutes', () => {
  const now = 1_000_000_000;
  assert.equal(shouldRelaunch({ failures: FAILURE_THRESHOLD, lastRelaunchAt: now }, now + RELAUNCH_MIN_INTERVAL_MS - 1), false, 'trop tôt');
  assert.equal(shouldRelaunch({ failures: FAILURE_THRESHOLD, lastRelaunchAt: now }, now + RELAUNCH_MIN_INTERVAL_MS), true, 'exactement à l\'échéance');
  assert.equal(shouldRelaunch({ failures: FAILURE_THRESHOLD, lastRelaunchAt: now }, now + RELAUNCH_MIN_INTERVAL_MS + 1), true);
});

test('shouldRelaunch : seuil et intervalle personnalisables (options)', () => {
  assert.equal(shouldRelaunch({ failures: 1 }, 2_000_000_000, { threshold: 1 }), true, 'aucune relance précédente (lastRelaunchAt absent)');
  assert.equal(shouldRelaunch({ failures: 5, lastRelaunchAt: 0 }, 500, { minIntervalMs: 1000 }), false);
  assert.equal(shouldRelaunch({ failures: 5, lastRelaunchAt: 0 }, 1500, { minIntervalMs: 1000 }), true);
});

test('shouldRelaunch : entrée invalide (failures non numérique) → jamais de relance', () => {
  assert.equal(shouldRelaunch({}), false);
  assert.equal(shouldRelaunch({ failures: NaN }), false);
  assert.equal(shouldRelaunch(undefined), false);
});
