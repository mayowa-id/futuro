# Render Docker preview

The repository now contains the root `Dockerfile`. It builds the TypeScript API, installs Node/Python, and supervises the private Python scorer plus the authenticated API. This resolves the missing-Dockerfile error and the former localhost-only startup restriction.

## Existing Render service settings

| Field | Value |
| --- | --- |
| Repository | `mayowa-id/futuro` |
| Branch | `prod` (must include these committed files) |
| Root directory | Blank |
| Language/runtime | Docker |
| Dockerfile path | `./Dockerfile` |
| Docker context | Repository root (`.`) |
| Docker command | Blank; use the image's default command |
| Health check | `/health/ready` |
| Plan | Free for a disposable preview |

There is no separate npm build/start command to enter for Docker deployments. The image runs the compiled API, not the TypeScript development runner. `render.yaml` can create the equivalent service through a Render Blueprint, with an automatically generated API access token; it does not update an existing manually configured service by itself.

## Required secrets

Add `API_ACCESS_TOKEN` in Render's Environment settings. Generate a separate random secret, for example 64 hexadecimal characters. It must be at least 32 characters. This protects Futuro's own API; **do not reuse the football-data token**.

Add `FOOTBALL_DATA_TOKEN` separately if you want to test fetching football data. The image does not contain either secret. Use Render Environment settings rather than committed `.env` files or Docker build arguments.

The Docker image already provides these defaults, so existing equivalent values can remain:

```dotenv
HOST=0.0.0.0
NODE_ENV=production
MODEL_URL=http://127.0.0.1:8001
MODEL_PORT=8001
PYTHON_EXECUTABLE=python3
DATABASE_PATH=/app/data/futuro.sqlite
ARTIFACT_DIRECTORY=/app/data/artifacts
AUTOMATION_ENABLED=false
```

Render supplies `PORT`; do not override it unless necessary. Only the Node API binds to the public interface; Python remains on container-local `127.0.0.1`.

After committing/pushing the deployment files to the selected branch, choose **Manual Deploy -> Deploy latest commit** if Render does not start automatically. Confirm the deployed commit includes the root Dockerfile. The running branch can differ from your local checkout, so inspect Render's selected branch when diagnosing another missing-file error.

## Access the API

`GET /health` and `GET /health/ready` are public health probes. Readiness checks the local database and Python scoring endpoint.

All other routes require:

```http
Authorization: Bearer YOUR_API_ACCESS_TOKEN
```

An example PowerShell request, using a token kept in your terminal environment:

```powershell
Invoke-RestMethod 'https://YOUR-SERVICE.onrender.com/capabilities' -Headers @{
  Authorization = "Bearer $env:FUTURO_API_ACCESS_TOKEN"
}
```

For local development, localhost without `API_ACCESS_TOKEN` remains available. Production mode and public binding refuse to start without the access token. If you set a token locally too, local requests require the same bearer header.

## Free preview storage and scheduling

Render Free sleeps on inactivity and does not provide a persistent disk. Its filesystem, including this SQLite database and model files, is disposable across restarts/redeploys. Keep `AUTOMATION_ENABLED=false` on this preview. Do not upload the local research database expecting Render Free to retain it.

For a durable free deployment, the application needs a separately designed persistent database/artifact backend and external scheduling. This packaging does not change the $0 budget or select a paid disk. Continue collecting valuable history locally until persistence is implemented for the chosen host.

Official references: [Docker settings](https://render.com/docs/docker), [port binding](https://render.com/docs/web-services#port-binding), [Free limitations](https://render.com/docs/free).

## Local verification

```powershell
npm ci
npm run typecheck
npm run build
npm run smoke:production
npm test
python -m unittest discover -s model -p 'test_*.py' -v
```

With Docker installed, build and run a temporary preview, passing an access token through your environment:

```powershell
docker build -t futuro-preview .
docker run --rm -p 10000:10000 -e API_ACCESS_TOKEN futuro-preview
```

The image runs as the non-root `node` user. A small supervisor stops the other process if Node or Python exits, and `tini` handles container signals/reaping. Runtime artifacts live under `/app/data`; source, dependencies and secrets are kept separate. `.dockerignore` excludes `.env`, Git metadata, local data/databases and installed dependencies from the build context.

Validation in this workspace: production compilation, 34 TypeScript tests, 9 Python tests, and the compiled API/real-Python smoke check passed. A Docker engine is not installed here, so the image itself has not been built locally; Render's build remains the image-level check.
