# Rolester Electron desktop

The Electron desktop app is the pilot product shell. It boots the local
Rolester server and opens the React app at `/app`; a first-run workspace opens
`/app/onboarding`. Generated tracker/static pages remain compatibility,
debug, or export support only, not the desktop pilot UX.

## Run in development

From the repo root:

```
npm run desktop
```

This runs `electron .` against the live checkout. It uses the same local data
root as other checkout-based commands and does not stage a packaged runtime.
Use it for development only.

Scripted verification (no window interaction, exits on its own):

```
npm --workspace apps/desktop run smoke
```

The smoke path boots the server, hits `GET /api/health` over loopback, verifies
the selected `/app` or `/app/onboarding` route returns the built SPA shell and
assets, prints `SMOKE OK` with the loopback URL, and exits 0. A window may
briefly open during boot.

## Build the pilot package

```
npm run desktop:dist
```

This runs the web app build, stages a self-contained engine copy into
`staging/rolester`, then runs `electron-builder --mac dmg`. The pilot target is
a signed and notarized macOS DMG. The staged runtime uses the same allowlist
`npm pack` ships, plus its own Agent SDK install, so the packaged app does not
reach back into the source checkout or root `node_modules`.

## Data root and AI runtime

In packaged mode, `ROLESTER_HOME` is set before any Rolester module is
imported. It points at Electron's per-user data directory:
`app.getPath("userData")/data`. Candidate setup, workspace state, SQLite data,
and `internal/ai.env` live there, outside the signed resources tree.

The packaged app detects supported AI CLIs in Finder-safe install locations and
uses an already-authenticated installed tool as its primary AI runtime. Rolester
stores only the selected runtime id; it never copies or persists the CLI's
credentials. A direct provider key and managed AI are explicit Advanced
fallbacks. Provider credentials written through `src/core/ai/ai-env.mjs` live in
`internal/ai.env` with local-only file permissions; no provider or Apple
credential is stored in the app bundle or tracked source.

## Signing and notarization

`apps/desktop/electron-builder.yml` enables `forceCodeSigning`, hardened
runtime entitlements, and notarization. electron-builder reads signing and
notarization credentials from the local keychain or CI environment. The tracked
config intentionally contains no Apple account, team, password, app-specific
password, or keychain-profile value.

Verify the app and DMG after a pilot build:

```
codesign -dv --verbose=2 dist/mac-arm64/Rolester.app
xcrun stapler validate dist/*.dmg
spctl --assess --type open --context context:primary-signature dist/*.dmg
```

## Runtime boundary

Normal desktop actions use local APIs, DB verbs, deterministic scanners,
bounded AI, and app-safe default runtime tools. The retained
`POST /api/skill/run` path is explicit tool-heavy support for workflows that
still need streamed `SKILL.md` execution; it is not a hidden implementation path
for normal `/app` buttons.

Auto-update readiness means this package is signed/notarized and the release
process can later attach an updater safely. The current desktop app does not
install updates itself; users still update the open-core CLI with
`rolester update`.
