#!/usr/bin/env bash
# Retire the names careerrat@0.5.2 replaced.
#
# `npm deprecate` has no CI path — trusted publishing mints a publish-scoped
# credential only, and npmjs.com has no deprecate button. It needs an
# authenticated npm CLI, which is why this is a script you run rather than
# something the release workflow does.
#
# Deprecating never unpublishes. Both packages keep installing; npm just prints
# the message on install and greys the version out on the website.

set -uo pipefail

ROLESTER_MSG="Renamed to careerrat. Install careerrat instead: npm i -g careerrat"
PLACEHOLDER_MSG="Placeholder release. Install careerrat@latest for the real package: npm i -g careerrat"

if ! WHO="$(npm whoami 2>/dev/null)"; then
  echo "==> npm CLI is not authenticated."
  echo "    ~/.npmrc has a token, but the registry rejects it with a 401, so it"
  echo "    was revoked or expired. Being signed in on npmjs.com does not help;"
  echo "    the CLI carries its own credential."
  echo
  if [ ! -t 0 ]; then
    # npm login runs a browser flow and prompts on stdin. Piped or run through
    # an agent shell it cannot prompt, so it fails with nothing useful printed.
    echo "    This shell has no TTY, so \`npm login\` cannot run here."
    echo "    Open Terminal yourself and run:"
    echo
    echo "        npm login && bash scripts/retire-old-npm-names.sh"
    echo
    exit 1
  fi
  echo "==> Starting npm login (a browser window will open)."
  if ! npm login; then
    echo "FATAL: npm login failed. Nothing was deprecated." >&2
    exit 1
  fi
  WHO="$(npm whoami)"
fi

echo "==> Logged in as $WHO"

fail=0

echo "==> Deprecating rolester (all versions)"
npm deprecate rolester "$ROLESTER_MSG" || fail=1

echo "==> Deprecating the careerrat 0.0.1 placeholder"
npm deprecate careerrat@0.0.1 "$PLACEHOLDER_MSG" || fail=1

echo
echo "==> Verifying (registry can lag a few seconds):"
echo "    rolester@0.5.2:  $(npm view rolester@0.5.2 deprecated 2>/dev/null || echo '(not deprecated)')"
echo "    careerrat@0.0.1: $(npm view careerrat@0.0.1 deprecated 2>/dev/null || echo '(not deprecated)')"
echo "    careerrat latest: $(npm view careerrat version 2>/dev/null)"

if [ "$fail" -ne 0 ]; then
  echo
  echo "FATAL: at least one deprecate call failed. See the npm error above." >&2
  exit 1
fi
