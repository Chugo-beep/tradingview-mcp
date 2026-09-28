/**
 * Watchdog TradingView Desktop : relance automatique du lanceur (scripts/launch_tv_debug.bat,
 * Windows uniquement) après plusieurs échecs CDP consécutifs (voir tvfeed.js), au maximum une fois
 * toutes les 10 minutes. Opt-in (XAUZ_AUTOLAUNCH_TV=1), car le lanceur ferme TradingView avant de le relancer. N'utilise jamais de chaîne shell
 * interpolée : le lanceur est passé à `spawn` sans argument construit depuis une entrée externe.
 *
 * La décision (« faut-il relancer maintenant ? ») est isolée dans `shouldRelaunch`, une fonction
 * pure sans I/O, pour rester testable unitairement (voir tests/watchdog.test.js).
 */
import { spawn } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as sec from './security.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
/** Nombre d'échecs CDP consécutifs déclenchant une relance. */
export const FAILURE_THRESHOLD = 3;
/** Intervalle minimal entre deux relances automatiques. */
export const RELAUNCH_MIN_INTERVAL_MS = 10 * 60 * 1000;

/**
 * Fonction pure : décide si une relance doit avoir lieu maintenant, sans effet de bord.
 * @param {{failures:number, lastRelaunchAt?:number}} state
 * @param {number} [now]
 * @param {{threshold?:number, minIntervalMs?:number}} [opts]
 */
export function shouldRelaunch({ failures, lastRelaunchAt = 0 } = {}, now = Date.now(), opts = {}) {
  const threshold = Number.isFinite(opts.threshold) ? opts.threshold : FAILURE_THRESHOLD;
  const minIntervalMs = Number.isFinite(opts.minIntervalMs) ? opts.minIntervalMs : RELAUNCH_MIN_INTERVAL_MS;
  if (!Number.isFinite(failures) || failures < threshold) return false;
  if (!Number.isFinite(lastRelaunchAt)) lastRelaunchAt = 0;
  return now - lastRelaunchAt >= minIntervalMs;
}

let lastRelaunchAt = 0;
let tvRelaunches = 0;
/** Nombre de relances effectuées depuis le démarrage du serveur (pour GET /api/health). */
export function relaunchCount() { return tvRelaunches; }
export function lastRelaunchTime() { return lastRelaunchAt || null; }

/**
 * Relance TradingView Desktop si les échecs CDP consécutifs dépassent le seuil, jamais plus d'une
 * fois toutes les 10 minutes, jamais hors Windows, et seulement si XAUZ_AUTOLAUNCH_TV=1 (opt-in).
 * @param {number} failures échecs CDP consécutifs (tvfeed.js, getHealth().failures)
 * @returns {Promise<boolean>} true si une relance a été déclenchée
 */
export async function maybeRelaunchTv(failures, { now = Date.now() } = {}) {
  // opt-in : le lanceur FERME TradingView avant de le relancer (il ne doit pas interrompre
  // l'utilisateur sans son accord) → activé seulement avec XAUZ_AUTOLAUNCH_TV=1.
  if (process.env.XAUZ_AUTOLAUNCH_TV !== '1') return false;
  if (process.platform !== 'win32') return false;
  if (!shouldRelaunch({ failures, lastRelaunchAt }, now)) return false;
  lastRelaunchAt = now;
  tvRelaunches++;
  const bat = resolve(__dirname, '..', 'scripts', 'launch_tv_debug.bat');
  try {
    // `spawn` sans shell, aucun argument externe interpolé (A05) : chemin fixe du dépôt.
    // Un .bat ne peut pas être lancé directement par spawn sous Windows (Node ≥ 18.20/20.12 :
    // EINVAL) : on passe par cmd.exe /c avec le chemin fixe du lanceur (aucune donnée externe).
    const p = spawn(process.env.ComSpec || 'cmd.exe', ['/d', '/c', bat], { detached: true, stdio: 'ignore', windowsHide: true });
    p.on('error', () => { /* best-effort : journalisé ci-dessous quel que soit le résultat */ });
    p.unref();
    await sec.secLog('tv_auto_relaunch', { failures });
    return true;
  } catch (e) {
    await sec.secLog('tv_auto_relaunch_failed', { msg: String(e?.message || e) });
    return false;
  }
}

/** Pour les tests. */
export function _resetWatchdog() { lastRelaunchAt = 0; tvRelaunches = 0; }
