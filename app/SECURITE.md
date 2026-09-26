# Sécurité de XAUUSD Zones : OWASP Top 10:2025

Ce document décrit comment l'application traite chacune des dix catégories de l'OWASP Top 10:2025, et quels risques restent ouverts. Pour l'application Android, il s'appuie aussi sur l'OWASP MASVS.

Les mesures marquées « testé » sont vérifiées automatiquement par `tests/security.test.js` (`npm test`).

## Architecture et surface d'attaque

```
Téléphone (APK) ──HTTPS / WireGuard (Tailscale)──▶ tailscale serve (PC, :443 du tailnet)
                                                     │
                                                     ▼
                                       127.0.0.1:3778  API distante (lecture seule)
Navigateur du PC ─────────────────────▶ 127.0.0.1:3777  interface + administration
                                                     │
                                                     ▼
                                       127.0.0.1:9222  TradingView Desktop (CDP)
```

- **Aucun port n'est ouvert sur Internet ni sur le réseau local.** Les deux services écoutent uniquement sur `127.0.0.1`. Le téléphone passe par Tailscale Serve, qui relaie en HTTPS uniquement pour les appareils connectés à ton compte Tailscale.
- **L'API distante n'expose que sept routes :** `GET /api/health`, `POST /api/pair`, `GET /api/tv/candles`, `GET /api/news`, `GET /api/session`, `POST /api/scan/start` et `GET /api/scan/{status,result}`, toutes sauf les deux premières avec un jeton. Rien ne permet de modifier TradingView ou de lire des fichiers.
- **« Analyse complète » (`/api/scan/*`)** parcourt tous les marchés d'une liste blanche fixe (`app/www/js/markets.js`, 11 entrées) : `market` (sur `/api/tv/candles`) et les marchés scannés ne sont jamais des chaînes arbitraires, seulement des identifiants de ce registre. Un seul scan à la fois côté serveur (409 sinon) ; le déclenchement distant (téléphone) est en plus limité à 1 par appareil et 10 minutes (429 sinon), ce scan étant coûteux (plusieurs minutes, bascules répétées du graphique TradingView).
- **Nouvel appel réseau sortant, depuis le PC uniquement :** `app/newsfeed.js` interroge en HTTPS `https://economic-calendar.tradingview.com/events` (calendrier économique TradingView, même service que `scripts/sync-economic-calendar.mjs`) pour les annonces majeures US/EU/CN/JP. Aucun secret n'est envoyé (aucune authentification, aucun cookie) ; chaque champ reçu est assaini avant stockage (liste blanche, longueurs bornées, nombres finis) et persisté sans donnée sensible dans `DATA_DIR/news.json`. Le téléphone ne fait jamais cet appel : il lit `/api/news` sur le PC (ou via l'API distante, avec jeton).
- **L'administration est réservée au PC :** codes d'appairage, appareils, journal et préparation de TradingView passent par le port local 3777.
- **Aucun ordre n'est passé chez un courtier.** L'application lit des bougies, rien d'autre.

## A01:2025 – Contrôle d'accès défaillant
- **Refus par défaut :** toute route non listée répond 404, et toute route distante autre que `health` et `pair` exige un jeton d'appareil (testé).
- **Passage obligé par Tailscale :** une requête distante sans l'en-tête d'identité `Tailscale-User-Login`, que seul Tailscale Serve ajoute, est refusée (testé).
- **Jeton lié au compte :** chaque jeton est lié au compte Tailscale qui a fait l'appairage. Un autre compte est refusé en 403 (testé).
- **Séparation des rôles :** l'administration n'existe que sur le port local. Elle est protégée contre le rebinding DNS par une liste blanche du `Host` (testé) et contre le CSRF par un en-tête obligatoire `X-XZ` et le contrôle de l'`Origin` (testé).
- **CORS restreint :** seules les origines de l'application Capacitor (`https://localhost`, `capacitor://localhost`) sont acceptées (testé).
- **Fichiers statiques :** la traversée de répertoire est bloquée par résolution puis contrôle du chemin relatif, et seules les extensions connues sont servies (testé).

