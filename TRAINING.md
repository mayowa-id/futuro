# Local training and held-out comparison

The pipeline fits a Poisson goal-rate challenger, selects parameters using validation data only, saves an immutable artifact, and compares it with the unchanged baseline on later test matches. It uses local Python/SQLite and requires no paid service, API key, scoring HTTP server, or Python packages.

## Run it

Requires Node 22.13+ and Python 3.11+.

```powershell
# Only needed if python is not on PATH; set your actual installed executable.
$env:PYTHON_EXECUTABLE = 'C:\path\to\python.exe'
npm run train -- PL
```

This uses completed imported Premier League fixtures, groups whole UTC dates into approximate chronological 60%/20%/20% splits, freezes a dataset, and prints the resulting job report. Existing data must contain enough history. No source is fetched by the trainer.

Reuse an existing frozen dataset:

```powershell
npm run train -- --dataset DATASET_ID
```

The CLI waits for completion and exits nonzero on failure. Set `DATABASE_PATH` and `ARTIFACT_DIRECTORY` through `.env` or environment settings to change local storage. The default artifact directory is ignored `data/artifacts/`.

## Training protocol

1. Verify every dataset member still points to its frozen result revision. Reject changed results before fitting.
2. Build and persist each member's pre-kickoff feature snapshot and exact input revision references. Keep blocked examples and reasons, including warmup history shortages.
3. Require at least 40 eligible training, 20 validation and 20 test fixtures. These are engineering minimums, not statistical guarantees.
4. For each of nine configurations, fit separate home/away multiplicative goal-rate corrections from training outcomes. Corrections are bounded to 0.5–2.0; final goal rates remain bounded to 0.15–6.
5. Search shrinkage strengths 2, 5, 10 and recent-six weights 0.25, 0.5, 0.75. Select the smallest validation mean Brier score across the six existing goal events. Training goal negative log likelihood and all validation trials are retained.
6. Write the chosen artifact before test scoring. The fitting worker receives only training and validation examples; its contract rejects a supplied test-data field.
7. Score identical eligible test snapshots with the baseline and challenger. Persist both forecasts, settlements and frozen evaluation records, then compute a matched comparison.
8. Keep the baseline as the default. No automatic promotion or test-driven retuning occurs.

The model parameters are fixed before the test. Test **features** use a retrospective rolling one-match-ahead protocol: completed earlier test matches can contribute form for later test matches, while the current target outcome is excluded. This differs from predicting an entire future season at once. Captured historical information is not reconstructed for missing injuries/news/odds.

Every market for a fixture stays in the same split. The six markets are correlated; 456 candidates from 76 fixtures are not 456 independent matches. The search objective is fixed to the existing six events; the niche-market shortlist does not change it after outcomes are inspected.

## Artifacts and provenance

An artifact records fitted parameters, dataset/run IDs, dataset fingerprint, training/validation completion bounds, scoring and trainer code hashes, feature version, and the uncalibrated status. Its exact JSON bytes are hashed and stored both in the database and a file written with exclusive creation.

Loading a completed model verifies the file/database digest. Python verifies the digest again and requires the scoring/trainer code versions used for fitting. Historical inference before the validation-selection period is rejected. Demo-trained artifacts cannot score real fixtures, or vice versa.

Changing scoring code requires a new compatible artifact/run; do not hand-edit an old artifact. A model's label alone is not its identity. Models remain uncalibrated estimates after this bounded parameter search.

Schema version 3 adds immutable `training_examples`, `model_artifacts`, `training_reports`, `training_evaluations`, and `training_events`. `training_runs` permits only running -> completed/failed transitions, keeps failures, and permits one active job per database. An automatic consistent backup is created before migrating a populated local database.

## API

With the NestJS API running:

| Method/route | Behavior |
| --- | --- |
| `POST /training` | `{ "datasetId": "ID", "name": "Experiment name" }`; returns 202 with a job ID |
| `GET /training` | List jobs and lifecycle status |
| `GET /training/:id` | Configuration, frozen counts, all validation trials, artifact metadata, events and held-out comparison |
| `POST /training/:id/recover` | Mark a stale job failed only when it is not locally active and its owner process is gone (or an orphan belongs to the current process) |
| `GET /models` | Registered model IDs/configuration; use job status to distinguish completed trained artifacts |
| `POST /predictions` | Optional `modelId` selects an explicitly completed trained artifact; omit it to use the baseline |

Example explicit model use:

```json
{"fixtureId":"FUTURE_FIXTURE_ID","mode":"live","modelId":"COMPLETED_MODEL_ID"}
```

Training runs in a child process with a 120-second runtime limit and a bounded output buffer. The API remains available while fitting. Input preparation and persistence use local synchronous SQLite; this is a single-user local worker, not a distributed queue. Graceful application shutdown waits for active jobs. After a hard process exit, inspect/recover the stale run before starting another; old partial observations/artifacts remain auditable.

## Reading the result

`rightMinusLeftBrier` compares trained minus baseline on matched test candidates: negative favors the trained model on that sample. This is not a significance test or a profit measure. ROI stays unavailable without verified captured odds.

Every repetition against the same dataset is recorded; the configuration exposes previous completed runs with the same dataset fingerprint. Reusing a reviewed test period does not create another untouched test. New rule/feature discovery, including niche markets, needs validation and a later untouched/forward period.

Initial real-data run on 2026-11-06 used the imported 2024/25 Premier League season: 179 eligible training fixtures, 75 validation and 76 test, with 50 warmup abstentions. The selected challenger improved validation Brier from 0.208961 to 0.208128, but test Brier was slightly worse: 0.217097 versus baseline 0.216705. It was saved for research and was not automatically promoted. This is an operational validation of the pipeline, not demonstrated model improvement.

Future work: richer trained features, proper probability calibration, multiple seasons/leagues, rolling folds, fixture/time-block uncertainty estimates, controlled model promotion and separate corner/payout models. See [niche research](NICHE_MARKET_RESEARCH.md) for the evidence and data requirements before extending markets.
