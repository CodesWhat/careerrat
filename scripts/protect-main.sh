#!/usr/bin/env bash
# Apply drydock-style branch protection to CodesWhat/careerrat `main` (via a ruleset).
#
# Mirrors drydock's "Main branch protection" ruleset: require a PR with 2 approvals,
# dismiss stale reviews on push, code-owner review, last-push approval, block force-push,
# block deletion, no bypass for anyone.
#
# Deliberately OMITS two of drydock's rules until careerrat has the matching infra:
#   - required_status_checks (drydock gates on Build/Lint/Test/E2E) — careerrat has no
#     PR CI yet and the suite is red; requiring checks that never pass blocks all merges.
#   - code_scanning (CodeQL) — not enabled on careerrat yet.
# Add both back here once a green PR CI workflow + CodeQL are in place.
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
    } }
  ],
  "bypass_actors": []
}
JSON

echo "✓ applied. Verify:  gh api repos/$REPO/rulesets --jq '.[] | {name, enforcement}'"
