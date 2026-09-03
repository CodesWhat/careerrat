# CareerRat Electron desktop

The Electron desktop app is the pilot product shell. It boots the local
CareerRat server and opens the chat-first React app at `/app`. First-run setup
and returning workspaces use that same shell.

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
that `/app` returns the built SPA shell and assets, renders a PDF through
Electron, and launches `about:blank` through the active Playwright adapter. A
packaged smoke uses the staged adapter and bundled Chromium. The command prints
`SMOKE OK` with the loopback URL and exits 0. A window may briefly open during
boot.

## Build the pilot package

```
npm run desktop:dist
```

This runs the web app build, stages a self-contained engine copy into
`staging/careerrat`, runs `electron-builder --mac dmg`, signs and notarizes the
DMG container, staples its ticket, then verifies the app signature, notarization
ticket, and Gatekeeper assessment. It then launches the exact signed app from
`dist/mac-arm64`, requires its packaged PDF and bundled-Chromium smoke to print
`SMOKE OK`, and exits
nonzero unless it produced a signed and notarized macOS DMG. The staged runtime
uses the same allowlist `npm pack` ships plus an isolated, exact dependency
manifest and lock installed with `npm ci`. That lock includes pinned Playwright
and matching Chromium installed hermetically under staged `node_modules`, but
excludes the proprietary Claude Agent SDK. The packaged app does not reach back
into the source checkout, root `node_modules`, or a developer browser cache.

Windows x64 packaging uses `npm run dist:windows --workspace apps/desktop`.
That command builds the same staged runtime and an unsigned NSIS installer with
electron-builder publication disabled. `npm run verify:windows --workspace
apps/desktop` runs only on Windows and installs, smokes, and uninstalls that
package. Unsigned outputs are QA artifacts only. Public release assets require
the Authenticode gate in [`docs/CODE_SIGNING_POLICY.md`](../../docs/CODE_SIGNING_POLICY.md).

## Data root and AI runtime

In packaged mode, `CAREERRAT_HOME` is set before any CareerRat module is
imported. It points at Electron's per-user data directory:
`app.getPath("userData")/data`. Candidate setup, workspace state, SQLite data,
and `internal/ai.env` live there, outside the signed resources tree.

CareerRat owns the workflows and threads, so durable product state stays
provider-neutral. Claude Code 2.1.241 or newer and OpenAI Codex are the two
supported product runtime choices. Both run the same
CareerRat-owned workflows, skills, and durable state. A runtime is
selectable only after Finder-safe detection confirms its availability,
authentication, and complete readiness check. Both adapters run fixed,
isolated invocations with an allowlisted process environment and only the
CareerRat capability requested for that call, including guarded public-web
research and one staged approved-file read when needed. Other detected CLIs are
diagnostic-only until they pass the same acceptance matrix.

CareerRat stores only the selected runtime id; it never copies or persists the
CLI's credentials, and the app never silently switches engines. The signed
artifact contains no Agent SDK or direct-provider fallback. Source development
can exercise provider fallback as a separate test-only path. Provider
credentials written through `src/core/ai/ai-env.mjs` live in `internal/ai.env`
with local-only file permissions; no provider or Apple credential is stored in
the app bundle or tracked source.

## Signing and notarization

`apps/desktop/electron-builder.yml` enables `forceCodeSigning`, hardened
runtime entitlements, and notarization. electron-builder reads signing and
notarization credentials from the local keychain or CI environment. The tracked
config intentionally contains no Apple account, team, password, app-specific
password, or keychain-profile value.

The release build runs these checks automatically. They can also be repeated manually:

```
codesign -dv --verbose=2 dist/mac-arm64/CareerRat.app
xcrun stapler validate dist/*.dmg
spctl --assess --type open --context context:primary-signature dist/*.dmg
```

## Runtime boundary

Normal desktop actions use local APIs, DB verbs, deterministic scanners, and
typed workspace workflows. The retained `POST /api/skill/run` path exposes only
`intake-extract` and `resume-extract`, each with one canonical uploaded file.
It is not a generic workflow or tool-heavy back door for `/app` buttons.

## In-app updates

The packaged Mac app uses pinned `electron-updater 6.8.9`. It checks the
GitHub release feed shortly after launch and then once every 24 hours, on by
default with an opt-out in Settings. “Check for Updates…” in the CareerRat
menu and “Check now” in Settings run one immediate check even when automatic
checks are off without changing that preference.

When a newer signed version exists, CareerRat downloads it in the app and
shows progress. Only the native `update-downloaded` event enables **Restart and install**.
CareerRat closes its chat runtime, browser sessions, PDF
renderer, file watchers, and local server before handing the completed update
to the native installer. Normal quits do not install a downloaded update.

The Mac release is one atomic feed: signed/notarized DMG, signed updater ZIP,
and `latest-mac.yml`. Release verification recomputes the manifest SHA-512 and
byte size against the exact ZIP before publication. Windows self-update stays
disabled until both the installed executable and final installer are signed
and the manifest is generated from those final signed bytes.

`apps/desktop/update-check.mjs` owns the typed updater state machine and daily
cadence. `main.mjs` owns native events, shutdown, and persisted settings in
`desktop-update-check.json` under `CAREERRAT_HOME`. The renderer never talks to
GitHub directly. `preload/update-check-preload.cjs` exposes only typed state,
check, preference, dismissal, and restart/install operations through Electron
IPC. Native updater errors remain in desktop logs; the app shows plain-English
recovery copy.
