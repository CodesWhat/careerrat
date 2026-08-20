#!/usr/bin/env bash
# Apply a tag-protection ruleset to CodesWhat/careerrat release tags (refs/tags/v*).
#
# Additive protection alongside the existing "Main branch protection" ruleset
# (scripts/protect-main.sh) — this script never touches that ruleset. It applies
# the house pattern from rulesets.md (drydock 20945202, portwing 20957972): block
# deletion, update, and non-fast-forward on release tags, no bypass actors.
#
# Deliberately NO `required_signatures` rule. The release bot pushes plain
# annotated tags; GitHub's signature rule can't verify Actions-created tags
# without real key management, and the Cosign artifact chain (identity-pinned to
# the release workflow) is already the signature of record. Commit signing stays
# out of scope — this is additive tag protection only, not a signing mandate.
#
# Usage:
#   bash scripts/protect-tags.sh            create the ruleset if absent, else verify
#   bash scripts/protect-tags.sh --verify   verify only, never writes
#
# Exit 0 = live protection matches this file. Exit 1 = drift (or a failed create).
#
# --- Why the verify step exists -------------------------------------------------
# Same failure mode scripts/protect-main.sh guards against: a ruleset edited live
# in the UI drifts from what this file declares, and re-applying the file would
# silently overwrite the live state with a smaller one. The pre-flight diff below
# fails on ANY difference rather than trying to merge, so drift gets caught and
# reconciled by hand instead of overwritten.
set -euo pipefail

# Context names sort differently under other collations, and a comparison over two
# differently-sorted lists silently produces wrong output. Pin the collation for the
# whole script rather than per-sort, so this can't be lost when a sort is added.
export LC_ALL=C

REPO="CodesWhat/careerrat"
RULESET_NAME="Protect release tags"

# Sourced or executed. Sourcing this file (a future
# tests/protect-tags-verify.test.mjs would) should load DESIRED and the functions
# and do nothing else: no argument parsing, since the argv belongs to the
# sourcing script, and no dispatch at the bottom. Executing it behaves exactly as
# it always has.
SOURCED=0
if [ "${BASH_SOURCE[0]}" != "$0" ]; then
	SOURCED=1
fi

VERIFY_ONLY=0
if [ "$SOURCED" = 0 ]; then
	case "${1:-}" in
	--verify) VERIFY_ONLY=1 ;;
	"") ;;
	*)
		echo "usage: bash scripts/protect-tags.sh [--verify]" >&2
		exit 2
		;;
	esac
fi

# The single source of truth. Both the create path and the verify path read this,
# so they can never disagree about what "correct" means.
read -r -d '' DESIRED <<'JSON' || true
{
  "name": "Protect release tags",
  "target": "tag",
  "enforcement": "active",
  "conditions": { "ref_name": { "include": ["refs/tags/v*"], "exclude": [] } },
  "rules": [
    { "type": "deletion" },
    { "type": "update" },
    { "type": "non_fast_forward" }
  ],
  "bypass_actors": []
}
JSON

