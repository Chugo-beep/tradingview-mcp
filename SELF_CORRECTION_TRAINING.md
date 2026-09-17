# Boucle d'auto-correction et d'entraînement analytique

## Finalité

Ce document définit la procédure obligatoire pour améliorer la précision des analyses de zones TradingView à partir du journal tenu par **History Agent Trades**.

L'objectif est de réduire les erreurs répétées, d'améliorer la vérification des order blocks et de comparer chaque nouvelle lecture au comportement réellement observé du marché. Cette boucle ne constitue pas un entraînement automatique du modèle et ne garantit aucun résultat financier. Elle produit une mémoire de travail auditable, réutilisée lors des prochaines analyses.

## Sources prioritaires

1. Données OHLCV brutes de TradingView MCP.
2. État réel du graphique et timeframe active.
3. Historique enregistré par `agents/history-agent-trades.md` ou le stockage associé.
4. Captures d'écran, uniquement pour contrôle visuel.
5. Interprétation des agents, toujours inférieure aux données brutes.

## Boucle obligatoire

### Phase A : revue des anciennes zones

Avant toute nouvelle conclusion :

1. Charger les dernières zones enregistrées par **History Agent Trades**.
2. Séparer les zones `VALIDÉE`, `REJETÉE`, `NON VÉRIFIABLE` et celles déjà suivies.
3. Pour chaque zone suivie, récupérer les bougies apparues depuis la dernière revue.
4. Déterminer si la zone a été touchée, respectée, invalidée, déclenchée ou ignorée.
5. Comparer le résultat observé aux conditions qui avaient justifié la zone.
6. Identifier les erreurs récurrentes par timeframe, direction, fournisseur et type de liquidité.

### Phase B : analyse du marché actuel

1. Vérifier symbole, fournisseur, prix courant, heure et timeframe.
2. Collecter les données détaillées pour les timeframes demandées.
3. Rechercher les configurations avec les règles du prompt maître.
4. Soumettre chaque candidat à l'agent `ultimate-trader`.
5. Refuser toute zone dont une condition est seulement supposée.
6. Ne jamais laisser le quota demandé influencer la validation.

### Phase C : correction avant décision

Pour chaque candidat, répondre à ces questions :

- La liquidité a-t-elle été prise juste avant C1, sur un niveau explicite ?
- C1 est-elle réellement l'order block, et C2 est-elle bien intermédiaire ?
- L'imbalance utilise-t-elle les mèches et les inégalités strictes ?
- Toutes les bougies postérieures à C3 ont-elles été contrôlées ?
- La zone est-elle sur une timeframe autorisée ?
- Le fournisseur et le symbole sont-ils identiques aux données historiques ?
- Une zone déjà dessinée a-t-elle été revalidée au lieu d'être considérée comme valide par défaut ?
- Le raisonnement repose-t-il sur une donnée ou sur une impression visuelle ?

Si une réponse est négative ou inconnue, classer la zone `REJETÉE` ou `NON VÉRIFIABLE`.

### Phase D : journalisation

Après chaque analyse :

1. Envoyer chaque zone validée, rejetée et non vérifiable à **History Agent Trades**.
2. Enregistrer les OHLC de P/C1/C2/C3 et les preuves de chaque règle.
3. Enregistrer les erreurs de l'analyse précédente lorsqu'une revue a corrigé un jugement.
4. Ajouter une règle de prévention concrète et testable.
5. Conserver l'analyse originale et créer une nouvelle version lors d'une correction.

## Métriques de progression

À chaque revue, calculer si les données le permettent :

- taux de zones entièrement vérifiables;
- taux de retests manqués;
- taux de liquidités mal identifiées;
- taux d'imbalances invalides;
- répartition des erreurs par timeframe;
- répartition des erreurs BUY/SELL;
- délai moyen entre détection et invalidation;
- proportion de zones non vérifiables présentées à tort comme valides.

Ne pas utiliser ces métriques pour créer une probabilité de gain. Elles servent uniquement à localiser les défauts de méthode.

## Règles d'apprentissage

- Une erreur corrigée devient une règle de prévention explicite.
- Une zone gagnante ne prouve pas que la méthode était correcte.
- Une zone perdante ne prouve pas que toutes les règles étaient mauvaises.
- Une zone non vérifiable ne doit pas être comptée comme succès ou échec.
- Les exemples récents ne doivent pas effacer les exemples anciens.
- Ne jamais modifier rétroactivement un statut sans enregistrer la raison et la version.
- Si les données de deux fournisseurs divergent, conserver les deux valeurs et classer le cas en conflit.
- Après trois erreurs du même type, renforcer la règle concernée et exiger une preuve supplémentaire avant validation.

## Format de rapport d'auto-correction

```markdown
# Revue de performance analytique - YYYY-MM-DD

## Données examinées
- Nombre de zones historiques :
- Période couverte :
- Symboles / fournisseurs :
- Timeframes :
- Bougies nouvelles vérifiées :

## Résultats observés
- Zones respectées :
- Zones touchées :
- Zones invalidées :
- Zones non évaluables :

## Erreurs dominantes
| Erreur | Occurrences | Timeframes | Correction |
|---|---:|---|---|

## Règles de prévention ajoutées
1.
2.
3.

## Candidats actuels après correction
| Statut | Timeframe | Sens | Zone | Preuves | Motif |
|---|---|---|---|---|---|

## Verdict
Aucune zone non prouvée ne doit être annoncée ou dessinée.
```

## Critère de sortie

La boucle est terminée uniquement lorsque :

- l'historique a été consulté ou son indisponibilité est signalée;
- les anciennes zones ont été confrontées aux nouvelles bougies;
- les candidats actuels ont été ré-audités;
- les erreurs et correctifs sont journalisés;
- seules les zones entièrement validées sont annoncées;
- en l'absence de zone conforme, la réponse exacte est : **Aucune opportunité valide pour le moment.**

Ajouter systématiquement : `Analyse informative uniquement, pas un conseil financier personnalisé.`
