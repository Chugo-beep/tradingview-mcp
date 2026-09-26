/**
 * Accès aux plugins natifs Capacitor sans dépendance npm côté web (aucun bundler, aucun JS de
 * plugin importé) : un plugin natif enregistré côté Java via registerPlugin() n'apparaît sous
 * window.Capacitor.Plugins.<Nom> que s'il fournit un wrapper JS. Sans wrapper, Capacitor 6 exige
 * de demander explicitement le proxy avec Capacitor.registerPlugin(nom) (voir « Custom native
 * code » dans la documentation Capacitor). Sans ce recours, vault.js et LiveKeeper se rabattent
 * silencieusement sur un mode dégradé (mémoire vive) alors que le plugin natif existe bel et bien.
 */
const cache = new Map();

/** Renvoie le proxy JS du plugin natif nommé, ou null s'il est réellement indisponible. */
export function nativePlugin(name) {
  if (cache.has(name)) return cache.get(name);
  const cap = window.Capacitor;
  let plugin = null;
  if (cap) {
    plugin = cap.Plugins?.[name] || null;
    if (!plugin && typeof cap.isPluginAvailable === 'function' && typeof cap.registerPlugin === 'function' && cap.isPluginAvailable(name)) {
      try { plugin = cap.registerPlugin(name); } catch { plugin = null; }
    }
  }
  if (plugin) cache.set(name, plugin); // ne pas mettre en cache un échec : le pont natif peut ne pas être prêt au premier appel
  return plugin;
}

export const isAndroid = () => window.Capacitor?.getPlatform?.() === 'android';
