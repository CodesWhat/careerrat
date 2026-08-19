#!/usr/bin/env bash
# Apply drydock-style branch protection to CodesWhat/careerrat `main` (via a ruleset).
#
# Mirrors drydock's "Main branch protection" ruleset: require a PR with 2 approvals,
# dismiss stale reviews on push, code-owner review, last-push approval, block force-push,
# block deletion, no bypass for anyone.
#
# required_status_checks lists the eight contexts promoted in #96. Contexts are JOB
# names, not workflow file names, so renaming a workflow file does not change them.
# Two PR checks are deliberately NOT required because they fail for reasons unrelated
# to the code: `qlty check` (Qlty Cloud minutes, distinct from the in-repo `qlty` job)
# and `Vercel` (deploy quota).
#
# Still omits drydock's code_scanning rule: CodeQL runs as the `analyze
# (javascript-typescript)` required check instead of through the code_scanning rule.
#
# Usage:
#   bash scripts/protect-main.sh            create the ruleset if absent, else verify
#   bash scripts/protect-main.sh --verify   verify only, never writes
#
# Exit 0 = live protection matches this file. Exit 1 = drift (or a failed create).
#
# --- Why the verify step exists -------------------------------------------------
# Contexts get added to a ruleset live, in the UI, while someone is unblocking an
# urgent thing, and nobody circles back to this file. The file then declares FEWER
# gates than are actually enforced, and re-establishing protection from it silently
# drops the difference. Overwriting protection with a smaller set is a perfectly
# valid API call, so there is no error to notice: the repo keeps looking protected
# while real security gates are gone. This fired in portwing (portwing#164), where a
# routine re-apply would have dropped four checks including three security gates.
#
# careerrat's create path has always been guarded (it refuses to touch an existing
# ruleset), but its own remediation advice used to be "delete + re-run", which is the
# same hazard by a longer route: the delete drops main to zero protection, and the
# re-run restores only what this file happens to declare. So the fix is the same one
# portwing took, a pre-flight diff that fails on ANY difference, not just on contexts.
# See careerrat#111.
set -euo pipefail

# Context names sort differently under other collations, and a comparison over two
# differently-sorted lists silently produces wrong output. Pin the collation for the
# whole script rather than per-sort, so this can't be lost when a sort is added.
export LC_ALL=C

REPO="CodesWhat/careerrat"
RULESET_NAME="Main branch protection"

VERIFY_ONLY=0
case "${1:-}" in
--verify) VERIFY_ONLY=1 ;;
"") ;;
*)
	echo "usage: bash scripts/protect-main.sh [--verify]" >&2
	exit 2
	;;
esac

# The single source of truth. Both the create path and the verify path read this,
# so they can never disagree about what "correct" means.
read -r -d '' DESIRED <<'JSON' || true
{
  "name": "Main branch protection",
  "target": "branch",
  "enforcement": "active",
  "conditions": { "ref_name": { "include": ["refs/heads/main"], "exclude": [] } },
  "rules": [
    { "type": "deletion" },
    { "type": "non_fast_forward" },
    { "type": "pull_request", "parameters": {
        "required_approving_review_count": 2,
        "dismiss_stale_reviews_on_push": true,
        "require_code_owner_review": true,
        "require_last_push_approval": true,
        "required_review_thread_resolution": false,
        "allowed_merge_methods": ["merge", "squash", "rebase"]
    } },
    { "type": "required_status_checks", "parameters": {
        "do_not_enforce_on_create": false,
        "strict_required_status_checks_policy": false,
        "required_status_checks": [
          { "context": "structure-guards" },
          { "context": "gitleaks" },
          { "context": "zizmor" },
          { "context": "actionlint" },
          { "context": "analyze (javascript-typescript)" },
          { "context": "dependency-review" },
          { "context": "qlty" },
          { "context": "knip" }
        ]
    } }
  ],
  "bypass_actors": []
}
JSON

