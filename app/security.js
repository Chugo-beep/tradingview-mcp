/**
 * Sécurité du serveur XAUUSD Zones (référence : OWASP Top 10:2025).
 *
 * - A07 Authentification : appairage par code à usage unique (8 chiffres, 10 min, 5 essais),
 *   puis jeton d'appareil aléatoire de 256 bits, expirant, révocable.
 * - A04 Cryptographie : seuls les empreintes SHA-256 des jetons sont stockées ; comparaison
 *   en temps constant ; transport HTTPS assuré par Tailscale Serve.
 * - A01 Contrôle d'accès : refus par défaut, liaison appareil ↔ compte Tailscale.
 * - A09 Journalisation : événements de sécurité horodatés (sans secret), alertes en cas d'abus.
 * - A10 Conditions exceptionnelles : échec fermé, erreurs génériques, limites de taille.
 */
import { randomBytes, randomInt, createHash, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, writeFile, appendFile, stat, rename, chmod } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';

export const DATA_DIR = process.env.XAUZ_DATA_DIR
  || (process.platform === 'win32' ? join(process.env.APPDATA || join(homedir(), 'AppData', 'Roaming'), 'xauusd-zones') : join(homedir(), '.xauusd-zones'));
const DEVICES_FILE = () => join(DATA_DIR, 'devices.json');
const LOG_FILE = () => join(DATA_DIR, 'security.log');

export const LIMITS = {
  pairingTtlMs: 10 * 60 * 1000,
  pairingMaxTtlMin: 30,
  pairingMaxAttempts: 5,
  tokenTtlMs: 180 * 24 * 3600 * 1000,
  authFailWindowMs: 10 * 60 * 1000,
  authFailMax: 10,
  lockoutMs: 15 * 60 * 1000,
  maxDevices: 5,
  logMaxBytes: 1024 * 1024,
};

const sha256 = (s) => createHash('sha256').update(s).digest('hex');
function safeEqualHex(a, b) {
  const x = Buffer.from(String(a), 'hex'), y = Buffer.from(String(b), 'hex');
  return x.length === y.length && x.length > 0 && timingSafeEqual(x, y);
}

// ── journal de sécurité (A09) ─────────────────────────────────────────────
const recent = []; // derniers événements pour l'interface PC
export async function secLog(event, details = {}) {
  const entry = { t: new Date().toISOString(), event, ...sanitize(details) };
  recent.push(entry); if (recent.length > 200) recent.shift();
  try {
    await mkdir(DATA_DIR, { recursive: true });
    try { const s = await stat(LOG_FILE()); if (s.size > LIMITS.logMaxBytes) await rename(LOG_FILE(), LOG_FILE() + '.1'); } catch { /* absent */ }
    await appendFile(LOG_FILE(), JSON.stringify(entry) + '\n', { mode: 0o600 });
  } catch { /* le journal ne doit jamais faire tomber le service */ }
  return entry;
}
function sanitize(d) {
  const out = {};
  for (const [k, v] of Object.entries(d)) {
    if (/token|code|secret|password|authorization/i.test(k)) continue; // jamais de secret dans le journal
    out[k] = typeof v === 'string' ? v.replace(/[\r\n\t]/g, ' ').slice(0, 200) : v;
  }
  return out;
}
export const recentEvents = () => recent.slice(-50).reverse();
export function alerts() {
  const since = Date.now() - 24 * 3600 * 1000;
  return recent.filter((e) => Date.parse(e.t) > since && /fail|lock|refus|revoked|rejected/i.test(e.event)).length;
}

// ── appareils (jetons hachés) ────────────────────────────────────────────
let devices = null;
async function loadDevices() {
  if (devices) return devices;
  try { devices = JSON.parse(await readFile(DEVICES_FILE(), 'utf8')); if (!Array.isArray(devices)) devices = []; }
  catch { devices = []; }
  return devices;
}
async function saveDevices() {
  await mkdir(DATA_DIR, { recursive: true });
  const tmp = DEVICES_FILE() + '.tmp';
  await writeFile(tmp, JSON.stringify(devices, null, 2), { mode: 0o600 });
  await rename(tmp, DEVICES_FILE());
  try { await chmod(DEVICES_FILE(), 0o600); } catch { /* Windows : ACL du profil utilisateur */ }
}
export async function listDevices() {
  const now = Date.now();
  return (await loadDevices()).map((d) => ({ id: d.id, name: d.name, login: d.login, createdAt: d.createdAt, lastSeen: d.lastSeen, expired: d.expiresAt < now }));
}
export async function revokeDevice(id) {
  await loadDevices();
  const before = devices.length;
  devices = devices.filter((d) => d.id !== id);
  if (devices.length !== before) { await saveDevices(); await secLog('device_revoked', { device: id }); return true; }
  return false;
}

// ── codes d'appairage (usage unique) ─────────────────────────────────────
let pairing = null; // { hash, expiresAt, attempts }
/**
 * @param {object} [o]
 * @param {number} [o.ttlMin] durée de validité (1 à 30 min, 10 par défaut) ; 30 min sert à la
 *   préconfiguration de l'APK, le temps de compiler et d'installer.
 * @param {string} [o.purpose] 'manuel' ou 'apk' (journalisé)
 */
