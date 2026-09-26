# XAUUSD Zones : application sans IA

> **Utilisateur final (trader, non développeur) : commence par [GUIDE-UTILISATEUR.md](GUIDE-UTILISATEUR.md).** Ce document technique décrit l'implémentation ; le guide couvre l'installation, l'utilisation quotidienne, les notifications, les réglages et le dépannage.

L'application détecte les zones d'achat et de vente sur XAUUSD avec les règles de `TRADING_RULES_MASTER_PROMPT.md` : liquidité prise sur P, order block C1, imbalance stricte C1/C3 mèches incluses, et absence de retest après C3. Pour chaque zone, elle indique si elle est **toujours viable** ou non.

Elle fonctionne sans IA, sans Claude et sans MCP. Le même code tourne sur PC (navigateur ou fenêtre d'application) et sur Android (APK).

| Statut | Signification |
|---|---|
| **Viable** | Aucune bougie n'est revenue dans la zone depuis C3, et le prix est du bon côté. |
| Non viable · retestée | Une bougie postérieure à C3 a touché la zone. La bougie en cours compte aussi. |
| Non viable · cassée | Après le retest, une bougie a clôturé au-delà du bord opposé. |
| Non viable · dépassée | Le prix est passé de l'autre côté sans toucher la zone (gap de marché). |

Le badge **gap fragile** signale une imbalance inférieure à 0,1 × ATR(14). Ce seuil se règle.
L'**entrée** affichée est le bord de la zone le plus proche du prix. L'**invalidation** est le bord opposé.

## Source de données : TradingView Desktop uniquement

Toutes les bougies viennent du **TradingView Desktop de ton PC**. Il n'y a ni OANDA ni autre fournisseur, et aucune clé API n'est nécessaire.

- **Lecture sans perturbation :** avec « Préparer TradingView » (Réglages, sur le PC), la disposition passe à plusieurs graphiques XAUUSD (1m, 5m, 15m, 1h, 4h, 1D, selon ce que ton abonnement autorise). Le serveur lit alors chaque graphique sans jamais changer ta timeframe.
- **Timeframes absentes de la disposition :** le graphique actif bascule brièvement, puis revient à ta timeframe d'origine. Un cache limite ces bascules.
- **Garde-fou :** le graphique doit correspondre au marché analysé (liste blanche `www/js/markets.js` : XAUUSD par défaut, ou tout autre marché suivi), sinon l'analyse est bloquée.

## Analyse complète et marchés en direct

Au-delà de XAUUSD, l'application suit 10 autres marchés (US30, S&P 500, Nasdaq 100, EUR/USD, GBP/USD, USD/JPY, DAX 40, CAC 40, WTI, Brent — registre `www/js/markets.js`). L'onglet **« Marchés »** lance une **analyse complète** (tous ces marchés × 9 timeframes, 1m à 1 an, en tâche de fond côté serveur, `POST /api/scan/start`), publie un **classement** par gains en pips puis taux de réussite (`GET /api/scan/result`). Par défaut, les **2 meilleurs marchés** du classement sont analysés **en direct simultanément**, chacun sur son propre graphique TradingView dédié (`POST /api/tv/setup-live`) : le nombre de marchés en direct est réglable (« Graphiques disponibles dans TradingView » : 1/2/4/8/16, plafonné à 2 panneaux dédiés), et se réduit à 1 (rotation classique du graphique actif) si un seul graphique est disponible. Les règles de trading (5★, SL ≤ 100 pips, TP, gestion du stop) sont identiques pour tous les marchés, avec le pip propre à chacun.

## PC (Windows)

Double-clique sur `app\XAUUSD-Zones.bat`. Le script :
1. lance TradingView Desktop avec le port de débogage local, s'il ne tourne pas déjà ;
2. démarre le serveur ;
3. ouvre l'application dans une fenêtre Edge.

## Téléphone, depuis n'importe où (Tailscale)

Le téléphone lit les données du PC à travers **Tailscale**, un réseau privé chiffré gratuit pour un usage personnel. Aucun port n'est ouvert sur ta box ni sur Internet.

Une seule fois :
1. Installe Tailscale sur le PC (tailscale.com/download/windows) et sur le OnePlus (Play Store). Connecte les deux **avec le même compte** et active la double authentification sur ce compte.
2. Sur le PC, double-clique sur `app\acces-distant.bat`. Si un lien te demande d'activer « HTTPS Certificates » ou MagicDNS, ouvre-le, active l'option et relance le script. Il affiche l'adresse du PC, du type `https://nom-du-pc.tailnet-xxxx.ts.net`.
3. Dans l'application PC, ouvre Réglages et clique sur **Générer un code d'appairage** : un code de 8 chiffres s'affiche, valable 10 minutes et utilisable une seule fois.
4. Dans l'application du téléphone, appuie sur **Saisir le code**, tape les 8 chiffres, puis **Connecter au PC** (l'adresse est préréglée).