# Reduce a ruleset (ours or the API's) to a canonical, comparable form: rules sorted
# by type, contexts sorted, and the API's own no-op defaults dropped.
#
# Dropping those defaults is narrow on purpose. `dismissal_restriction` and
# `required_reviewers` come back populated on every GET even though nothing set them,
# so comparing them raw reports drift on a ruleset that is byte-correct. They are only
# dropped when they hold their disabled/empty value — set to anything meaningful, they
# stay in the comparison and show up as drift, which is the point.
canonicalize() {
	jq -S '
    def drop_noop_defaults:
      if .dismissal_restriction == {"allowed_actors": [], "enabled": false}
        then del(.dismissal_restriction) else . end
      | if .required_reviewers == [] then del(.required_reviewers) else . end;

    {
      enforcement: .enforcement,
      bypass_actors: (.bypass_actors // [] | sort),
      conditions: (.conditions // {}),
      rules: (
        [ .rules[]
          | { type: .type,
              parameters: (
                (.parameters // {})
                | drop_noop_defaults
                | if has("required_status_checks")
                    then .required_status_checks |= sort_by(.context)
                    else . end
              )
            }
        ] | sort_by(.type)
      )
    }
  '
}

live_ruleset() {
	local id
	id="$(gh api "repos/$REPO/rulesets" --jq ".[] | select(.name == \"$RULESET_NAME\") | .id" 2>/dev/null || true)"
	[ -n "$id" ] || return 1
	gh api "repos/$REPO/rulesets/$id"
}

verify() {
	local live
	if ! live="$(live_ruleset)"; then
		echo "✗ no '$RULESET_NAME' ruleset on $REPO — main is UNPROTECTED." >&2
		echo "  run:  bash scripts/protect-main.sh" >&2
		return 1
	fi

	local want got
	want="$(printf '%s' "$DESIRED" | canonicalize)"
	got="$(printf '%s' "$live" | canonicalize)"

	if [ "$want" = "$got" ]; then
		echo "✓ live protection on $REPO main matches scripts/protect-main.sh."
		printf '%s' "$got" | jq -r '
      "  \(.rules | map(.type) | join(", "))",
      "  required checks: \([.rules[] | select(.type == "required_status_checks")
                            | .parameters.required_status_checks[].context] | join(", "))"
    '
		return 0
	fi

	echo "✗ DRIFT between scripts/protect-main.sh and the live ruleset on $REPO." >&2
	echo >&2
	# Contexts called out separately from the raw diff: a removed required check is
	# the failure this guard exists for, and it should not need reading a JSON diff
	# to spot.
	local want_ctx got_ctx
	want_ctx="$(printf '%s' "$want" | jq -r '[.rules[] | select(.type == "required_status_checks") | .parameters.required_status_checks[].context] | .[]')"
	got_ctx="$(printf '%s' "$got" | jq -r '[.rules[] | select(.type == "required_status_checks") | .parameters.required_status_checks[].context] | .[]')"

	local only_live only_file
	only_live="$(comm -13 <(printf '%s\n' "$want_ctx") <(printf '%s\n' "$got_ctx"))"
	only_file="$(comm -23 <(printf '%s\n' "$want_ctx") <(printf '%s\n' "$got_ctx"))"

	# One context per line via sed, not `printf '- %s\n' $var`. Context names contain
	# spaces and parentheses ("analyze (javascript-typescript)"), so unquoted word
	# splitting would mangle exactly the check most likely to go missing.
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
	diff <(printf '%s\n' "$want") <(printf '%s\n' "$got") | sed 's/^/    /' >&2
	echo >&2
	echo "  Reconcile by hand. Do NOT delete the ruleset to re-create it: that drops main to" >&2
	echo "  zero protection, and the re-create restores only what this file declares." >&2
	echo "  Either edit the ruleset in the UI to match this file, or update this file to match" >&2
	echo "  the live set. History is authoritative if you need to establish when it changed:" >&2
	echo "    gh api repos/$REPO/rulesets --jq '.[] | select(.name == \"$RULESET_NAME\") | .id'" >&2
	echo "    gh api repos/$REPO/rulesets/{id}/history" >&2
	return 1
}

if [ "$VERIFY_ONLY" = 1 ]; then
	verify
	exit $?
fi

if live_ruleset >/dev/null 2>&1; then
	echo "→ a '$RULESET_NAME' ruleset already exists on $REPO — verifying instead of applying."
	verify
	exit $?
fi

printf '%s' "$DESIRED" | gh api -X POST "repos/$REPO/rulesets" --input -

echo "✓ applied. Verifying:"
verify
