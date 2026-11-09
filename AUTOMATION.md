# Scheduled prediction and result tracking

The scheduler runs a durable workflow: refresh fixtures/results, create pre-kickoff forecasts, settle live predictions, and store a performance snapshot. It uses the free football-data.org integration and the configured SQLite or PostgreSQL database. Render can use the external GitHub schedule below; no paid scheduler or queue service is required.

## Enable it

Create a local `.env` from `.env.example` if needed, and configure the free account token:

```dotenv
FOOTBALL_DATA_TOKEN=YOUR_FREE_TOKEN
AUTOMATION_ENABLED=true
AUTOMATION_COMPETITIONS=PL,PD,BL1,SA,FL1
AUTOMATION_INTERVAL_HOURS=6
AUTOMATION_HORIZON_HOURS=24
AUTOMATION_MODEL_ID=
```

Run the existing services in separate terminals:

```powershell
python model/server.py
```

```powershell
npm run dev
```

Keep the API process/computer running. This is an in-process scheduler, not an installed Windows service or external hosting schedule. Automatic scheduling defaults to disabled unless `AUTOMATION_ENABLED=true` is set. Copying the example enables scheduling; a missing token produces a failed run with a clear credential error and no remote requests.

The default checks persisted work every minute and creates one cycle per six-hour UTC bucket: 00:00, 06:00, 12:00 and 18:00 UTC, equivalent to **01:00, 07:00, 13:00 and 19:00 Africa/Lagos**. Startup runs the current bucket immediately. It resumes due unfinished tasks and starts the current bucket after downtime; it does not replay every missed bucket or backdate predictions for games already started.

Available cadence is 6–24 hours. Changing environment settings requires restarting the API. Every run freezes its own configuration. The model setting is optional: blank keeps the baseline. A specified model ID must identify a completed, integrity-checked trained artifact; choosing it is an explicit action, not automatic promotion.

## Workflow behavior

1. Sync the configured leagues, sharing the provider response cache. Successful leagues continue even if another league fails.
2. Plan forecasts only for scheduled football-data.org fixtures with precise kickoff times in the next 24 hours. Date-only OpenFootball records and demo fixtures are excluded from automatic prospective forecasting.
3. Allow at least five minutes before kickoff when starting a scoring task. The persistence transaction checks the clock and current fixture again after scoring: forecasts that finish after kickoff or whose kickoff/status changed are rejected.
4. Save every eligible forecast or statistical abstention, including its original cutoff, features, model and missing-evidence warnings. The automatic identity is fixture + kickoff + selected model reference + policy version. It is saved atomically with the prediction, so restarts do not save duplicates. Manual forecasts remain separate.
5. Once sync/prediction tasks reach terminal states, settle completed **live-mode** predictions against current regulation results. Existing result-correction/revision handling is retained. Postponed/cancelled games without a completed supported result remain pending; no bookmaker-specific void rule is invented.
6. Store an immutable cumulative live analytics snapshot for that cycle. It includes per-market/per-league results, calibration, errors, variance, distinct fixture counts and missing prices. The report is cumulative as of that cycle, not a separate independent daily sample.

Repeated cycles reuse a saved automatic prediction even if its evidence later changes. They do not create six-hour forecast revisions for the same kickoff/policy. A new kickoff, explicit model selection, or `AUTOMATION_POLICY_VERSION` produces a different identity. A later refinement can introduce documented forecast stages without overwriting the first forecast.

No old predictions or settlements are replaced. Historical and synthetic experiments do not enter the live report. Stored injury/quote/source inputs remain manual; missing inputs are reflected in the existing forecast explanation. No odds means return/closing-line metrics remain unavailable.

## Limits and retries

