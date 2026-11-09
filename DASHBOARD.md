# Performance dashboard

The dashboard now lives in `frontend/` and deploys independently on Vercel. The API stays on Render. Open the Vercel site's root URL after configuring its public API origin and the API's exact frontend-origin allowlist. See [frontend deployment settings](frontend/README.md).

Enter the API access token configured in Render. It stays in JavaScript memory for the current tab and is cleared on disconnect or page reload. It is never placed in a URL, cookie, local storage or session storage. The password field is cleared after submitting. Local development without an API access token accepts an empty field.

Vercel serves the public sign-in HTML, stylesheet and script. All research data comes from authenticated API requests to Render, with exact-origin CORS. The dashboard only performs GET requests; it cannot trigger imports, training or automation. This is single-operator API-token access, not a multi-user account system. The API no longer serves a dashboard route or frontend assets.

## What it shows

- Settled fixture/candidate counts, observed hit rate, Brier score, calibration gap, residual variance and hypothetical flat-stake ROI.
- Calibration bins: mean estimated probability versus observed outcomes, with candidate counts and an accessible data table.
- Monthly observed hit rate versus mean model probability.
- Diagnostics by market, league, odds, estimated-probability band, source agreement, injury-evidence availability and month.
- The daily live shortlist with available odds, last-six form, captured evidence, reasons and caveats.
- Recorded prediction-source track records, largest forecast errors and latest workflow status.

Performance filters cover live/historical/demo mode, league, market, model and preference-passing candidates. Reports use the existing latest-prediction/current-result policy; changing filters does not create forecasts or modify history.

The shortlist is always a live view, with the selected league and a minimum estimated probability of 65%. It is hidden in historical/demo mode. Market and model analysis filters do not alter the shortlist. By default, candidates must pass the existing price/preferences rules; enable **Include unpriced research** to inspect estimates without matching verified quotes.

Source performance is a separate all-time view over real fixtures and captured pre-kickoff recommendations. It intentionally does not use the analysis filters. Source opinions remain manual evidence; no website scraping or automated probability boost is added.

## Reading the results

Missing metrics appear as `—`, not zero. ROI stays unavailable without verified captured prices. Empty or failed panels explain their state, and refresh failures clear the previous filtered metrics instead of retaining stale numbers. A failed token check returns to the connection form and clears displayed data.

Multiple markets from one fixture are correlated. Candidate count is not independent match count. Calibration and segment comparisons are descriptive; the baseline is uncalibrated and no measured profitability is claimed. Displayed returns are hypothetical, not actual bets.

Times use Africa/Lagos. The dashboard refreshes on request or filter changes, with no background polling that continually wakes the free database.

## Verification

```powershell
npm run typecheck
npm run build --prefix frontend
npm run build
npm test
npm run smoke:production
```

Browser checks are opt-in and use the locally installed Microsoft Edge through `playwright-core`; no browser binary is downloaded:

```powershell
$env:FUTURO_BROWSER_TESTS = 'true'
node --import tsx --test test/dashboard.test.ts
```

Set `FUTURO_BROWSER_CHANNEL` to another installed Chromium channel if needed. Tests build and serve the frontend on a separate origin from a temporary API with synthetic fixtures, exercise CORS/authentication/filtering/error handling, verify source text cannot inject HTML, and check mobile overflow. Screenshots are saved under ignored `data/dashboard-preview/`.
