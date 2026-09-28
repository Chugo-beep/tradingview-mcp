/**
 * Aides de formatage PURES (aucune dépendance à l'état de l'application) : nombres, pips, euros,
 * R, dates, échappement HTML. Extrait d'app.js pour la maintenabilité (aucun changement de
 * comportement).
 */

export const nf = (d) => new Intl.NumberFormat('fr-FR', { minimumFractionDigits: d, maximumFractionDigits: d });

export function fmtNum(v, d = 2) { return v == null || !Number.isFinite(v) ? '—' : nf(d).format(v); }

export function fmtPips(v) { return v == null ? '—' : `${v > 0 ? '+' : ''}${nf(1).format(v)} pips`; }

export function fmtEur(v) { return v == null || !Number.isFinite(v) ? '—' : new Intl.NumberFormat('fr-FR', { style: 'currency', currency: 'EUR', signDisplay: 'exceptZero' }).format(v); }

export function fmtR(v) { return v == null || !Number.isFinite(v) ? '—' : `${v > 0 ? '+' : ''}${nf(2).format(v)} R`; }

export function fmtT(t) { return new Date(t * 1000).toLocaleString('fr-FR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }); }

export function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }

export function dirFr(d, cap) { const s = d === 'BUY' ? 'achat' : 'vente'; return cap ? s[0].toUpperCase() + s.slice(1) : s; }

export function esc(s) { return String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }
