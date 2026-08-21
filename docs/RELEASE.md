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

1. Version bumped everywhere it lives in lockstep: `package.json`,
   `apps/desktop/package.json`, and the three sites `package-lock.json` carries
   it. `npm version <x.y.z> --no-git-tag-version` in the root and in
   `apps/desktop/` updates all five; editing `package.json` by hand updates
   one, which is exactly how the lockfile once sat at 0.9.0 while the
   published package was 0.10.0.
2. Convert `CHANGELOG.md`'s `## [Unreleased]` section into a
   `## [x.y.z] - YYYY-MM-DD` heading carrying the new version and today's date.
3. `docs/ROADMAP.md` (public) updated — shipped items reflect reality, planned
   list current. The private working roadmap lives under `.internal/roadmap/`.
   This comes before the validation steps on purpose: the placeholder linter
   and the privacy grep below scan the roadmap too, so an edit made after they
   ran ships unvalidated.
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

### Desktop Release Pipeline

Pushing a tag `vX.Y.Z` does the whole desktop release with no further human
action: `.github/workflows/desktop-release.yml` builds the app, signs and
notarizes the DMG, uploads it to that tag's GitHub release, and flips the
release from draft to published. Two jobs, in order:

1. **`build-notarize-upload`** (`macos-14`), checks out the tag, runs
   `npm run desktop:release` (build, sign, notarize, staple,
   Gatekeeper-verify, then `gh release upload`), creating the release as a
   draft first if one doesn't already exist for the tag. Fails fast, before
   any of that runs, if a required signing secret is missing.
2. **`publish-release`**, confirms the `.dmg` landed on the release, then
   `gh release edit "$tag" --draft=false`. This is the step that fires
   `publish.yml` (npm publish) and `release-assets.yml` (the .dmg detector
   below, which by now is a no-op since the asset is already there).

The Homebrew cask is not updated from this repo. `CodesWhat/homebrew-tap`
carries its own `update-careerrat-cask.yml` (cron plus manual dispatch) that
watches the latest published careerrat release, regenerates
`Casks/careerrat.rb` with this repo's `scripts/generate-homebrew-cask.sh`,
and commits the bump directly to the tap's `main` with its own
`GITHUB_TOKEN`, the same way the goreleaser-managed casks already land
there. No cross-repo credential lives in either repo's secrets.

`workflow_dispatch` (no inputs, matching `release-assets.yml`) backfills the
latest `vX.Y.Z` tag, re-running after a secrets fix for example, without
needing a new tag push.

The rest of this section, the release checklist, the manual publish order,
and the manual cask steps, is the fallback path: what to run by hand if the
pipeline needs debugging, a secret is temporarily unavailable, or you want to
verify a step in isolation.

#### One-time CI signing setup

The pipeline needs five repository secrets, set once
(`gh secret set <name> --repo CodesWhat/careerrat --body ...` or the
Settings → Secrets and variables → Actions UI):

| Secret | What it is | How to produce it |
| --- | --- | --- |
| `CSC_LINK` | Base64 of the Developer ID Application `.p12` certificate | `base64 -i DeveloperIDApplication.p12 \| pbcopy` |
| `CSC_KEY_PASSWORD` | The `.p12`'s export password | Set when exporting the cert from Keychain Access |
| `APPLE_API_KEY` | Base64 of the App Store Connect API key `.p8` | `base64 -i AuthKey_XXXXXXXXXX.p8 \| pbcopy` |
| `APPLE_API_KEY_ID` | The API key's Key ID | App Store Connect → Users and Access → Integrations → Team Keys |
| `APPLE_API_ISSUER` | The API key's Issuer ID | Same Integrations page, above the key list |

`build-notarize-upload`'s first real step checks all five secrets are set and
fails with a clear list of what's missing rather than failing deep inside an
electron-builder or notarytool error.

#### Manual fallback: building and verifying locally

1. Build the desktop artifact with `npm run desktop:dist`. The command signs and notarizes the app
   and DMG container, staples the DMG ticket, and fails unless Gatekeeper verification passes.
2. Confirm the output includes a signed and notarized macOS DMG.
3. Verify signing and notarization evidence:
   - `codesign -dv --verbose=2 apps/desktop/dist/mac-arm64/CareerRat.app`
   - `xcrun stapler validate apps/desktop/dist/*.dmg`
   - `spctl --assess --type open --context context:primary-signature apps/desktop/dist/*.dmg`
