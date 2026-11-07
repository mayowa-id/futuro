# Futuro

A local, free-data football prediction research API. It imports historical results, syncs current fixtures with an optional free account, calculates form and experimental goal probabilities, preserves predictions, and tracks results.

The current model is an **uncalibrated baseline**, not a proven profitable selection system. All scored candidates are labeled `research_only`; passing preference filters is not a confidence guarantee.

Neon schema setup is available: setting `DATABASE_URL` verifies the connection and creates the PostgreSQL tables at startup. **Application storage remains SQLite until the PostgreSQL read/write adapter is implemented.** See [POSTGRES.md](POSTGRES.md) for setup and the authenticated database status check.

## Run locally

Requires Node.js 22.13+ and Python 3.11+. SQLite is included in Node; no Python packages, database server, paid data plan, or paid AI API are required. Node 22 may print an experimental SQLite warning.

```powershell
npm install
Copy-Item .env.example .env
python model/server.py
```

In a second terminal in this directory:

```powershell
npm run dev
```

The API listens at `http://127.0.0.1:3000`; the Python scoring service listens at `http://127.0.0.1:8001`. Set `MODEL_PORT` for Python and the corresponding `MODEL_URL` in `.env` to change the scoring address. Localhost development can run without an access token. Production/public binding requires a separate `API_ACCESS_TOKEN`; protected routes then require `Authorization: Bearer YOUR_API_ACCESS_TOKEN`. See [Render deployment](RENDER_DEPLOYMENT.md) for the Docker setup and required secrets.

If Node/Python are not on Windows PATH, use their installed executable paths or add their installation directories to your terminal's PATH. Run commands from the repository root so aliases and `.env` resolve correctly.

## Keyless historical workflow

With the Python service running:

```powershell
npm run import:openfootball -- PL 2024-25
npm run backtest -- PL
```

This downloads a public-domain OpenFootball season, caches it for 24 hours, and persists normalized matches. The backtest produces retrospective probabilities using prior completed matches, records early-season abstentions, and settles the candidates. It uses no odds, so ROI and closing-line value are `null`.

If your Windows network allows PowerShell downloads but blocks Node's direct HTTPS connection, download the JSON through PowerShell and use the same validated importer:

```powershell
New-Item -ItemType Directory -Force data | Out-Null
Invoke-WebRequest 'https://raw.githubusercontent.com/openfootball/football.json/master/2024-25/en.1.json' -OutFile data/openfootball-2024-25-en.1.json -UseBasicParsing
npm run import:openfootball -- PL 2024-25 --file data/openfootball-2024-25-en.1.json
```

Supply the correct competition and season for the file. Local-file ingestion records its current capture time and does not claim an earlier historical observation time.

Competition codes: `PL` England, `PD` Spain, `BL1` Germany, `SA` Italy, `FL1` France, `PPL` Portugal. Available seasons depend on the source. Import completed seasons before your target season if you need more team history. OpenFootball local match times are deliberately ignored because their timezone is not explicit; date-only records cannot contribute same-day results.

To exercise the entire flow without external data:

```powershell
npm run demo
```

The demo creates synthetic fixtures in **data/demo.sqlite**, calls the real Python model, records a simulated result, and prints demo-only performance. It never writes the primary database. Demo fixtures, historical experiments, and live predictions are isolated by mode. Repeated runs append new predictions; reports use the latest prediction per fixture.

## Current fixtures with a free account

