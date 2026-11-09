# Neon PostgreSQL storage

Set `DATABASE_URL` in Render Environment to use Neon for application reads and writes. With the variable blank, local development uses `DATABASE_PATH` (SQLite). A configured PostgreSQL connection or migration failure stops startup; there is no silent SQLite fallback.

## Deployment and verification

The API connects over verified TLS with channel binding enabled. Keep the connection URL in Render's environment settings or an ignored local `.env`; never commit it. No additional paid service is needed.

After deploying this code, startup logs `Futuro storage: postgresql`. Authenticated `GET /capabilities` must report `storage: "postgresql"` and `postgresSchema.applicationStorageMigrated: true`. Authenticated `GET /database/status` opens a fresh read-only connection and returns:

```json
{
  "configured": true,
  "connected": true,
  "schema": "futuro",
  "version": 3,
  "expectedVersion": 3,
  "tableCount": 46,
  "migrationsCurrent": true,
  "applicationStorage": "postgresql"
}
```

Public `/health/ready` checks the configured database and Python scorer. Database failures return 503. PostgreSQL pools are small and idle connections close after one second. The API closes storage after training/automation shutdown hooks finish.

Existing local SQLite files are preserved, but they are **not automatically uploaded or merged into Neon**. Switch storage before collecting hosted history. The synthetic demo always uses its separate SQLite file, even when a Neon URL is configured.

## Schema and transactions

The dedicated `futuro` schema contains 45 data tables plus `schema_migrations`. Migration numbering is separate from SQLite's version 4:

1. The original complete football/research schema, including history and lifecycle triggers. This deployed migration remains unchanged.
2. Explicit insertion-order identity columns for prediction runs, settlements, evidence and workflow records.
3. A server-side bulk ingestion function, preserving provider precedence, unchanged-snapshot deduplication, result corrections, goals and provenance.

Migration transactions use a transaction-scoped advisory lock, verify recorded checksums, and run on one connection. Concurrent deployments serialize. Existing `public` objects are untouched; incompatible existing objects/history cause failure rather than replacement. Future schema changes must be new migrations.

All application operations now await database completion: provider caches and quotas, fixture ingestion, predictions, evidence, settlement, analytics, research datasets/evaluations, training and workflow state. Atomic writes hold a transaction-scoped advisory lock across workers. Nested operations use the same client. Query errors are summarized without connection strings, SQL parameters or database details.

Fixture imports send one batch to PostgreSQL per provider response. Feature building reads fixtures and revision IDs together; training reuses a history corpus rather than querying each input revision. Feature-input links are inserted in bounded batches. These changes keep season imports and exact lineage practical over a remote connection.

Historical records stay append-only. Evidence must belong to its fixture and predate the prediction cutoff. Settlement must reference a completed result for that predicted fixture. Reports retain original observations and only use the current matching result revision. See [SCHEMA.md](SCHEMA.md) for relationships and metrics.

## Model recovery

Model artifact JSON and its digest are stored in PostgreSQL. Loading a completed model verifies the database copy and recreates a missing local artifact in the configured `ARTIFACT_DIRECTORY`. Existing corrupted files fail integrity checks. Stored paths from another machine are not followed. Render's disposable filesystem therefore does not lose the durable model copy.

Training jobs do not automatically resume after process interruption. A stale job remains visible for recovery; hosted training-owner recovery needs additional distributed ownership handling. Daily prediction workflow recovery is separate and uses database leases/fencing.

## Commands

With the connection URL in the terminal environment or ignored `.env`:

```powershell
npm run build
npm run db:migrate
npm run db:status
npm run db:inspect
```

The compiled Docker image includes `node dist/postgres/cli.js migrate` and `status`. The application migrates automatically at startup. The import, backtest, training, inspection and one-shot automation scripts honor `DATABASE_URL`; the demo intentionally stays local.

In Neon's SQL editor:

```sql
SELECT version, name, applied_at FROM futuro.schema_migrations ORDER BY version;
SELECT table_name FROM information_schema.tables
WHERE table_schema = 'futuro' ORDER BY table_name;
```

## Verification

Ordinary tests never use `DATABASE_URL` to reach a real database. Set `FUTURO_TEST_DATABASE_URL` explicitly to enable the isolated PostgreSQL integration test:

```powershell
node --import tsx --test test/postgres.test.ts
```

The test reserves a random `futuro_test_<hex>` namespace. It exercises concurrent migration, real application ingestion/prediction/settlement, analytics, append-only/cutoff/result constraints, workflow restart recovery, shortlist selection and shared provider budgets. Cleanup drops only that freshly reserved namespace, never `futuro` or `public`. An interrupted test may leave its isolated schema for manual cleanup.

See [AUTOMATION.md](AUTOMATION.md) to configure the opt-in external GitHub schedule. Schema version 1 was verified and created in the configured Neon database on 2026-11-07; deployment applies the newer migrations before using PostgreSQL storage.

On 2026-11-09, the expanded isolated Neon test passed ingestion, prediction, settlement, analytics, coordinator/store restart, shortlist and shared quota checks. Migrations 2–3 were then applied to the main `futuro` schema, and storage inspection confirmed PostgreSQL schema version 3. The hosted API still requires deployment of this code to switch its running application storage.

Driver references: [TLS/channel binding](https://node-postgres.com/features/ssl), [transactions on one client](https://node-postgres.com/features/transactions).
