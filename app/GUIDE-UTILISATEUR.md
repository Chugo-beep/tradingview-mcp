# Guide utilisateur — XAUUSD Zones

Ce guide s'adresse à un trader qui utilise l'application, sans connaissance en développement. Il décrit chaque bouton, chaque réglage et chaque notification tels qu'ils apparaissent réellement dans l'application.

## Table des matières

Présentation](#1-présentation)
Prérequis](#2-prérequis)
Installation pas à pas (première fois)](#3-installation-pas-à-pas-première-fois)
Démarrage rapide](#4-démarrage-rapide)
L'écran expliqué](#5-lécran-expliqué)
Prendre un trade chez ton courtier à partir d'une notification](#6-prendre-un-trade-chez-ton-courtier-à-partir-dune-notification)
Analyse complète, classement et marchés en direct](#7-analyse-complète-classement-et-marchés-en-direct)
Annonces économiques](#8-annonces-économiques)
Toutes les notifications](#9-toutes-les-notifications)
Réglages](#10-réglages)
Stratégie : Smart Money HTF → LTF & Fibonacci](#11-stratégie--smart-money-htf--ltf--fibonacci)
Comprendre l'analyse](#12-comprendre-lanalyse)
Sécurité en bref](#13-sécurité-en-bref)
Dépannage / FAQ](#14-dépannage--faq)
Glossaire](#15-glossaire)

---

## 1. Présentation

XAUUSD Zones détecte des zones d'achat et de vente appelées **order blocks**, selon une méthode fixe et documentée (`TRADING_RULES_MASTER_PROMPT.md`), **sans intelligence artificielle**. Pour chaque zone, elle indique si elle est encore valable, calcule un plan de trade complet (entrée, stop, objectifs) et suit son évolution.

Au-delà de l'or (XAUUSD), l'application suit en tout **11 marchés** : XAUUSD, US30, S&P 500, Nasdaq 100, EUR/USD, GBP/USD, USD/JPY, DAX 40, CAC 40, pétrole WTI et pétrole Brent (§7).

Le même code tourne :
- sur **PC** (fenêtre Edge, lancée par `XAUUSD-Zones.bat`) ;
- sur **Android** (application installée, APK compilé par `installer-android.bat`).

Les deux lisent les **mêmes bougies**, venues uniquement de **TradingView Desktop** installé sur le PC.

### Ce que l'application NE fait PAS

- **Elle ne passe aucun ordre chez un courtier.** Les positions affichées (« Mes trades », « Backtest ») sont **entièrement simulées** : l'application suit un prix et calcule un résultat théorique, elle ne touche à aucun compte de trading réel.
- **Elle ne donne pas de conseil financier personnalisé.** L'analyse est informative : à toi de décider d'ouvrir ou non un ordre chez ton courtier, et de gérer ce trade toi-même.
- **Elle n'utilise aucune IA.** Toutes les règles (order block, étoiles, stop, objectifs, apprentissage) sont des calculs déterministes, toujours reproductibles avec les mêmes bougies.

---

## 2. Prérequis

### Sur le PC (Windows)

| Élément | Détail |
|---|---|
| **TradingView Desktop** | Installé et connecté. Un abonnement **gratuit** suffit pour l'or (XAUUSD) sur les timeframes 1m à 1D. L'application n'utilise et ne crée jamais qu'**1 seul graphique**, quel que soit l'abonnement : quand plusieurs marchés sont analysés en direct (jusqu'à 3, choisis par toi, §7 et §10), ils s'y relaient à tour de rôle via la barre de recherche. |
| **Un graphique ouvert sur un marché suivi** | Au moins un graphique d'un des 11 marchés du registre (XAUUSD par défaut) doit être ouvert dans TradingView Desktop. Sans cela, l'analyse est bloquée (garde-fou). |
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
| **Exemption d'optimisation de batterie** | À accorder dans Réglages de l'application (bouton « Autoriser l'analyse en arrière-plan »), sinon OnePlus peut arrêter l'analyse en arrière-plan (service **LiveKeeper**, §5). |
| **Débogage USB** (une seule fois, à l'installation) | Options pour les développeurs → Débogage USB, puis accepter la fenêtre « Autoriser le débogage USB » qui apparaît quand le téléphone est branché. |
| **Android Studio** | Uniquement sur le PC qui **compile** l'APK — jamais nécessaire sur le téléphone. |

---

## 3. Installation pas à pas (première fois)

### 3.1 Préparer le PC

1. Installe **Node.js** (version 18 ou plus) si ce n'est pas déjà fait.
2. Place le projet dans `C:\Users\Joshu\tradingview-mcp` (dossier contenant `app\`).
3. Installe et connecte **TradingView Desktop**, avec au moins un graphique **XAUUSD** ouvert.

### 3.2 Démarrer le serveur PC

Double-clique sur `app\XAUUSD-Zones.bat`. Une fenêtre noire (invite de commandes) s'ouvre et affiche, dans l'ordre :

1. Si besoin, l'installation des dépendances (`npm ci`, versions figées) — uniquement la toute première fois.
2. Une vérification du port de débogage de TradingView (`127.0.0.1:9222`). S'il ne répond pas, le script lance lui-même TradingView Desktop en mode débogage.
3. La ligne `XAUUSD Zones (PC) → http://localhost:3777` — le serveur est démarré, et une fenêtre Edge s'ouvre automatiquement sur l'application.
4. Un encadré **« CODE D'APPAIRAGE »** avec 8 chiffres, valable jusqu'à une heure indiquée, à usage unique. En dessous : « Nouveau code : appuie sur Entrée dans cette fenêtre. » — à tout moment, appuyer sur **Entrée** dans cette fenêtre invalide l'ancien code et en affiche un nouveau.

**Garde cette fenêtre ouverte** : la fermer arrête le serveur (et donc l'accès depuis le téléphone).

### 3.3 Vérifier les marchés TradingView

Pour que l'application dispose de toutes les timeframes (1m, 5m, 15m, 1h, 4h, 1D) sans changer ta propre disposition à chaque fois :

1. Dans l'application PC, ouvre **Réglages** (icône engrenage).
2. Clique sur **« Vérifier les marchés TradingView »**.
3. L'application résout chacun des 11 marchés suivis sur l'UNIQUE graphique de TradingView Desktop, via sa barre de recherche (requête exacte par marché, ex. « USOIL » pour le WTI, 1er résultat cliqué), sans jamais créer de graphique ou de panneau supplémentaire — ton abonnement TradingView n'en affiche qu'un à la fois. Le graphique revient ensuite à ta position de départ. Un toast confirme combien de marchés ont été reconnus (et lesquels, sinon, restent introuvables).

Le serveur lit ensuite chaque graphique **sans jamais changer ta timeframe** : si une timeframe manque à la disposition, le graphique actif bascule brièvement puis revient à ta timeframe d'origine (un cache limite ces bascules).

**Charger plus d'historique :** automatique — le serveur PC demande lui-même à TradingView de charger davantage de bougies (peu après le démarrage, puis toutes les 30 minutes), sans jamais toucher à ta timeframe ou ton symbole affichés. Pour forcer un chargement immédiat (utile juste après avoir ouvert un nouveau graphique, ou pour l'apprentissage qui demande au moins 20 trades clôturés), utilise le bouton **« Charger tout l'historique TradingView »** dans **Réglages → Accès depuis le téléphone**. Plafond de sécurité inchangé : 20 000 bougies par timeframe. L'application détecte quand l'historique a grandi côté TradingView et retélécharge alors automatiquement la timeframe concernée à l'analyse suivante ; un bouton **« Tout voir »** sur le graphique ajuste le zoom pour afficher toutes les bougies chargées.

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
   3. **Prépare le projet Android** (Capacitor), lit l'adresse Tailscale actuelle du PC pour la **préconfigurer dans l'APK** (« adresse préréglée »), et **génère un code d'appairage à usage unique (30 min)** qu'il préconfigure aussi dans l'APK : demandé au serveur PC s'il tourne déjà, sinon généré directement (`scripts\new-pairing-code.mjs`) ;
   4. **Durcit le manifeste Android** : sauvegarde désactivée, HTTPS uniquement, coffre Keystore, captures d'écran bloquées, permissions de notification et d'analyse en arrière-plan, Android 8 minimum ;
   5. **Compile l'APK release** (Gradle) ;
   6. **Signe l'APK** avec une clé privée créée sur ce PC (`%USERPROFILE%\.xauusd-zones`, mot de passe protégé par Windows) ;
   7. **Attend le téléphone** (jusqu'à 2 minutes) : débloque-le, active le débogage USB si ce n'est pas déjà fait, et accepte « Autoriser le débogage USB » ;
   8. **Installe et lance** l'application sur le téléphone.

   L'APK signé est aussi copié dans `app\XAUUSD-Zones.apk`. Si le téléphone n'était pas prêt au moment de la compilation, relance juste l'installation avec `app\installer-telephone.bat` (attend jusqu'à 10 minutes).

2. Sur le téléphone, ouvre simplement l'application XAUUSD Zones. **L'appairage se fait automatiquement**, avec le code préconfiguré à la compilation : un toast confirme « Téléphone appairé automatiquement au PC. » et le bandeau passe au vert (**« ✓ Téléphone appairé au PC · … »**). Rien à saisir.
3. Si le PC n'était pas joignable à ce moment (Wi-Fi, Tailscale pas encore connecté…), le code reste préréglé dans **Réglages → Connexion au PC** et l'appairage est retenté automatiquement à chaque relance de l'application et à chaque appui sur **« Analyser »**, jusqu'à ce qu'il réussisse ou que le code expire (30 min).
4. **Solution de secours (saisie manuelle)** : si le code préconfiguré a expiré ou a déjà servi (ex. code compilé il y a plus de 30 min), lance `app\code-appairage.bat` sur le PC (il affiche un nouveau code à 8 chiffres, encadré vert, valable 10 minutes, une seule fois ; fenêtre exigeant que `XAUUSD-Zones.bat` tourne déjà), puis sur le téléphone ouvre le bandeau rouge **« Téléphone non appairé »** et appuie sur **« Saisir le code »** (ou **Réglages → Connexion au PC**), tape les **8 chiffres**, puis **« Connecter au PC »**.

L'adresse du PC reste modifiable ensuite dans **Réglages → Connexion au PC → « Adresse du PC »** (champ sous « Adresse du PC (préréglée) et nom du téléphone »), utile si l'adresse Tailscale du PC change.

---

## 3 bis. Démarrage en un clic

Double-clique sur **`Demarrer.bat`** à la racine du projet (macOS / Linux : `./start.sh`). Il installe Node.js et les dépendances si besoin, lance TradingView Desktop en mode débogage, démarre le serveur et ouvre l'application. Rien d'autre à lancer.

### Indicateur de confiance

Chaque zone porte un badge **Confiance bonne / moyenne / faible / nulle / non démontrée** : c'est le niveau de preuve du backtest long terme (2019 → aujourd'hui) pour le marché concerné, pas une probabilité de gain. Il apparaît sur les cartes, dans le détail et dans les notifications. Il est « bonne » seulement si la période d'apprentissage ET la période de validation sont positives, si l'intervalle de confiance est entièrement > 0 et si le résultat bat 95 % des tirages aléatoires. Aujourd'hui, aucun marché n'atteint ce niveau.

### Dates d'entrée et de clôture

Chaque trade simulé affiche sa **date d'entrée** et sa **date de clôture** (détail d'une zone, historique de l'onglet Marchés et export CSV). Le backtest écrit aussi `app/www/data/backtest-<MARCHÉ>-trades.csv`. Relancer le backtest : `npm run backtest --prefix app -- --market XAUUSD --from 2019-01-01`.

## 4. Démarrage rapide

Une fois l'installation faite (§3), la routine de tous les jours :

1. Sur le PC : lance `XAUUSD-Zones.bat` (si pas déjà fait) et laisse TradingView Desktop ouvert sur un graphique d'un marché suivi.
2. Ouvre l'application (fenêtre Edge sur PC, ou application sur le téléphone — connecté par Tailscale).
3. Sur le téléphone, vérifie le bandeau en haut de l'écran : **vert** = tout va bien, **rouge** = appaire d'abord (§3.5).
4. Appuie sur **« Analyser »** (icône ▶). Le bouton devient **« En direct »** avec un point rouge clignotant : l'analyse tourne désormais en continu (toutes les 5 à 60 secondes, réglable). Un nouvel appui arrête l'analyse.
5. Laisse tourner et attends une notification **5★** (§9). Elle indique la zone à surveiller, puis l'entrée quand elle est confirmée.
6. Suis les instructions de la notification pour agir chez ton courtier (§6).
7. En fin de journée : jette un œil à l'onglet **Annonces** (§8) pour anticiper la nuit, et à l'onglet **Marchés** (§7) si tu veux relancer une **Analyse complète**.

C'est tout ce qu'il faut pour une utilisation quotidienne ; les sections suivantes détaillent chaque écran, chaque réglage et chaque notification.

---

## 5. L'écran expliqué

### En-tête et bandeaux

| Zone | Contenu |
|---|---|
| **En-tête** | Prix actuel du marché affiché, heure de la dernière analyse, source (PC · TradingView Desktop, ou Téléphone · PC distant). |
| **Chip « Analyse en arrière-plan activée »** (Android) | Apparaît sous l'en-tête pendant que « En direct » tourne, tant que le service d'arrière-plan (LiveKeeper) est actif. |
| **Chip « Prochaine annonce »** | Ex. « Prochaine annonce : 🇺🇸 CPI dans 2 h 10 » : compte à rebours vers la prochaine annonce économique majeure suivie (§8). |
| **Bandeau d'appairage** (téléphone uniquement) | **Vert** — **« ✓ Téléphone appairé au PC · <adresse> »** : tout fonctionne. **Rouge** — **« Téléphone non appairé »**, avec le bouton **« Saisir le code »** qui ouvre directement les réglages d'appairage. Une erreur d'analyse (PC injoignable, TradingView fermé…) affiche temporairement un bandeau rouge d'erreur à sa place ; dès l'analyse suivante réussie, le bandeau vert réapparaît automatiquement. |
| **Bouton « Analyser »** | Icône ▶. Devient **« En direct »** (point rouge clignotant) pendant l'analyse continue. Sur téléphone non appairé, affiche **« Non connecté »** : l'analyse ne peut pas tourner sans PC appairé (toast + bandeau rouge, fenêtre de code ouverte automatiquement). |
| **Bouton « Analyse complète »** (en-tête et onglet Marchés) | Lance l'analyse complète des 11 marchés (§7). |

### Balance et onglets

| Zone | Contenu |
|---|---|
| **Balance** | Pips et euros cumulés, réalisé/latent, gagnants/perdants, taux de réussite. Bascule **« Mes trades »** / **« Backtest »** (§12). Bouton **« Lot & stop »** (§10). |
| **Onglets de catégorie** | **Tous** · **Scalp** (1m·5m) · **Daily** (15m·1h) · **Swing** (4h·1D). |
| **Onglets de timeframe** | 1m 5m 15m 1h 4h 1D, au-dessus du graphique. Un point vert = une opportunité 5★ est disponible sur cette timeframe. |
| **Chips de marché** | Boutons ronds pour choisir le marché affiché en direct (§7). |
| **Graphique** | Bougies (neutres : creuse = hausse, pleine = baisse, pour réserver vert/rouge aux résultats), zones colorées, ligne d'objectif, ligne de stop. Bouton **« Tout voir »** : zoom sur toutes les bougies chargées. Case **« Zones des autres TF »** : affiche aussi les zones des autres timeframes en fond. |
| **Légende** | ◷ Opportunité · ✓ Gagnant · ✕ Perdant · ⊘ Non validée · – Annulée · ligne objectif · ligne stop · bougie creuse = hausse. |
| **Onglets latéraux** | **Trades** · **Marchés** · **Agents** · **Apprentissage** · **Annonces**. Dans « Trades » : **Opportunités** · **Suivis** · **Historique** · **Non validées**, plus un filtre **Achat et vente** / **▲ Achat** / **▼ Vente**. |

### Le code couleur des cartes

| Couleur | Icône | Signification |
|---|---|---|
| Bleu | ◷ | Opportunité validée, en attente du prix |
| Vert | ✓ / ↗ | Gagnant (objectif atteint) / en position à gains |
| Rouge | ✕ / ↘ | Perdant (stop touché) / en position à perte |
| Ardoise hachurée | ⊘ | Zone non validée (auditeur, stop trop large, règle apprise) |
| Ambre | ⏸ | Validée mais suspendue (annonce macro) |
| Gris pointillé | – | Annulée |

Le sens est toujours indiqué en plus par ▲ Achat / ▼ Vente, jamais par la couleur seule.

### Le détail d'une zone

Clique sur une carte (dans la liste ou sur le graphique) pour ouvrir sa fiche complète :

- **Statut** en grand, avec le résultat en pips/€ s'il y en a un.
- **Grille des 5 étoiles** : chaque critère (imbalance, tendance, liquidité, OB vierge, Fibonacci) avec ✓/✗ et son détail chiffré — le **checklist** complet de la note (§12).
- **Zone d'entrée (OB)** : les deux bords, avec l'explication « Entrée à la clôture de la première bougie haussière/baissière dans l'OB » (mode par défaut), ou le prix exact si le mode « ordre limite » est choisi.
- **Stop loss (invalidation)** : prix, pips et perte en euros.
- **TP1, TP2, TP3** : prix, pips et ratio R pour chacun, avec une coche ✓ si déjà atteint.
- **Gestion** : résumé texte de la règle de gestion du stop (1/3 par palier, BE, trailing, plancher TP1…).
- **Zone C1**, l'imbalance, les OHLC de P/C1/C2/C3, et la preuve complète (liquidité prise, order block, imbalance stricte, retest ou non).
- Bouton **« Suivre »** / **« J'ai suivi cette zone »** (selon l'état), ou **« Ne plus suivre »** si déjà suivi, avec un champ **Lot** modifiable pour ce trade précis.

### Marquer « Suivre » / « J'ai suivi »

- Dans **Opportunités**, appuie sur **« Suivre »** dès que tu comptes prendre le trade (ou l'as déjà pris) : la zone entre dans **« Mes trades »** et compte dans ta balance réelle.
- Si le trade est déjà en cours ou terminé au moment où tu le marques, le bouton affiche **« Je l'ai pris »** : l'application reprend alors l'exécution déjà simulée (prix d'entrée, TP atteints...) comme si tu l'avais suivi depuis le début.
- Pour retirer un trade de ton suivi, ouvre sa fiche ou la liste **Suivis**, et appuie deux fois sur **« Ne plus suivre »** (double confirmation).
- Le **lot** de chaque trade suivi est modifiable individuellement dans sa fiche (champ « Lot »), indépendamment du lot par défaut réglé dans « Lot & stop ».

### « Mes trades » vs « Backtest »

- **Mes trades** (case cochée par défaut) : uniquement les zones que tu as marquées « Suivre » — ta balance réelle.
- **Backtest** : toutes les zones détectées, simulées sur tout l'historique chargé dans TradingView — utile pour juger la méthode elle-même, sans que tes propres décisions n'influencent le résultat.

---

## 6. Prendre un trade chez ton courtier à partir d'une notification

L'application ne passe aucun ordre : c'est toi qui agis chez ton courtier, en suivant les notifications (table complète §9).

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

Les distances de TP (+100/+200/+350 en Scalp/Daily, +100/+400/+600 en Swing) et les règles de gestion du stop sont détaillées en §12.

---

## 7. Analyse complète, classement et marchés en direct

L'onglet **« Marchés »** (panneau latéral) analyse, en plus de l'or, tous les marchés suivis : US30, S&P 500, Nasdaq 100, EUR/USD, GBP/USD, USD/JPY, DAX 40, CAC 40, pétrole WTI et pétrole Brent (11 marchés en tout).

1. Appuie sur **« Analyse complète »** : l'application passe en revue chacun de ces marchés sur les **9 timeframes** (1m, 5m, 15m, 1h, 4h, 1D, 1W, 1Mo, 1A), à partir de l'historique déjà chargé dans TradingView Desktop. **Compte plusieurs minutes** (le graphique bascule brièvement de marché et de timeframe pendant l'opération, puis revient à ta position de départ ; les lectures en direct sont mises en pause pendant ce temps).
2. Une fois terminée, un **classement** apparaît : chaque marché avec ses gains en pips (backtest), son nombre de trades, son taux de réussite et ses opportunités 5★ actuelles. Les marchés avec moins de 8 trades clôturés dans l'historique chargé sont listés à part (« échantillon insuffisant »), en dessous des autres.
3. Des **chips** (boutons ronds) permettent de choisir le marché **affiché** (graphique/liste) : appuie sur un marché pour le consulter, ou choisis-le directement dans le sélecteur de marché de la barre d'outils du graphique. Ce classement est **uniquement informatif** : il ne choisit jamais les marchés analysés **en direct**. C'est TOI qui les choisis, dans le sélecteur « Marchés analysés en direct » de l'onglet « Marchés » (jusqu'à 3, l'or sélectionné par défaut ; chaque marché du classement porte aussi un bouton « + Direct » / « ✓ En direct » pour l'ajouter ou le retirer directement). Ils se relaient à tour de rôle sur l'UNIQUE graphique TradingView (ton abonnement n'en affiche qu'un) — l'application y sélectionne automatiquement chaque marché via la barre de recherche avant de le lire ; plus tu en choisis, plus le rafraîchissement de chacun est lent.
4. **Historique de l'analyse complète** (bas de l'onglet « Marchés ») : tous les trades simulés par la dernière analyse complète, filtrables par marché, catégorie et résultat (gagnants/perdants), avec un résumé (nombre de trades, taux de réussite, somme des R) et un export CSV du filtre affiché.

