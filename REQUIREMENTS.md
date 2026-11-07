# Futuro: prediction preferences and evaluation

This document records the owner's requirements as of 2026-11-03. These are starting selection heuristics to evaluate, not established predictive advantages.

## Technical direction

Data resources must be free: recurring data budget is $0. Use free APIs/open datasets and local processing; do not assume paid upgrades or card-required trials. See FREE_DATA_PLAN.md for the current source selection and known coverage limits.

The attached planning discussion proposes TypeScript/NestJS for ingestion and the API, PostgreSQL for storage, Redis/BullMQ for jobs, a small Python/FastAPI modeling service, and Next.js/TypeScript for the frontend. No application has been implemented yet.

## Trusted prediction sources

- Sportskeeda and Sports Mole.
- Use comparable football prediction sites for fixtures these sources do not cover. Keep the source list extensible and evaluate each site's coverage and historical performance before assigning it weight.
- External predictions are supporting evidence, not a mandatory gate. A pick may qualify without source corroboration when statistics, contextual factors, data quality, and validated model confidence are sufficient. Missing coverage is distinct from source disagreement; record both explicitly.
- Prefer each article's first/best prediction. Preserve its exact text, published time, match, source URL, and the market it actually recommends. An article's ordering or a predicted score must not silently be converted into a different recommended market.
- Track the sources individually and together; measure whether agreement improves outcomes.
- SportyBet is the preferred bookmaker. Store bookmaker-specific market labels, odds, timestamps, and settlement rules.

## Shared selection factors

- Recent form over the last five and six completed matches, with goals scored/conceded, wins/draws/losses, opponent strength, and home/away context.
- Injuries and availability of star/key players; record the player's role and information available at prediction time. Unknown availability must remain distinguishable from confirmed fitness.
- Relative team strength, league position, home advantage, and motivation to compete for a league, cup, or tournament.
- Explicit contextual/sentimental factors, such as title or relegation stakes and rivalry. Treat these as testable features, not automatic probability boosts.
- Stability/volatility and information quality should determine whether a match qualifies. The system may abstain.

## Preferred markets, in order

These three markets express preferences, not an exclusive selection list. Consider other markets when their own statistics and validated performance support a pick; do not force every fixture into one of these three options. Their stated odds ranges apply only to the corresponding markets.

### 1. Team to win

- Prefer clear mismatches: a strong team, often with four or five wins in its recent sample, against a weaker or bottom-table opponent.
- Preferred decimal odds: 1.20–1.50, with consideration up to 1.80.
- Stronger preference when the selected team is at home and has a clear competitive objective.
- Recent form, motivation, and home advantage require validation against historical outcomes.

### 2. Team to win OR total goals over 2.5

- Working interpretation: an inclusive OR market that wins if the selected team wins, or if the match has at least three goals, or both. Verify SportyBet's exact market and settlement rules before implementing settlement.
- Intended for a team expected to win where plausible draw/loss scenarios may still produce a high total.
- Examine both teams' scoring/conceding history, recent results, and match context.
- Model the joint score distribution: P(win OR over 2.5) = P(win) + P(over 2.5) - P(win AND over 2.5). These events are correlated; their probabilities must not simply be added or treated as independent.
- No preferred odds range has been specified for this market.

### 3. Total goals over 1.5

- Preferred decimal odds strictly greater than 1.18 and strictly less than 1.40.
- Additional screening preference: bookmaker-implied probability of over 2.5 exceeds 50%.
- Store both raw implied probability (1 / decimal odds) and a margin-adjusted estimate when both sides of the same totals market are available. Keep the exact interpretation of the screening rule configurable and visible.
- The beliefs that most games have at least two goals and that higher odds are suspicious are hypotheses to test by league and context, not hardcoded truths.

## Additional statistically supported markets

Research less-obvious markets with explicit evidence labels. Published market-structure findings, high event frequencies, and current profitable pricing are separate claims. See NICHE_MARKET_RESEARCH.md for the evidence-ranked shortlist and test protocol. Do not label a market profitable merely because it is uncommon or historically frequent.

- Include corner markets, such as match or team corner totals, where the required data and bookmaker markets are available.
- Use corner-specific evidence: corners won and conceded, home/away splits, opponent strength, recent and longer-term distributions, and relevant tactical context. A goal prediction alone does not establish a corner prediction.
- Other markets may qualify when supported by suitable historical data, explicit market definitions, a market-appropriate probability model, and chronological evaluation.
- Assess each market separately for probability calibration, uncertainty, odds/value, and settlement rules. High estimated hit probability alone does not establish good value at the offered odds.
- Show whether each pick has preferred-source support, alternative-source support, or no external corroboration. Compare these groups in performance reporting.

## Competition coverage

Primary: the top domestic leagues of England, Spain, Germany, Italy, and France.

Secondary: the top domestic leagues of Croatia, Belgium, Austria, Poland, Turkey, Egypt, Saudi Arabia, Scotland, Portugal, Uruguay, Sweden, Switzerland, and Norway.

Use stable provider competition IDs and season mappings. Cup/tournament motivation is relevant, but specific cup coverage has not yet been defined.

## Prediction history and feedback

- Save predictions before kickoff with their creation time, model/rule version, selected market/team, odds, estimated probability, confidence, feature values, source predictions, information freshness, and explanation.
- Keep immutable original predictions; later revisions are separate timestamped records.
- Record all eligible matches, rejected candidates, and abstentions with reasons to expose selection bias.
- Settle against verified final results and the bookmaker's actual rules, including postponements, voids, abandoned matches, and regulation time versus extra time.
- Track hit rate, sample size, calibration, Brier score, return on investment for clearly defined hypothetical stakes, and closing-line value when comparable closing odds exist.
- Break results down by market, league, odds band, home/away status, source, form window, key-player availability, and motivation/context flags.
- Evaluate changes on chronological held-out matches or walk-forward windows. Never use later lineups, results, revised articles, or future odds as if available at prediction time.
- Assess incremental feature value and uncertainty before changing weights. Keep backtest results separate from live forward predictions.
- Support ingestion and historical evaluation of thousands of matches daily when data coverage permits. The selected competitions will not necessarily produce thousands of live fixtures each day; distinguish fixtures from market candidates, historical replays, and updated snapshots.

## Implementation sequence

1. Define provider-backed fixtures, competition mappings, market semantics, and timestamped data contracts.
2. Ingest results, odds, recent form, and key-player availability; preserve raw source records.
3. Implement transparent baseline rules for the three preferred markets and a score-distribution model; extend to corners and other supported markets with suitable data and separate validation.
4. Save predictions, abstentions, and settlements; build performance reporting early.
5. Add source predictions and explicit contextual flags, measuring their incremental contribution.
6. Tune using chronological evaluation and show the reasons and uncertainty behind every pick.
