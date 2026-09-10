#!/bin/sh
set -eu
# Apply Postgres migrations against DATABASE_URL, then keep this process
# alive so Drive copies continue after the browser is closed.
node scripts/migrate.mjs
exec node .output/server/index.mjs
