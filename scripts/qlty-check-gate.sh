#!/usr/bin/env bash
# Runs the Qlty gate used by both `lefthook` pre-push and CI (see
# .github/workflows/ci-verify.yml's `qlty` job and lefthook.yml's `qlty` command).
#
# Default ("changed") mode diffs against origin/main so the gate only
# enforces the code a push/PR actually touches — CareerRat is pre-launch and
# carries a large pre-existing doc/YAML backlog (.planning/, examples/,
# templates/) that a repo-wide `--all` run would immediately fail on. Pass
# "all" explicitly to check everything (useful for a dedicated cleanup pass).
set -euo pipefail

mode="${1:-changed}"

case "$mode" in
changed | all) ;;
*)
	echo "Usage: $0 [changed|all]"
	exit 1
	;;
esac

cmd=(qlty check --no-progress)

if [ "$mode" = "all" ]; then
	cmd+=(--all)
elif git rev-parse --verify --quiet refs/remotes/origin/main >/dev/null; then
	cmd+=(--upstream origin/main)
fi

echo "Running Qlty gate: ${cmd[*]}"
"${cmd[@]}" </dev/null
