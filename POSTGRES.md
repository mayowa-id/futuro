# Neon schema setup

This stage connects to PostgreSQL and creates Futuro's tables. **Application reads and writes still use SQLite.** Creating the Neon tables does not copy local history or make Render's current prediction data persistent. Keep Render automation disabled until the asynchronous PostgreSQL repositories and model-file recovery are implemented.

## Deployment

Set `DATABASE_URL` in Render Environment to the pooled PostgreSQL URL from Neon. Do not commit it. The connection uses verified TLS certificates and enables channel binding. Rotate credentials that were shared outside the environment settings.

On startup, a configured URL is now used to connect and apply pending migrations. Deployment fails if connection or migration fails; it cannot silently claim Neon was configured successfully. Look for:

```text
PostgreSQL schema ready: futuro, migration 1, 46 tables
Application storage is still SQLite; PostgreSQL schema setup does not migrate application reads or writes.
```

An ordinary startup without `DATABASE_URL` continues to use local SQLite. PostgreSQL connections are closed after setup/checks, so this stage does not hold an idle database connection or ping Neon on every public health probe.

## Tables and safeguards

Migration 1 creates **45 data tables** plus `schema_migrations` in a dedicated `futuro` schema. It ports SQLite schema versions 1–4, including fixtures and result revisions, evidence and quotes, predictions and candidates, settlements, feature lineage, model versions/artifacts, datasets, training/evaluation history, provider budgets, and automation state. See [SCHEMA.md](SCHEMA.md) for the relationships and evaluation metrics.

- Foreign keys retain links between the exact observations, prediction inputs and settled results.
- Checks enforce valid probabilities, scores, odds, JSON payloads and experiment modes.
- Database triggers prevent edits/deletes of historical records, reject late or wrong-fixture evidence, and reject settlements against another fixture's result.
- Training/workflow transitions preserve terminal records and original configuration.
- Six supported goal markets are seeded. Corners can be recorded as statistics, but no corner prediction market is claimed yet.

Payloads stay JSON text to preserve the existing serialized data and digests. PostgreSQL validates structured payloads by casting them to `jsonb` in checks. Identity columns replace SQLite's generated integer keys; compatibility JSON tables also have an explicit insertion sequence.

The migration and its metadata commit in one transaction. Concurrent deployments serialize using a transaction advisory lock compatible with a transaction pooler. Repeated deployments skip the recorded migration and verify its checksum. A changed/unknown migration causes setup to fail. Existing `public` tables are untouched; name conflicts inside `futuro` fail instead of replacing existing objects. There is no automatic destructive reset or rollback command.

## Verify the connection

Call the protected endpoint using the existing API bearer token:

```powershell
Invoke-RestMethod 'https://YOUR-SERVICE.onrender.com/database/status' -Headers @{
  Authorization = "Bearer $env:FUTURO_API_ACCESS_TOKEN"
}
```

Expected fields after migration:

```json
{
  "configured": true,
  "connected": true,
  "schema": "futuro",
  "version": 1,
  "expectedVersion": 1,
  "tableCount": 46,
  "migrationsCurrent": true,
  "applicationStorage": "sqlite-local"
}
```

This endpoint opens a fresh read-only connection, and returns 503 if it cannot check PostgreSQL. `/capabilities` continues to report `storage: "sqlite-local"` and `applicationStorageMigrated: false`. Public `/health/ready` checks the current application storage and Python scorer; it does not prove a fresh Neon connection.

In Neon's SQL editor, inspect:

```sql
SELECT version, name, applied_at FROM futuro.schema_migrations;
SELECT table_name FROM information_schema.tables
WHERE table_schema = 'futuro' ORDER BY table_name;
```

## CLI and tests

With `DATABASE_URL` set in the terminal environment or ignored local `.env`:

```powershell
npm run build
npm run db:migrate
npm run db:status
```

Both commands are also included in the compiled Docker image (`node dist/postgres/cli.js migrate` or `status`). Status does not create tables. Driver errors are summarized without logging connection strings or database contents.

The normal suite does not use `DATABASE_URL` to reach a real database. To run the PostgreSQL integration test explicitly, set `FUTURO_TEST_DATABASE_URL` in your terminal and run:

```powershell
node --import tsx --test test/postgres.test.ts
```

The integration test reserves a random `futuro_test_<hex>` namespace, tests concurrent migrations and a genuine fixture/prediction/settlement graph, verifies history/evidence/result constraints and reconnection, then drops only its own namespace. It never drops `futuro` or `public`. The test account needs permission to create a schema. An interruption can leave the isolated test schema behind for manual cleanup.

Next implementation: asynchronous PostgreSQL reads/writes and transaction handling across Store, research, training and automation; bulk fixture ingestion; recovery of model files from stored artifact JSON; explicit import of existing SQLite history. Schema setup alone does not provide those features.

Verified against the configured Neon database on 2026-11-07: the isolated integration test passed; migration 1 was then applied to `futuro`, and a separate connection reported 46 tables and current migration checksums. The temporary test schema was removed. Only the six market definitions were seeded in `futuro`; synthetic predictions/results stayed in the isolated test schema.

Driver references: [TLS and channel binding](https://node-postgres.com/features/ssl), [transactions on one client](https://node-postgres.com/features/transactions).
