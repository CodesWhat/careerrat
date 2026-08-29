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
3. The local `.planning/` roadmap is current. It is intentionally gitignored and
   never ships in the npm package, desktop app, or public documentation.
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

The public trust rules for both platforms are in the
[Code signing policy](CODE_SIGNING_POLICY.md). Windows install, privacy, removal,
and Store-readiness details are in [Windows installation and release status](WINDOWS.md).

Pushing a tag `vX.Y.Z` runs the whole desktop release:
`.github/workflows/desktop-release.yml` builds the app, signs and notarizes the
DMG, builds the exact-version updater ZIP and `latest-mac.yml`, uploads that
atomic macOS release bundle to the tag's GitHub release, and flips the release
from draft to published only after all three assets are present. The DMG remains
the direct-download and Homebrew artifact; the ZIP and manifest are the in-app
update feed. All three must land before the workflow may publish the release.
macOS is unattended after its one-time setup. An enabled Windows
signing request waits for the required SignPath approval. The Windows lane builds
and fully smokes an
NSIS package too, but attaches it only after a valid SignPath Foundation
Authenticode signature. Until Windows signing is approved and configured, that
unsigned installer remains an Actions-only QA artifact. Five jobs enforce the
order:

1. **`resolve-tag`**, resolves and validates the `vX.Y.Z` tag once (from the
   push ref, or the newest tag by semver order on a dispatch) and threads it
   to the other jobs. It rejects lightweight or unsigned tags through GitHub's
   tag API and requires the tagged commit to be reachable from protected `main`,
   so no build starts without the reviewed, signed release boundary and no job
   ever splices an unvalidated ref into a script.
2. **`prepare-draft-release`**, creates or reuses exactly one draft for the tag.
   It records that draft's immutable GitHub release id and fails closed if the
   tag already has a published release.
3. **`build-notarize-upload`** (`macos-15`, arm64), checks out the tag, refuses to
   build if the tag doesn't match `apps/desktop/package.json`'s version,
   installs dependencies, and builds and stages the app before any signing
   material exists. It then checks the required secrets, imports the signing
   identity into a short-lived keychain, and signs and notarizes the app and
   DMG. While that same identity is still available, it downloads the greatest
   earlier stable release's updater ZIP and manifest, verifies their checksum,
   extracts and Gatekeeper-checks the actual prior app, and requires its bundled
   acceptance hook to perform a real native update from the final ZIP over a
   loopback feed. The one bootstrap after public 0.16.3 may build a synthetic
   0.16.3 fixture because that release predates the updater ZIP and acceptance
   hook. Every later missing feed or incompatible prior app fails closed. The
   restarted app must report the release version without losing its isolated
   data. It removes the API key, certificate, and keychain only after that
   transition passes. The job then Gatekeeper-verifies and launches the
   exact signed app for its PDF and bundled-browser smoke. The release verifier
   selects exactly one ZIP carrying
   the package version, recomputes its SHA-512 and size, and requires both to
   match `latest-mac.yml`. It then uploads the DMG, exact-version updater ZIP,
   manifest, and generated blockmaps to the same immutable draft release.
4. **`build-windows-upload`** (`windows-latest`, x64), checks out the same tag,
   builds the NSIS installer with publishing forced off, then installs it and
   runs the packaged app/PDF/bundled-Chromium smoke before uninstalling. The
   unsigned installer is retained only as a labeled Actions artifact. When
   SignPath is enabled, the job submits that artifact, requires a valid
   Foundation Authenticode signer, repeats the installed smoke, writes its
   SHA-256 file, and only then uploads both to the draft release. Immediately
   before every macOS or Windows asset upload, the uploader resolves one exact
   tag match again and requires both the prepared release id and `draft:true`.
   Uploads do not replace an existing asset.
