# Futuro: free-only data plan

Decision date: 2026-11-03. Recurring data budget: $0. This replaces the paid-provider recommendation in DATA_PROVIDER_REVIEW.md. No paid upgrades, card-required trials, or automatic subscriptions are part of the implementation plan.

Research used the official pages below. Account entitlements, response completeness, and model accuracy have not been tested. Free access does not imply unrestricted reuse.

## Recommended combination

| Resource | Free offer checked | Role | Limitation |
| --- | --- | --- | --- |
| football-data.org | 12 competitions; 10 calls/minute; delayed scores/schedules | Primary current fixtures, results, and tables | Includes the top five European leagues and Portugal. Statistics and odds are paid add-ons, so exclude those endpoints |
| OpenFootball football.json | Public-domain/CC0 JSON, no key | Historical results for form and goal models; fixtures/results fallback | Not an injury, corner, or odds feed. Generated daily, but upstream updates are not guaranteed daily; verify completeness and freshness |
| The Odds API | 500 credits/month; no historical odds on free tier | Limited current bookmaker comparisons for shortlisted fixtures | Credits depend on markets/regions and endpoint. Exact corner lines and SportyBet coverage are not established |
| API-Football free | 100 requests/day; season-restricted access | Optional historical statistics/corner experiments and availability checks if entitled | Do not assume current-season access. Inspect actual accessible seasons before using it for current recommendations |
| TheSportsDB free | 30 requests/minute; restricted free endpoints | Optional team/league identity lookup and fixture fallback | Development use terms and endpoint restrictions apply. Not a verified comprehensive injury/corner/odds source |

Sources: [football-data.org pricing](https://www.football-data.org/pricing), [free competitions](https://www.football-data.org/coverage), [OpenFootball](https://github.com/openfootball/football.json), [The Odds API](https://the-odds-api.com/), [API-Football](https://www.api-football.com/pricing), [TheSportsDB documentation](https://api.thesportsdb.com/documentation), [TheSportsDB terms](https://api.thesportsdb.com/docs_terms_of_use.php).

Use football-data.org and OpenFootball as the first two adapters. The others are optional enrichments; they must not become hidden paid dependencies.

## Features available initially

- Team form over five/six matches, scoring and conceding rates, home/away performance, standings, goal-model probabilities, and prediction/result tracking.
- Manual timestamped SportyBet quote entry for exact markets, especially team-win OR over 2.5. Never substitute another bookmaker's quote without labeling it.
- Manual source-prediction entry from Sportskeeda, Sports Mole, or comparable sites; source support remains optional. Scheduled collection needs an established supported collection route.
- Manual dated key-player injury/suspension and motivation/context entries, preferably backed by club reports. Unknown availability remains unknown and visible in the explanation.
- Local processing and caching. Re-evaluate many historical fixtures locally without spending API credits per model evaluation.

## Features not yet covered automatically

No source combination reviewed establishes a complete free current feed for all requested leagues, injuries, corner statistics, and exact SportyBet market odds.

Keep corners in scope, but activate recommendations only for league-seasons with adequate verified corner history and available market quotes. Do not infer corner confidence from goal results. Until suitable data exists, accept user-provided data with known provenance, run limited historical experiments, or leave corner recommendations unavailable.

Historical price-free experiments can report prediction accuracy, but cannot establish ROI or closing-line value. Archive permitted odds snapshots prospectively to build our own evaluation history.

## Other free sources assessed

- [StatsBomb/Hudl Open Data](https://github.com/hudl/open-data): selected competitions with events and lineups, useful for analytics research. It is not a complete current top-five-league feed. Observe the repository license and attribution requirements; research availability does not establish unrestricted commercial betting-product use.
- [OpenLigaDB](https://openligadb.de/): potential community-maintained Bundesliga fallback, with database licensing conditions; optional until the first two adapters are audited.
- [Football-Data.co.uk](https://football-data.co.uk/data): rich free results, statistics, and odds files, but the current page restricts commercial and automated/AI data-training products. Exclude from automated ingestion/model training unless permission covering Futuro is established. This is a different service from football-data.org.
- [Footiqo](https://footiqo.com/database/): advertises free sample exports including corners; larger datasets are paid. Not selected as an unlimited free historical feed.

## Request budget and storage

For football-data.org, batch fixtures by date and tables by competition, cache responses, enforce fewer than 10 requests/minute, and honor provider errors/retry instructions. Start with daily sync plus deliberate refreshes around prediction time; avoid live polling because the free scores are delayed.

For The Odds API, an illustrative featured-odds budget is 5 leagues x 2 markets x 1 region x 1 daily snapshot x 30 days = 300 credits. Reserve the remaining 200 for retries or targeted checks. Verify actual credit headers and market availability; alternate goal/corner markets may need event-specific requests and separate budgeting. Stop at the local monthly ceiling. See [endpoint charging rules](https://the-odds-api.com/liveapi/guides/v4/index.html).

For API-Football, enforce at most 80 scheduled calls/day and reserve 20 for diagnostics/retries. Disable inaccessible current seasons without prompting an upgrade. Download reusable history once and cache it.

Store data locally with the planned open-source database/services initially. Cloud deployment is optional and must have a separately confirmed zero-cost setup. No paid LLM calls are required to score or explain baseline predictions.

## First implementation and validation

1. Add an OpenFootball importer for completed historical seasons in the top five leagues. Audit missing scores, duplicates, team aliases, and match dates. Treat date-only records conservatively: exclude same-day results from as-of features unless completion before the cutoff is established.
2. Add football-data.org current fixture/result/table ingestion using a free account key configured locally. Verify accessible history rather than assuming a multi-season allowance.
3. Fit and evaluate a goal baseline chronologically; save probabilities, eligibility decisions, explanations, and result settlements. Keep retrospective experiments separate from prospective predictions.
4. Add manual odds, injury/context, and external-prediction entry; allow documented revisions with timestamps.
5. Add the optional free odds adapter with quota accounting. Probe API-Football's free seasons for corner data before enabling any corner model.

Do not work around free limits through multiple accounts or use undocumented sportsbook/site endpoints as a required production dependency. Reduce scope and cache data when a free quota is exhausted.

## Access needed

OpenFootball enables keyless development immediately. A free football-data.org key enables the first current-data adapter. The Odds API and API-Football keys are optional later additions. Keep private keys in local environment settings, excluded from version control; never put them into documentation.
