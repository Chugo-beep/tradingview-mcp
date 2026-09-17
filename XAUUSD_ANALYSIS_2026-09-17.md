# Analyse XAUUSD - 2026-09-17

## Verrou de symbole

- Symbole autorisé : `XAUUSD`
- Fournisseur : `OANDA:XAUUSD`
- Aucun autre actif utilisé.
- Prix observé : `4341.840`
- Timeframe active au contrôle : `1M`

## Rapports des agents

### candle-by-candle-reporter

- Statut : `COMPLET`
- Timeframes : `1m`, `5m`, `15m`, `1h`, `4h`, `1D`
- Bougies reçues : 335 par timeframe
- Historique disponible : 335 par timeframe
- Données utilisées : OHLCV TradingView MCP

### historical-candle-scanner

- Statut : `COMPLET`
- Méthode : liquidité immédiatement avant C1, OB directionnel, imbalance stricte avec mèches, absence de retest après C3
- Candidats stricts : 4
- Timeframe des candidats : `5m`

### economic-calendar-agent

- Statut : `PARTIEL`
- Registre 2026 : présent mais non synchronisé
- Événements macro : non utilisés comme preuve
- Limite : aucune validation macroéconomique disponible

### history-agent-trades

- Statut : `PARTIEL`
- Historique consulté : zones précédemment enregistrées
- Limite : les zones actuelles n'ont pas encore de résultat postérieur complet

### ultimate-trader

- Statut : `COMPLET`
- Verdict : quatre zones techniquement conformes, toutes en 5m
- Aucune zone issue d'une timeframe différente n'est validée dans ce scan

## Zones validées techniquement

| Sens | Timeframe | Date C1 UTC | Zone | Liquidité | Imbalance | Retest |
|---|---|---|---:|---:|---:|---|
| BUY | 5m | 2026-09-17 00:00 | 4266.535 - 4272.485 | 4271.765 | 4272.485 < 4278.290, gap 5.805 | Aucun détecté |
| BUY | 5m | 2026-09-17 11:40 | 4323.365 - 4327.140 | 4325.340 | 4327.140 < 4331.540, gap 4.400 | Aucun détecté |
| SELL | 5m | 2026-09-17 18:10 | 4361.485 - 4365.460 | 4363.500 | 4361.485 > 4361.395, gap 0.090 | Aucun détecté |
| SELL | 5m | 2026-09-17 19:10 | 4353.595 - 4355.840 | 4355.650 | 4353.595 > 4352.125, gap 1.470 | Aucun détecté |

## Verdict

Les quatre zones respectent les règles techniques sur la couverture OHLCV disponible. La validation macroéconomique est incomplète tant que le calendrier 2026 n'est pas synchronisé. Ces zones ne doivent donc pas être présentées comme validées sur le plan macro.

Analyse informative uniquement, pas un conseil financier personnalisé.