## A02:2025 – Mauvaise configuration de sécurité
- **Écoute locale uniquement :** les services écoutent sur `127.0.0.1`. L'option réseau `--lan` a été supprimée.
- **En-têtes de sécurité :**
  - une CSP stricte, sans script ni style en ligne (testé) ;
  - `X-Content-Type-Options`, `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer` ;
  - `Permissions-Policy`, COOP et CORP ;
  - `Cache-Control: no-store` ;
  - HSTS sur l'API distante.
- **Pas de bannière serveur :** aucun `X-Powered-By` (testé).
- **Android :**
  - `allowBackup=false` et règles d'extraction de données vides ;
  - trafic en clair interdit, certificats système uniquement ;
  - débogage WebView désactivé ;
  - build release.

- **Android, permissions ajoutées (v4) :**
  - notifications (`POST_NOTIFICATIONS`) ;
  - service au premier plan « usage spécial », uniquement pendant l'analyse en direct lancée par l'utilisateur, avec une notification permanente visible ;
  - verrou de veille partiel, limité à 12 h ;
  - demande d'exemption d'optimisation batterie, qui n'est affichée que si l'utilisateur la déclenche.
  - Ces ajouts n'ouvrent aucun accès réseau supplémentaire. Le texte des notifications ne contient ni jeton ni donnée personnelle.

## A03:2025 – Défaillances de la chaîne d'approvisionnement logicielle
- **Dépendances minimales :** 4 paquets Capacitor officiels, à versions exactes et figées dans le fichier de verrouillage. L'installation utilise `npm ci`.
- **Audit bloquant :** `npm audit --omit=dev --audit-level=critical` arrête la compilation si une vulnérabilité critique est détectée.
- **Aucun code distant :** pas de CDN ni de script externe. Le graphique et le moteur sont écrits dans le projet.
- **JDK de compilation :** il est téléchargé uniquement depuis la source officielle adoptium.net.

## A04:2025 – Défaillances cryptographiques
- **Transport :** HTTPS (certificat Let's Encrypt fourni par Tailscale) dans un tunnel WireGuard. Le téléphone refuse toute adresse autre que `https://` (testé dans l'interface).
- **Jetons :** 256 bits issus de `crypto.randomBytes`. Seule leur empreinte SHA-256 est stockée sur le PC (testé), et la comparaison se fait en temps constant.
- **Téléphone :** le jeton est chiffré en AES-256-GCM avec une clé non exportable du Keystore Android (plugin natif `TokenVault`). Il n'est jamais écrit dans `localStorage`.
- **Signature de l'APK :** clé RSA 3072 générée localement. Son mot de passe est protégé par Windows DPAPI et le dossier par des ACL limitées à ton compte.