5. **`publish-release`**, waits for both platform jobs and confirms the DMG,
   exact-version updater ZIP, and single `latest-mac.yml` all landed before it
   may publish. It requires the `.exe` too when Windows signing reported success,
   then publishes and explicitly dispatches `publish.yml` (npm publish),
   `release-assets.yml` (the release-bundle verifier below), and `sbom.yml`. GitHub
   suppresses workflows triggered by events created with `GITHUB_TOKEN`, but
   explicitly permits `workflow_dispatch`, so each dispatch is pinned to the
   validated release tag after the complete macOS release bundle is present. The job
   waits for all three dispatched runs and fails if any one fails, so a green
   desktop release means npm, the complete Mac feed check, and the SBOM all completed.

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

The pipeline needs six repository secrets, set once
(`gh secret set <name> --repo CodesWhat/careerrat --body ...` or the
Settings → Secrets and variables → Actions UI):

| Secret | What it is | How to produce it |
| --- | --- | --- |
| `CSC_LINK` | Base64 of the Developer ID Application `.p12` certificate | `base64 -i DeveloperIDApplication.p12 \| pbcopy` |
| `CSC_KEY_PASSWORD` | The `.p12`'s export password | Set when exporting the cert from Keychain Access |
| `APPLE_API_KEY` | Base64 of the App Store Connect API key `.p8` | `base64 -i AuthKey_XXXXXXXXXX.p8 \| pbcopy` |
| `APPLE_API_KEY_ID` | The API key's Key ID | App Store Connect → Users and Access → Integrations → Team Keys |
| `APPLE_API_ISSUER` | The API key's Issuer ID | Same Integrations page, above the key list |
| `NATIVE_UPDATE_ACCEPTANCE_PRIVATE_KEY` | Stable Ed25519 PKCS#8 PEM matching the public key bundled in CareerRat | Preserve the private half of the acceptance signing pair as the multiline secret |

After dependency installation and credential-free app staging,
`build-notarize-upload` checks all six secrets and fails with a clear list of
what's missing before it materializes any signing file or starts
electron-builder or notarytool.

Windows signing stays inert until SignPath Foundation approves the project and
the SignPath organization is configured. After approval, configure these
repository Actions values exactly as issued by SignPath:

| Setting | Kind | Purpose |
| --- | --- | --- |
| `SIGNPATH_ENABLED` | Variable | Set to `true` only after every value below is live |
| `SIGNPATH_ORGANIZATION_ID` | Variable | Approved SignPath organization id |
| `SIGNPATH_PROJECT_SLUG` | Variable | Approved CareerRat project slug |
| `SIGNPATH_ARTIFACT_CONFIGURATION_SLUG` | Variable | Approved NSIS artifact configuration |
| `SIGNPATH_API_CREDENTIAL` | Secret | Credential used by the pinned SignPath GitHub action |

The workflow uses the `release-signing` policy slug and waits for approval. Do
not enable the variable before that policy, artifact configuration, roles, and
MFA requirements in the [Code signing policy](CODE_SIGNING_POLICY.md) are in
place. The artifact configuration must accept a GitHub ZIP artifact, enforce the
CareerRat product name, and require the `version` parameter the workflow passes.
The approval wait is one hour; a timed-out request fails the Windows release
instead of publishing an unsigned substitute.

The Foundation application and account acceptance are external identity and
terms actions for an authorized CodesWhat owner. After approval, configure a
separate CI submitter and human approver in SignPath, require one approver per
release, link the CareerRat project to the GitHub.com trusted build system, and
install the SignPath GitHub App for this repository if SignPath requires it.
Keep `SIGNPATH_ENABLED` false until SignPath has issued and tested every value
above. An unsigned `.exe` is never a manual substitute for this gate.

Windows self-update stays disabled even when an Authenticode-signed installer is
published. SignPath signs the NSIS installer after electron-builder creates it,
which changes the bytes after its update metadata and blockmap were generated.
Enable Windows self-update only after the workflow produces and verifies a feed
against the exact signed installer users receive. Never publish an unsigned or
metadata-mismatched update as a fallback.

#### Manual fallback: building and verifying locally

1. Build the desktop artifact with `npm run desktop:dist`. The command signs and notarizes the app
   and DMG container, staples the DMG ticket, and fails unless Gatekeeper verification and the
   exact signed app's packaged smoke both pass.
2. Confirm the output includes a signed and notarized macOS DMG, exactly one
   updater ZIP carrying the package version, and `latest-mac.yml`.
