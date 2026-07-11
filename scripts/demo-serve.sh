#!/usr/bin/env bash
# Serve the enriched demo dashboard WITHOUT touching your real data or the live
# 7777 instance. Seeds an isolated demo workspace (ROLESTER_HOME=./.demo-home) from
# examples/demo-workspace, then boots the tracker-dev backend on :7788 and the Vite
# dev SPA on :5173 (whose /api proxy is pointed at :7788, not your live 7777).
#
#   bash scripts/demo-serve.sh      # then open http://localhost:5173
#
# Ctrl-C stops both. Re-run any time to re-seed the latest fixture.
set -euo pipefail
cd "$(dirname "$0")/.."

export ROLESTER_HOME="$PWD/.demo-home"   # isolated — never your default workspace
export ROLESTER_DEV_PORT=7788            # read by BOTH the backend and vite's proxy

echo "→ Seeding demo into $ROLESTER_HOME (isolated, safe) ..."
node src/cli/data.mjs init --demo

# clear any stale demo backend so a re-run doesn't hit EADDRINUSE on 7788
lsof -nP -tiTCP:7788 -sTCP:LISTEN 2>/dev/null | xargs -r kill 2>/dev/null || true

echo "→ Starting tracker-dev backend on :7788 ..."
node src/cli/tracker-dev.mjs --port 7788 &
BACKEND=$!
trap 'kill "$BACKEND" 2>/dev/null || true' EXIT

# wait for the backend to actually bind before vite starts proxying to it
for _ in $(seq 1 30); do
  lsof -nP -iTCP:7788 -sTCP:LISTEN >/dev/null 2>&1 && break
  sleep 0.5
done

echo "→ Starting Vite dev SPA on :5173 (proxy /api → :7788) ..."
echo ""
echo "   ┌─────────────────────────────────────────────┐"
echo "   │  Open  http://localhost:5173/app/            │"
echo "   │  (note the /app/ — bare :5173 shows nothing) │"
echo "   └─────────────────────────────────────────────┘"
echo ""
npm run dev --workspace apps/web