Pour la suite :
- Le PC doit rester allumé, avec TradingView Desktop et `XAUUSD-Zones.bat` lancés. Le téléphone fonctionne en Wi-Fi comme en 4G/5G.
- Réglages PC → **Appareils autorisés** permet de révoquer un téléphone (perdu, volé…).
- `acces-distant-arreter.bat` coupe l'accès distant.

La sécurité, détaillée pour chaque catégorie de l'OWASP Top 10:2025, est décrite dans **SECURITE.md**.

## Android (APK)

### A. Installation automatique (Android Studio + téléphone en USB)

Double-clique sur `app\installer-android.bat`. Le script :
1. installe les dépendances à versions figées et lance un audit de sécurité ;
2. durcit le projet Android ;
3. compile un APK **release**, signé avec une clé créée sur ton PC (`%USERPROFILE%\.xauusd-zones`) ;
4. l'installe sur le téléphone branché en USB, avec le débogage USB autorisé.

**Adresse préréglée :** l'application connaît déjà l'adresse Tailscale du PC (`https://joshua.taila406c5.ts.net`). À chaque compilation, `installer-android.bat` relit l'adresse actuelle auprès de Tailscale et l'intègre à l'APK. Sur le téléphone, **seul le code d'appairage est à saisir** : lance `code-appairage.bat` sur le PC, puis tape les 8 chiffres dans l'application (le bandeau « Saisir le code » y mène directement). L'adresse reste modifiable dans Réglages → Connexion au PC → « Adresse du PC ».

L'APK est aussi copié dans `app\XAUUSD-Zones.apk`. Si le téléphone n'était pas prêt, `app\installer-telephone.bat` fait uniquement l'installation.

## Utilisation

Mode d'emploi détaillé (boutons, onglets, notifications, réglages) : **[GUIDE-UTILISATEUR.md](GUIDE-UTILISATEUR.md)**. En résumé pour un développeur qui teste l'interface :

- Les onglets **1m 5m 15m 1h 4h 1D** changent le graphique. Un point vert signale une TF qui a des zones viables.
- Pour naviguer dans le graphique : glisser pour déplacer, molette ou pincement pour zoomer, double-clic pour revenir à la fin.
- Clique sur une zone, dans la liste ou sur le graphique, pour voir la preuve complète : OHLC de P/C1/C2/C3, niveau de liquidité, gap et retest.
- Mode démo (PC uniquement, données simulées) : ajoute `?demo=1` à l'adresse.

## Réglages de la méthode

| Réglage | Défaut | Rôle |
|---|---|---|
| Fenêtre de liquidité | 5 | P doit balayer l'extrême (creux pour un achat, sommet pour une vente) des N bougies précédentes, puis clôturer en réintégrant. |
| Gap fragile | 0,1 × ATR | En dessous de ce seuil, la zone est marquée « gap fragile ». |

