#!/usr/bin/env node
// Background update check — spawned detached by the update-notifier. Looks up the
// latest published careerrat version and caches it under the workspace internal dir
// so the NEXT `careerrat <cmd>` run can print a "newer version available" notice
// without ever blocking on the network. Best-effort: stays silent on any failure.

import { fileURLToPath } from "node:url";
import { latestVersion, writeUpdateCache } from "../src/core/update/update-core.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const pathCtx = { repoRoot: root };

try {
  const latest = latestVersion("latest");
  if (latest) {
    writeUpdateCache(pathCtx, { latest, checkedAtMs: Date.now() });
  }
} catch {
  /* offline / npm missing — leave the cache as-is */
}
