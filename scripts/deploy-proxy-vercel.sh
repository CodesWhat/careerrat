#!/usr/bin/env bash
set -euo pipefail

# Stage a self-contained copy of apps/proxy-vercel and deploy it to Vercel.
#
# Why staging: the handler imports ../../../../src/... (repo root), but a CLI
# deploy uploads only the invocation directory, and Vercel only routes a
# root-level api/. So we assemble <stage>/{api,src,vercel.json,package.json}
# and rewrite the import depth (4 up -> 2 up) to match the flat layout.
#
# Usage: bash scripts/deploy-proxy-vercel.sh [vercel args, e.g. --prod]

repo="$(cd "$(dirname "$0")/.." && pwd)"
stage="${TMPDIR:-/tmp}/rolester-proxy-vercel-stage"

rm -rf "$stage"
mkdir -p "$stage/src"
cp -R "$repo/apps/proxy-vercel/api" "$stage/api"
cp "$repo/apps/proxy-vercel/vercel.json" "$repo/apps/proxy-vercel/package.json" "$stage/"
# package-lock.json (apps/proxy-vercel now has its own install — @clerk/backend,
# for api/auth/exchange.mjs) isn't guaranteed to exist yet on every checkout;
# carry it along when it does so the deployed build's install is reproducible
# instead of re-resolving the caret range fresh on every deploy.
if [ -f "$repo/apps/proxy-vercel/package-lock.json" ]; then
  cp "$repo/apps/proxy-vercel/package-lock.json" "$stage/"
fi
cp -R "$repo/src/cli" "$repo/src/core" "$stage/src/"

# Flat layout puts the handler two levels below root, not four.
find "$stage/api" -name "*.mjs" -exec perl -pi -e 's{(\.\./){4}src/}{../../src/}g' {} +

# Keep the existing project link (vercel link writes .vercel/ into the stage,
# which rm -rf above would nuke) — restore it if we saved one previously.
link_backup="$repo/apps/proxy-vercel/.vercel"
if [ -d "$link_backup" ]; then
  cp -R "$link_backup" "$stage/.vercel"
fi

(cd "$stage" && vercel --scope codeswhat "$@")

# Persist the project link back beside the app so future runs reuse it.
if [ -d "$stage/.vercel" ]; then
  rm -rf "$link_backup"
  cp -R "$stage/.vercel" "$link_backup"
fi
