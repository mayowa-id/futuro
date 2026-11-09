# Futuro

Free-data football prediction research API with form analysis, result tracking, and model evaluation.

**Model:** Experimental, uncalibrated baseline; picks remain research candidates.
**Storage:** Set `DATABASE_URL` for Neon PostgreSQL; leave it blank for local SQLite.

## Run locally

Requires Node.js 22.13+ and Python 3.11+. Run commands from the repository root.

```powershell
npm install
Copy-Item .env.example .env
python model/server.py
```

In a second terminal:

```powershell
npm run dev
```

API: `http://127.0.0.1:3000` · Python scorer: `http://127.0.0.1:8001`.
Set `FOOTBALL_DATA_TOKEN` for current fixtures and `API_ACCESS_TOKEN` for production access.
Keep secrets in environment settings or ignored `.env` files.

## Common commands

- `npm run demo` — synthetic prediction and settlement workflow.
- `npm run import:openfootball -- PL 2024-25` — import free historical results.
- `npm run backtest -- PL` — evaluate historical predictions with the scorer running.
- `npm run typecheck`, `npm run build`, `npm test` — validate the TypeScript app.

## Guides

- [Usage and API](USAGE.md) · [Render deployment](RENDER_DEPLOYMENT.md) · [Neon setup](POSTGRES.md)
- [Database design](SCHEMA.md) · [Training](TRAINING.md) · [Automation](AUTOMATION.md)
- [Free data](FREE_DATA_PLAN.md) · [Market research](NICHE_MARKET_RESEARCH.md)
- [Requirements](REQUIREMENTS.md) · [Implementation plan](IMPLEMENTATION_PLAN.md)