- Current fixture/result responses cache for six hours; standings retain their twelve-hour cache.
- All uncached provider calls reserve their budget transactionally in the configured database, shared by manual endpoints, scheduler runs and retries. Local limits are eight requests/minute and 200/provider/UTC day. The daily cap is our own budget policy, not a claim about the provider's published daily allowance.
- A normal five-league, four-cycle day is approximately 20 fixture-list requests before retries/manual work. Results and upcoming fixtures come from the same league request.
- HTTP 429 and supported 503 `Retry-After` responses establish a persisted provider-wide cooldown. Other leagues/routes wait rather than sending more calls during that cooldown. A missing 429 header defaults to one minute.
- Successful football-data.org responses are also checked for remaining quota (`X-RequestsAvailable` or `X-Requests-Available-Minute`) and reset seconds (`X-RequestCounter-Reset`). A zero counter pauses further uncached calls until reset, before another request hits HTTP 429. Valid cached data remains usable. Invalid/missing quota headers retain the local safeguards; a zero counter without a usable reset gets a conservative one-minute pause. See the [official v4 header reference](https://docs.football-data.org/general/v4/lookup_tables.html).
- Network errors, 5xx and throttling retry at most three attempts, normally after 60 then 120 seconds. Provider `Retry-After` and local budget reset times take precedence when later. Scheduler polling can add up to a minute of delay.
- Missing tokens and known nonretryable HTTP failures stop after one attempt. Invalid data and exhausted retries remain visible in task/run history. Stale sync input cannot silently generate a forecast.
- Each tick processes at most 20 tasks by default, prioritizing sync and then earlier kickoff times. Pending work carries into later ticks.

The queue uses a 90-second database lease renewed every 15 seconds. Another process can resume after expiry. Lease fencing rejects stale worker completions; prediction identity links protect side effects if a process dies after a prediction commits but before task completion is recorded. Hard interruptions retain attempt counts. Lifecycle events and reports are append-only, and terminal tasks/runs cannot be rewritten.

## Inspect and trigger

| Route | Purpose |
| --- | --- |
| `GET /automation/status` | Enabled/configured state, current policy, next due work, latest run and quota policy |
| `POST /automation/run` | `{}` creates/reuses the current slot and immediately processes a due batch; returns 202 |
| `POST /automation/run` | `{ "force": true }` explicitly creates another manual cycle; all provider budgets still apply |
| `POST /automation/tick` | Creates/reuses the current slot, awaits one bounded batch, and returns its persisted run/status |
| `GET /shortlist` | Latest future live forecasts ranked by probability, one candidate per fixture; preference filters default on |
| `GET /automation/runs` | Latest 100 run summaries |
| `GET /automation/runs/:id` | Tasks, attempts, failures, events and the saved live report |

Manual triggering works when the recurring scheduler is disabled. To resume future retry work in that case, trigger again once due, or enable the scheduler. Reusing a completed/failed current slot does not modify its history; after fixing credentials use a forced manual cycle or wait for the next scheduled slot.

One-shot CLI:

```powershell
npm run automation:once
# Explicit fresh manual cycle:
npm run automation:once -- --force
```

The CLI drains currently due batches only; it does not sleep through future backoff periods. Exit codes: 0 completed, 1 failed/partial, 2 waiting/busy work. It prints the durable run record for inspection. Neither the CLI nor the API installs an OS schedule.

Run states: `running`, `waiting`, `completed`, `partial` (some failures with successful league sync), or `failed`. A stored analytics report can exist on a partial/failed cycle; it describes known predictions and does not mean all inputs refreshed successfully.

## Schema and verification

Schema version 4 adds `automation_runs`, `automation_tasks`, `automation_events`, `automation_locks`, `automation_prediction_links`, `automation_reports`, and shared `provider_cooldowns`. A populated database is backed up consistently before migration. Operational queue/lease/cooldown state can change; forecast links, events, completed work and reports are protected.

The test suite exercises prospective forecast -> repeated cycle -> completed result -> analytics, provider retry delays across coordinator replacement, post-commit crash recovery, expired-worker fencing, kickoff rejection, deadline skips, isolated league failures, shared quotas/cooldowns, application startup/shutdown and the HTTP trigger/status routes. All remote responses/clocks are controlled; those tests do not claim authenticated current coverage from a real account.

Live data still requires the free token. The existing historical database and local model can be used without one, but cannot substitute for a current fixture/result feed.

## Hosted schedule on Render Free

Deploy PostgreSQL application storage first. Confirm authenticated `/capabilities` reports `storage: "postgresql"`, then keep `AUTOMATION_ENABLED=false` in Render: the external job drives persisted batches rather than relying on an always-running process.

The repository includes `.github/workflows/daily-predictions.yml`. Configure GitHub repository settings under **Secrets and variables → Actions**:

| Setting | Kind | Value |
| --- | --- | --- |
| `FUTURO_API_URL` | Variable | Your HTTPS Render API origin, without a path |
| `FUTURO_AUTOMATION_ENABLED` | Variable | `true` after deployment and credentials are ready |
| `FUTURO_API_ACCESS_TOKEN` | Secret | The same API access token configured in Render |

Keep `FOOTBALL_DATA_TOKEN` and `DATABASE_URL` in Render. The workflow does not need either value. It runs at 00:17, 06:17, 12:17 and 18:17 UTC, or **01:17, 07:17, 13:17 and 19:17 Africa/Lagos**, and supports manual dispatch. It is inactive until the opt-in variable is set.

The runner verifies PostgreSQL storage and provider configuration, tolerates a Render cold start, and calls `/automation/tick` until the current slot finishes. Requests are authenticated and redirects are refused. Workflows do not overlap. Partial/failed runs and a 12-minute retry deadline return a failing job; pending tasks remain in Neon for a later tick. It never forces a fresh slot or bypasses provider cooldowns. Defaults allow up to 15 minutes per GitHub job; check your account's included Actions allowance for private repositories.

Scheduled workflows must be present on GitHub's default branch. Scheduling can be delayed; public repositories can have inactive schedules disabled after 60 days without activity. See [GitHub schedule behavior](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#schedule). This schedule cannot guarantee last-minute coverage before every kickoff.

The same runner can be called from another free scheduler using `FUTURO_API_URL`, `FUTURO_API_ACCESS_TOKEN`, and `npm run automation:hosted`. A single authenticated `POST /automation/tick` also resumes a batch manually.

## Daily shortlist

`GET /shortlist?minProbability=0.65&limit=20&preferenceOnly=true` returns at most one candidate per fixture from its latest saved live forecast. Optional `competition=PL` restricts the league. Started, rescheduled, date-only and blocked fixtures are excluded; a newer rejected forecast cannot fall back to an older successful one. The response includes probabilities, available quotes, form, captured evidence, warnings, and exclusion counts.

The default requires the existing odds/preference filters, so an unpriced forecast will not appear. Use `preferenceOnly=false` to inspect unpriced research candidates. Probabilities remain uncalibrated estimates. Ranking a forecast does not establish a betting edge.
