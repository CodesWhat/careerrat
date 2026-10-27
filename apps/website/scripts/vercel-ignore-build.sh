#!/bin/sh
# Vercel Ignored Build Step for the website project (see ignoreCommand in
# apps/website/vercel.json). Exit 0 skips the build, exit 1 builds.
# Sources: vercel.com/docs/project-configuration/project-settings (the command
# runs in the Root Directory with system env vars; 1 = build, 0 = cancel) and
# vercel.com/docs/environment-variables/system-environment-variables
# (VERCEL_GIT_PREVIOUS_SHA is set only when an ignore step exists, empty on a
# branch's first deploy).

# Everything the site build reads, relative to the repo root.
SITE_PATHS="apps/website apps/docs scripts/build-docs-content.mjs scripts/harden-static-html.mjs package.json package-lock.json"

if [ "$VERCEL_ENV" = "production" ] || [ "$VERCEL_GIT_COMMIT_REF" = "main" ]; then
	echo "vercel-ignore-build: building, production deploy"
	exit 1
fi

root=$(git rev-parse --show-toplevel 2>/dev/null) || {
	echo "vercel-ignore-build: building, not inside a git checkout"
	exit 1
}
cd "$root" || exit 1

# shellcheck disable=SC2086
changed_since() {
	git diff --quiet "$1" HEAD -- $SITE_PATHS
	case $? in
	0) return 1 ;;
	1) return 0 ;;
	*) return 2 ;;
	esac
}

report() {
	# $1 = base ref, $2 = label
	changed_since "$1"
	case $? in
	0)
		echo "vercel-ignore-build: building, site files changed since $2"
		exit 1
		;;
	1)
		echo "vercel-ignore-build: skipping, no site files changed since $2"
		exit 0
		;;
	esac
	return 1
}

if [ -n "$VERCEL_GIT_PREVIOUS_SHA" ] && git cat-file -e "$VERCEL_GIT_PREVIOUS_SHA^{commit}" 2>/dev/null; then
	report "$VERCEL_GIT_PREVIOUS_SHA" "last deploy ($VERCEL_GIT_PREVIOUS_SHA)"
fi

# No usable previous deploy (first push of a branch, shallow clone): compare to main.
if git fetch --quiet --depth=50 origin main 2>/dev/null; then
	base=$(git merge-base FETCH_HEAD HEAD 2>/dev/null) || base=""
	if [ -n "$base" ]; then
		report "$base" "merge base with main ($base)"
	fi
fi

echo "vercel-ignore-build: building, could not find a base commit to diff against"
exit 1
