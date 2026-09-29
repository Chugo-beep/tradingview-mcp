/**
 * Adaptateur de sécurité pour @capacitor/cli 6 (dernière version : 6.2.2, dépend de tar ^6, dont
 * TOUTES les versions sont vulnérables — GHSA-34x7-hfp2-rc4v, GHSA-8qq5-rm4j-mr97, etc.).
 *
 * Capacitor appelle `tslib.__importDefault(require('tar')).default.extract(...)`. tar 7 est marqué
 * `__esModule` sans export par défaut, ce qui casse cet appel. On réexporte donc tar 7.5.22 (corrigé)
 * sous une forme CommonJS simple : `__importDefault` l'enveloppe dans `{ default: … }` et
 * `.default.extract` pointe vers la fonction corrigée.
 *
 * Branché par "overrides" dans app/package.json. À supprimer lors du passage à Capacitor ≥ 7.4.6.
 */
'use strict';
const tar = require('tar-patched');
module.exports = { ...tar };
