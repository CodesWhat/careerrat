import { chmodSync, existsSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

const require = createRequire(import.meta.url);

export function preparePtyHelpers({
  moduleRoot = dirname(require.resolve("node-pty/package.json")),
  platform = process.platform,
  arch = process.arch,
} = {}) {
  if (platform === "win32") return [];
  const changed = [];
  for (const directory of ["build/Release", "build/Debug", `prebuilds/${platform}-${arch}`]) {
    const path = join(moduleRoot, directory, "spawn-helper");
    if (!existsSync(path)) continue;
    const stat = statSync(path);
    if (stat.isFile() && (stat.mode & 0o111) !== 0o111) {
      chmodSync(path, (stat.mode & 0o777) | 0o111);
      changed.push(path);
    }
  }
  return changed;
}
