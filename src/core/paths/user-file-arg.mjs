import { existsSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { userPath } from "./workspace.mjs";

// Skills name files as `workspace/...` or `candidate/...`, which live under the
// user's data root, not the shell's current directory. Try the working
// directory first (so a real relative path still wins), then the data root.
// Returns { path, tried }: path is null when nothing exists.
export function resolveUserFileArg(arg, { cwd = process.cwd(), repoRoot, env } = {}) {
  const value = String(arg ?? "");
  const tried = [];
  const candidates = [isAbsolute(value) ? value : join(cwd, value)];
  if (!isAbsolute(value) && /^(workspace|candidate|config)(\/|\\|$)/.test(value)) {
    candidates.push(userPath({ repoRoot, env }, value.replaceAll("\\", "/")));
  }
  for (const candidate of candidates) {
    tried.push(candidate);
    if (existsSync(candidate)) return { path: candidate, tried };
  }
  return { path: null, tried };
}
