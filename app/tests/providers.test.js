/**
 * Tests unitaires de la décision de retéléchargement complet côté client (sans réseau).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { needsFullRefetch } from '../www/js/providers.js';

const T0 = 1_800_000_000_000; // ms, date arbitraire

test('needsFullRefetch : pas de meta → jamais de retéléchargement forcé', () => {
  assert.equal(needsFullRefetch({ count: 100, first: 10 }, null, T0, T0), false);
});

test('needsFullRefetch : pas de cache (première analyse) → retéléchargement complet', () => {
  assert.equal(needsFullRefetch(null, { count: 100, first: 10 }, T0, T0), true);
});

test('needsFullRefetch : première bougie du serveur plus ancienne que le cache → historique agrandi', () => {
  const cache = { count: 100, first: 1000 };
  const meta = { count: 100, first: 500 }; // TradingView a chargé plus loin en arrière
  assert.equal(needsFullRefetch(cache, meta, T0, T0), true);
});

test('needsFullRefetch : nombre de bougies en hausse notable (> +50) → historique agrandi', () => {
  const cache = { count: 500, first: 1000 };
  const meta = { count: 560, first: 1000 };
  assert.equal(needsFullRefetch(cache, meta, T0, T0), true);
});

test('needsFullRefetch : légère hausse (≤ 50) sans recul de la première bougie → pas forcé', () => {
  const cache = { count: 500, first: 1000 };
  const meta = { count: 530, first: 1000 };
  assert.equal(needsFullRefetch(cache, meta, T0, T0), false);
});

test('needsFullRefetch : 30 minutes écoulées depuis le dernier téléchargement complet → forcé', () => {
  const cache = { count: 500, first: 1000 };
  const meta = { count: 500, first: 1000 };
  assert.equal(needsFullRefetch(cache, meta, T0, T0 + 31 * 60 * 1000), true);
  assert.equal(needsFullRefetch(cache, meta, T0, T0 + 10 * 60 * 1000), false);
});

test('needsFullRefetch : jamais de téléchargement complet connu (lastFull null) → forcé', () => {
  const cache = { count: 500, first: 1000 };
  const meta = { count: 500, first: 1000 };
  assert.equal(needsFullRefetch(cache, meta, null, T0), true);
});
