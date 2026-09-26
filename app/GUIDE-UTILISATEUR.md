# Guide utilisateur — XAUUSD Zones

Ce guide s'adresse à un trader qui utilise l'application, sans connaissance en développement. Il décrit chaque bouton, chaque réglage et chaque notification tels qu'ils apparaissent réellement dans l'application.

## Table des matières

1. [À quoi sert l'application](#1-à-quoi-sert-lapplication)
2. [Prérequis complets](#2-prérequis-complets)
3. [Installation pas à pas (première fois)](#3-installation-pas-à-pas-première-fois)
4. [Utilisation quotidienne](#4-utilisation-quotidienne)
5. [Toutes les notifications](#5-toutes-les-notifications)
6. [Réglages](#6-réglages)
7. [Comprendre l'analyse](#7-comprendre-lanalyse)
8. [Sécurité en bref](#8-sécurité-en-bref)
9. [Dépannage / FAQ](#9-dépannage--faq)
10. [Glossaire](#10-glossaire)

---

## 1. À quoi sert l'application

XAUUSD Zones détecte, sur l'or (XAUUSD), des zones d'achat et de vente appelées **order blocks**, selon une méthode fixe et documentée (`TRADING_RULES_MASTER_PROMPT.md`), **sans intelligence artificielle**. Pour chaque zone, elle indique si elle est encore valable, calcule un plan de trade complet (entrée, stop, objectifs) et suit son évolution.

Le même code tourne :
- sur **PC** (fenêtre Edge, lancée par `XAUUSD-Zones.bat`) ;
- sur **Android** (application installée, APK compilé par `installer-android.bat`).

Les deux lisent les **mêmes bougies**, venues uniquement de **TradingView Desktop** installé sur le PC.

### Ce que l'application NE fait PAS

- **Elle ne passe aucun ordre chez un courtier.** Les positions affichées (« Mes trades », « Backtest ») sont **entièrement simulées** : l'application suit un prix et calcule un résultat théorique, elle ne touche à aucun compte de trading réel.
- **Elle ne donne pas de conseil financier personnalisé.** L'analyse est informative : à toi de décider d'ouvrir ou non un ordre chez ton courtier, et de gérer ce trade toi-même.
- **Elle n'utilise aucune IA.** Toutes les règles (order block, étoiles, stop, objectifs, apprentissage) sont des calculs déterministes, toujours reproductibles avec les mêmes bougies.

---

## 2. Prérequis complets

### Sur le PC (Windows)

| Élément | Détail |
|---|---|
| **TradingView Desktop** | Installé et connecté. Un abonnement TradingView (gratuit ou payant) donnant accès aux timeframes 1m, 5m, 15m, 1h, 4h et 1D sur XAUUSD est nécessaire pour profiter des 3 catégories (Scalp/Daily/Swing) ; avec un compte gratuit, certaines timeframes ou le nombre de graphiques simultanés peuvent être limités — l'application s'adapte à ce qui est disponible. |
| **Un graphique XAUUSD ouvert** | Au moins un graphique du symbole XAUUSD doit être ouvert dans TradingView Desktop. Sans cela, l'analyse est bloquée (garde-fou). |
| **Node.js 18 ou plus récent** | Requis pour lancer le serveur (`app/package.json`, `engines.node >= 18`). Téléchargement : nodejs.org. |
| **Dossier du projet** | `C:\Users\Joshu\tradingview-mcp` (le dossier `app` s'y trouve, ex. `C:\Users\Joshu\tradingview-mcp\app`). |
| **Tailscale** | Installé sur le PC (tailscale.com/download/windows), connecté avec ton compte, **authentification à deux facteurs (2FA) activée sur ce compte**. Nécessaire uniquement si tu veux utiliser le téléphone à distance. |
| **MagicDNS et « HTTPS Certificates »** | Options à activer une fois sur le compte Tailscale (admin.tailscale.com), pour que le PC obtienne une adresse `https://…ts.net` valide. |
| **Android Studio + JDK** | Uniquement pour **compiler** l'APK (`installer-android.bat`). Après l'installation d'Android Studio, ouvre-le une fois pour qu'il termine le téléchargement du SDK et que tu acceptes les licences. |
| **Câble USB + débogage USB** | Nécessaire uniquement pendant la compilation/installation de l'APK, pour transférer l'application sur le téléphone. |

### Sur le téléphone (OnePlus / Android)

| Élément | Détail |
|---|---|
| **Android 8.0 ou plus récent** | Version minimale supportée par l'application (`minSdkVersion = 26`). |
| **Application Tailscale** | Installée depuis le Play Store, connectée avec le **même compte** que le PC. |
| **Autorisation des notifications** | À accorder quand l'application le demande (sinon aucune alerte de trading n'arrive). |
| **Exemption d'optimisation de batterie** | À accorder dans Réglages de l'application (bouton « Autoriser l'analyse en arrière-plan »), sinon OnePlus peut arrêter l'analyse en arrière-plan. |
| **Débogage USB** (une seule fois, à l'installation) | Options pour les développeurs → Débogage USB, puis accepter la fenêtre « Autoriser le débogage USB » qui apparaît quand le téléphone est branché. |

---

## 3. Installation pas à pas (première fois)

### 3.1 Préparer le PC

1. Installe **Node.js** (version 18 ou plus) si ce n'est pas déjà fait.
2. Place le projet dans `C:\Users\Joshu\tradingview-mcp` (dossier contenant `app\`).
3. Installe et connecte **TradingView Desktop**, avec au moins un graphique **XAUUSD** ouvert.

### 3.2 Démarrer le serveur PC

Double-clique sur `app\XAUUSD-Zones.bat`. Une fenêtre noire (invite de commandes) s'ouvre et affiche, dans l'ordre :

1. Si besoin, l'installation des dépendances (`npm ci`, versions figées) — uniquement la toute première fois.
2. Une vérification du port de débogage de TradingView (`127.0.0.1:9222`). S'il ne répond pas, le script lance lui-même TradingView Desktop en mode débogage (`scripts\launch_tv_debug.bat`).
3. La ligne `XAUUSD Zones : http://localhost:3777` — le serveur est démarré, et une fenêtre Edge s'ouvre automatiquement sur l'application.
4. Un encadré **« CODE D'APPAIRAGE »** avec 8 chiffres, valable jusqu'à une heure indiquée, à usage unique. En dessous : « Nouveau code : appuie sur Entrée dans cette fenêtre. » — à tout moment, appuyer sur **Entrée** dans cette fenêtre invalide l'ancien code et en affiche un nouveau.

**Garde cette fenêtre ouverte** : la fermer arrête le serveur (et donc l'accès depuis le téléphone).

### 3.3 Préparer TradingView (multi-graphiques)

Pour que l'application dispose de toutes les timeframes (1m, 5m, 15m, 1h, 4h, 1D) sans changer ta propre disposition à chaque fois :

1. Dans l'application PC, ouvre **Réglages** (icône engrenage).
2. Clique sur **« Préparer TradingView (multi-graphiques) »**.
3. TradingView Desktop bascule vers une disposition à plusieurs graphiques XAUUSD (autant que ton abonnement le permet), une timeframe par graphique. Un toast confirme : « TradingView préparé : X graphique(s) XAUUSD (…). »

Le serveur lit ensuite chaque graphique **sans jamais changer ta timeframe** : si une timeframe manque à la disposition, le graphique actif bascule brièvement puis revient à ta timeframe d'origine (un cache limite ces bascules).

**Charger plus d'historique :** l'application utilise toutes les bougies déjà chargées dans TradingView Desktop pour chaque graphique (plafond de sécurité : 20 000 bougies par timeframe). Pour en avoir plus (utile pour l'apprentissage, qui demande au moins 20 trades clôturés), **fais défiler chaque graphique vers le passé** (glisser vers la droite, ou molette) : TradingView charge alors plus d'historique, que l'application réutilisera à la prochaine analyse.

### 3.4 Activer l'accès à distance (téléphone, via Tailscale)

Une seule fois :

1. Installe Tailscale sur le PC et sur le téléphone, connecte les deux **avec le même compte**, et active la **double authentification** sur ce compte.
2. Sur le PC, double-clique sur `app\acces-distant.bat`. Le script :
   - recherche Tailscale et vérifie qu'il est connecté (sinon il ouvre une page de connexion) ;
   - publie l'API téléphone (port local 3778) en HTTPS dans ton réseau Tailscale (`tailscale serve`) ;
   - si un lien apparaît demandant d'activer **« HTTPS Certificates »** ou **MagicDNS**, ouvre-le, active l'option sur admin.tailscale.com, puis relance le script ;
   - affiche en vert l'adresse à saisir sur le téléphone, du type `https://joshua.taila406c5.ts.net` (déjà préréglée dans l'APK, voir 3.5).
3. `app\acces-distant-arreter.bat` coupe l'accès distant à tout moment (le PC reste utilisable en local).

### 3.5 Compiler et installer l'application Android (APK)

Sur un PC avec **Android Studio** déjà ouvert une fois (SDK téléchargé, licences acceptées) et le téléphone **branché en USB** :

1. Double-clique sur `app\installer-android.bat`. Le script (visible dans la fenêtre, avec des étapes `=== … ===`) :
   1. **Recherche du JDK et du SDK Android** (Android Studio, puis un JDK 21 portable si besoin) ;
   2. **Installe les dépendances** à versions figées (`npm ci`) et lance un **audit de sécurité** (`npm audit`), qui arrête tout si une vulnérabilité critique est trouvée ;
   3. **Prépare le projet Android** (Capacitor) et lit l'adresse Tailscale actuelle du PC pour la **préconfigurer dans l'APK** — c'est l'« adresse préréglée » : sur le téléphone, il ne restera qu'à saisir le code d'appairage, pas l'adresse ;
   4. **Durcit le manifeste Android** : sauvegarde désactivée, HTTPS uniquement, coffre Keystore, captures d'écran bloquées, permissions de notification et d'analyse en arrière-plan, Android 8 minimum ;
   5. **Compile l'APK release** (Gradle) ;
   6. **Signe l'APK** avec une clé privée créée sur ce PC (`%USERPROFILE%\.xauusd-zones`, mot de passe protégé par Windows) ;
   7. **Attend le téléphone** (jusqu'à 2 minutes) : débloque-le, active le débogage USB si ce n'est pas déjà fait, et accepte « Autoriser le débogage USB » ;
   8. **Installe et lance** l'application sur le téléphone.

   L'APK signé est aussi copié dans `app\XAUUSD-Zones.apk`. Si le téléphone n'était pas prêt au moment de la compilation, relance juste l'installation avec `app\installer-telephone.bat` (attend jusqu'à 10 minutes).

2. Sur le PC, lance `app\code-appairage.bat` : il affiche un code à 8 chiffres (encadré vert), valable 10 minutes, une seule fois. (Cette fenêtre exige que `XAUUSD-Zones.bat` tourne déjà.)
3. Sur le téléphone, ouvre l'application XAUUSD Zones. Un bandeau invite à **« Saisir le code »** : appuie dessus (ou ouvre **Réglages → Connexion au PC**), tape les **8 chiffres uniquement** dans le champ **« Code d'appairage »**, puis appuie sur **« Connecter au PC »**.
4. Un toast confirme « Téléphone connecté au PC. » et l'analyse démarre.

L'adresse du PC reste modifiable ensuite dans **Réglages → Connexion au PC → « Adresse du PC »** (champ sous « Adresse du PC (préréglée) et nom du téléphone »), utile si l'adresse Tailscale du PC change.

---

## 4. Utilisation quotidienne

### 4.1 Routine

1. Sur le PC : lance `XAUUSD-Zones.bat` (si pas déjà fait) et laisse TradingView Desktop ouvert sur un graphique XAUUSD.
2. Ouvre l'application (fenêtre Edge sur PC, ou application sur le téléphone — connecté par Tailscale).
3. Appuie sur **« Analyser »** (bouton en haut, avec l'icône ▶). Le bouton devient **« En direct »** avec un point rouge clignotant : l'analyse tourne désormais en continu (toutes les 5 à 60 secondes, réglable). Un nouvel appui arrête l'analyse.

### 4.2 Lire l'écran

| Zone de l'écran | Contenu |
|---|---|
| **En-tête** | Prix actuel de l'or, heure de la dernière analyse, source (PC · TradingView Desktop, ou Téléphone · PC distant). |
| **Balance** | Pips et euros cumulés, réalisé/latent, gagnants/perdants, taux de réussite. Bascule **« Mes trades »** / **« Backtest »** (voir 4.5). Bouton **« Lot & stop »**. |
| **Onglets de catégorie** | **Tous** · **Scalp** (1m·5m) · **Daily** (15m·1h) · **Swing** (4h·1D). |
| **Onglets de timeframe** | 1m 5m 15m 1h 4h 1D, au-dessus du graphique. Un point vert = une opportunité 5★ est disponible sur cette timeframe. |
| **Graphique** | Bougies (creuse = hausse, pleine = baisse, neutres pour réserver vert/rouge aux résultats), zones colorées, ligne d'objectif, ligne de stop. Case **« Zones des autres TF »** : affiche aussi les zones des autres timeframes en fond. |
| **Légende** | ◷ Opportunité · ✓ Gagnant · ✕ Perdant · ⊘ Non validée · – Annulée · ligne objectif · ligne stop · bougie creuse = hausse. |
| **Onglets de la liste** | **Trades** / **Agents** / **Apprentissage** (panneau latéral), puis dans « Trades » : **Opportunités** · **Suivis** · **Historique** · **Non validées**, et un filtre **Achat et vente** / **▲ Achat** / **▼ Vente**. |

### 4.3 Le code couleur des cartes

| Couleur | Icône | Signification |
|---|---|---|
| Bleu | ◷ | Opportunité validée, en attente du prix |
| Vert | ✓ / ↗ | Gagnant (objectif atteint) / en position à gains |
| Rouge | ✕ / ↘ | Perdant (stop touché) / en position à perte |
| Ardoise hachurée | ⊘ | Zone non validée (auditeur, stop trop large, règle apprise) |
| Ambre | ⏸ | Validée mais suspendue (annonce macro) |
| Gris pointillé | – | Annulée |

Le sens est toujours indiqué en plus par ▲ Achat / ▼ Vente, jamais par la couleur seule.

### 4.4 Le détail d'une zone

Clique sur une carte (dans la liste ou sur le graphique) pour ouvrir sa fiche complète :

- **Statut** en grand, avec le résultat en pips/€ s'il y en a un.
- **Grille des 5 étoiles** : chaque critère (imbalance, tendance, liquidité, OB vierge, Fibonacci) avec ✓/✗ et son détail chiffré.
- **Zone d'entrée (OB)** : les deux bords, avec l'explication « Entrée à la clôture de la première bougie haussière/baissière dans l'OB » (mode par défaut), ou le prix exact si le mode « ordre limite » est choisi.
- **Stop loss (invalidation)** : prix, pips et perte en euros.
- **TP1, TP2, TP3** : prix, pips et ratio R pour chacun, avec une coche ✓ si déjà atteint.
- **Gestion** : résumé texte de la règle de gestion du stop (1/3 par palier, BE, trailing, plancher TP1…).
- **Zone C1**, l'imbalance, les OHLC de P/C1/C2/C3, et la preuve complète (liquidité prise, order block, imbalance stricte, retest ou non).
- Bouton **« Suivre »** / **« J'ai suivi cette zone »** (selon l'état), ou **« Ne plus suivre »** si déjà suivi, avec un champ **Lot** modifiable pour ce trade précis.

### 4.5 Prendre un trade chez ton courtier

L'application ne passe aucun ordre : c'est toi qui agis chez ton courtier, en suivant les notifications.

1. **Notification "à surveiller"** (`👀 ★★★★★ ACHAT/VENTE GOLD · zone …`) : ne fais rien encore, la zone est simplement à surveiller.
2. **Notification "entrée"** (`▶ Entrée déclenchée` ou `🟢/🔴 … GOLD @ prix`) : le prix vient de confirmer l'entrée (réaction dans l'OB, ou arrivée sur l'ordre limite selon ton réglage). **Place ton ordre chez ton courtier maintenant**, au prix indiqué (ou au marché si tu es en retard de quelques secondes), avec :
   - le **stop loss (SL)** indiqué dans la notification/le détail de la zone ;
   - les trois **TP1 / TP2 / TP3** indiqués, en préparant de **clôturer 1/3 de la position à chacun** (« gestion institutionnelle », 1/3 à chaque palier).
3. **À TP1 atteint** (`✅ TP1 +100 atteint !`) : clôture 1/3 de ta position. Le stop reste **inchangé** (pas de BE trop tôt).
4. **À « Passer à BE »** (`🛡️ Passer à BE : … (TP1 + 1R atteints)`) : remonte/descends ton stop au niveau indiqué (entrée ± 3 pips). Cela n'arrive que lorsque **TP1 et +1R sont tous les deux atteints**.
5. **À chaque « Remonter/Descendre le stop »** (`🔒 …`) : resserre ton stop au niveau indiqué (trailing structurel, jamais desserré). Ce sont des notifications qui peuvent se répéter tant que le trade est ouvert.
6. **À TP2 atteint** (`✅ TP2 atteint ! Stop sur TP1 : …`) : clôture un second tiers, et remonte ton stop au moins à TP1 si le trailing ne l'a pas déjà fait.
7. **Fin de trade :**
   - **Scalp/Daily** : à `🏁 TP3 +350 atteint`, le dernier tiers est clôturé, le trade est terminé.
   - **Swing** : à `🏁 +600 pips atteints · CLÔTURE le trade SWING`, c'est à **toi de clôturer manuellement** le dernier tiers chez ton courtier — l'application ne le fait pas automatiquement, elle considère seulement le trade clôturé dans son journal.
   - Si le stop est touché après un TP (`⚖️ Clôturé en gain …`) ou avant tout TP (`🛑 SL touché …`), le trade se termine à ce niveau.
8. **Annulation** (`⛔ Annule l'ordre …`) : ne prends pas (ou annule) l'ordre — le motif est donné (ex. « SL de 122 pips > 100 pips : zone non viable »).

### 4.6 Marquer « Suivre » / « J'ai suivi »

- Dans **Opportunités**, appuie sur **« Suivre »** dès que tu comptes prendre le trade (ou l'as déjà pris) : la zone entre dans **« Mes trades »** et compte dans ta balance réelle.
- Si le trade est déjà en cours ou terminé au moment où tu le marques, le bouton affiche **« Je l'ai pris »** : l'application reprend alors l'exécution déjà simulée (prix d'entrée, TP atteints...) comme si tu l'avais suivi depuis le début.
- Pour retirer un trade de ton suivi, ouvre sa fiche ou la liste **Suivis**, et appuie deux fois sur **« Ne plus suivre »** (double confirmation).
- Le **lot** de chaque trade suivi est modifiable individuellement dans sa fiche (champ « Lot »), indépendamment du lot par défaut réglé dans « Lot & stop ».

### 4.7 « Mes trades » vs « Backtest »

- **Mes trades** (case cochée par défaut) : uniquement les zones que tu as marquées « Suivre » — ta balance réelle.
- **Backtest** : toutes les zones détectées, simulées sur tout l'historique chargé dans TradingView — utile pour juger la méthode elle-même, sans que tes propres décisions n'influencent le résultat.

---

## 5. Toutes les notifications

| Événement | Titre (exemple) | Que faire |
|---|---|---|
| Opportunité à surveiller (mode confirmation, par défaut) | `👀 ★★★★★ ACHAT GOLD · zone 4260.10–4261.40` | Rien encore : attends la 2ᵉ notification (entrée confirmée). |
| Opportunité à prendre (mode ordre limite) | `🟢 ACHAT GOLD @ 4269.97` avec `TP1 4279.97 · TP2 4289.97 · TP3 4304.97 · SL 4257.77` | Place l'ordre limite chez ton courtier à ce prix, avec ces SL/TP. |
| Entrée confirmée (mode confirmation) | `🟢 ACHAT GOLD @ 4269.97 ★★★★★` | Entre maintenant chez ton courtier, aux SL/TP indiqués. |
| Entrée déclenchée (mode ordre limite) | `▶ Entrée déclenchée · ACHAT GOLD 4269.97` | Le prix a atteint ton ordre limite : la position est ouverte. |
| TP1 (+100) atteint | `✅ TP1 +100 atteint !` | Clôture 1/3 de la position ; stop inchangé jusqu'à +1R. |
| Passer à BE (TP1 + 1R atteints) | `🛡️ Passer à BE : 4270.27 (TP1 + 1R atteints)` | Remonte/descends le stop à ce niveau (entrée ± 3 pips). |
| Stop resserré (trailing structurel) | `🔒 Remonter le stop à 4272.10` (« Descendre… » en vente) | Resserre le stop à ce niveau ; ne le desserre jamais. |
| TP2 atteint | `✅ TP2 atteint ! Stop sur TP1 : 4279.97` | Clôture un second tiers ; stop au moins sur TP1. |
| TP3 atteint (Scalp/Daily) | `🏁 TP3 +350 atteint · trade terminé +217 pips` | Dernier tiers clôturé, trade terminé. |
| +600 pips atteints (Swing, manuel) | `🏁 +600 pips atteints · CLÔTURE le trade SWING` | Clôture toi-même le dernier tiers chez ton courtier. |
| Clôture en gain (après BE/trailing) | `⚖️ Clôturé en gain +35 pips` | Le stop protégé a été touché après un ou plusieurs TP : trade terminé en gain. |
| SL touché (avant tout TP) | `🛑 SL touché · ACHAT GOLD −45 pips` | Trade terminé en perte, au stop initial. |
| Annulation (zone invalidée / SL > 100 pips) | `⛔ Annule l'ordre d'ACHAT GOLD 4269.97` | N'entre pas (ou annule) l'ordre ; le motif est donné dans la notification. |

Ces notifications ne s'affichent (en toast dans l'application, et en notification système si activées) que pendant que **« Analyser »/« En direct »** tourne. Sur Android, elles continuent d'arriver écran éteint ou application en arrière-plan grâce au service de premier plan (voir « Autoriser l'analyse en arrière-plan », §6). Si l'application est **complètement fermée**, aucune analyse ne tourne, donc aucune notification n'arrive.

---

## 6. Réglages

Ouvre les réglages avec l'icône engrenage en haut à droite.

### Accès depuis le téléphone (visible seulement sur PC)

| Champ / bouton | Rôle |
|---|---|
| Encadré d'état | Indique si Tailscale est installé, connecté, et si l'API téléphone est publiée, avec l'adresse à saisir sur le téléphone. |
| **« Générer un code d'appairage »** | Crée un nouveau code à 8 chiffres, affiché à l'écran, valable jusqu'à l'heure indiquée, à usage unique. |
| **« Préparer TradingView (multi-graphiques) »** | Bascule TradingView Desktop vers une disposition multi-graphiques XAUUSD (voir §3.3). |
| **Appareils autorisés** | Liste des téléphones appairés (nom, compte Tailscale, date d'appairage, dernière connexion) avec un bouton **« Révoquer »** par appareil (double confirmation). |
| **Journal de sécurité** | Derniers événements de sécurité (appairages, échecs, verrouillages…), et le nombre d'événements suspects sur 24 h. |

### Connexion au PC (visible seulement sur téléphone)

| Champ / bouton | Rôle |
|---|---|
| **Code d'appairage** | Les 8 chiffres affichés sur le PC. |
| **Adresse du PC** (dans « Adresse du PC (préréglée) et nom du téléphone ») | Adresse Tailscale du PC ; préréglée automatiquement à la compilation de l'APK, modifiable ici si elle change. |
| **Nom de ce téléphone** | Nom affiché côté PC dans « Appareils autorisés ». |
| **« Connecter au PC »** | Envoie le code au PC et enregistre le jeton d'accès (chiffré dans le Keystore Android). |
| **« Désappairer »** | Supprime le jeton sur ce téléphone (pense aussi à révoquer l'appareil côté PC). |

### Analyse

| Champ | Rôle |
|---|---|
| **Temps réel : toutes les …** | Fréquence de l'analyse en direct : 5, 10, 15, 30 ou 60 secondes. |
| **Fenêtre de liquidité** | Nombre de bougies avant P dont l'extrême définit le niveau de liquidité balayé (défaut : 5). |
| **Gap fragile (× ATR)** | Seuil sous lequel une imbalance est marquée « gap fragile » (défaut : 0,1 × ATR). |
| Cases par timeframe | Active ou désactive chaque timeframe (1m à 1D) dans l'analyse. |

### Apprentissage

| Champ | Rôle |
|---|---|
| **Échantillons minimum par règle** | Nombre minimal de trades nécessaires avant qu'une caractéristique perdante devienne une règle candidate (défaut : 8). |
| **Seuil d'espérance (R)** | Espérance moyenne (en R) en dessous de laquelle une caractéristique est jugée perdante (défaut : −0,15 R). |

### Alertes et données

| Champ / bouton | Rôle |
|---|---|
| **Notifications de trading** (case) | Active les notifications (opportunité, entrée, TP1/2/3, BE, trailing, SL). Demande la permission système si nécessaire. |
| **« Autoriser l'analyse en arrière-plan »** (Android uniquement) | Demande l'exemption d'optimisation de batterie, pour que l'analyse et les notifications continuent écran éteint. |
| **« Effacer le journal »** | Supprime toutes les positions suivies (double confirmation). |
| **« Réinitialiser l'apprentissage »** | Efface les échantillons appris et les règles actives (double confirmation). |

### Dialogue « Lot & stop »

Ouvert par le bouton **« Lot & stop »** de la barre de balance.

| Champ | Rôle |
|---|---|
| **Lot** | Taille de position utilisée pour calculer le P&L en euros (0,01 à 100). |
| **Valeur d'un pip ($)** | 0,10 $ (standard or), 0,01 $ ou 1,00 $, selon la convention de ton courtier. |
| **Taux EUR/USD** | Taux de conversion manuel, pour afficher le résultat en euros. |
| **Entrée** | « Après une bougie de réaction dans l'OB (recommandé) » (mode confirmation) ou « Ordre limite au bord de l'OB » (mode limite). |
| **Pause autour des annonces (min)** | Aucune nouvelle entrée n'est proposée ± N minutes autour d'une annonce USD à fort impact (0 à 240 min). |
| **Suivre automatiquement toutes les opportunités validées** (case, désactivée par défaut) | Si activée, chaque zone validée entre automatiquement dans « Mes trades » sans que tu appuies sur « Suivre ». Recommandé de laisser désactivé, pour ne suivre que les trades réellement pris. |
| Case **« J'accepte ce lot et cette gestion du risque… »** | Obligatoire pour valider le formulaire. |
| **« Valider le paramétrage »** | Enregistre et débloque le suivi des trades. |

Le stop loss et les objectifs (TP1/TP2/TP3) ne sont **pas** réglables : ils sont entièrement automatiques (voir §7). Seuls le lot, la valeur du pip, le taux de change, le mode d'entrée et la pause autour des annonces sont paramétrables ici.

---

## 7. Comprendre l'analyse

### Les 5 étoiles

Chaque order block est noté sur 5, à la clôture de C3 (sans information future, sauf ⭐4) :

| Étoile | Critère | Règle | Statut |
|---|---|---|---|
| ⭐1 | Imbalance | `C1.high < C3.low` (achat) / `C1.low > C3.high` (vente) | Éliminatoire |
| ⭐2 | Tendance | Supertrend (ATR 10, × 3) dans le sens de l'OB, et marché hors range (moins de 4 changements de couleur sur 50 bougies) | Éliminatoire |
| ⭐3 | Liquidité | Aucun swing non pris (ni égalité) à moins de 1 × ATR au-delà de l'OB | Qualité |
| ⭐4 | OB vierge | Aucune bougie n'a touché la zone depuis C3 | Essentiel |
| ⭐5 | Fibonacci | Achat sous 0,5 du mouvement (Discount) / Vente au-dessus (Premium) | Filtre final |

**Seules les zones notées 5★ sont proposées.** Moins de 5★ (même 4★) = zone **invalidée**, quel que soit le détail. ⭐1 ou ⭐2 manquante invalide toujours la zone, quel que soit le total.

### Règle SL ≤ 100 pips

Le risque (distance entrée → stop) ne doit **jamais dépasser 100 pips**, quelle que soit la catégorie. Au-delà, la zone est **refusée** (« non viable »). Comme l'entrée se fait par défaut après une bougie de réaction, le risque réel est **revérifié à l'entrée** : s'il dépasse 100 pips à ce moment-là, le trade est **annulé**, même si le plan initial était valide.

### Échelles d'objectifs (TP)

Distances fixes depuis l'entrée, selon la catégorie :

| Catégorie | TP1 | TP2 | TP3 |
|---|---|---|---|
| **Scalp** (1m·5m) et **Daily** (15m·1h) | +100 pips | +200 pips | +350 pips (trade terminé) |
| **Swing** (4h·1D) | +100 pips | +400 pips | +600 pips (**clôture manuelle**, notifiée) |

### Gestion institutionnelle

- **1/3 de la position** est encaissé à chaque palier (TP1, TP2, TP3/+600).
- **BE (point mort)** : le stop ne passe au point mort que si **TP1 ET +1R** sont **tous les deux** atteints — jamais l'un sans l'autre, jamais trop tôt. BE = entrée ± 3 pips (frais couverts), jamais l'entrée exacte.
- **Trailing structurel** : après le BE, chaque nouveau creux/sommet de swing (fractale à 2 bougies, confirmée) formé après l'entrée resserre le stop — jamais il ne le desserre, jamais derrière le BE.
- **Après TP2** : le stop est toujours au moins sur TP1 (plancher), le niveau retenu étant toujours le plus protecteur.

### Préservation du compte

Ces garde-fous s'appliquent uniquement au **journal réel** (« Mes trades »), pas au backtest :

- **Maximum 2 positions ouvertes** en même temps.
- **Pas deux positions dans le même sens** sur des zones qui se chevauchent.
- **Coupe-circuit journalier** : après 2 pertes le même jour (UTC), plus aucune nouvelle proposition jusqu'au lendemain.
- **Taille réduite conseillée** (50 % du lot) après 3 pertes consécutives.

### Apprentissage champion / challenger

Chaque position clôturée (backtest et réelle, réelle comptant double) enrichit un modèle statistique par caractéristique (session, tendance, taille de gap, annonce proche, timeframe, sens…). Une caractéristique perdante de façon répétée (≥ 8 trades, ≥ 3 pertes, espérance lissée < −0,15 R) devient une **règle candidate**. Une candidate n'est **appliquée par l'auditeur** que si le mécanisme **champion / challenger** prouve qu'elle améliore l'espérance à la fois sur l'échantillon complet et sur sa moitié la plus récente (en conservant au moins 60 % des échantillons). La configuration active des règles est versionnée (v1, v2, …) ; si sa performance mesurée après coup se révèle pire que celle de la version précédente (sur au moins 8 trades), l'application **revient automatiquement en arrière**, et la règle rejetée est mise en **quarantaine 7 jours**. Tout est visible dans l'onglet **Apprentissage**, section « Amélioration continue ».

### Les 5 agents et leurs statuts

| Agent | Rôle |
|---|---|
| **Collecteur** | Vérifie la couverture des bougies, les trous, les données anciennes. |
| **Scanner** | Détecte les candidats et compte les rejets par règle. |
| **Calendrier économique** | 241 annonces USD à fort impact embarquées, avec fenêtre de pause. |
| **Historique des trades** | Journal, backtest et apprentissage. |
| **Auditeur** | Revérifie chaque zone à partir des bougies brutes (code indépendant du scanner), applique la règle SL ≤ 100 pips, les annonces et les règles apprises, et rend le verdict final. |

Chaque agent produit un rapport avec un statut :
- **COMPLET** : tout est disponible et cohérent.
- **PARTIEL** : une partie manque ou est incomplète (ex. une timeframe indisponible).
- **ÉCHEC** : l'agent ne peut pas fonctionner (ex. TradingView non joignable, symbole ≠ XAUUSD).

L'agent **Historique** reste en **PARTIEL** tant que **moins de 20 trades clôturés** ont été appris (message : « seulement N trades clôturés appris (20 nécessaires) »). Fais défiler les graphiques TradingView vers le passé pour charger plus d'historique : plus de bougies anciennes donnent plus de trades simulés dans le backtest, donc plus d'échantillons d'apprentissage.

---

## 8. Sécurité en bref

- **Appairage** : code à 8 chiffres, valable 10 minutes, à usage unique, grillé après 5 essais.
- **Jeton du téléphone** : 256 bits, chiffré en AES-256-GCM dans le Keystore Android (jamais en clair), lié au compte Tailscale qui a fait l'appairage, expirant après 180 jours.
- **Révoquer un appareil** : Réglages PC → Appareils autorisés → « Révoquer » (immédiat).
- **Journal de sécurité** : visible dans Réglages PC, aucun secret n'y figure.
- **Ce qui est exposé** : uniquement 3 routes distantes en lecture seule (`/api/health`, `/api/pair`, `/api/tv/candles`), accessibles seulement via Tailscale, jamais directement sur Internet ni sur le réseau local. Aucun ordre de courtier, aucune donnée personnelle.
- **Verrouillage automatique** : après 10 échecs d'authentification en 10 minutes, l'accès distant est bloqué 15 minutes.

Détail complet, catégorie par catégorie de l'OWASP Top 10:2025, dans **[SECURITE.md](SECURITE.md)**.

---

## 9. Dépannage / FAQ

**« Serveur injoignable » (code-appairage.bat ou l'application PC)**
→ Lance `XAUUSD-Zones.bat` et garde sa fenêtre ouverte ; le message précis apparaît en rouge dans la fenêtre du script.

**Tailscale non détecté / non installé**
→ Installe-le sur le PC (tailscale.com/download/windows), connecte-toi, puis relance `acces-distant.bat`.

**« HTTPS Certificates » ou MagicDNS non activé**
→ Un lien s'affiche dans la fenêtre de `acces-distant.bat` : ouvre-le, active l'option sur admin.tailscale.com, puis relance le script.

**Code d'appairage refusé ou expiré**
→ Le code n'est valable que 10 minutes et une seule fois. Génère-en un nouveau (« Générer un code d'appairage » sur PC, ou appuie sur Entrée dans la fenêtre du serveur, ou relance `code-appairage.bat`).

**TradingView n'affiche pas XAUUSD**
→ Ouvre un graphique du symbole XAUUSD dans TradingView Desktop : sans cela, l'agent Collecteur bloque l'analyse (« Symbole … ≠ XAUUSD : analyse bloquée »).

**Aucune opportunité n'apparaît**
→ C'est normal : seules les zones **5★** sont proposées (moins de 5★ = toujours invalidée). Laisse « Analyser » tourner ; les zones 5★ sont rares par nature. Consulte l'onglet « Non validées » pour voir ce qui a été écarté et pourquoi.

**Les notifications n'arrivent pas**
→ Vérifie, dans l'ordre : la case « Notifications de trading » est cochée dans Réglages ; la permission de notification est accordée à l'application (réglages Android) ; l'exemption de batterie a été accordée (« Autoriser l'analyse en arrière-plan ») ; l'application n'est pas **complètement fermée** — l'analyse en direct doit continuer à tourner (service de premier plan visible en notification discrète).

**« INSTALL_FAILED_UPDATE_INCOMPATIBLE » / signatures différentes lors de l'installation de l'APK**
→ Une version précédente signée différemment (ex. version de débogage) est déjà installée. `installer-android.bat`/`installer-telephone.bat` désinstallent puis réinstallent automatiquement dans ce cas ; si le message persiste, désinstalle manuellement l'application sur le téléphone avant de relancer.

**Mettre à jour l'application**
→ Relance `installer-android.bat` (recompile, resigne avec la même clé, réinstalle par-dessus). Le calendrier économique se met à jour avec `npm run calendar:sync` (racine du projet), puis `npm run calendar:build` (dossier `app`).

---

## 10. Glossaire

| Terme | Définition |
|---|---|
| **OB (order block)** | Bougie C1, à l'origine du déplacement de prix qui crée l'imbalance ; c'est la zone d'entrée. |
| **P** | Bougie de prise de liquidité, juste avant l'OB. |
| **C1 / C2 / C3** | La séquence de 4 bougies (P, C1, C2, C3) qui définit l'order block et son imbalance. |
| **Imbalance** | Écart de prix entre C1 et C3 (aucune mèche en commun) qui « prouve » le déséquilibre acheteurs/vendeurs. |
| **Liquidité** | Zone de prix où de nombreux ordres stop sont probablement regroupés (extrêmes de swing, sommets/creux égaux). |
| **Retest** | Le fait qu'une bougie postérieure à C3 revienne toucher la zone de l'order block. |
| **BE (point mort / break-even)** | Stop replacé au niveau d'entrée (± 3 pips ici), pour ne plus risquer de perte sur le trade. |
| **R** | Unité de risque : 1 R = la distance initiale entrée → stop loss. Un résultat de « +2 R » signifie deux fois le risque initial gagné. |
| **Pip** | Plus petite variation de prix suivie par l'application. Sur l'or (XAUUSD), 1 pip = 0,10 $ (convention standard). |
| **Premium / Discount** | Position du prix par rapport au milieu (0,5) d'un mouvement récent : Discount = moitié basse (zone d'achat recherchée), Premium = moitié haute (zone de vente recherchée). |
| **Supertrend** | Indicateur de tendance basé sur l'ATR, utilisé ici pour valider le sens (⭐2) et détecter un marché en range. |
| **ATR** | Average True Range : mesure de la volatilité moyenne récente, utilisée pour la marge de stop, le seuil « gap fragile » et le Supertrend. |
| **Order block vierge** | Order block jamais retesté depuis sa formation (⭐4). |
| **Order block mitigé** | Order block déjà retesté (donc non vierge). |
| **Champion / challenger** | Mécanisme qui n'adopte une règle apprise que si elle prouve une amélioration mesurée, avec retour arrière automatique si elle se révèle pire ensuite. |
| **Scalp / Daily / Swing** | Les trois catégories de trade de l'application, selon la timeframe : Scalp (1m·5m), Daily (15m·1h), Swing (4h·1D). |
