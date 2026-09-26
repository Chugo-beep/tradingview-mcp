#!/usr/bin/env node
/**
 * Extrait les annonces USD à fort impact de history/economic-calendar-2026.md
 * vers app/www/data/calendar.json (embarqué dans l'application, y compris l'APK).
 * Usage : npm run calendar:sync (racine) puis npm run calendar:build (dossier app).
 */
import { readFile, writeFile } from 'node:fs/promises';

const src = new URL('../../history/economic-calendar-2026.md', import.meta.url);
const out = new URL('../www/data/calendar.json', import.meta.url);
const text = await readFile(src, 'utf8');
const syncedAt = (text.match(/Dernière synchronisation : (\S+)/) || [])[1] || null;
const status = (text.match(/- Statut : (\S+)/) || [])[1] || 'INCONNU';
const events = [];
for (const block of text.split(/\n### EVENT-/).slice(1)) {
  const get = (k) => (block.match(new RegExp(`- ${k} : (.*)`)) || [])[1]?.trim();
  const impact = get('Impact');
  const country = (get('Pays / devise') || '').split('/')[0].trim();
  if (impact !== '1' || country !== 'US') continue;
  const t = Date.parse(get('Date/heure UTC'));
  if (!Number.isFinite(t)) continue;
  events.push({ t: Math.floor(t / 1000), title: get('Événement') });
}
events.sort((a, b) => a.t - b.t);
await writeFile(out, JSON.stringify({ source: 'history/economic-calendar-2026.md', status, syncedAt, country: 'US', impact: 'fort', events }));
console.log(`${events.length} annonces USD à fort impact → app/www/data/calendar.json (synchro ${syncedAt})`);