Historique des bougies (pas un réglage exposé, comportement fixe) : toutes les bougies chargées dans TradingView Desktop sont utilisées. Le serveur charge l'historique automatiquement (démarrage puis toutes les 30 min) ; bouton « Charger tout l'historique TradingView » pour forcer, bouton « Tout voir » sur le graphique pour tout afficher. Plafond de sécurité : 20 000 bougies par timeframe (`MAX_BARS`, `tvfeed.js`).

## Structure

```
app/
  server.js              serveur PC : interface + administration (127.0.0.1:3777) et API téléphone (127.0.0.1:3778)
  security.js            appairage, jetons hachés, verrouillage, journal de sécurité, en-têtes
  tvfeed.js              lecture de TradingView Desktop (multi-graphiques, bascule, validation)
  newsfeed.js            annonces économiques majeures en direct (US/EU/CN/JP, TradingView) : polling, assainissement, /api/news
  XAUUSD-Zones.bat       lanceur Windows
  acces-distant.bat      publication HTTPS dans ton réseau Tailscale
  installer-android.bat  compilation release signée + installation sur le téléphone
  native/android/        coffre Keystore (TokenVault), MainActivity, sécurité réseau Android
  SECURITE.md            conformité OWASP Top 10:2025
  www/                   interface (identique sur PC et Android)
  tests/                 règles, positions, sécurité (npm test)
```

Tests : `npm test` dans `app` (règles, positions et 13 tests de sécurité).

## Version 2 : positions, balance, catégories, apprentissage

### Bouton « Analyser »
Le bouton lance l'analyse **en temps réel** : les agents tournent toutes les 5 à 60 s (réglable) et mettent à jour les zones, les ordres et les positions. Appuie à nouveau pour arrêter (« En direct » avec le point rouge).

### Stratégie Order Blocks « 5 étoiles »
Chaque order block est noté sur 5, selon `trading_agent_order_blocks.md` et la section 6 de `TRADING_RULES_MASTER_PROMPT.md` :
- ⭐1 **imbalance** (éliminatoire) ;
- ⭐2 **tendance** Supertrend, hors range (éliminatoire) ;
- ⭐3 pas de **liquidité** proche au-delà de l'OB ;
- ⭐4 OB **vierge** ;
- ⭐5 achat en **Discount** / vente en **Premium** (Fibonacci 0,5).

Seules les zones **5★** sont proposées/validées : toute zone notée moins de 5★ est considérée **invalidée** (proposition « REFUSEE »). Le détail d'une zone montre la grille, la liquidité à prendre avant l'OB et la confluence multi-UT.

Par défaut, l'entrée se fait **après une réaction** : le prix revient dans l'OB, puis une bougie clôture dans le sens du trade (1 minute si disponible). Si l'OB casse avant, il n'y a pas de trade. Deux notifications se suivent :
1. `👀 ★★★★★ ACHAT GOLD · zone …` : la zone est à surveiller ;
2. `🟢 ACHAT GOLD @ prix ★★★★★` avec TP1 · TP2 · TP3 · SL : le trade est à prendre maintenant.

