#!/usr/bin/env bash
# Point demo.careerrat.codeswhat.com at the Vercel project that serves the demo.
#
# Why a script and not the dashboard: this is the one piece of the demo pipeline
# that lives outside the repo, so it was undocumented and got lost in the
# rename. scripts/deploy-demo.mjs's header claimed this record already existed;
# it did not, and the old demo.rolester record is what was actually serving.
#
# Auth: a Cloudflare API token in the macOS Keychain. Never an env var in a
# dotfile, never a literal in this script. Wrangler cannot do this — its OAuth
# scope list has no DNS scope, only zone:read — so flarectl is the tool.
#
# One-time token setup, if the Keychain lookup below fails:
#
#   1. https://dash.cloudflare.com/profile/api-tokens -> Create Token
#      -> Edit zone DNS template
#      Permissions:  Zone / DNS / Edit  AND  Zone / Zone / Read
#      Zone resources: Include / Specific zone / codeswhat.com
#   2. Store it (prompts with hidden input, so it never lands in shell history):
#        security add-generic-password -U -s cloudflare -a api-token -w
#   3. Re-run this script.

set -uo pipefail

ZONE="codeswhat.com"
RECORD="demo.careerrat.codeswhat.com"
TARGET="cname.vercel-dns.com"

if ! CF_API_TOKEN="$(security find-generic-password -s cloudflare -a api-token -w 2>/dev/null)"; then
  echo "==> No Cloudflare API token in the Keychain."
  echo "    Create one (Zone/DNS/Edit + Zone/Zone/Read on ${ZONE}) at"
  echo "    https://dash.cloudflare.com/profile/api-tokens, then store it with:"
  echo
  echo "        security add-generic-password -U -s cloudflare -a api-token -w"
  echo
  echo "    The trailing -w with no value prompts for the token with hidden"
  echo "    input, so it never enters shell history. Then re-run this script."
  exit 1
fi
export CF_API_TOKEN

echo "==> Existing ${ZONE} records for the demo hosts"
flarectl dns list --zone "$ZONE" 2>/dev/null | grep -i "demo" || echo "    (none)"

echo
echo "==> Creating or updating ${RECORD} -> ${TARGET}"
# Proxy MUST stay off. Behind Cloudflare's proxy, Vercel never sees the
# validation request and cannot issue the certificate for this host.
if ! flarectl dns create-or-update \
  --zone "$ZONE" \
  --name "$RECORD" \
  --type CNAME \
  --content "$TARGET" \
  --proxy=false; then
  echo "FATAL: flarectl could not write the record." >&2
  echo "  If it reports a permission error, the token is missing Zone/DNS/Edit" >&2
  echo "  or was scoped to the wrong zone. ${RECORD} lives under ${ZONE}," >&2
  echo "  NOT under careerrat.com." >&2
  exit 1
fi

echo
echo "==> Verifying (DNS can take a moment to propagate)"
for attempt in 1 2 3 4 5 6; do
  resolved="$(dig +short "$RECORD" CNAME 2>/dev/null)"
  if [ -n "$resolved" ]; then
    echo "    ${RECORD} -> ${resolved}"
    break
  fi
  echo "    attempt ${attempt}: not resolving yet"
  sleep 10
done

if [ -z "${resolved:-}" ]; then
  echo
  echo "The record was written but is not resolving yet. That is normal."
  echo "Re-check with: dig +short ${RECORD} CNAME"
  exit 0
fi

cat <<EOF

==> Record is live. Remaining steps:

  1. vercel domains inspect ${RECORD} --scope codeswhat
     (confirms Vercel sees it and has issued the certificate)

  2. npm run deploy:demo
     (rebuilds the evergreen bundle and ships it prebuilt)
EOF