# Reduce a ruleset (ours or the API's) to a canonical, comparable form: rules
# sorted by type, a rule's `parameters` dropped when the API returns it as an
# empty object (deletion/update/non_fast_forward carry none), and bypass actors
# sorted. No context list here (unlike protect-main.sh) — this ruleset has no
# required_status_checks rule.
canonicalize() {
	jq -S '
    {
      enforcement: .enforcement,
      bypass_actors: (.bypass_actors // [] | sort),
      conditions: (.conditions // {}),
      rules: (
        [ .rules[]
          | { type: .type }
            + ( if ((.parameters // {}) | length) > 0 then { parameters: .parameters } else {} end )
        ] | sort_by(.type)
      )
    }
  '
}

# Three outcomes, deliberately distinguished by exit code, because conflating them
# is how a guard cries wolf: 0 = here it is, 1 = the repo genuinely has no ruleset
# by this name, 2 = the API call failed so we don't know either way. Swallowing
# case 2 into case 1 would announce "tags are UNPROTECTED" on a network blip or an
# expired auth, and a guard that panics on a bad wifi connection stops being read.
live_ruleset() {
	local list id
	list="$(gh api "repos/$REPO/rulesets" 2>/dev/null)" || return 2
	id="$(printf '%s' "$list" | jq -r ".[] | select(.name == \"$RULESET_NAME\") | .id" 2>/dev/null)"
	[ -n "$id" ] || return 1
	gh api "repos/$REPO/rulesets/$id" 2>/dev/null || return 2
}

verify() {
	local live rc
	live="$(live_ruleset)" || rc=$?
	if [ "${rc:-0}" = 2 ]; then
		echo "✗ couldn't read the ruleset list for $REPO — this says nothing about whether" >&2
		echo "  release tags are protected, only that the check didn't run. Fix auth/network and re-run:" >&2
		echo "    gh auth status" >&2
		return 1
	fi
	if [ "${rc:-0}" != 0 ] || [ -z "$live" ]; then
		echo "✗ no '$RULESET_NAME' ruleset on $REPO — release tags are UNPROTECTED." >&2
		echo "  run:  bash scripts/protect-tags.sh" >&2
		return 1
	fi
	compare_ruleset "$live"
}

# The comparison, split out from the fetch so it can be exercised against a
# fixture without a network round trip, the same shape as
# scripts/protect-main.sh's compare_ruleset — a guard whose own drift detection
# has never been run against an actually-drifted ruleset is just a hope.
compare_ruleset() {
	local live="$1"
	local want got
	want="$(printf '%s' "$DESIRED" | canonicalize)"
	got="$(printf '%s' "$live" | canonicalize)"

	if [ "$want" = "$got" ]; then
		echo "✓ live protection on $REPO release tags matches scripts/protect-tags.sh."
		printf '%s' "$got" | jq -r '"  \(.rules | map(.type) | join(", "))"'
		return 0
	fi

	echo "✗ DRIFT between scripts/protect-tags.sh and the live ruleset on $REPO." >&2
	echo >&2
	# Rule types called out separately from the raw diff: a removed protection is
	# the failure this guard exists for, and it should not need reading a JSON
	# diff to spot.
	local want_types got_types
	want_types="$(printf '%s' "$want" | jq -r '.rules[].type')"
	got_types="$(printf '%s' "$got" | jq -r '.rules[].type')"

	local only_live only_file
	only_live="$(comm -13 <(printf '%s\n' "$want_types") <(printf '%s\n' "$got_types"))"
	only_file="$(comm -23 <(printf '%s\n' "$want_types") <(printf '%s\n' "$got_types"))"

	if [ -n "$only_live" ]; then
		echo "  ENFORCED LIVE BUT NOT DECLARED HERE — re-creating from this file would REMOVE these:" >&2
		printf '%s\n' "$only_live" | sed 's/^/    - /' >&2
		echo >&2
	fi
	if [ -n "$only_file" ]; then
		echo "  DECLARED HERE BUT NOT ENFORCED LIVE — protection is weaker than this file claims:" >&2
		printf '%s\n' "$only_file" | sed 's/^/    - /' >&2
		echo >&2
	fi

	echo "  full diff (< this file, > live):" >&2
	# diff exits 1 when its inputs differ, which is guaranteed here (that's why this
	# branch is running at all), and pipefail is on, so a bare pipeline would trip
	# set -e and cut off the remediation text below before it ever prints. Wrapping
	# it as an if-condition keeps that exit off the script's back; only diff crashing
	# outright (rc > 1) or sed itself failing is treated as a real error.
	if ! diff <(printf '%s\n' "$want") <(printf '%s\n' "$got") | sed 's/^/    /' >&2; then
		local diff_rc=${PIPESTATUS[0]} sed_rc=${PIPESTATUS[1]}
		if [ "$diff_rc" -gt 1 ] || [ "$sed_rc" -ne 0 ]; then
			echo "  (could not render the diff: diff rc=$diff_rc, sed rc=$sed_rc)" >&2
		fi
	fi
	echo >&2
	echo "  Reconcile by hand. Do NOT delete the ruleset to re-create it: that drops release" >&2
	echo "  tags to zero protection, and the re-create restores only what this file declares." >&2
	echo "  Either edit the ruleset in the UI to match this file, or update this file to match" >&2
	echo "  the live set. History is authoritative if you need to establish when it changed:" >&2
	echo "    gh api repos/$REPO/rulesets --jq '.[] | select(.name == \"$RULESET_NAME\") | .id'" >&2
	echo "    gh api repos/$REPO/rulesets/{id}/history" >&2
	return 1
}

if [ "$SOURCED" = 1 ]; then
	return 0
fi

if [ "$VERIFY_ONLY" = 1 ]; then
	verify
	exit $?
fi

# live_ruleset's three exit codes matter here: 0 means create must not run (an
# existing ruleset would be silently replaced), 1 is the only code that actually
# licenses a create, and 2 (lookup failed) must not be treated as "absent" or
# this is the exact overwrite-what-you-can't-see failure this script exists to
# prevent.
live_rc=0
live_ruleset >/dev/null 2>&1 || live_rc=$?

if [ "$live_rc" = 0 ]; then
	echo "→ a '$RULESET_NAME' ruleset already exists on $REPO — verifying instead of applying."
	verify
	exit $?
fi

if [ "$live_rc" != 1 ]; then
	echo "✗ couldn't read the ruleset list for $REPO — this says nothing about whether" >&2
	echo "  release tags are protected, only that the check didn't run. Fix auth/network and re-run:" >&2
	echo "    gh auth status" >&2
	exit 1
fi

printf '%s' "$DESIRED" | gh api -X POST "repos/$REPO/rulesets" --input -

echo "✓ applied. Verifying:"
verify
