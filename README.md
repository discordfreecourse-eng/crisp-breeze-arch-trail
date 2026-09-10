# Raw Copy

One-time **Google Drive** migration into a folder named `/Raw` on your own Drive.

Paste vendor Drive links or drop a PDF. The server copies files with Drive `files.copy` — nothing is downloaded through the browser. Close the tab; the job keeps running on the host.

Built to run as a **single long-lived Northflank service** (web UI + copy worker in one process) with Postgres.

## Layout

```text
.
├── Dockerfile                 # Northflank / Docker image (Node 22)
├── docker-compose.yml         # local Postgres + app
├── docker-entrypoint.sh       # migrate, then start the server
├── northflank.yaml            # combined-service spec
├── deploy/
│   └── env.list               # env template — no secrets
├── migrations/
│   └── 0002_drive_migration.sql
├── public/                    # favicon + share card
├── src/
│   ├── components/            # UI (wizard + primitives)
│   ├── lib/
│   │   ├── google/            # Drive API + OAuth
│   │   ├── jobs/              # queue, resolve, copy worker
│   │   ├── pdf/               # PDF link extraction
│   │   ├── fn/                # server functions
│   │   └── db.ts              # Postgres (or embedded preview store)
│   └── routes/                # pages + /api/health + OAuth callback
└── scripts/
    └── migrate.mjs            # applies migrations/ against DATABASE_URL
```

## What it does

1. **Connect** your Google Drive (your OAuth client, not a shared account).
2. **Load** Drive folder/file links from a PDF or by paste.
3. **Select** what to copy. Defaults: 5 concurrent copies, ~600 GB / 24 h.
4. **Start Copy.** Files land under `/Raw` (or `DEST_FOLDER_NAME`) via `files.copy`. Already-copied IDs are skipped. Rate limits are retried.

Health check: `GET /api/health`.

## Northflank

1. Create a **combined service** from this repo’s `Dockerfile` (see `northflank.yaml`). One instance is enough.
2. Attach a **Postgres** addon so `DATABASE_URL` is injected.
3. In Google Cloud: enable Drive API, create an OAuth **web** client, add redirect URI  
   `https://<your-host>/api/google/callback`.
4. Set secrets / env from `deploy/env.list`. Required:

   | Variable | Purpose |
   |---|---|
   | `DATABASE_URL` | Postgres (addon) |
   | `GOOGLE_CLIENT_ID` | OAuth web client |
   | `GOOGLE_CLIENT_SECRET` | OAuth web client |
   | `PUBLIC_BASE_URL` | Public `https://` origin |
   | `LONG_RUNNING` | `1` so copies continue after the browser closes |

   Optional: `GOOGLE_REDIRECT_URI`, `DEST_FOLDER_NAME` (default `Raw`), `COPY_CONCURRENCY` (default `5`), `COPY_DAILY_BUDGET_GB` (default `600`).

Do not put client secrets in git. Set them in the Northflank dashboard.

## Docker (same image)

```sh
docker compose up --build
```

Pass Google credentials through the environment (`GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `PUBLIC_BASE_URL`). Compose starts Postgres and the app together.

## Scripts

```sh
npm install
npm run dev          # local UI (embedded DB if DATABASE_URL is unset)
npm run build        # production build + migrate when DATABASE_URL is set
npm start            # LONG_RUNNING=1 node .output/server/index.mjs
npm run typecheck
```

Node 22+.
