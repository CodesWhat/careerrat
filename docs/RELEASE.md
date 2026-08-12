# Release & Versioning Policy

## Semantic Versioning

Rolester follows [Semantic Versioning](https://semver.org/). The project is
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
   list current. (The private working roadmap `ROADMAP.md` is gitignored.)
6. `README.md` version badge / install snippet reflects new version (if any).
7. `package.json` version bumped.
8. Git tag created: `git tag -s v<version> -m "release: v<version>"` then pushed.
9. GitHub release created from the tag with changelog notes.

## Schema Versioning

All JSON schemas live in `config/*.schema.json` and carry a `$id` URL of the
form:

```
https://rolester.local/schemas/<name>.schema.json
```

Schemas are versioned implicitly by the Rolester release that ships them. A
schema change is treated as:

- **Non-breaking** if it only adds optional fields (patch or minor bump).
- **Breaking** if it removes, renames, or tightens required fields (major bump
  in 1.x; minor bump in 0.x with a migration note).

Breaking schema changes are documented in the release notes with a before/after
diff and migration instructions.

## User-Owned Files — Migration Policy

`candidate/` and `workspace/` are **user-owned**. Rolester updates **never**
overwrite files in those directories. After updating Rolester:

1. Run `careerrat doctor` — it will flag any schema mismatches or missing fields.
2. If new required fields were added, add them manually or re-run
   `careerrat ingest` in update mode (it prompts only for missing fields).
3. Workspace artefacts (jobs, tailored resumes, tracker) are forward-compatible;
   old files remain readable by newer versions.

If a breaking schema change requires a migration, the release notes will include
an explicit migration script or step-by-step instructions.