## A05:2025 – Injection
- **Paramètres validés par liste blanche :** timeframes, nombre de bougies (entier de 50 à 20 000, ou littéral `all`), `since` (entier unix, 0 < since < 4102444800 ; entier ≥ 0 pour `/api/news`) et `market` (identifiant du registre `markets.js`, 400 sinon) (testé).
- **Annonces économiques (`/api/news`) assainies à la source :** seuls les champs whitelistés (id, titre, pays, heure, actual/forecast/previous, unité, échelle, période) sont conservés, importance MAJEURE et 4 pays whitelistés uniquement, chaînes nettoyées des caractères de contrôle et bornées en longueur, nombres finis (testé, avec des fixtures — le bac à sable n'a pas d'accès réseau à TradingView).
- **Pas de code injecté dans TradingView :** tout ce que le serveur exécute via CDP est soit un nombre validé, soit une chaîne sérialisée par `JSON.stringify` et vérifiée par une expression régulière.
- **Interface :** les données affichées passent par `textContent` ou par un échappement HTML systématique (`esc`), et la CSP interdit tout script en ligne.
- **Journal :** les retours à la ligne sont neutralisés (pas d'injection de lignes).

## A06:2025 – Conception non sécurisée
- **Menaces prises en compte :**
  - vol du téléphone : révocation depuis le PC, jeton chiffré par le Keystore, captures d'écran bloquées ;
  - vol du code d'appairage : 8 chiffres, 10 minutes, usage unique, 5 essais ;
  - site web malveillant ouvert sur le PC : rebinding DNS et CSRF bloqués ;
  - réseau hostile : chiffrement de bout en bout Tailscale.
- **Moindre privilège :** l'API distante est en lecture seule, avec au plus 5 appareils et des jetons expirant après 180 jours.
- **Données minimales :** aucune clé de fournisseur ni donnée personnelle. Les anciennes clés OANDA stockées sont effacées au démarrage.

## A07:2025 – Défaillances d'authentification
- **Appairage :** code à usage unique (testé), grillé après 5 essais (testé), expirant en 10 minutes (manuel) ou 30 minutes maximum (préconfiguration APK, `purpose=apk`, testé).
- **Persistance du code en attente :** le code d'appairage courant (empreinte SHA-256 seule, jamais le code en clair) est écrit sur disque (`DATA_DIR/pairing.json`, permissions `0600`) à chaque création/tentative/purge, et rechargé paresseusement par `redeemPairing` — un code créé par un autre processus (`scripts/new-pairing-code.mjs`, utilisé par l'installeur quand le serveur PC ne tourne pas) ou pendant que le serveur était arrêté reste donc valable dès que le serveur y accède, en retenant toujours la version la plus récente (testé).
- **Code embedded dans l'APK (préconfiguration) :** pour éviter toute saisie, l'installeur génère un code d'appairage (30 min, usage unique) et l'écrit dans `www/provision.json`, empaqueté tel quel dans l'APK compilé. **Risque accepté :** quiconque obtient ce fichier APK avant l'expiration du code (30 min après compilation) pourrait tenter de l'utiliser pour s'appairer à ta place ; passé ce délai, ou une fois utilisé (usage unique), le code figé dans l'APK est définitivement inerte. Le fichier `provision.json` source sur le PC est remis à `{}` juste après la compilation (le code ne reste que dans l'APK déjà installé sur ton téléphone).
- **Verrouillage :** après 10 échecs en 10 minutes, l'API distante est bloquée 15 minutes (testé).
- **Débit :** limité à 120 requêtes par minute et par compte.
- **Gestion des jetons :** expiration, révocation immédiate depuis le PC (testé) et effacement sur le téléphone.

## A08:2025 – Défaillances d'intégrité des logiciels ou des données
- **Bougies :** chaque bougie reçue de TradingView est validée (types, `high ≥ low`, prix positifs). Les lignes invalides sont écartées.
- **Mises à jour de l'application :** pas de mise à jour automatique ni de chargement dynamique. L'APK est signé, et Android refuse une mise à jour signée par une autre clé.
- **Calendrier économique :** il est embarqué dans l'application, et non téléchargé à l'exécution.

## A09:2025 – Défaillances de journalisation et d'alerte
- **Journal de sécurité :**
  - fichier JSON horodaté dans `%APPDATA%\xauusd-zones\security.log`, avec rotation à 1 Mo ;
  - événements consignés : appairages, révocations, échecs, verrouillages, requêtes refusées, erreurs ;
  - aucun secret n'y figure (testé).
- **Alertes :** le panneau Réglages du PC affiche les événements récents, le nombre d'événements suspects sur 24 h et l'état de verrouillage.

## A10:2025 – Mauvaise gestion des conditions exceptionnelles
- **Échec fermé :**
  - un jeton illisible est effacé sur le téléphone ;
  - un jeton inconnu donne 401 ;
  - une erreur interne renvoie un message générique, sans trace de pile.
- **Limites :** corps de requête limité à 2 Ko (testé), type de contenu imposé (testé), JSON invalide rejeté (testé), délais d'expiration côté serveur et client.
- **Robustesse :** les rejets et exceptions non gérés sont journalisés sans arrêter le service. L'indisponibilité de TradingView renvoie une erreur claire (503).

## Risques résiduels (acceptés ou à ta charge)
- **Port de débogage de TradingView :** le port CDP 9222 est accessible à tout programme exécuté sur le PC. C'est inhérent au projet tradingview-mcp : n'installe pas de logiciel douteux sur ce PC.
- **Compte Tailscale :** sa sécurité conditionne l'accès. Active l'authentification à deux facteurs sur le compte (Google ou Microsoft, par exemple) utilisé pour Tailscale.
- **PC éteint :** si le PC ou TradingView est éteint, le téléphone ne reçoit plus de données. L'application l'affiche.
- **Absence d'audit externe :** ce document décrit les mesures appliquées. Il ne remplace pas un audit indépendant ou un test d'intrusion.
