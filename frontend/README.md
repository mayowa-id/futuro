# Futuro frontend

Independent static frontend for Vercel. The NestJS API stays on Render; PostgreSQL stays on Neon. No API token, database URL, provider token, framework runtime, CDN, or paid dependency is bundled into this site.

## Vercel settings

Import the existing GitHub repository as a **new Vercel project**:

| Setting | Value |
| --- | --- |
| Root Directory | `frontend` |
| Framework Preset | Other |
| Install Command | `npm ci` |
| Build Command | `npm run build` |
| Output Directory | `dist` |
| Environment variable | `PUBLIC_API_URL=https://futuro-api-69dy.onrender.com` |

`vercel.json` already declares the build command, output directory and security headers. The frontend has its own package/lockfile and needs no access to files outside its root. `PUBLIC_API_URL` is intentionally public; it is the API origin only, without a path, username, password or query string. Changing it requires a new frontend build.

After Vercel gives you the production URL, set this on **Render** (a trailing slash is accepted and normalized):

```dotenv
FRONTEND_ORIGINS=https://YOUR-PROJECT.vercel.app
```

Redeploy the API after updating this value. Keep `API_ACCESS_TOKEN`, `FOOTBALL_DATA_TOKEN` and `DATABASE_URL` only in Render's environment settings. Enter the API access token into the frontend's sign-in form when using the dashboard; it is kept in that tab's memory, not storage or URLs.

Add exact custom-domain or preview origins to `FRONTEND_ORIGINS` as a comma-separated list if needed. Unrelated Vercel deployments are not allowed automatically. The frontend only sends authenticated GET requests; it does not trigger imports, workflow jobs or model training.

## Local development

Start the API and Python scorer using the root README, then:

```powershell
# In the backend environment:
# FRONTEND_ORIGINS=http://localhost:4173
# Restart the API after setting it.
cd frontend
Copy-Item .env.example .env
# For a local backend, set PUBLIC_API_URL=http://127.0.0.1:3000 in frontend/.env.
npm ci
npm run dev
```

Open `http://localhost:4173`. The build reads only `PUBLIC_API_URL` from `frontend/.env`; the rest of the backend's environment is not copied. Local HTTP is accepted only for localhost/loopback API origins. Preview a completed build with `npm run preview`. The output folder is ignored by Git.

The frontend requests only its configured API origin, does not follow API redirects, and uses no external scripts/fonts. Vercel serves an explicit content policy, frame restrictions and no-store responses for deployment freshness. The page contains only static markup until an authenticated API response arrives.

Verification from the repository root:

```powershell
npm run build --prefix frontend
npm run typecheck
npm test
```

Opt-in real browser checks: set `FUTURO_BROWSER_TESTS=true` and run `node --import tsx --test test/dashboard.test.ts`. These tests build the frontend, serve it on a separate local origin from the API, check CORS/authentication/filtering, and capture desktop/mobile screenshots under ignored `data/dashboard-preview/`.

See [dashboard behavior](../DASHBOARD.md) and [Vercel build configuration](https://vercel.com/docs/builds/configure-a-build).
