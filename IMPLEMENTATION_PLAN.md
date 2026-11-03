# Futuro implementation approach

Status: design ready for an initial implementation; live coverage and model performance are unverified. Data budget is $0. See REQUIREMENTS.md and FREE_DATA_PLAN.md; the latter supersedes the paid recommendations in DATA_PROVIDER_REVIEW.md.

Implementation update: the initial local backend now uses NestJS, embedded SQLite, and a dependency-free Python HTTP scoring service. This keeps the first version runnable without PostgreSQL/Redis or Python package installation. PostgreSQL, FastAPI, queue workers, and the frontend remain later milestones. README.md documents the implemented endpoints, manual workflows, testing, and limitations; live data coverage/model calibration are still unverified.

## First vertical slice

Build a local NestJS API/worker, PostgreSQL database, and small Python model service. Use Redis/BullMQ for scheduled ingestion and settlement. Start with OpenFootball historical JSON and football-data.org free current fixtures behind adapters, plus a fixture-file adapter for offline development. Support manual odds and availability entry. Add the Next.js board after the ingestion-to-settlement API works; frontend scope is not part of this provider review.

End-to-end acceptance: import provider records, normalize one fixture, compute as-of form, produce a versioned goal-market probability, attach a matching timestamped quote when available, save its explanation, settle from the final result, and retrieve performance statistics. A deterministic offline sample proves the plumbing; it must be clearly labeled and excluded from live performance.

## Core storage and contracts

| Entity | Essential contents |
| --- | --- |
| Competitions, seasons, teams, players | Internal IDs, names, provider-ID mappings |
| Fixtures and result revisions | Teams, competition/season, kickoff UTC, status, regulation-time result, source/capture timestamps |
| Raw observations | Provider, endpoint, sanitized request metadata, captured time, source time if supplied, payload/hash; no API keys |
| Team-match statistics | Fixture/team, goals, corners, other available statistics, provenance and revision |
| Availability observations | Player/team, injury/suspension status, effective dates, published/observed timestamps, uncertainty |
| Context observations | Motivation/rivalry flags, author/source, available-at time, rationale |
| Source recommendations | Article URL, source, original recommendation, normalized market, source/capture times, revision, parsing confidence |
| Market definitions and quotes | Bookmaker, period, statistic, line, team/selection, OR semantics if applicable, settlement-rule version; decimal odds and observed/source time |
| Feature snapshots and model runs | Prediction cutoff, input references, feature/model/config versions, probability, uncertainty and missing-data flags |
| Predictions and abstentions | Exact candidate, quote reference if priced, explanation, corroboration status, eligibility/rejection reasons |
| Settlements | Prediction, result revision, rule version, win/loss/push/void/pending, hypothetical stake and return when applicable |

All model inputs must be available by the prediction cutoff. Store event time separately from observation time. Historical result-based features may be reconstructed when their availability is established; unavailable historical injury/news snapshots must remain absent. Keep later corrections auditable.

Adapter operations: discover capabilities, fetch competitions/seasons, fetch fixtures/results, fetch fixture statistics, fetch availability, list markets/bookmakers, fetch quotes. Each returns provenance, pagination/rate-limit metadata, and explicit supported/unsupported/unknown capability states. Persist before normalization and make jobs idempotent using provider IDs plus observation identity.

## Processing and API boundaries

1. Scheduled ingestion -> raw records -> normalized entities and observations.
2. Feature job -> fixture-specific snapshot using only completed prior matches and available evidence.
3. Python scoring -> probabilities from a fitted baseline goal distribution, followed by chronological calibration evaluation. Start with transparent form features; assess home advantage, injuries, and context before introducing arbitrary probability adjustments.
4. Candidate evaluation -> market eligibility, matching quote, preference filters, uncertainty, and explanation. Site support is optional and tracked separately. Unpriced probabilities remain distinguishable from priced recommendations.
5. Result ingestion -> rule-based settlement -> versioned evaluation metrics.

Initial API resources: fixtures; fixture evidence; predictions; abstentions; settlements; performance; provider capability/status reports. Model scoring accepts a versioned feature snapshot and returns market probabilities and diagnostics, without fetching its own hidden data.

## Market rollout

First implement regulation-time team wins, over 1.5, and the probability of team-win OR over 2.5. Only price/settle the combination as a bookmaker product once its exact rules are verified. Goal-model probabilities must account for the overlap of win and over events.

Introduce corner totals with a separately fitted count model, corner-specific features, and held-out evaluation once coverage passes. Keep other markets extensible through explicit definitions and independent validation. Preferences influence ranking but never imply that every match needs a pick.

## Evaluation and release checks

- Use rolling chronological training/validation/test windows, with matches grouped by fixture so markets from the same match cannot leak across splits.
- Compare against simple league/home-away baselines and margin-adjusted bookmaker probabilities where comparable quotes exist.
- Report sample counts, calibration, Brier score, hit rate, hypothetical flat-stake ROI, and matching-market closing-line value. Mark unavailable metrics explicitly.
- Separate reconstructed historical experiments, offline samples, and prospective predictions. Do not report profit without actual historical prices.
- Test score-to-market logic, OR overlap, cutoff enforcement, duplicate ingestion, postponed fixtures, missing corner/injury data, pushes/voids, and corrected results. Contract-check real sanitized provider responses after credentials are configured.
- Show model probabilities as unvalidated estimates until chronological results support calibration claims. Do not automatically retrain or change production weights after individual results.

## Ordered milestones

1. Coverage probe and sanitized response samples; publish capability report.
2. Database migrations, provider adapter, local services, and idempotent fixture/result/statistics ingestion.
3. Feature snapshots, baseline scoring, prediction persistence, and exact-market quote matching.
4. Settlement, historical evaluation, and prospective tracking.
5. Board and match explanations; source recommendations and contextual features.
6. Corners and secondary leagues as their data and model checks pass.

Steps 1 and 2 can overlap through keyless OpenFootball data and offline fixtures. Free account credentials enable current-data integrations. Missing coverage must reduce capability rather than trigger a paid dependency.
