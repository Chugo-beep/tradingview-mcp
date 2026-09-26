#!/usr/bin/env node
/**
 * Crée un code d'appairage à usage unique sans démarrer le serveur HTTP : utilisé par
 * installer-android.ps1 quand le serveur PC (127.0.0.1:3777) n'est pas joignable pendant la
 * compilation de l'APK. Écrit dans le même DATA_DIR que security.js (XAUZ_DATA_DIR), avec les
 * mêmes règles (hash SHA-256 uniquement sur disque, TTL ≤ 30 min pour purpose=apk).
 *
 * Usage : node scripts/new-pairing-code.mjs [--ttl 30] [--purpose apk] [--json]
 */
import { newPairingCode } from '../security.js';

const args = process.argv.slice(2);
const argVal = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const ttlRaw = Number(argVal('--ttl'));
const ttlMin = Number.isInteger(ttlRaw) ? ttlRaw : undefined;
const purpose = argVal('--purpose') || 'manuel';
const asJson = args.includes('--json');

try {
  const { code, expiresAt } = await newPairingCode({ ttlMin, purpose });
  if (asJson) {
    process.stdout.write(JSON.stringify({ code, expiresAt }) + '\n');
  } else {
    console.log(`Code d'appairage : ${code} (valable jusqu'à ${new Date(expiresAt).toLocaleTimeString('fr-FR')}, une seule fois)`);
  }
} catch (e) {
  console.error('Erreur : ' + (e?.message || e));
  process.exit(1);
}
