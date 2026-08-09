#!/usr/bin/env bash
# Publish rolester to npm under the codeswhat org (unscoped, public).
# Run AFTER `npm login` and AFTER the codeswhat org exists on npmjs.com.
# Usage:  bash scripts/publish-rolester.sh
set -euo pipefail

ORG="codeswhat"
TEAM="$ORG:developers"   # default team created with the org
cd "$(dirname "$0")/.."  # repo root

echo "→ checking npm auth…"
who=$(npm whoami 2>/dev/null) || {
  echo "✗ not logged in. Run:  npm login   then re-run this script."
  exit 1
}
echo "  logged in as: $who"

echo "→ checking org '$ORG' exists / you're a member…"
npm org ls "$ORG" >/dev/null 2>&1 || {
  echo "✗ org '$ORG' not found (or you're not a member)."
  echo "  Create it free at https://www.npmjs.com/org/create then re-run."
  exit 1
}

echo "→ dry-run pack (what will ship)…"
npm publish --dry-run

echo
read -r -p "Publish rolester@$(node -p "require('./package.json').version") public to npm? [y/N] " ok
[[ "$ok" == "y" || "$ok" == "Y" ]] || { echo "aborted."; exit 0; }

echo "→ publishing…"
npm publish --access public

echo "→ granting '$TEAM' read-write on rolester…"
npm access grant read-write "$TEAM" rolester || echo "  (grant skipped/failed — set it in the org UI if needed)"

echo "→ bringing portkey-admin-mcp under '$ORG' (keeps bare name, no rescope)…"
npm access grant read-write "$TEAM" portkey-admin-mcp || echo "  (portkey grant skipped/failed — fine to do later)"

echo "✓ done. Verify:  npm view rolester  &&  npm owner ls rolester"
