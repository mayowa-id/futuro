# Tournament coverage

The scheduler now includes Champions League (`CL`), Europa League (`EL`), Conference League (`ECL`), Nations League (`UNL`), UEFA World Cup qualifying (`WCQ_EU`) and World Cup (`WC`), alongside the five major domestic leagues.

Optional competitions: European Championship (`EC`), FA Cup (`FAC`), EFL Cup (`EFL`), DFB-Pokal (`DFB`), Copa del Rey (`CDR`), Coppa Italia (`CI`) and Portugal's league (`PPL`). These are selectable in the dashboard; add their codes to the scheduler configuration to collect them automatically.

## Deployment

Existing Render environment values override new defaults. Set:

```text
AUTOMATION_COMPETITIONS=PL,PD,BL1,SA,FL1,CL,EL,ECL,UNL,WCQ_EU,WC
```

Redeploy the backend and frontend, then run the existing automation workflow. Synchronization finishes before predictions begin, so cross-competition form is available. No database migration is needed: tournament metadata is retained in existing fixture revisions and snapshots.

Authenticated API: `GET /competitions` lists supported competitions; `POST /sync/competition` accepts `{"competition":"EL"}` and imports its configured source. Existing football-data synchronization remains supported.

## Free sources and limits

Champions League, World Cup and European Championship use the authenticated football-data.org adapter. Check [free coverage](https://www.football-data.org/coverage) for your account's entitlement and current availability.

Europa League, Conference League, Nations League, UEFA qualifying and domestic cups use ESPN's public scoreboard feed. This is an undocumented public endpoint with no availability guarantee. There is no automatic paid fallback. The adapter caches current calendar-year responses for six hours and the previous year for seven days, with a shared request budget and throttling. It retains a football-only extract rather than commercial or player payloads. A response at the 1,000-event limit is rejected to avoid silently importing truncated data.

## Prediction and evaluation rules

- Tournament fixtures use provider event IDs, preserving identity across postponements and distinguishing repeat opponents and replays. Domestic league IDs remain unchanged.
- Stage, group, matchday, neutral venue and provider team IDs are retained when supplied. Unresolved future opponents are skipped until assigned.
- Club tournament form draws from available club competitions; national-team form draws only from competitive international competitions. Explicit team aliases link source names, and the alias policy is recorded in tournament features.
- Historical features respect observation time and kickoff cutoffs. Each team still needs five completed games; competition priors require twenty completed games. Missing history causes abstention.
- Known neutral venues abstain because the existing model assumes home advantage. Unknown venue metadata remains a source limitation.
- Markets settle on regulation time. Extra-time and penalty totals never substitute for a verified 90-minute score; missing regulation results remain unsettled.
- Tournament forecasts use a separate research model version and feature context. The current trained league model cannot score tournament features, and tournament datasets cannot enter league training.

Cross-league strength, national-team strength, rotation, lower-division opponents and two-leg aggregate incentives are not calibrated yet. Tournament candidates therefore remain experimental; use tracked outcomes to evaluate them separately before increasing confidence.
