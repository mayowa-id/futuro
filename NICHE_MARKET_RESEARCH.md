# Futuro: less-obvious markets worth investigating

Reviewed 2026-11-06. This is an evidence-ranked research shortlist, not a list of proven profitable bets. The review did not establish current SportyBet profitability or that these markets are globally unexplored. A high event frequency and a positive return at an available price are different claims.

## Findings supported by published research

### 1. Whole-goal Asian handicaps versus nearby half/quarter lines

Hegarty and Whelan document lower average losses for integer Asian handicaps with possible full refunds than for half-goal lines without refunds, including same-match comparisons. Their historical samples still show average losses; this supports refund-aware price comparison, not automatic profit. See the [authors' working paper](https://mpra.ub.uni-muenchen.de/117244/1/ComplexBets.pdf) and [CEPR abstract](https://cepr.org/publications/dp18153).

Futuro hypothesis: compare the *actual offered prices* for a selected team's Asian 0/draw-no-bet, +1.0, -1.0 and adjacent lines. A push changes the payout distribution and effective margin, so ordinary binary hit-rate calculations are insufficient.

Research priority: high for market-structure work. Exact handicap, period, odds, push and half-return settlement are prerequisites. Final-score history can settle the events; our free sources do not yet establish the historical prices needed to test an edge.

### 2. Corner totals with clustering and excess variance modeled explicitly

Yip and coauthors model clustered/overdispersed corner counts using compound Poisson methods and information from other markets. The study uses historical corner odds and match data; it is evidence for a modeling approach, not a universal current profitable corner line. See the [paper](https://arxiv.org/html/2112.13001v3).

Futuro hypothesis: investigate match corner totals first, then team/alternative lines as extensions. The latter are our proposed extensions, not findings established by that paper. Compare an ordinary Poisson baseline with an overdispersed model; inspect calibration in the tails instead of merely choosing the line with the highest historical hit rate.

Research priority: promising but data-blocked. We need both-team corner history, actual line-specific pre-match prices and independent chronological evaluation. Goal form alone is insufficient.

### 3. Use Asian-handicap prices as a benchmark for other markets

Hegarty and Whelan's 2025 forecasting paper finds favourite-longshot bias in traditional match-result prices and more efficient forecasting from Asian-handicap prices in its sample. This makes handicap-derived probabilities a useful benchmark; it also cautions against assuming the handicap market is easy to beat. See [Forecasting soccer matches with betting odds: A tale of two markets](https://www.sciencedirect.com/science/article/pii/S0169207024000670).

Futuro hypothesis: flag disagreement between the score model, margin-adjusted match-result prices, and handicap-implied strength. Investigate stale/inconsistent prices, rather than adopting a blanket rule to back every favourite. Efficient forecasting does not itself provide a profitable selection rule.

## Plausible candidates requiring our own evidence

The following are explicit hypotheses. No source reviewed establishes these exact combinations as currently profitable. They can be evaluated from final scores, but actual combination-market prices are still required for value/return assessment.

| Candidate | Exact event | Pre-match situation to investigate | Principal failure mode |
| --- | --- | --- | --- |
| Stronger side over 0.5 + opponent under 1.5 | Selected side scores at least once AND opponent scores at most once | Attacking strength with low opponent scoring projection | Selected side blanks, or opponent scores twice |
| Double chance + under 4.5 | Selected side wins/draws AND total goals <=4 | Competitive advantage without a projected high-scoring match | Unexpected loss or five-goal match |
| Team win + under 4.5 | Selected side wins AND total goals <=4 | Controlled-win hypothesis | Draws, upsets or a five-goal win |
| Opponent team total under 1.5 | Opponent scores 0 or 1 | Low opponent attack projection; selected side need not win | Two opponent goals |
| Alternative goal unders | Total goals below a specified half-goal line | Model predicts lower scoring than the available line's price implies | Market already prices the high hit rate cheaply |

“Stronger side” must be determined using pre-kickoff evidence, never the eventual winner. Its proxy and thresholds must be recorded in a versioned rule before testing. The model's stronger side is not necessarily the bookmaker favourite.

For combination events, sum probabilities over the *joint* score distribution. Do not multiply marginal probabilities as if independent, and do not synthesize a same-game price from separate odds. Bookmaker availability and exact settlement rules remain unverified.

## How a hypothesis earns a stronger label

1. Register its exact market, rule version, pre-match filters, intended leagues, metric and required data before outcome inspection.
2. Explore thresholds on training data; choose among hypotheses on validation data. Log every attempted rule, including failures, to expose multiple testing.
3. Freeze the rule/model before a new chronological test period. Do not repurpose the trainer's already-reviewed test results as untouched confirmation for new niche rules.
4. Save actual prices, publication/capture times, bookmaker and settlement rules before kickoff. No odds means event accuracy can be tested, but a pricing edge cannot.
5. Compare with simple unconditional/league baselines and margin-adjusted market probabilities where available. Report distinct fixtures, coverage, Brier/log loss, calibration and time/league stability.
6. For refund markets, report win/push/half-win/half-loss/loss frequencies and realized payout per unit. A refund is neither a winning bet nor a complete loss.
7. Evaluate return uncertainty by fixture/time blocks, accounting for correlated markets. Correct for testing many rules, and collect an additional forward sample. No fixed hit-rate threshold proves profit.

Evidence labels: `hypothesis` -> `outcome_validated` -> `price_tested` -> `forward_supported`, with sample/date/bookmaker attached to every claim. None of these candidates currently qualifies as a proven live Futuro edge.

## Implementation boundary

The current production/research scoring contract still covers six goal events. This shortlist does not silently add candidate markets or alter the trainer's validation objective after looking at outcomes.

Next market extension should introduce payout distributions and settlement for pushes/half returns before Asian handicaps enter recommendations. Binary combination markets can follow using the joint score distribution and a new registered market/model version. Corner models require their own data and validation. The existing schema can store corner observations now, but that is not a corner forecasting capability.

Practical starting order: (1) refund-aware handicap comparisons once quotes are collected, (2) opponent team total under 1.5 and stronger-side scoring combinations as score-model hypotheses, (3) double-chance/under combinations, (4) corner models after data coverage is established. This order reflects evidence and our data constraints, not an assertion that unpopular markets are inherently better value.
