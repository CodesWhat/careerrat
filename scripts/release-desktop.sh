#!/usr/bin/env bash
# Build, notarize, staple, and (optionally) publish a CareerRat Desktop release.
#
# Usage: bash scripts/release-desktop.sh [patch|minor|none]
#   patch/minor — bump apps/desktop/package.json semver before building
#   none (default) — build the current version, no bump
#
# Set RELEASE=1 to also cut a GitHub release (tag desktop-v$VERSION) with the
# DMG attached. Without it, the script just builds/notarizes/staples and
# leaves publishing to a follow-up run.
set -euo pipefail

BUMP="${1:-none}"

# Resolve repo root from this script's own location, never assume cwd.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$REPO_ROOT"

DESKTOP_DIR="apps/desktop"

case "$BUMP" in
  patch|minor)
    echo "Bumping $BUMP version..."
    (cd "$DESKTOP_DIR" && npm version "$BUMP" --no-git-tag-version)
    ;;
  none)
    ;;
  *)
    echo "error: unknown bump arg '$BUMP' (expected patch, minor, or none)" >&2
    exit 1
    ;;
esac

VERSION="$(node -p "require('./$DESKTOP_DIR/package.json').version")"
echo "Building CareerRat $VERSION"

npm run desktop:dist

DMG_PATH="$DESKTOP_DIR/dist/CareerRat-$VERSION-arm64.dmg"
APP_PATH="$DESKTOP_DIR/dist/mac-arm64/CareerRat.app"

if [ ! -f "$DMG_PATH" ]; then
  echo "error: expected DMG not found at $DMG_PATH" >&2
  exit 1
fi

# Notary credentials come from the environment (or an untracked local env
# file) so no personal paths or IDs live in the tracked script.
LOCAL_ENV="$REPO_ROOT/.internal/release.env"
if [ -f "$LOCAL_ENV" ]; then
  # shellcheck disable=SC1090
  . "$LOCAL_ENV"
fi
NOTARY_KEY="${ROLESTER_NOTARY_KEY:-}"
NOTARY_KEY_ID="${ROLESTER_NOTARY_KEY_ID:-}"
NOTARY_ISSUER="${ROLESTER_NOTARY_ISSUER:-}"
if [ -z "$NOTARY_KEY" ] || [ -z "$NOTARY_KEY_ID" ] || [ -z "$NOTARY_ISSUER" ]; then
  echo "error: set ROLESTER_NOTARY_KEY, ROLESTER_NOTARY_KEY_ID, and ROLESTER_NOTARY_ISSUER" >&2
  echo "       (export them or put them in .internal/release.env — untracked)" >&2
  exit 1
fi
if [ ! -f "$NOTARY_KEY" ]; then
  echo "error: notary key file not found at $NOTARY_KEY" >&2
  exit 1
fi

echo "Submitting $DMG_PATH for notarization (key: $NOTARY_KEY)..."
NOTARY_OUTPUT="$(xcrun notarytool submit "$DMG_PATH" \
  --key "$NOTARY_KEY" \
  --key-id "$NOTARY_KEY_ID" \
  --issuer "$NOTARY_ISSUER" \
  --wait)"
echo "$NOTARY_OUTPUT"

if ! grep -q "status: Accepted" <<<"$NOTARY_OUTPUT"; then
  echo "error: notarization did not report 'status: Accepted'" >&2
  exit 1
fi

echo "Stapling ticket to DMG and app..."
xcrun stapler staple "$DMG_PATH"
xcrun stapler staple "$APP_PATH"

echo "Verifying Gatekeeper acceptance..."
SPCTL_OUTPUT="$(spctl -a -vv "$APP_PATH" 2>&1)"
echo "$SPCTL_OUTPUT"
if ! grep -q "accepted" <<<"$SPCTL_OUTPUT"; then
  echo "error: spctl did not report the app as accepted" >&2
  exit 1
fi

if [ "${RELEASE:-}" = "1" ]; then
  TAG="desktop-v$VERSION"
  if gh release view "$TAG" >/dev/null 2>&1; then
    echo "error: release $TAG already exists — bump the version first" >&2
    exit 1
  fi
  echo "Creating GitHub release $TAG..."
  gh release create "$TAG" "$DMG_PATH" \
    --title "CareerRat Desktop $VERSION" \
    --generate-notes
  echo "Published $TAG."
else
  echo "Built and notarized: $DMG_PATH"
  echo "Set RELEASE=1 to publish this as a GitHub release."
fi
