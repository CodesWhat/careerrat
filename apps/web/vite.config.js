import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// apps/web — source for the M7 SPA shell. Built output (dist/) is served in
// production by src/cli/tracker-dev.mjs at /app/* (see that file's
// serveApp()); base:"/app/" makes every built asset URL resolve correctly
// under that mount prefix regardless of what serves it.
//
// In dev, `vite` runs its own HMR server on its own port and proxies API,
// asset, and font traffic to a SEPARATELY-running `tracker-dev` instance rather than
// re-implementing any of that server's behavior — see apps/web/README.md for
// the two-process loop. This covers both SSE shapes already in this codebase
// (GET EventSource streams and hand-parsed POST streams): Vite's dev proxy
// streams/pipes rather than buffering, so both pass through untouched.
const TRACKER_DEV_TARGET = `http://127.0.0.1:${process.env.ROLESTER_DEV_PORT || 7777}`;
const BASE_PATH = process.env.VITE_BASE_PATH || "/app/";

export default defineConfig({
  base: BASE_PATH,
  plugins: [react()],
  build: {
    outDir: "dist",
  },
  server: {
    proxy: {
      "/api": { target: TRACKER_DEV_TARGET, changeOrigin: true },
      "/assets": { target: TRACKER_DEV_TARGET, changeOrigin: true },
      "/fonts": { target: TRACKER_DEV_TARGET, changeOrigin: true },
    },
  },
});
