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

1. All tests pass: `npm test`
2. Doctor reports clean: `careerrat doctor`
3. Placeholder linter is clean: `npm run lint:placeholders`
4. **Privacy/public-split check** — grep all tracked files (`git ls-files`) for
   the private origin codename and any personal identity strings — must return
   nothing. Confirm that gitignored private paths (the private working roadmap,
   internal JSON artifacts, `candidate/`, `workspace/`) remain untracked:
   `git status --ignored` must not show any of them as staged or tracked.
5. `docs/ROADMAP.md` (public) updated — shipped items reflect reality, planned
   list current. The private working roadmap lives under `.internal/roadmap/`.
6. `README.md` version badge / install snippet reflects new version (if any).
7. `package.json` version bumped.
8. Git tag created with the concrete release version, for example
   `git tag -s v0.4.0 -m "release: v0.4.0"`, then pushed.
9. GitHub release created from the tag with changelog notes.

### Desktop Pilot Release

For a desktop pilot release, add these checks before tagging:

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

### Publishing a Desktop Release

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