3. Verify signing and notarization evidence:
   - `codesign -dv --verbose=2 apps/desktop/dist/mac-arm64/CareerRat.app`
   - `xcrun stapler validate apps/desktop/dist/*.dmg`
   - `spctl --assess --type open --context context:primary-signature apps/desktop/dist/*.dmg`
4. Run `npm run verify:release --workspace apps/desktop`. In addition to the
   signature checks above, it recomputes the updater ZIP's SHA-512 and size and
   requires both to match `latest-mac.yml` before any upload.
5. Run `npm run verify:native-update --workspace apps/desktop` while the same
   Developer ID, notarization credentials, GitHub release credential, and
   `NATIVE_UPDATE_ACCEPTANCE_PRIVATE_KEY` remain available. It signs the exact
   request bytes, downloads and verifies the actual prior updater ZIP, checks
   the extracted app with codesign and Gatekeeper. It performs a native N-to-N+1 update
   from a loopback feed, waits for the updated app to restart and report
   the new version, and verifies that a CAREERRAT_HOME sentinel survived. Only
   the first release after public 0.16.3 may use the synthetic bootstrap; later
   missing or incompatible prior artifacts fail. The launched app receives none
   of the release, Apple, Developer ID, GitHub, or acceptance-signing secrets.
   The workflow runs this before removing its signing material and before
   uploading any asset.
6. Run packaged smoke checks for a fresh workspace and an existing workspace.
   Both should open the chat-first shell at `/app`; the fresh workspace should
   begin the conversational intake flow inside that shell.
7. Verify the packaged app runs without the source checkout and writes user data
   under the packaged `CAREERRAT_HOME` data root, not inside signed resources.
8. Confirm no Apple credentials, candidate data, workspace files, private paths,
   or local keychain-profile values are tracked or included in release notes.
9. Record final rollup evidence for the signed/notarized artifact, stapling,
   Gatekeeper assessment, fresh/existing workspace smoke, and checkout
   independence.

Packaged macOS builds check at most once a day when automatic checks are enabled.
An available release downloads in the background, then waits at **Restart and
install**. That action first shuts down CareerRat's app services and agent child
processes, then hands the ready update to the native installer. An ordinary quit
does not install a downloaded update. The current version keeps working after a
download, verification, or install-start failure.

#### Manual fallback: publishing a desktop release

A GitHub release without the complete macOS bundle is a defect, not a
formality. The DMG is the direct installer and Homebrew input; the exact-version
updater ZIP plus `latest-mac.yml` make in-app updates work. Publishing the
release is what fires `publish.yml`, so all three must be uploaded before that
happens, not after. Follow this order:

Resolve the tag once and reuse it, so nothing below depends on retyping a
version correctly:

```bash
tag="$(git describe --tags --exact-match)"
```

1. Create the GitHub release as a **draft** first, from that tag:
   `gh release create "$tag" --draft --title "$tag" --generate-notes`.
2. Run `npm run desktop:release` from the repo root. It builds, signs,
   notarizes, staples, verifies (fails closed on Gatekeeper and the exact signed
   app smoke, plus manifest SHA-512 and size parity), and uploads the DMG,
   exact-version updater ZIP, `latest-mac.yml`, and generated blockmaps to the
   draft release via `gh release upload`.
3. Confirm the upload: `gh release view "$tag" --json assets` should list a
   versioned `.dmg`, exactly one `.zip` carrying the same version, and exactly
   one `latest-mac.yml`.
4. Only then publish the release: `gh release edit "$tag" --draft=false`.
   This is the step that fires `publish.yml` and pushes to npm.

`publish.yml` independently resolves that exact tag's GitHub Release and
refuses to publish unless the release is public and already carries the
version-matching DMG, exact-version updater ZIP, and `latest-mac.yml`. The same gate applies to a direct tag-pinned
`workflow_dispatch`, so a manual retry cannot bypass signing and artifact
publication order.

The `release-assets` workflow checks every published release for the matching
DMG, exact-version updater ZIP, and single `latest-mac.yml`, and fails loudly
if any part is missing. It runs alongside
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
