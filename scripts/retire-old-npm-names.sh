#!/usr/bin/env bash
# Retire the names careerrat@0.5.2 replaced.
#
# `npm deprecate` has no CI path — trusted publishing mints a publish-scoped
# credential only, and npmjs.com has no deprecate button. It needs an
# interactive `npm login`, which is why this is a script you run rather than
# something the release workflow does.
#
# Deprecating never unpublishes. Both packages keep installing; npm just prints
# the message on install and greys the version out on the website.

set -euo pipefail

ROLESTER_MSG="Renamed to careerrat. Install careerrat instead: npm i -g careerrat"
PLACEHOLDER_MSG="Placeholder release. Install careerrat@latest for the real package: npm i -g careerrat"

if ! npm whoami >/dev/null 2>&1; then
  echo "==> Not logged in to npm. Opening the login flow."
  npm login
fi

echo "==> Logged in as $(npm whoami)"

echo "==> Deprecating rolester (all versions)"
npm deprecate rolester "$ROLESTER_MSG"

echo "==> Deprecating the careerrat 0.0.1 placeholder"
npm deprecate careerrat@0.0.1 "$PLACEHOLDER_MSG"

echo
echo "==> Done. Verifying:"
npm view rolester deprecated || true
npm view careerrat@0.0.1 deprecated || true
echo "    careerrat latest: $(npm view careerrat version)"
