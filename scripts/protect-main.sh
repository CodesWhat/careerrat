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
# Run:  bash scripts/protect-main.sh
set -euo pipefail
REPO="CodesWhat/careerrat"

if gh api "repos/$REPO/rulesets" --jq '.[].name' 2>/dev/null | grep -qx "Main branch protection"; then
	echo "✓ a 'Main branch protection' ruleset already exists on $REPO — nothing to do."
	echo "  (edit it in the UI or delete + re-run if you want to change it.)"
	exit 0
fi

gh api -X POST "repos/$REPO/rulesets" --input - <<'JSON'
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

echo "✓ applied. Verify:  gh api repos/$REPO/rulesets --jq '.[] | {name, enforcement}'"