4. Run packaged smoke checks for a fresh workspace and an existing workspace.
   Fresh workspace should open `/app/onboarding`; existing workspace should open
   `/app`.
5. Verify the packaged app runs without the source checkout and writes user data
   under the packaged `CAREERRAT_HOME` data root, not inside signed resources.
6. Confirm no Apple credentials, candidate data, workspace files, private paths,
   or local keychain-profile values are tracked or included in release notes.
7. Record final rollup evidence for the signed/notarized artifact, stapling,
   Gatekeeper assessment, fresh/existing workspace smoke, and checkout
   independence.

#### Manual fallback: publishing a desktop release

A GitHub release with no `.dmg` attached is a defect, not a formality:
nobody can download the app from it. Publishing the release is what fires
`publish.yml`, so the .dmg has to be uploaded before that happens, not after.
Follow this order:

Resolve the tag once and reuse it, so nothing below depends on retyping a
version correctly:

```bash
tag="$(git describe --tags --exact-match)"
```

1. Create the GitHub release as a **draft** first, from that tag:
   `gh release create "$tag" --draft --title "$tag" --generate-notes`.
2. Run `npm run desktop:release` from the repo root. It builds, signs,
   notarizes, staples, verifies (fails closed on Gatekeeper), and uploads the
   `.dmg` to the draft release via `gh release upload`.
3. Confirm the upload: `gh release view "$tag" --json assets` should list a
   `.dmg` whose name carries the version.
4. Only then publish the release: `gh release edit "$tag" --draft=false`.
   This is the step that fires `publish.yml` and pushes to npm.

The `release-assets` workflow checks every published release for a matching
`.dmg` asset and fails loudly if one is missing. It runs alongside
`publish.yml`, not before it, so it is a detector, not a blocker: it cannot
stop npm publish from firing. If it flags a release, run
`npm run desktop:release` to upload the missing asset. A manual
`workflow_dispatch` run takes no tag and always checks the **latest**
published release, so re-running it only confirms the repair while the
flagged release is still the latest one. If a newer release has landed since,
verify the repaired one directly with
`gh release view "$tag" --json assets` instead.

#### Manual fallback: updating the Homebrew cask

The cask lives at `Casks/careerrat.rb` in the separate repo
`CodesWhat/homebrew-tap`, cloned locally at `~/code/codeswhat/homebrew-tap`.
`scripts/generate-homebrew-cask.sh` generates its body; the tap repo's own
`update-careerrat-cask.yml` workflow applies the bump automatically after a
release publishes, so this is only needed to debug or redo that step by hand.

1. After the GitHub release is published with its `.dmg` attached, run
   `scripts/generate-homebrew-cask.sh --write ~/code/codeswhat/homebrew-tap/Casks/careerrat.rb`.
   With no `--dmg`, it downloads the published DMG itself and hashes it, so
   the `sha256` provably matches what users download.
2. Verify before opening the PR. The cask has to be reachable through a tap
   for most of these to work, and a bare file path is not, so stage the
   generated file into the local tap clone first. That is a different
   directory from the working clone in step 1:

   ```bash
   tap="$(brew --repository codeswhat/tap)"
   cp ~/code/codeswhat/homebrew-tap/Casks/careerrat.rb "$tap/Casks/careerrat.rb"
   brew style "$tap/Casks/careerrat.rb"
   brew audit --cask codeswhat/tap/careerrat
   brew livecheck --cask codeswhat/tap/careerrat
   ```

   Skip `--new`. That flag adds homebrew-cask core rules such as the
   "repository not notable enough" star count, which do not apply to a private
   tap.

   The strongest check is a real install of the edited cask, which proves the
   `sha256` matches the published artifact and that the app Gatekeeper sees is
   the notarized one:

   ```bash
   brew install --cask codeswhat/tap/careerrat
   spctl --assess --type execute --verbose=2 /Applications/CareerRat.app
   brew uninstall --cask careerrat
   ```

   `spctl` should report `accepted` and `source=Notarized Developer ID`. Then
   remove the staged copy so the tap clone is pristine again:
   `rm "$tap/Casks/careerrat.rb"`. Use `brew uninstall` without `--zap`, since
   `--zap` deletes the local job search.
3. Deliver as a reviewed PR against the tap's `main`, matching how idlescreen
   lands. Do not push directly; the tap's `main` is protected.

`depends_on macos:` must match the `LSMinimumSystemVersion` electron-builder
bakes into the bundle (currently 12.0, so `:monterey`).

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
