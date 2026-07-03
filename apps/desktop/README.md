# Rolester desktop (M5 — thin Electron shell)

A native window over the same local server `rolester tracker-dev` already
serves in a browser. This shell never forks a skill itself — it boots
`createDevServer()` (see `../../src/cli/tracker-dev.mjs`) and loads its pages
into a `BrowserWindow`. All skill execution still runs through that one
embedded Agent SDK runtime.

## Run (dev)

From the repo root:

```
npm run desktop
```

This runs `electron .` against the live checkout — same candidate/workspace
data as `npm run tracker:dev`, no separate data root, no build step. This is
the primary POC deliverable and the one that has to work end to end.

Scripted verification (no window interaction, exits on its own):

```
cd apps/desktop && npx electron . --smoke
```

Boots the server, hits its own `GET /api/health` over loopback, prints
`SMOKE OK <url>`, and exits 0. A window may still flash open briefly during
boot — that's expected and harmless.

## Run (dist — best-effort)

```
npm run desktop:dist
```

This stages a self-contained copy of the engine into `staging/rolester`
(`scripts/stage.mjs` — the same allowlist `npm pack` ships, plus its own
`@anthropic-ai/claude-agent-sdk` install, so the packaged app doesn't reach
back into the repo checkout or its `node_modules`), then runs
`electron-builder --mac dmg`.

The packaged app writes its data (candidate/workspace/internal state) under
its own per-user data directory instead of a checkout — Electron's
`app.getPath("userData")/data`, laid out the same way the CLI's data root is
(`internal/ai.env` etc., just without the `.internal` dot-prefix the
in-checkout legacy layout uses). `ROLESTER_HOME` is set to that path before
any Rolester module is imported (see the trap comments in `main.mjs`).

### Signing

A `Developer ID Application` certificate (team ID `3524374A2S`) is already in
the keychain; electron-builder auto-discovers and uses it — nothing to
configure. Verify after a build:

```
codesign -dv --verbose=2 dist/mac-arm64/Rolester.app
```

### Notarization (deferred)

`electron-builder.yml` sets `mac.notarize: false` explicitly. No
`notarytool` keychain profile exists yet on this machine. One-time setup to
enable it later:

```
xcrun notarytool store-credentials "rolester-notary" \
  --apple-id <apple-id-email> \
  --team-id 3524374A2S \
  --password <app-specific-password>
```

Then flip `mac.notarize` back to `true` (or an object naming the
`rolester-notary` keychain profile) in `electron-builder.yml`.

## Honest POC boundaries

- The packaged app is **BYOK only** — there is no bundled/managed API key.
  The onboarding wizard's `/onboard` AI-key step is how a candidate enters
  their own Anthropic key; it's stored under the app's own data root, in
  `internal/ai.env` (loopback-only, never transmitted anywhere but the local
  server process — same mechanism the CLI already uses, see
  `../../src/core/ai/ai-env.mjs`).
- Notarization is off (see above) — a locally-built `.dmg` will trigger
  Gatekeeper's "unidentified developer" warning until notarization is wired
  up. Signing (not notarizing) is on, so the binary itself is tamper-evident.
- No auto-update, no crash reporting, no telemetry — none of that exists in
  this shell yet.