Les règles (5★, SL ≤ 100 pips, échelle de TP, gestion du stop) sont strictement identiques pour tous les marchés ; seule la taille du pip change (ex. 0,0001 pour l'EUR/USD, 1 point pour le DAX 40) — les notifications et le journal l'indiquent toujours en toutes lettres (« EUR/USD », « DAX 40 »…) au lieu de « GOLD » quand ce n'est pas l'or.

---

## 8. Annonces économiques

L'onglet **Annonces** (panneau latéral) liste les annonces majeures à venir (7 prochains jours) et les résultats récents (24 dernières heures) pour les États-Unis 🇺🇸, la zone euro 🇪🇺, la Chine 🇨🇳 et le Japon 🇯🇵 — impact **majeur** uniquement. Pour chaque annonce : heure locale, consensus, précédent, puis valeur réelle et tendance dès sa publication (« Supérieur/Inférieur/Conforme aux attentes », et pour les États-Unis la tendance habituelle pour l'or — jamais une prédiction). Le sous-titre de l'application affiche un compte à rebours vers la prochaine annonce majeure (« Prochaine annonce : 🇺🇸 CPI dans 2 h 10 »). Ces annonces alimentent aussi la fenêtre de pause du calendrier (§12, agent Calendrier économique).

---

## 9. Toutes les notifications

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
| Pré-alerte annonce économique majeure | `⚠️ 14:30 · 🇺🇸 NFP · impact majeur` avec `Consensus 150K · Précédent 142K` | Prépare-toi : une annonce à fort impact (US/zone euro/Chine/Japon) arrive dans le délai choisi (« Alerte avant annonce »). |
| Résultat d'une annonce économique majeure | `📊 🇺🇸 NFP : 210K (consensus 150K)` avec `Supérieur aux attentes · généralement baissier pour l'or · précédent 142K` | Résultat publié : la tendance indiquée pour l'or est habituelle, jamais une prédiction. |

Ces notifications ne s'affichent (en toast dans l'application, et en notification système si activées) que pendant que **« Analyser »/« En direct »** tourne. Sur Android, elles continuent d'arriver écran éteint ou application en arrière-plan grâce au service de premier plan LiveKeeper (voir « Autoriser l'analyse en arrière-plan », §10). Si l'application est **complètement fermée**, aucune analyse ne tourne, donc aucune notification n'arrive.

---

## 10. Réglages

Ouvre les réglages avec l'icône engrenage en haut à droite.

### Accès depuis le téléphone (visible seulement sur PC)

| Champ / bouton | Rôle |
|---|---|
| Encadré d'état | Indique si Tailscale est installé, connecté, et si l'API téléphone est publiée, avec l'adresse à saisir sur le téléphone. |
| **« Générer un code d'appairage »** | Crée un nouveau code à 8 chiffres, affiché à l'écran, valable jusqu'à l'heure indiquée, à usage unique. |
| **« Vérifier les marchés TradingView »** | Résout les 11 marchés suivis sur l'unique graphique de TradingView Desktop, via sa barre de recherche (§3.3). |
| **« Charger tout l'historique TradingView »** | Force un chargement immédiat de l'historique (§3.3), plafonné à 20 000 bougies par timeframe. |
| **Appareils autorisés** | Liste des téléphones appairés (nom, compte Tailscale, date d'appairage, dernière connexion) avec un bouton **« Révoquer »** par appareil (double confirmation). Maximum 5 appareils ; ré-appairer un même nom remplace l'appareil existant. |
| **Journal de sécurité** | Derniers événements de sécurité (appairages, échecs, verrouillages…), et le nombre d'événements suspects sur 24 h. |

### Connexion au PC (visible seulement sur téléphone)

| Champ / bouton | Rôle |
|---|---|
| **Code d'appairage** | Les 8 chiffres affichés sur le PC. Prérempli automatiquement avec le code préconfiguré à la compilation de l'APK tant qu'il n'a pas été utilisé ou refusé par le PC — l'appairage se fait alors sans rien taper (§3.5). |
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

### Marchés en direct

| Champ | Rôle |
|---|---|
| **Marchés analysés en direct** | Se choisit dans l'onglet « Marchés » (un bouton « Ouvrir Marchés » y renvoie depuis Réglages) : jusqu'à **3 marchés**, au moins 1, l'or sélectionné par défaut — CHOISIS par toi, jamais imposés par le classement. Ton compte TradingView n'affiche qu'un seul graphique à la fois : ces marchés s'y relaient à tour de rôle, l'application sélectionnant automatiquement le bon marché (barre de recherche) avant chaque lecture ; plus tu en choisis, plus le rafraîchissement de chacun est lent. |

### Apprentissage

| Champ | Rôle |
|---|---|
| **Échantillons minimum par règle** | Nombre minimal de trades nécessaires avant qu'une caractéristique perdante devienne une règle candidate (défaut : 8). |
| **Seuil d'espérance (R)** | Espérance moyenne (en R) en dessous de laquelle une caractéristique est jugée perdante (défaut : −0,15 R). |

### Alertes et données

| Champ / bouton | Rôle |
|---|---|
| **Notifications de trading** (case) | Active les notifications (opportunité, entrée, TP1/2/3, BE, trailing, SL). Demande la permission système si nécessaire. |
| **Notifications des annonces économiques** (case, activée par défaut) | Pré-alerte avant chaque annonce majeure (US, zone euro, Chine, Japon) et notification de son résultat, avec la tendance habituelle pour l'or (US uniquement). |
| **Alerte avant annonce** | Délai de la pré-alerte : 5, 15, 30 (défaut) ou 60 minutes avant l'annonce. |
| **« Autoriser l'analyse en arrière-plan »** (Android uniquement) | Demande l'exemption d'optimisation de batterie, pour que l'analyse et les notifications continuent écran éteint. Une ligne d'état juste en dessous affiche **« Optimisation batterie désactivée ✓ »** ou **« Non autorisée »**, mise à jour dès que tu reviens dans l'application. |
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

Le stop loss et les objectifs (TP1/TP2/TP3) ne sont **pas** réglables : ils sont entièrement automatiques (§12). Seuls le lot, la valeur du pip, le taux de change, le mode d'entrée et la pause autour des annonces sont paramétrables ici.

---

## 11. Stratégie : Smart Money HTF → LTF & Fibonacci

Depuis cette version, l'application propose **deux stratégies**, réglables dans **Réglages → Stratégie** :

- **Smart Money HTF → LTF & Fibonacci** (recommandée, activée par défaut) : cherche une zone d'intérêt institutionnelle
  sur les grandes unités de temps (1D/1W/1Mo), la filtre par le Fibonacci, puis attend une confirmation précise sur
  15m/5m avant d'entrer.
- **Order Blocks 5★ (historique)** : l'ancienne stratégie de l'application (§12), conservée pour comparaison.

Les deux stratégies sont **déterministes et sans IA** : aucune ne devine, chacune ne fait que mesurer des bougies
déjà clôturées, en temps réel comme en backtest.

### Comment lire un setup SMC dans l'application

Ouvre le détail d'une zone (clic sur une opportunité, ou sur le graphique). À la place des « 5 étoiles », un setup
SMC affiche une checklist en 5 points, tous validés pour qu'un setup soit proposé :

1. **① POI HTF** — l'Order Block ou le Fair Value Gap (1D, 1W ou 1Mo) sur lequel le prix vient de toucher pour la
   première fois (« non mitigé au contact »).
2. **② Biais & Fibonacci HTF** — le sens de la structure (achat/vente) et la position du POI dans le Fibonacci tracé
   sur la dernière impulsion 1D : « Discount » (< 0,5) pour un achat, « Premium » (> 0,5) pour une vente ; un badge
   **OTE** apparaît quand le POI est dans la zone de recharge optimale (0,618–0,786).
3. **③ CHoCH / MSS LTF** — l'heure et le niveau de la cassure de structure en 15m ou 5m qui confirme le changement de
   comportement du prix après le contact du POI.
4. **④ Micro-zone LTF** — le micro-FVG ou micro-OB formé juste après le CHoCH, sur lequel l'ordre limite est posé
   (badge **OTE** si son retracement tombe dans la zone 0,618–0,786).
5. **⑤ R:R entrée → TP2** — le ratio risque/rendement théorique jusqu'à l'objectif final. **Un R:R inférieur à
   1:3 rejette automatiquement le setup** : il n'apparaît alors qu'en « Non validées », avec le motif du rejet.

Le détail affiche ensuite deux objectifs seulement (pas de TP3) :

- **TP1** : la prochaine liquidité 15m (sommets/creux égaux, ou FVG opposé) — **50 % de la position encaissés**, puis
  stop ramené au **point mort**.
- **TP2 (objectif final)** : la liquidité majeure 1D (swing non pris, ou FVG 1D opposé) — le **reste (50 %)** de la
  position est clôturé ici, sans trailing supplémentaire.

L'entrée est **toujours un ordre limite** posé sur la micro-zone LTF : la position n'existe que lorsque le prix y
revient. L'ordre est annulé (« expiré ») s'il n'est pas exécuté à temps.

Sur le graphique, la zone sélectionnée affiche en plus, quand ils entrent dans la plage visible : une bande
translucide « POI 1D/1W/1Mo » (le POI HTF d'origine) et une ligne pointillée « Fibo 0,5 » (l'équilibre du Fibonacci
HTF) — utiles pour visualiser d'un coup d'œil pourquoi le setup a été retenu.

Dans l'onglet **Marchés**, le classement de chaque marché affiche l'entonnoir de détection propre à la stratégie SMC
(« POI HTF … · atteints … · biais ok … · Fibo ok … · CHoCH … · micro-zones … · R:R ≥ 1:3 … »), et l'onglet
**Agents** affiche une liste « POI HTF à surveiller » : les POI 1D/1W/1Mo pas encore atteints, les plus proches du
prix d'abord — utile pour anticiper les prochains setups avant même qu'ils ne se déclenchent.

### Changer de stratégie

Réglages → **Stratégie** → sélecteur **« Stratégie »** → choisis « Smart Money HTF → LTF & Fibonacci » ou
« Order Blocks 5★ (historique) », puis « Enregistrer ». Les réglages qui ne s'appliquent qu'à l'ancienne stratégie
(mode d'objectifs adaptatif/fixe, filtre de tendance) sont automatiquement masqués quand la stratégie SMC est
sélectionnée : elle n'en a pas besoin, son stop et ses objectifs sont recalculés setup par setup. Les réglages
communs (capital, risque %, coûts, séances autorisées) restent valables pour les deux stratégies.

### Valider sur plusieurs années d'historique

Sur le PC, `backtest.bat` permet de rejouer une stratégie sur tout l'historique TradingView chargé. Pour valider la
stratégie SMC sur plusieurs années de données avant de l'utiliser en direct, lance-le avec la stratégie `smc` (le
script demande la stratégie à backtester, ou accepte un paramètre — voir l'aide affichée par `backtest.bat` sans
argument) ; compare ensuite son espérance, son taux de réussite et son drawdown à ceux de la stratégie « Order
Blocks 5★ » dans l'onglet **Stats** avant de basculer ton compte réel dessus.

---

## 12. Comprendre l'analyse

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

### Pip par marché

| Marché | Taille du pip |
|---|---|
| Or (XAUUSD) | 0,10 $ |
| US30, S&P 500, Nasdaq 100, DAX 40, CAC 40 | 1 point |
| EUR/USD, GBP/USD | 0,0001 |
| USD/JPY | 0,01 |
| Pétrole WTI, pétrole Brent | 0,01 |

### Règle SL ≤ 100 pips

Le risque (distance entrée → stop) ne doit **jamais dépasser 100 pips**, quelle que soit la catégorie ou le marché. Au-delà, la zone est **refusée** (« non viable »). Comme l'entrée se fait par défaut après une bougie de réaction, le risque réel est **revérifié à l'entrée** : s'il dépasse 100 pips à ce moment-là, le trade est **annulé**, même si le plan initial était valide.

**Ordre en attente : quand est-il annulé ?** Deux règles existent, et l'application choisit elle-même, par catégorie (scalp, intraday, swing), celle que le backtest prouve la meilleure à chaque **analyse complète** :
- *Prudente (par défaut)* : l'ordre est annulé si le prix atteint le TP1 avant d'être revenu dans la zone (« le setup s'est joué sans nous »).
- *Premier retour* : la zone reste valable pour son premier retour après l'impulsion ; elle n'est annulée que si le TP3 est atteint sans entrée, si la zone est cassée, ou si elle vieillit trop (120 bougies de son unité de temps en scalp/intraday, 60 en swing).

La règle « premier retour » n'est adoptée que si, sur tous les marchés, elle rapporte **plus de pips**, avec une **espérance positive**, un **profit factor ≥ 1,2** et au moins égal à la règle prudente, un **drawdown relatif** au moins aussi bon, et qu'elle reste **meilleure sur la moitié la plus récente** de l'historique. Sinon la règle prudente est conservée. La règle retenue est affichée en haut de l'onglet **Marchés**.

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
| **Calendrier économique** | Annonces USD à fort impact embarquées + annonces majeures en direct de TradingView (US, zone euro, Chine, Japon, onglet « Annonces ») fusionnées, avec fenêtre de pause ; indique la source (embarqué/direct) et le compte par pays. |
| **Historique des trades** | Journal, backtest et apprentissage. |
| **Auditeur** | Revérifie chaque zone à partir des bougies brutes (code indépendant du scanner), applique la règle SL ≤ 100 pips, les annonces et les règles apprises, et rend le verdict final. |

Chaque agent produit un rapport avec un statut :
- **COMPLET** : tout est disponible et cohérent.
- **PARTIEL** : une partie manque ou est incomplète (ex. une timeframe indisponible).
- **ÉCHEC** : l'agent ne peut pas fonctionner (ex. TradingView non joignable, symbole non suivi).

L'agent **Historique** reste en **PARTIEL** tant que **moins de 20 trades clôturés** ont été appris (message : « seulement N trades clôturés appris (20 nécessaires) »). Fais défiler les graphiques TradingView vers le passé pour charger plus d'historique : plus de bougies anciennes donnent plus de trades simulés dans le backtest, donc plus d'échantillons d'apprentissage.

---

## 13. Sécurité en bref

- **Appairage** : code à 8 chiffres, à usage unique, grillé après 5 essais ; 10 minutes en saisie manuelle, 30 minutes pour le code préconfiguré dans l'APK (appairage automatique, §3.5 et SECURITE.md). Plusieurs codes peuvent être valables en même temps.
- **Jeton du téléphone** : 256 bits, chiffré en AES-256-GCM dans le Keystore Android (jamais en clair), lié au compte Tailscale qui a fait l'appairage, expirant après 180 jours.
- **Appareils** : jusqu'à 5 appareils autorisés à la fois ; ré-appairer un appareil déjà connu (même nom) remplace l'entrée existante.
- **Révoquer un appareil** : Réglages PC → Appareils autorisés → « Révoquer » (immédiat).
- **Journal de sécurité** : visible dans Réglages PC, aucun secret n'y figure.
- **Ce qui est exposé** : uniquement 3 routes distantes en lecture seule (`/api/health`, `/api/pair`, `/api/tv/candles`), accessibles seulement via Tailscale, jamais directement sur Internet ni sur le réseau local. Aucun ordre de courtier, aucune donnée personnelle.
- **Verrouillage automatique** : après 10 échecs d'authentification en 10 minutes, l'accès distant est bloqué 15 minutes.

Détail complet, catégorie par catégorie de l'OWASP Top 10:2025, dans **[SECURITE.md](SECURITE.md)**.

---

## 14. Dépannage / FAQ

**« Serveur injoignable » (code-appairage.bat ou l'application PC)**
→ Lance `XAUUSD-Zones.bat` et garde sa fenêtre ouverte ; le message précis apparaît en rouge dans la fenêtre du script.

**Tailscale non détecté / non installé**
→ Installe-le sur le PC (tailscale.com/download/windows), connecte-toi, puis relance `acces-distant.bat`.

**« HTTPS Certificates » ou MagicDNS non activé**
→ Un lien s'affiche dans la fenêtre de `acces-distant.bat` : ouvre-le, active l'option sur admin.tailscale.com, puis relance le script.

**Code d'appairage refusé ou expiré (plusieurs codes, verrouillage 15 min, limite d'appareils)**
→ Le code préconfiguré à la compilation de l'APK est valable 30 minutes, une seule fois. Le code manuel (« Générer un code d'appairage », `code-appairage.bat`, ou Entrée dans la fenêtre du serveur) est valable 10 minutes ; plusieurs codes générés séparément peuvent être valables en même temps, mais chacun n'est utilisable qu'une fois. Passé le délai ou après usage, génère-en un nouveau puis saisis-le dans **Réglages → Connexion au PC**. Après 5 essais erronés, les codes en attente sont grillés (relance-en un). Après 10 échecs d'authentification en 10 minutes, l'accès distant est bloqué 15 minutes (§13). Si « Nombre maximal d'appareils atteint (5) » apparaît, révoque un appareil existant côté PC (Réglages → Appareils autorisés) avant de ré-appairer.

**Bouton « Analyser » qui affiche « Non connecté »**
→ Le téléphone n'est pas (encore) appairé au PC : appaire-le d'abord (§3.5). Si un code était préconfiguré dans l'APK mais que le PC était injoignable au premier lancement, une nouvelle tentative automatique a lieu à chaque appui sur « Analyser » — vérifie que le PC est allumé, `XAUUSD-Zones.bat` lancé, et Tailscale connecté des deux côtés.

**TradingView n'affiche pas de graphique du marché suivi**
→ Ouvre un graphique d'un des marchés suivis (XAUUSD par défaut) dans TradingView Desktop : sans cela, l'agent Collecteur bloque l'analyse (« Symbole non suivi : analyse bloquée »).

**Le graphique et l'application se chevauchent visuellement pendant le scan**
→ C'est normal pendant une « Analyse complète » ou un chargement d'historique : le graphique bascule brièvement de marché/timeframe. Si l'affichage reste décalé après coup, recompile l'APK (`installer-android.bat`) pour repartir d'une disposition propre.

**Aucune opportunité n'apparaît**
→ C'est normal : seules les zones **5★** sont proposées (moins de 5★ = toujours invalidée), et le risque doit rester ≤ 100 pips (SL). Laisse « Analyser » tourner ; les zones 5★ sont rares par nature. Consulte l'onglet « Non validées » pour voir ce qui a été écarté et pourquoi.

**Peu de bougies affichées / historique trop court**
→ Force un chargement avec **« Charger tout l'historique TradingView »** (Réglages → Accès depuis le téléphone), ou fais défiler manuellement le graphique TradingView vers le passé. Plafond : 20 000 bougies par timeframe.

**La timeframe 1A (1 an) semble peu exploitable**
→ Normal : peu de marchés ont assez d'historique annuel chargé dans TradingView pour produire des zones ou des trades fiables sur cette timeframe ; elle reste incluse dans l'analyse complète mais donne rarement des résultats exploitables.

**Les notifications n'arrivent pas**
→ Vérifie, dans l'ordre : la case « Notifications de trading » est cochée dans Réglages ; la permission de notification est accordée à l'application (réglages Android) ; l'exemption de batterie a été accordée (« Autoriser l'analyse en arrière-plan ») ; l'application n'est pas **complètement fermée** — l'analyse en direct doit continuer à tourner (service LiveKeeper de premier plan, visible en notification discrète).

**Le graphique TradingView change de marché/timeframe pendant une analyse**
→ Comportement normal pendant une « Analyse complète », une vérification des marchés (§3.3) ou l'analyse en direct de plusieurs marchés (§7, ils se relaient sur l'unique graphique) : le graphique revient à ta position de départ une fois l'opération terminée, un cache limite ces bascules le reste du temps.

**« INSTALL_FAILED_UPDATE_INCOMPATIBLE » / signatures différentes lors de l'installation de l'APK**
→ Une version précédente signée différemment (ex. version de débogage) est déjà installée. `installer-android.bat`/`installer-telephone.bat` désinstallent puis réinstallent automatiquement dans ce cas ; si le message persiste, désinstalle manuellement l'application sur le téléphone avant de relancer.

**Mettre à jour l'application**
→ Relance `installer-android.bat` (recompile, resigne avec la même clé, réinstalle par-dessus). Le calendrier économique se met à jour avec `npm run calendar:sync` (racine du projet), puis `npm run calendar:build` (dossier `app`).

---

## 15. Glossaire

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
| **Pip** | Plus petite variation de prix suivie par l'application, propre à chaque marché (§12). Sur l'or (XAUUSD), 1 pip = 0,10 $ (convention standard). |
| **Premium / Discount** | Position du prix par rapport au milieu (0,5) d'un mouvement récent : Discount = moitié basse (zone d'achat recherchée), Premium = moitié haute (zone de vente recherchée). |
| **Supertrend** | Indicateur de tendance basé sur l'ATR, utilisé ici pour valider le sens (⭐2) et détecter un marché en range. |
| **ATR** | Average True Range : mesure de la volatilité moyenne récente, utilisée pour la marge de stop, le seuil « gap fragile » et le Supertrend. |
| **Order block vierge** | Order block jamais retesté depuis sa formation (⭐4). |
| **Order block mitigé** | Order block déjà retesté (donc non vierge). |
| **Champion / challenger** | Mécanisme qui n'adopte une règle apprise que si elle prouve une amélioration mesurée, avec retour arrière automatique si elle se révèle pire ensuite. |
| **Scalp / Daily / Swing** | Les trois catégories de trade de l'application, selon la timeframe : Scalp (1m·5m), Daily (15m·1h), Swing (4h·1D). |
| **Analyse complète** | Backtest et classement de tous les marchés suivis sur toutes les timeframes (§7). |
| **Marché en direct** | Marché dont le graphique TradingView est actuellement lu en continu par l'analyse (§7). |
| **LiveKeeper** | Service Android de premier plan qui maintient l'analyse et les notifications actives écran éteint (§9, §10). |

## Nouveautés (septembre 2026)

**Ce qu'il faut retenir :** l'application ne prouve pas qu'une stratégie gagne tant qu'elle n'a pas assez de trades. L'onglet **Stats** te dit honnêtement où tu en es.

- **Onglet Stats** : nombre de trades, taux de réussite, espérance en R avec sa marge d'incertitude, profit factor, pire drawdown, plus longue série de pertes, courbe de capital, et un **test contre le hasard**. Tant qu'il y a moins de 30 trades, les chiffres ne prouvent rien.
- **Mode d'objectifs** (Réglages → Stratégie) : *Adaptatif* (recommandé, stop et objectifs proportionnels à la volatilité) ou *Échelle fixe en pips* (ancien fonctionnement).
- **Risque & coûts** (Réglages) : ton capital, le risque par trade en %, la perte maximale par jour, le spread et le glissement. Chaque carte affiche le **lot conseillé**, le risque en €, et le ratio gain/risque.
- **Décalage courtier** : si le prix de ton courtier diffère de TradingView, saisis l'écart ; les niveaux « chez ton courtier » sont affichés en plus.
- **Alertes** : notification quand le prix s'approche d'une zone ; alerte « PC ou TradingView injoignable » si les données ne se mettent plus à jour (le badge « Données : il y a … » en haut indique leur fraîcheur).
- **Journal** : une note par trade suivi et un bouton **Exporter CSV**.
- **Classement des marchés** : trié par solidité statistique (espérance en R et son intervalle), plus par pips (les pips ne se comparent pas d'un marché à l'autre).
- **Backtest long terme** (sur le PC) : double-clique `backtest.bat`, choisis un marché : l'application télécharge gratuitement plusieurs années d'historique 1 minute (Dukascopy) et affiche les résultats avec un contrôle sur une période non utilisée (70 % / 30 %).
