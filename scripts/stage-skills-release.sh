#!/usr/bin/env bash
# Stage the last skills release for publishing under the careerrat name.
#
# Background: the working product is the skills release on `main` (tag
# rolester-skills-lock), published as rolester@0.5.2. careerrat.com tells
# people to run `npm install -g careerrat`, which currently resolves to an
# empty 0.0.1 placeholder. This republishes that same skills release as
# careerrat@0.5.2 so the install instruction is true.
#
# Why the package keeps a `rolester` bin alias: every SKILL.md on `main`
# instructs the agent to run `rolester <verb>` (31 occurrences in one file
# alone). A careerrat-only bin would ship a package whose own skills invoke a
# command that does not exist. The alias is not user-data back-compat, it is
# what makes the published tarball internally consistent. Renaming the skill
# text instead would mean redoing, on the frozen lineage, the rename that
# dev/v0.7 already did.
#
# This script does NOT publish. It builds and verifies a tarball, then prints
# the exact commands to run. Publishing needs `npm login` and is your call.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SRC_TAG="rolester-skills-lock"
PKG_VERSION="0.5.2"
WORKTREE="$REPO_ROOT/.claude/worktrees/skills-release"
OUT_DIR="$REPO_ROOT/.claude/skills-release-out"

cleanup_worktree() {
  if git -C "$REPO_ROOT" worktree list --porcelain | grep -qF "$WORKTREE"; then
    git -C "$REPO_ROOT" worktree remove --force "$WORKTREE"
  fi
}

echo "==> Staging $SRC_TAG as careerrat@$PKG_VERSION"

if ! git -C "$REPO_ROOT" rev-parse -q --verify "refs/tags/$SRC_TAG" >/dev/null; then
  echo "FATAL: tag $SRC_TAG not found. Nothing to stage." >&2
  exit 1
fi

cleanup_worktree
rm -rf "$OUT_DIR"
mkdir -p "$OUT_DIR"

# Detached worktree: reads the frozen tag, never moves a branch ref.
git -C "$REPO_ROOT" worktree add --detach "$WORKTREE" "$SRC_TAG" >/dev/null
echo "    worktree: $WORKTREE (detached at $SRC_TAG)"

# Rename the package and expose both bin names. node over sed so we fail loudly
# on an unexpected shape instead of silently writing nothing.
node - "$WORKTREE/package.json" "$PKG_VERSION" <<'NODE'
const { readFileSync, writeFileSync } = require("node:fs");
const [file, version] = process.argv.slice(2);
const pkg = JSON.parse(readFileSync(file, "utf8"));

if (pkg.name !== "rolester") {
  console.error(`FATAL: expected name "rolester", found "${pkg.name}"`);
  process.exit(1);
}
if (!pkg.bin || !pkg.bin.rolester) {
  console.error("FATAL: expected a rolester bin entry");
  process.exit(1);
}

const entry = pkg.bin.rolester;
pkg.name = "careerrat";
pkg.version = version;
// careerrat is what people type. rolester stays so this release's own
// SKILL.md instructions keep resolving.
pkg.bin = { careerrat: entry, rolester: entry };

writeFileSync(file, `${JSON.stringify(pkg, null, 2)}\n`);
console.log(`    package: ${pkg.name}@${pkg.version}`);
console.log(`    bin:     ${Object.keys(pkg.bin).join(", ")} -> ${entry}`);
NODE

# Rewrite `rolester <verb>` command instructions to `careerrat <verb>` so the
# help output and skill steps name the command people actually installed.
# Deliberately conservative: ONLY a lowercase `rolester` followed by a space and
# a verb. That leaves alone the things a blanket replace would corrupt:
# `.rolester` (the private data dir), `rolester.db`, `rolester.mjs`, and every
# uppercase `ROLESTER_*` env var. Those stay valid because the tarball keeps the
# rolester bin alias and its own data paths.
echo
echo "==> Rewriting printed command instructions"
node - "$WORKTREE" <<'NODE'
const { readdirSync, readFileSync, writeFileSync, statSync } = require("node:fs");
const { join } = require("node:path");

const root = process.argv[2];
const SKIP_DIRS = new Set(["node_modules", ".git", ".claude"]);
const EXTS = /\.(mjs|js|md|json|yml|yaml|html)$/;
// `rolester ` followed by a lowercase verb, a `<placeholder>`, or the banner's
// dash. Not preceded by a dot or word char, so `.rolester`, `rolester.db`, and
// `ROLESTER_` can never match.
const CMD = /(^|[^\w.])rolester (?=[a-z0-9<—$-])/g;

let files = 0;
let hits = 0;

function walk(dir) {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      walk(full);
      continue;
    }
    if (!EXTS.test(entry)) continue;
    const before = readFileSync(full, "utf8");
    const after = before.replace(CMD, "$1careerrat ");
    if (after === before) continue;
    hits += before.match(CMD).length;
    files += 1;
    writeFileSync(full, after);
  }
}

walk(root);
console.log(`    rewrote ${hits} command reference(s) across ${files} file(s)`);
NODE

# Guard: the rewrite must not have touched data paths or env var names.
for pattern in '\.careerrat' 'careerrat\.db' 'CAREERRAT_'; do
  if grep -rqE "$pattern" "$WORKTREE/src" "$WORKTREE/bin" 2>/dev/null; then
    echo "FATAL: rewrite touched a data path or env name ($pattern). Not publishable." >&2
    cleanup_worktree
    exit 1
  fi
done
echo "    data paths and env names untouched (good)"

( cd "$WORKTREE" && npm pack --pack-destination "$OUT_DIR" >/dev/null 2>&1 )

TARBALL="$(find "$OUT_DIR" -name '*.tgz' -maxdepth 1 | head -1)"
if [ -z "$TARBALL" ]; then
  echo "FATAL: npm pack produced no tarball." >&2
  cleanup_worktree
  exit 1
fi

echo
echo "==> Tarball contents check"
tar -tzf "$TARBALL" | sed 's|^package/||' | sort > "$OUT_DIR/filelist.txt"
echo "    files:     $(wc -l < "$OUT_DIR/filelist.txt" | tr -d ' ')"
echo "    size:      $(du -h "$TARBALL" | cut -f1 | tr -d ' ')"
echo "    bin/:      $(grep -c '^bin/' "$OUT_DIR/filelist.txt" || true)"
echo "    skills:    $(grep -c 'SKILL.md$' "$OUT_DIR/filelist.txt" || true)"

# The published tarball must not carry local candidate data. Belt and braces on
# top of the repo's own release-safety test.
if grep -qE '^(\.rolester|\.careerrat|candidate/|workspace/)' "$OUT_DIR/filelist.txt"; then
  echo
  echo "FATAL: tarball contains private workspace paths. Do not publish." >&2
  grep -E '^(\.rolester|\.careerrat|candidate/|workspace/)' "$OUT_DIR/filelist.txt" >&2
  cleanup_worktree
  exit 1
fi
echo "    private:   none found (good)"

cleanup_worktree

cat <<EOF

==> Staged. Nothing has been published.

  tarball:  $TARBALL
  filelist: $OUT_DIR/filelist.txt

Inspect the file list, then run these yourself:

  npm login
  npm publish $TARBALL --access public
  npm deprecate rolester "Renamed to careerrat. Install careerrat instead: npm i -g careerrat"

Note: npm's trusted-publisher binding still points at CodesWhat/rolester and
publish.yml. Fix that in the npmjs.com UI before any CI-driven publish, or the
automated release will fail even though this manual one succeeds.
EOF
