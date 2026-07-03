# @rolester/web

The M7 Vite + React app shell, mounted at `/app` by the embedded server
(`src/cli/tracker-dev.mjs`). Private workspace — never published on its own;
only its built `dist/` output ships (see root `package.json#files`).

## Dev loop (two processes)

Vite's dev server gives you HMR for the SPA; it proxies `/api` and `/fonts`
traffic to a separately-running `tracker-dev` instance rather than
re-implementing any of that server's behavior (skill execution, candidate
file writes, the sqlite data layer, …).

Terminal 1 — the embedded app server (unchanged):

```
npm run tracker:dev
```

Terminal 2 — the SPA's own dev server, from the repo root:

```
npm run app:dev
```

Then open `http://localhost:5173/app` (Vite's default dev port). Both SSE
shapes this codebase uses — `GET` (`EventSource`) and hand-parsed `POST`
streams — pass through Vite's proxy untouched.

## Production build

```
npm run app:build
```

Builds `apps/web/dist/`, which `tracker-dev.mjs` then serves at `/app/*`
(with SPA fallback for client-side routes) whether run via
`rolester tracker-dev`, the packaged Electron desktop app, or after
`npm install rolester` from npm. `npm pack`/`npm publish` also run this build
automatically via the root `prepack` script, so a broken SPA build fails the
publish step instead of shipping stale/missing output.
