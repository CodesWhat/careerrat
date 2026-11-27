# Release & Versioning Policy

## Semantic Versioning

CareerRat follows [Semantic Versioning](https://semver.org/). The project is
currently in **0.x** — the minor version increments for new features and the
patch version for bug fixes. While in 0.x, **any minor bump may contain
breaking changes**; read the release notes before upgrading.

Once 1.0.0 ships, the standard semver compatibility guarantees apply:

- **Patch** (0.x.**y**): backward-compatible bug fixes only.
- **Minor** (0.**x**.0): backward-compatible new features; may deprecate.
- **Major** (**x**.0.0): breaking changes; migration notes required.

## Release Checklist

Before tagging a release:

1. Version bumped everywhere it lives in lockstep: `package.json` and the
   sites `package-lock.json` carries it. `npm version <x.y.z> --no-git-tag-version`
   in the root updates all of them; editing `package.json` by hand updates
   one, which is exactly how the lockfile once sat at 0.9.0 while the
   published package was 0.10.0.
2. Convert `CHANGELOG.md`'s `## [Unreleased]` section into a
   `## [x.y.z] - YYYY-MM-DD` heading carrying the new version and today's date.
3. The local `.planning/` roadmap is current. It is intentionally gitignored and
   never ships in the npm package or public documentation.
4. All tests pass: `npm test`. Run this after the version bump and changelog
   conversion (steps 1 and 2), not before:
   `tests/release-consistency.test.mjs` hard-fails unless the newest
   `CHANGELOG.md` heading matches `package.json`'s version and carries a real
   date, so a green run here proves the release state, not the pre-release one.
5. Doctor reports clean: `careerrat doctor`
6. Placeholder linter is clean: `npm run lint:placeholders`
7. **Privacy/public-split check** — grep all tracked files (`git ls-files`) for
   the private origin codename and any personal identity strings — must return
   nothing. Confirm that gitignored private paths (the private working roadmap,
   internal JSON artifacts, `candidate/`, `workspace/`) remain untracked:
   `git status --ignored` must not show any of them as staged or tracked.
8. `README.md` version badge is still the dynamic npm badge
   (`img.shields.io/npm/v/careerrat`, not a hardcoded version) and the install
   snippet still resolves correctly.
9. Git tag created with the concrete release version, for example
   `git tag -s v0.4.0 -m "release: v0.4.0"`, then pushed.
10. GitHub release created from the tag with changelog notes.

The maintainer's personal privacy sentinels live in the ignored
`.internal/personal-sentinels.json` file as a nonempty JSON array of strings.
`CAREERRAT_PERSONAL_SENTINELS_FILE` selects another private file;
`CAREERRAT_PERSONAL_SENTINELS` supplies the same JSON directly and takes precedence.
Keep the list out of tracked files. GitHub Actions uses the repository secret
`CAREERRAT_PERSONAL_SENTINELS` for trusted releases. Release creation refuses a
missing or invalid list, and npm publishing scans tracked source and built web
assets before publication. Only the privacy-check step receives the list.
Ordinary PR and fork CI runs the generic privacy checks and skips the two
personal-list scans when private configuration is unavailable.

### Native-runtime search certification

Native Claude and Codex live-search evidence is a separate product-certification
check, not a tag or packaged-release prerequisite. Open-web result mix and paid
runtime availability are external state, so requiring fresh receipts for every
patch can reject a healthy build after all deterministic product checks pass.

Run the live fixtures when the native runtime adapters, unified search, search
workflow, canonical capture, or ranking behavior changes, and on the scheduled
certification cadence. `npm run qa:native-search:evidence` validates a completed
evidence set. Keep its exact-source, native-runtime, canonical-readback, and
manual-liveness checks strict. The source-checkout command fails when any receipt
is missing or stale. Do not weaken those checks to make a release pass.

Every release still requires the protected unit, integration, browser, and build
matrix. The tag pipeline separately checks the signed tag, confirms the tag's
version matches `package.json`, publishes the GitHub release from the changelog,
and then publishes npm and the SBOM.

### Release pipeline

Pushing a signed annotated tag `vX.Y.Z` on protected `main` runs
`.github/workflows/release.yml`. There is no Mac or Windows build in the chain.

1. **`resolve-tag`** resolves the tag once (from the push ref, or the newest tag
   by semver order on a dispatch). It rejects lightweight or unsigned tags
   through GitHub's tag API, requires the tagged commit to be reachable from
   protected `main`, and requires the tag's version to equal `package.json`'s
   `version` at that tag.
2. **`publish-release`** fails closed if the tag already has a release. It
   extracts the matching `## [x.y.z]` section from `CHANGELOG.md` at the tag
   (failing if the section is missing or empty), creates the published
   (non-draft) release titled with the tag, then explicitly dispatches
   `publish.yml` (npm) and `sbom.yml`, both pinned to the tag. GitHub suppresses
   workflows triggered by events created with `GITHUB_TOKEN` but permits
   `workflow_dispatch`, so the job waits for both runs and fails if either
   fails.

`publish.yml` independently resolves the tag's release and refuses to publish
unless it is published (not a draft) and its tag equals `package.json`'s
version. npm trusted publishing is bound to the `publish.yml` file name, so
don't rename it.

`workflow_dispatch` on `release.yml` (no inputs) backfills the newest `vX.Y.Z`
tag. It fails if that tag already has a release, so re-run `publish.yml` and
`sbom.yml` directly to repair a release whose follow-up jobs failed.

### Retired desktop build

The Mac and Windows desktop apps ended at v0.19.2 and the desktop release
workflow, signing setup and Homebrew cask are gone. npm (`publish.yml`) is the
only distribution channel.

## Website Preview Deploys

The Vercel project (root `apps/website`) is on the Hobby plan, which caps
deploys at 100 per day, so previews are limited in `apps/website/vercel.json`:

- Production deploys from `main` are unchanged.
- `git.deploymentEnabled` turns off deploys for every working-branch prefix
  this repo uses: `feat/`, `fix/`, `docs/`, `ci/`, `chore/`, `test/`,
  `refactor/`, `build/`, `perf/`, `style/`, `revert/`, `dev/`, `release/`,
  `renovate/`, `dependabot/`, `codex/` and `claude/`. Vercel counts a build
  canceled by the ignored-build step toward the daily cap, so this list is what
  actually saves deploys.
- To get a preview of a site change, push it on a `site/` branch. Any branch
  outside that list gets a preview only when the build inputs changed:
  `apps/website`, `apps/docs`, `scripts/build-docs-content.mjs`,
  `scripts/harden-static-html.mjs`, `src/core/security/browser-policy.mjs`
  (which that script imports), `package.json` or `package-lock.json`.
  `apps/website/scripts/vercel-ignore-build.sh` diffs against the last
  deployed commit (or the merge base with `main` on a branch's first push) and
  builds when it can't tell.
- If the site build starts reading a new path, add it to `SITE_PATHS` in the
  script.

## Schema Versioning

All JSON schemas live in `config/*.schema.json` and carry a `$id` URL of the
form:

```
https://careerrat.local/schemas/{schema-name}.schema.json
```

Schemas are versioned implicitly by the CareerRat release that ships them. A
schema change is treated as:

- **Non-breaking** if it only adds optional fields (patch or minor bump).
- **Breaking** if it removes, renames, or tightens required fields (major bump
  in 1.x; minor bump in 0.x with a migration note).

Breaking schema changes are documented in the release notes with a before/after
diff and migration instructions.

## User-Owned Files — Migration Policy

`candidate/` and `workspace/` are **user-owned**. CareerRat updates **never**
overwrite files in those directories. After updating CareerRat:

1. Run `careerrat doctor` — it will flag any schema mismatches or missing fields.
2. If new required fields were added, add them manually or re-run
   `careerrat ingest` in update mode (it prompts only for missing fields).
3. Workspace artefacts (jobs, tailored resumes, tracker) are forward-compatible;
   old files remain readable by newer versions.

If a breaking schema change requires a migration, the release notes will include
an explicit migration script or step-by-step instructions.