Create a free [football-data.org](https://www.football-data.org/client/register) account and put its token in your local `.env` as `FOOTBALL_DATA_TOKEN`. Restart the API after changing it. Do not commit or share that file.

```powershell
$base = 'http://127.0.0.1:3000'
Invoke-RestMethod "$base/sync/football-data" -Method Post -ContentType 'application/json' -Body '{"competition":"PL"}'
$fixtures = Invoke-RestMethod "$base/fixtures?competition=PL&status=scheduled"
$fixture = $fixtures | Where-Object { [datetime]$_.kickoff -gt [datetime]::UtcNow } | Select-Object -First 1
if ($fixture) {
  $body = @{ fixtureId = $fixture.id; mode = 'live' } | ConvertTo-Json
  Invoke-RestMethod "$base/predictions" -Method Post -ContentType 'application/json' -Body $body
}
```

Free provider scores/schedules are delayed. Manual sync remains available, and an optional local scheduler now syncs results/fixtures, generates pre-kickoff forecasts and settles them every six hours. See [AUTOMATION.md](AUTOMATION.md) to enable it and inspect run history. Current matches cache for six hours, tables for twelve. Shared free-provider limits, cooldowns and bounded retries apply; no paid fallback is used. History entitlement is not assumed.

Team identities use exact normalized names and explicit aliases in **config/team-aliases.json**. Audit source names when combining providers; add aliases only for verified equivalents. The same home/away teams within a league season map to one fixture, keeping postponements stable. This identity scheme is intended for the supported home-and-away domestic leagues, not arbitrary cup formats. Football-data records take precedence over OpenFootball fallbacks for matching fixtures.

## Manual evidence

Quotes, injuries, context, and source predictions are append-only evidence records. The API assigns their capture time; a historical publication date does not make a newly entered quote available to an earlier prediction. Only evidence captured and published before the cutoff can be used.

Example SportyBet quote, after checking the actual market's regulation-time settlement rules:

```powershell
$quote = @{
  kind = 'quote'
  fixtureId = $fixture.id
  publishedAt = [datetime]::UtcNow.ToString('o')
  payload = @{
    bookmaker = 'SportyBet'
    market = 'over_1_5'
    odds = 1.25
    period = 'regulation'
    rulesVerified = $true
    rulesReference = 'Record the actual rules URL or checked rule text here'
  }
} | ConvertTo-Json -Depth 4
Invoke-RestMethod "$base/evidence" -Method Post -ContentType 'application/json' -Body $quote
```

Supported markets: `home_win`, `away_win`, `over_1_5`, `over_2_5`, `home_win_or_over_2_5`, `away_win_or_over_2_5`. The combination is inclusive OR. Confirm the bookmaker offers that exact event before attaching its odds. Quotes expire from candidate matching after 24 hours. For over 1.5, the preference filter requires odds strictly between 1.18 and 1.40 plus a captured same-bookmaker over-2.5 quote with raw implied probability >50%. Margin-adjusted probabilities are not implemented.

Other evidence payloads:

```json
{"kind":"injury","fixtureId":"ID","publishedAt":"2026-11-03T12:00:00Z","payload":{"player":"Player name","team":"Team name","status":"out","keyPlayer":true,"url":"https://example.com/dated-club-report"}}
```

```json
{"kind":"source","fixtureId":"ID","publishedAt":"2026-11-03T12:00:00Z","payload":{"source":"Sports Mole","url":"https://example.com/original-preview","originalText":"Original first/best pick","market":"home_win"}}
```

```json
{"kind":"context","fixtureId":"ID","publishedAt":"2026-11-03T12:00:00Z","payload":{"note":"Title-race context with supporting evidence","url":"https://example.com/report"}}
```

External sources are optional. In this baseline, injuries/context/source opinions are visible evidence and do **not** apply arbitrary probability boosts. Corner recommendations remain unavailable until verified corner history and a separately validated model exist.

## API

The relational research schema, variance definitions, dataset/evaluation API and migration behavior are documented in [SCHEMA.md](SCHEMA.md). `GET /analytics` provides the expanded diagnostics; `GET /performance` retains the original summary for compatibility.

| Method | Route | Purpose |
| --- | --- | --- |
| GET | `/health`, `/capabilities` | Service status and explicit supported/missing capabilities |
| POST | `/imports/openfootball` | `{ "competition": "PL", "season": "2024-25" }` |
| POST | `/sync/football-data` | `{ "competition": "PL" }` |
| GET | `/standings/PL` | Cached provider tables; not currently a fitted model feature |
| GET | `/fixtures?competition=PL&status=scheduled` | Stored fixtures |
| GET | `/fixtures/:id` | Fixture and captured evidence |
| POST | `/evidence` | Append manually verified information |
| POST | `/predictions` | `{ "fixtureId": "ID", "mode": "live" }`; optional ISO cutoff |
| GET | `/predictions?mode=historical` | Immutable predictions and abstentions |
| POST | `/settlements/run` | Settle completed results; repeated runs do not duplicate identical settlements |
| GET | `/settlements?mode=live` | Settlement revisions |
| GET | `/performance?mode=live` | Counts, hit rate, Brier score, calibration bins, per-market metrics |

The default mode for reporting is `live`. A corrected result appends settlement revisions; only the latest result-matching revision contributes to reports. Cancelled, postponed, abandoned, or missing regulation results stay pending; bookmaker-specific void rules require future implementation. Flat-stake hypothetical ROI requires a captured quote with manually verified rules. Reports cover research candidates, not actual bets or an independent six-game sample for six markets on one fixture.

## Model and verification

The Python service builds a joint score distribution from independent Poisson goal counts. Rates combine recent-six scoring/conceding with home/away venue attacks and defences at fixed equal weights, with five-match-equivalent shrinkage to prior league means. Features include last-five and last-six form, ten recent venue fixtures, and a 400-day league history. At least 20 league results and five results per team are required to score. Weights are not tuned; injuries, standings and context are not fitted adjustments yet.

Live features use captured fixture revisions available by cutoff. Historical experiments reconstruct prior form from the current stored result history, using a conservative next-day bound for date-only results and four-hour bound for timed matches. These are reconstruction assumptions, not proof of historical information availability. The local trainer fits bounded goal-rate corrections and selects weights on validation data; robust calibration studies and confidence intervals remain future work. See [TRAINING.md](TRAINING.md) for commands and the held-out protocol.

```powershell
npm run build
npm run typecheck
npm test
python -m unittest discover -s model -p 'test_*.py' -v
```

Tests cover provider parsing, regulation-time scores, idempotency, cutoff leakage, result corrections, OR semantics, strict odds preferences, abstentions, API validation, and Python probability identities.

## Current scope and next steps

Implemented: local NestJS API, standard-library Python scoring service, SQLite persistence/revision schema, two free-data adapters, manual evidence, historical replay, analytical settlement, and performance reporting.

The research schema includes normalized football/results/statistics records, exact new feature-input lineage, model artifact/configuration registration, calibration and variance diagnostics, frozen chronological datasets, and immutable evaluation comparisons. Schema version 3 adds a working asynchronous trainer, immutable artifacts, frozen training examples and experiment lifecycle reports. Completed match corner/shot/xG observations can be recorded manually; they are not automatically used by the goal model.

Schema version 4 adds persistent scheduled workflow tasks, retry/cooldown state, atomic automatic-prediction deduplication, saved live analytics reports, and save-time kickoff checks. Set the free token and `AUTOMATION_ENABLED=true`, then keep the local services running. No API token is included in the repository.

Docker packaging now starts the compiled API and private Python scorer together, with readiness checks and bearer-token access control. Render Free remains a disposable preview; persistent cloud storage and reliable hosted scheduling remain separate work.

Deferred: frontend, PostgreSQL adapter, Redis/BullMQ workers, automated article/injury/odds ingestion, richer trained features and probability calibration, corner models, secondary-league adapters, bookmaker-specific void handling, and multi-user authentication/roles. SQLite and Python's standard HTTP server keep this local milestone dependency-light; the documented PostgreSQL/FastAPI/queue direction can be introduced as usage requires it.

Less-obvious market hypotheses and published evidence are tracked in [NICHE_MARKET_RESEARCH.md](NICHE_MARKET_RESEARCH.md). They are not silently enabled as proven profitable selections.

See [free data plan](FREE_DATA_PLAN.md), [requirements](REQUIREMENTS.md), and [implementation plan](IMPLEMENTATION_PLAN.md). No paid services are required by the current implementation.
