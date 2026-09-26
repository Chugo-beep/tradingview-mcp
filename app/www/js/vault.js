/**
 * Coffre à secrets (jeton d'appareil).
 * Android : plugin natif TokenVault, chiffrement AES-256-GCM avec une clé du Keystore Android
 * (non exportable). Hors application native : mémoire vive uniquement, jamais localStorage.
 */
import { nativePlugin } from './native.js';

const mem = new Map();
const native = () => nativePlugin('TokenVault');

export const isSecure = () => !!native();

export async function get(key) {
  const p = native();
  if (p) { try { return (await p.get({ key })).value || null; } catch { return null; } }
  return mem.get(key) || null;
}
export async function set(key, value) {
  const p = native();
  if (p) { await p.set({ key, value }); return; }
  mem.set(key, value);
}
export async function remove(key) {
  const p = native();
  if (p) { try { await p.remove({ key }); } catch { /* absent */ } return; }
  mem.delete(key);
}