export async function newPairingCode({ ttlMin, purpose = 'manuel' } = {}) {
  const ttlMs = Number.isInteger(ttlMin) && ttlMin >= 1 && ttlMin <= LIMITS.pairingMaxTtlMin ? ttlMin * 60000 : LIMITS.pairingTtlMs;
  const code = String(randomInt(0, 1e8)).padStart(8, '0');
  pairing = { hash: sha256(code), expiresAt: Date.now() + ttlMs, attempts: 0 };
  await secLog('pairing_code_created', { expiresInMin: ttlMs / 60000, purpose: purpose === 'apk' ? 'apk' : 'manuel' });
  return { code, expiresAt: pairing.expiresAt };
}

/** Échange un code d'appairage contre un jeton d'appareil (renvoyé une seule fois). */
export async function redeemPairing({ code, name, login }) {
  if (isLocked()) { await secLog('pair_rejected_locked', { login }); return { ok: false, status: 429, error: 'Trop de tentatives : réessaie dans 15 minutes.' }; }
  if (!pairing || Date.now() > pairing.expiresAt) {
    await authFailure('pair_fail_no_code', { login });
    return { ok: false, status: 401, error: 'Code invalide ou expiré : génère un nouveau code sur le PC.' };
  }
  pairing.attempts++;
  const ok = /^\d{8}$/.test(String(code || '')) && safeEqualHex(sha256(String(code)), pairing.hash);
  if (!ok) {
    if (pairing.attempts >= LIMITS.pairingMaxAttempts) { pairing = null; await secLog('pairing_code_burned', { login }); }
    await authFailure('pair_fail_bad_code', { login });
    return { ok: false, status: 401, error: 'Code invalide ou expiré : génère un nouveau code sur le PC.' };
  }
  pairing = null; // usage unique
  await loadDevices();
  if (devices.length >= LIMITS.maxDevices) {
    await secLog('pair_rejected_max_devices', { login });
    return { ok: false, status: 409, error: `Nombre maximal d'appareils atteint (${LIMITS.maxDevices}) : révoque un appareil sur le PC.` };
  }
  const token = randomBytes(32).toString('base64url');
  const id = randomBytes(6).toString('hex');
  const now = Date.now();
  devices.push({ id, name: cleanName(name), login: login || null, hash: sha256(token), createdAt: now, lastSeen: now, expiresAt: now + LIMITS.tokenTtlMs });
  await saveDevices();
  await secLog('device_paired', { device: id, name: cleanName(name), login });
  return { ok: true, token, deviceId: id, expiresAt: now + LIMITS.tokenTtlMs };
}
const cleanName = (n) => String(n || 'Téléphone').replace(/[^\p{L}\p{N} _.\-()]/gu, '').slice(0, 40) || 'Téléphone';

/** Vérifie un jeton « Bearer ». */
export async function authenticate({ authorization, login }) {
  if (isLocked()) return { ok: false, status: 429, error: 'Accès temporairement bloqué après trop d\'échecs.' };
  const m = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(String(authorization || ''));
  if (!m) { await authFailure('auth_fail_missing', { login }); return { ok: false, status: 401, error: 'Authentification requise : appaire ce téléphone.' }; }
  const h = sha256(m[1]);
  await loadDevices();
  const d = devices.find((x) => safeEqualHex(x.hash, h));
  if (!d) { await authFailure('auth_fail_unknown_token', { login }); return { ok: false, status: 401, error: 'Appareil inconnu ou révoqué : appaire à nouveau ce téléphone.' }; }
  if (d.expiresAt < Date.now()) { await authFailure('auth_fail_expired', { device: d.id, login }); return { ok: false, status: 401, error: 'Appairage expiré : appaire à nouveau ce téléphone.' }; }
  // liaison au compte Tailscale ayant fait l'appairage (défense en profondeur)
  if (d.login && login && d.login !== login) { await authFailure('auth_fail_login_mismatch', { device: d.id, login }); return { ok: false, status: 403, error: 'Compte Tailscale différent de celui de l\'appairage.' }; }
  if (Date.now() - d.lastSeen > 60000) { d.lastSeen = Date.now(); saveDevices().catch(() => {}); }
  return { ok: true, device: d.id };
}

// ── limitation / verrouillage (A07) ───────────────────────────────────────
const failures = [];
let lockedUntil = 0;
export const isLocked = () => Date.now() < lockedUntil;
async function authFailure(event, details) {
  const now = Date.now();
  failures.push(now);
  while (failures.length && failures[0] < now - LIMITS.authFailWindowMs) failures.shift();
  await secLog(event, details);
  if (failures.length >= LIMITS.authFailMax && !isLocked()) {
    lockedUntil = now + LIMITS.lockoutMs;
    failures.length = 0;
    await secLog('remote_locked', { minutes: LIMITS.lockoutMs / 60000 });
  }
}

/** Pour les tests. */
export function _reset() { devices = null; pairing = null; failures.length = 0; lockedUntil = 0; recent.length = 0; }

// ── en-têtes de sécurité (A02) ───────────────────────────────────────────
export function securityHeaders({ html = false, remote = false } = {}) {
  const h = {
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'X-Frame-Options': 'DENY',
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Cross-Origin-Resource-Policy': 'same-origin',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
    'Cache-Control': 'no-store',
  };
  if (html) {
    h['Content-Security-Policy'] = "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; font-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";
  }
  if (remote) h['Strict-Transport-Security'] = 'max-age=31536000';
  return h;
}