### Positions, objectifs et balance
L'utilisateur ne règle plus le stop loss ni les objectifs : ils sont **entièrement automatiques**, par catégorie (Scalp / Daily / Swing).
- **Stop loss :** placé **uniquement sur l'invalidation de la zone**, c'est-à-dire le bord opposé de l'order block C1, plus une marge automatique adaptée à la catégorie (`max(3 pips, min(bufAtr × ATR, 25 % de la hauteur de l'OB))`, `bufAtr` = 5 % en scalping, 10 % en daily, 15 % en swing).
- **Règle dure : le risque (entrée → SL) ne doit jamais dépasser 100 pips**, quelle que soit la catégorie. Au-delà, la zone est **REFUSÉE** (« non viable »). Avec l'entrée sur confirmation, le risque réel (bougie de réaction) est revérifié à l'entrée : s'il dépasse 100 pips, le trade est annulé même si le plan initial était valide.
- **TP1, TP2, TP3 : distances fixes depuis l'entrée**, par catégorie — il n'y a plus de cible structurelle ni de profil d'objectifs optimisé :
  - **Scalp et Daily :** TP1 = entrée ± 100 pips, TP2 = ± 200 pips, TP3 = ± 350 pips (trade terminé).
  - **Swing :** TP1 = ± 100 pips, TP2 = ± 400 pips, TP3 = ± 600 pips — **manuel** : une notification invite à clôturer le trade ; en backtest/journal, il est considéré clôturé à ce niveau.
- **Gestion institutionnelle du stop** (compte pérenne) : 1/3 de la position est encaissé à chaque niveau (TP1, TP2, TP3/+600).
  - **BE (point mort) :** le stop ne passe au BE que si TP1 **et** +1R (R = risque initial) sont **tous les deux** atteints — jamais trop tôt. BE = entrée **± 3 pips** (frais couverts), jamais l'entrée exacte.
  - **Trailing structurel :** après le BE, chaque nouveau creux/sommet de swing (fractale 2 bougies, confirmée) formé après l'entrée, sur les bougies de la zone, resserre le stop (± 3 pips) — jamais il ne le desserre, jamais derrière le BE.
  - **Après TP2 :** le stop est au moins sur TP1 (plancher), toujours le niveau le plus protecteur.
- **Entrée en position :** une position n'existe que lorsque **le prix arrive sur l'ordre limite**. Si le TP1 est atteint avant l'entrée, l'ordre est annulé.
- **Préservation du compte** (journal réel) : maximum 2 positions ouvertes en même temps ; pas deux positions ouvertes dans le même sens sur des zones qui se chevauchent ; coupe-circuit après 2 pertes le même jour (pause jusqu'au lendemain) ; taille réduite conseillée (50 % du lot) après 3 pertes consécutives.
- **Balance :** somme en pips et en euros de tes trades suivis (« Mes trades ») ou de toutes les zones (« Backtest »).

### Notifications
Pendant « Analyser » (en direct), l'application envoie une notification lisible **sans l'ouvrir**, pour chaque étape du trade (opportunité, entrée, TP1/TP2/TP3, BE, trailing, SL, annulation). Table complète avec exemples : **[GUIDE-UTILISATEUR.md §5](GUIDE-UTILISATEUR.md#5-toutes-les-notifications)**. Implémentation : `notifText()` dans `www/js/trades.js`.

Préservation du compte : une opportunité au-delà de 2 positions ouvertes, ou en pause après 2 pertes le même jour, reste visible mais n'est **pas** notifiée « à prendre » (carte/bandeau « En attente : … » ou « Pause : 2 pertes aujourd'hui, protection du capital »).

- **En arrière-plan :** sur Android, l'analyse en direct continue écran éteint ou application en arrière-plan, grâce à un service au premier plan signalé par une notification discrète. Dans Réglages, appuie une fois sur **Autoriser l'analyse en arrière-plan**, sinon OnePlus peut arrêter l'application.
- **Limite :** si l'application est complètement fermée, aucune analyse ne tourne, donc aucune notification.

### Catégories
**Scalp** ◔ (1m, 5m) · **Daily** ◑ (15m, 1h) · **Swing** ● (4h, 1D), affichées sur chaque carte et dans le détail. Chaque catégorie a sa marge de stop (ATR) et son échelle d'objectifs fixe (voir « Positions, objectifs et balance »).

### Listes et code couleur (RGAA)
Onglets : **Opportunités** · **Suivis** · **Historique** · **Non validées**.

| Couleur | Icône | Signification |
|---|---|---|
| Bleu | ◷ | Opportunité validée, en attente du prix |
| Vert | ✓ / ↗ | Gagnant (objectif atteint) / en position à gains |
| Rouge | ✕ / ↘ | Perdant (stop touché) / en position à perte |
| Ardoise hachurée, bord pointillé | ⊘ | Zone non validée par l'analyse (auditeur, stop trop large, règle apprise) |
| Ambre | ⏸ | Validée mais suspendue (annonce macro) |
| Gris pointillé | – | Annulée |

Contrastes : texte ≥ 4,5:1, éléments graphiques ≥ 3:1, en thème sombre comme clair. Le vert et le rouge sont séparés en luminosité pour rester distincts en cas de daltonisme. L'information n'est jamais portée par la couleur seule : icône, texte, signe +/−, hachures. Le sens est indiqué par ▲ Achat / ▼ Vente. Sur le graphique, les bougies sont neutres (creuse = hausse, pleine = baisse) pour réserver le vert et le rouge aux résultats.

### Les 5 agents (sans IA)
1. **Collecteur :** couverture des bougies, trous, données anciennes.
2. **Scanner :** candidats et rejets par règle.
3. **Calendrier économique :** annonces USD à fort impact embarquées (`www/data/calendar.json`) fusionnées avec les annonces MAJEURES en direct de TradingView (US, zone euro, Chine, Japon — `app/newsfeed.js`, onglet « Annonces »), avec la fenêtre d'annonce.
4. **Historique des trades :** journal des positions, backtest et apprentissage.
5. **Auditeur :** revérifie chaque zone à partir des bougies brutes, avec un code distinct du scanner. Il applique la règle SL ≤ 100 pips, les annonces et les règles apprises, puis rend le verdict.

Leurs rapports (COMPLET, PARTIEL ou ÉCHEC) sont dans l'onglet **Agents**.

### Apprentissage des pertes
Chaque position clôturée est décrite par des caractéristiques connues au moment de sa détection :
- session ;
- tendance EMA 50 ;
- taille de l'imbalance, de la zone et du balayage rapportée à l'ATR ;
- annonce proche ;
- timeframe et sens.

Quand une caractéristique perd de façon répétée (au moins 8 trades, 3 pertes et une espérance lissée inférieure à −0,15 R), elle devient une **règle CANDIDATE**. Les **combinaisons** de caractéristiques (ex. session de Londres + contre-tendance) sont aussi apprises, avec 12 trades minimum. Une candidate n'est **appliquée par l'auditeur** que si le mécanisme champion / challenger (ci-dessous) prouve qu'elle améliore l'espérance ; sinon elle reste affichée comme « candidate · non appliquée ». Les positions réelles comptent double. L'onglet **Apprentissage** montre la réussite sans et avec règles actives, et chaque règle peut être désactivée manuellement (la désactivation l'emporte toujours).

### Amélioration continue : champion / challenger (règles apprises)
Les objectifs (TP1/TP2/TP3) sont désormais des distances fixes par catégorie, non optimisées. Seules les **règles de prévention apprises** passent par le mécanisme champion / challenger : l'application ne les active ou ne les retire que si le changement est **prouvé meilleur**, jamais par confiance a priori — mécanisme déterministe, sans IA :
- Une règle candidate n'est acceptée que si l'ajouter améliore l'espérance moyenne à la fois sur l'échantillon complet et sur sa moitié la plus récente, en conservant au moins 60 % des échantillons (pour ne pas tout filtrer). Une règle déjà acceptée qui ne sert plus (la retirer améliore les deux fenêtres) est retirée automatiquement.
- **Configuration versionnée :** l'ensemble des règles actives est mémorisé dans une configuration numérotée (`v1`, `v2`, …), historisée à chaque changement. À chaque analyse suivante, sa performance « avancée » (trades clôturés détectés après son adoption) est comparée à celle validée par la configuration précédente ; si elle est pire (≥ 8 trades), l'application **revient automatiquement en arrière**, et la règle rejetée est mise en quarantaine 7 jours (anti ping-pong).
- Tout ceci est visible dans l'onglet **Apprentissage**, section « Amélioration continue » : version en cours et dernières décisions (adopté / rejeté / retour arrière) avec leurs raisons chiffrées. Le rapport de l'agent Historique résume aussi ces décisions à chaque analyse.

Mettre à jour le calendrier : `npm run calendar:sync` (racine), puis `npm run calendar:build` (dossier app).

**Positions simulées :** l'application ne passe aucun ordre chez un courtier.

Analyse informative uniquement, pas un conseil financier personnalisé.
