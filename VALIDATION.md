# Initial implementation validation

## Training pipeline validation (2026-11-06)

- 17 TypeScript tests and 7 Python tests passed; TypeScript type check passed.
- The integration test invokes the real Python worker, freezes inputs, verifies fitting receives no test labels, persists/reloads the artifact, compares 20 held-out fixtures, and rejects tampered files and terminal-job edits.
- Failure tests retain worker errors and release the local job lock; changed frozen results are rejected before fitting.
- Real local run `c06611fa-ed6c-469d-90ee-8d62319b2feb` completed on the imported Premier League season, with 179 eligible training, 75 validation and 76 test fixtures. The chosen artifact was written before test scoring; 456 matched test candidates were settled for each model.
- Baseline test Brier: 0.2167052183. Challenger: 0.2170965562 (slightly worse). The challenger was retained as a research artifact with no automatic promotion. No price/profit claim is made.
- Migration to schema version 3 backs up a populated database before adding training artifacts/examples/reports and lifecycle integrity rules.

## Schema version 2 validation

- 14 TypeScript tests and 4 Python tests passed after adding research storage and diagnostics.
- The migration was applied to the existing local database with an automatic SQLite backup: 380 fixtures/result observations, 760 team-goal observations, 380 preserved prediction runs, 1,980 candidates and 1,980 settlements.
- `PRAGMA foreign_key_check` reported no violations.
- New tests cover known variance/calibration formulas, preserved v1 JSON records and backup, exact new feature lineage, immutable evaluations after score corrections, matched model comparisons, chronological split validation, sourced match statistics, and individual prediction-source accuracy.
- Existing feature-input lineage remains unknown (zero backfilled links), as expected: the initial predictions did not capture revision IDs. New snapshots populate these links.
- New model responses include an artifact hash and configuration; historical models remain flagged as legacy/unverified. An automated trainer is not part of this validation.

Validated 2026-11-03 on Windows with Node 22.13.1 and Python 3.13.5.

- TypeScript check: passed (`npm run build`, currently `tsc --noEmit`).
- TypeScript tests: 8 passed, including local NestJS HTTP validation.
- Python probability/model tests: 4 passed.
- Real Python HTTP scoring plus local SQLite prediction/settlement demo: passed; synthetic data is in the separate ignored demo database.
- Real-data importer: 380 fixtures imported from OpenFootball's 2024-25 English Premier League JSON, using the local-file transport.
- Chronological reconstructed replay: 380 predictions/abstentions persisted; 50 abstentions from insufficient prior history; 330 fixtures scored across 6 markets, yielding 1,980 analytical event settlements. No quotes were supplied, so ROI and closing-line value remain null.

This validates the working data flow, not a betting edge. Each scored match generates several correlated market probabilities. Event hit rates across all candidates are not the success rate of selected bets. The baseline has not been tuned or independently calibrated.

## Environment observations

Node's direct OpenFootball HTTPS request failed here. PowerShell downloaded the same public-domain JSON successfully; the CLI's `--file` option imported it through the normal validation/normalization path. The README includes this fallback. The downloaded file and local databases are ignored by Git.

Some Node commands required execution outside the filesystem sandbox because Windows blocked path resolution at the user directory. Dependency installation required network permission. These are execution-environment restrictions, not paid services.

No football-data.org token was available/configured for this validation. Its adapter's response parsing is tested, but authenticated current-data sync, live entitlement, and standings responses have not been verified against an account. Injury, source, and quote inputs remain manual; corners and scheduled workers remain unavailable.

Reproduce with the README instructions and a running local Python model. Running the demo/replay again appends new prediction records; reporting selects the latest prediction per fixture. Original prediction records are preserved.
