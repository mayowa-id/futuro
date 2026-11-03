# Futuro data-provider review

SUPERSEDED: The user requires free resources only. FREE_DATA_PLAN.md is the active decision. The paid options and budgets below are retained as earlier research, not implementation recommendations or authorized spending.

Reviewed 2026-11-03 using public official documentation. Prices are advertised USD/EUR amounts, not converted to naira; checkout terms, tax, and coverage must be reconfirmed. No subscriptions or authenticated API calls were made. Published capabilities are not verified data quality.

## Recommended starting decision

Use API-Football as the provisional primary football-data adapter. Start with its free tier for a coverage probe; consider Pro only after the probe passes. Keep provider IDs behind internal IDs so another vendor can replace or supplement it.

Do not purchase a separate odds feed until the probe establishes missing markets or insufficient history. SportyBet-specific availability and the team-win OR over-2.5 market remain unverified. A different bookmaker's price must never be presented as SportyBet's price.

## Shortlist

| Provider | Published entry pricing and capacity | Fit for Futuro | Main qualification |
| --- | --- | --- | --- |
| API-Football | Free: 100 requests/day; Pro: $19/month, 7,500/day; Ultra: $29/month, 75,000/day | Primary candidate for fixtures, results, standings, injuries, lineups, statistics, and odds | Free seasons are restricted; verify each league-season and market |
| Sportmonks | Starter: from EUR29/month for 5 leagues; Growth: from EUR99/month for 30 leagues | Alternative for the first five leagues and later expansion; documented corner statistic types | Odds/Predictions bundle advertised from EUR15/month; xG and premium odds have separate offers. Confirm exact checkout configuration and historical entitlements |
| The Odds API | Free: 500 credits/month without historical odds; $30/month: 20,000 credits with historical odds | Supplemental timestamped odds candidate | Published soccer markets include corner totals and team corner totals; availability varies by event/bookmaker. SportyBet was absent from the public bookmaker list checked |
| football-data.org | Free tier and paid packages | Possible simpler fixtures/results fallback | Do not select as the sole source without proving our injuries, corners, and market requirements |

Sources: [API-Football pricing](https://www.api-football.com/pricing), [Sportmonks pricing](https://www.sportmonks.com/football-api/plans-pricing/), [Sportmonks statistic types](https://docs.sportmonks.com/v3/definitions/types/statistics), [The Odds API pricing](https://the-odds-api.com/), [markets](https://the-odds-api.com/sports-odds-data/betting-markets.html), [bookmakers](https://the-odds-api.com/sports-odds-data/bookmaker-apis.html), [football-data.org pricing](https://www.football-data.org/pricing).

## Critical data limitations

API-Football's guide describes fixture corner statistics and league-season coverage flags. Its pre-match odds are typically available 1–14 days before a fixture, update every three hours, and have only seven days of history. Archive permitted snapshots ourselves from the beginning; this feed alone does not establish a multi-season odds backtest. See the [official getting-started guide](https://www.api-football.com/news/post/how-to-get-started-with-api-football-the-complete-beginners-guide).

The Odds API documents historical snapshot access, with historical credit cost of 10 per market per region for the featured historical odds endpoint. Historical availability starts when that sport/bookmaker/market entered the service; advertised history is not proof of coverage for our exact selections. See [API documentation](https://the-odds-api.com/liveapi/guides/v4/index.html).

Injuries require their own audit: an injury record fetched today does not establish what was known at an earlier prediction time. The same distinction applies to standings, article revisions, and confirmed lineups.

Goal models may estimate the win-OR-over event even when no exact offered price exists. Such an estimate is an unpriced candidate; it cannot support an actionable odds/value recommendation or historical ROI calculation for that market.

## Prediction articles

Sportskeeda and Sports Mole remain preferred. Store normalized recommendations, URLs, source timestamps, capture times, and parsing confidence. Establish an available permitted feed or collection route before scheduling automated collection. Sports Mole publishes [terms](https://www.sportsmole.co.uk/about/information/terms-and-conditions_467.html); this review has not established automated reuse rights or a supported feed for either site.

Initially allow manual recommendation entry with attribution and timestamped revisions. Add alternative sources through the same interface after assessment. Missing articles must not block an otherwise qualified statistics-based prediction. Do not manufacture historical pre-kickoff articles from present-day captures.

## Coverage probe before purchase

Run on the top domestic leagues of England, Spain, Germany, Italy, and France. Resolve provider competition and season IDs from the API rather than guessing them.

1. Inspect league-season flags and subscription permissions for fixtures, standings, statistics, lineups, injuries, and odds. Record unsupported fields separately from empty responses.
2. Sample 20 completed fixtures per league across different dates and teams, plus available upcoming fixtures over the next seven days. Page and cache responses; spread the probe across days if needed to respect the free quota. If free season access prevents a representative trial, document that restriction rather than treating it as provider data failure.
3. Audit final scores, both teams' corners, timestamps, stable IDs, missing fields, duplicate fixtures, and corrections. Review injury records against a small manually checked sample of dated club reports.
4. Enumerate bookmakers and markets. Check exact 1X2, goal lines 1.5/2.5, win-OR-over-2.5, match corners, and team corners. Capture actual sample responses and settlement definitions. Record SportyBet as verified, absent, or unresolved.
5. Report coverage percentages with denominators, odds freshness, request consumption, and historical reach. Repeat prospective snapshots for seven days to assess operational reliability; this is not a claim of model accuracy.
6. Enable capabilities independently. Missing corner data disables corner recommendations for that scope; unverified combination markets stay unpriced. Use explicit missing-data rules for injury uncertainty.

Proposed engineering acceptance checks: 100% unambiguous fixture identity and score mapping in the sample; at least 95% availability of both-team corner counts before enabling corners for a league; no unresolved settlement mapping for any enabled market. These are trial criteria, not statistical confidence guarantees. Decide freshness limits from observed update cadence and intended prediction time.

## Working budget and request plan

- Coverage exploration: $0 using available free access, with limited history and volume.
- Provisional primary ingestion: $19/month API-Football Pro, subject to a successful probe.
- Optional primary plus supplemental odds: $49/month ($19 + $30), only if exact coverage and credit requirements justify it.
- Alternative: Sportmonks Starter from EUR29/month before optional add-ons. Compare with real responses rather than marketing breadth.

Hosting, storage, historical purchases, tax, and currency conversion are additional. No paid plan is selected or authorized for purchase by this document.

Illustrative primary-provider daily budget: 20 fixture-list calls + 5 standings calls + 200 statistics calls + 100 availability calls + 300 odds calls = 625 calls, or 750 with 20% retry/pagination allowance. This is a planning assumption, not measured demand; adapt to endpoint batch sizes and cache team history rather than refetching it per candidate.

For a supplemental feed, 5 leagues x 2 featured markets x 1 region x 4 polls/day x 30 days is approximately 1,200 credits under its featured-odds formula, before historical requests or event-specific alternate/corner markets. Budget those separately using the relevant endpoint's actual charging rules. A credit is not necessarily an HTTP request.

## Remaining external dependencies

- An API-Football account/key supplied through local secrets or deployment settings; never committed or pasted into tracked files.
- A budget decision only if the free probe cannot cover the needed seasons or a paid service is justified.
- Verified SportyBet price access and combination-market semantics. A timestamped manual quote import is a workable initial fallback.

Provider-neutral schema and ingestion development can proceed before those dependencies are resolved.
