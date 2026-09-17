import { mkdir, writeFile } from 'node:fs/promises';

const year = 2026;
const output = new URL('../history/economic-calendar-2026.md', import.meta.url);
const countries = 'AR,AU,BR,CA,CN,FR,DE,IN,ID,IT,JP,KR,MX,RU,SA,ZA,TR,GB,US,EU';
const start = new Date(`${year}-01-01T00:00:00.000Z`);
const end = new Date(`${year + 1}-01-01T00:00:00.000Z`);
const events = new Map();
const missing = [];
let windowCount = 0;

function iso(value) {
  return value.toISOString();
}

function key(event) {
  return String(event.id ?? `${event.date}|${event.country}|${event.title}`);
}

async function fetchWindow(from, to) {
  const params = new URLSearchParams({
    from: iso(from),
    to: iso(to),
    countries,
  });
  const response = await fetch(`https://economic-calendar.tradingview.com/events?${params}`, {
    headers: {
      Accept: 'application/json',
      Origin: 'https://www.tradingview.com',
      Referer: 'https://www.tradingview.com/economic-calendar/',
      'User-Agent': 'Mozilla/5.0',
    },
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const payload = await response.json();
  if (payload.status !== 'ok') {
    throw new Error('Réponse calendrier TradingView invalide');
  }
  return Array.isArray(payload.result) ? payload.result : [];
}

for (let cursor = new Date(start); cursor < end;) {
  const windowStart = new Date(cursor);
  const windowEnd = new Date(Math.min(cursor.getTime() + 7 * 24 * 60 * 60 * 1000, end.getTime()));
  windowCount++;
  try {
    for (const event of await fetchWindow(windowStart, windowEnd)) events.set(key(event), event);
  } catch (error) {
    missing.push(`${iso(windowStart)} -> ${iso(windowEnd)}: ${error.message}`);
  }
  cursor = windowEnd;
}

const sorted = [...events.values()].sort((a, b) => String(a.date).localeCompare(String(b.date)));
const lines = [
  '# Economic Calendar 2026',
  '',
  '- Statut : ' + (missing.length ? 'PARTIEL' : 'COMPLET'),
  '- Période demandée : 2026-01-01 -> 2026-12-31',
  '- Fenêtres synchronisées : ' + (windowCount - missing.length) + '/' + windowCount,
  '- Événements dédupliqués : ' + sorted.length,
  '- Dernière synchronisation : ' + new Date().toISOString(),
  '- Source : https://economic-calendar.tradingview.com/events',
  '- Fuseau stocké : UTC source; TradingView peut afficher un fuseau local dans l’interface.',
  '',
  '## Événements',
  '',
];
for (const event of sorted) {
  lines.push(`### EVENT-${event.id ?? `${event.date}-${event.country}-${event.title}`}`);
  lines.push(`- Date/heure UTC : ${event.date ?? 'NON VÉRIFIÉE'}`);
  lines.push(`- Pays / devise : ${event.country ?? 'NON VÉRIFIÉE'} / ${event.currency ?? 'NON VÉRIFIÉE'}`);
  lines.push(`- Événement : ${event.title ?? 'NON VÉRIFIÉ'}`);
  lines.push(`- Catégorie : ${event.category ?? 'NON VÉRIFIÉE'}`);
  lines.push(`- Impact : ${event.importance ?? 'NON VÉRIFIÉ'}`);
  lines.push(`- Actual : ${event.actual ?? 'NON PUBLIÉ'}`);
  lines.push(`- Forecast : ${event.forecast ?? 'NON DISPONIBLE'}`);
  lines.push(`- Previous : ${event.previous ?? 'NON DISPONIBLE'}`);
  lines.push(`- Unité : ${event.unit ?? 'NON DISPONIBLE'}`);
  lines.push(`- Période : ${event.period ?? 'NON DISPONIBLE'}`);
  lines.push(`- Source : ${event.source_url || event.source || 'NON DISPONIBLE'}`);
  lines.push('');
}
if (missing.length) {
  lines.push('## Fenêtres manquantes');
  lines.push('');
  for (const item of missing) lines.push(`- ${item}`);
  lines.push('');
}

await mkdir(new URL('../history/', import.meta.url), { recursive: true });
await writeFile(output, lines.join('\n'), 'utf8');
console.log(JSON.stringify({ status: missing.length ? 'PARTIEL' : 'COMPLET', events: sorted.length, missing: missing.length, output: output.pathname }, null, 2));
