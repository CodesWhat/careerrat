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
# This script does NOT publish. It builds a release BRANCH and verifies the
# tarball that branch would produce, then prints the remaining steps.
#
# Why a branch and not a local `npm publish`: .github/workflows/publish.yml
# publishes on GitHub Release via npm Trusted Publishing (OIDC), which needs no
# stored token and attaches a signed provenance attestation. A hand-publish from
# a laptop gets neither. But that workflow publishes whatever the repo contains
# at the release tag: dev/v0.7 would ship the unfinished 0.7.0 web app, and the
# skills tag still says `name: rolester`, so it would publish the OLD package.
# This branch is the missing piece, the skills release carrying careerrat's name.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SRC_TAG="rolester-skills-lock"
PKG_VERSION="0.5.2"
RELEASE_BRANCH="release/careerrat-$PKG_VERSION"
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

# Branch off the frozen tag. main is never touched, and re-running replaces the
# release branch rather than stacking commits on it.
if git -C "$REPO_ROOT" show-ref -q --verify "refs/heads/$RELEASE_BRANCH"; then
  git -C "$REPO_ROOT" branch -D "$RELEASE_BRANCH" >/dev/null
fi
git -C "$REPO_ROOT" worktree add -b "$RELEASE_BRANCH" "$WORKTREE" "$SRC_TAG" >/dev/null
echo "    worktree: $WORKTREE"
echo "    branch:   $RELEASE_BRANCH (from $SRC_TAG)"

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

// The repo URLs must name careerrat, not rolester. This is not cosmetic:
// npm verifies the sigstore provenance bundle against repository.url and
// rejects the publish outright (E422) when it names a different repo than
// the workflow that built it. GitHub redirects the old name, npm does not.
const REPO = "https://github.com/CodesWhat/careerrat";
if (pkg.repository?.url) pkg.repository.url = `git+${REPO}.git`;
if (pkg.homepage) pkg.homepage = `${REPO}#readme`;
if (pkg.bugs?.url) pkg.bugs.url = `${REPO}/issues`;

writeFileSync(file, `${JSON.stringify(pkg, null, 2)}\n`);
console.log(`    package: ${pkg.name}@${pkg.version}`);
console.log(`    bin:     ${Object.keys(pkg.bin).join(", ")} -> ${entry}`);
console.log(`    repo:    ${pkg.repository?.url ?? "(none)"}`);
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

# The verified tree becomes the release branch's commit. Committed in the
# worktree so the branch ref moves, then the worktree itself is disposable.
git -C "$WORKTREE" add -A
git -C "$WORKTREE" -c user.name="CodesWhat" -c user.email="sbenson@sypartners.com" \
  commit -q -m "chore(release): publish the skills release as careerrat@$PKG_VERSION

Republishes $SRC_TAG under the careerrat name so \`npm install -g careerrat\`
resolves to the working product instead of the 0.0.1 placeholder.

Renames the package, exposes both careerrat and rolester bins, and rewrites
printed \`rolester <verb>\` instructions to \`careerrat <verb>\`. The bin alias
stays because this release's own skills invoke it. Data paths (.rolester,
rolester.db) and ROLESTER_* env names are deliberately untouched."

COMMIT="$(git -C "$WORKTREE" rev-parse --short HEAD)"
cleanup_worktree

cat <<EOF

==> Release branch built. Nothing has been published or pushed.

  branch:   $RELEASE_BRANCH ($COMMIT)
  tarball:  $TARBALL   (verification only, not the publish artifact)
  filelist: $OUT_DIR/filelist.txt

Publishing goes through CI, not a laptop, so the package gets a signed
provenance attestation and no npm token is stored anywhere.

  1. npmjs.com -> careerrat -> Settings -> Trusted Publisher:
       GitHub Actions | CodesWhat/careerrat | publish.yml
     careerrat@0.0.1 was hand-published and has no attestation, so this
     binding does not exist yet. rolester has one; careerrat does not.

  2. git push -u origin $RELEASE_BRANCH

  3. Cut a GitHub Release targeting $RELEASE_BRANCH, tag v$PKG_VERSION-careerrat.
     publish.yml fires on release:published and publishes to the "latest"
     dist-tag (no hyphen in the package version, so it is not treated as an rc).

  4. Once it is live, retire the old name:
       npm deprecate rolester "Renamed to careerrat. Install careerrat instead: npm i -g careerrat"
EOF
