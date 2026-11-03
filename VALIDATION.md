# Initial implementation validation

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
