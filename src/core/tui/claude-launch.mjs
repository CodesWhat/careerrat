import { homedir } from "node:os";
import { dirname, join } from "node:path";

// Claude Code walks up from its working directory for instruction files. A
// global install can sit inside someone else's repo (Homebrew's prefix is one),
// so those files would load into the job-search agent and prompt about imports.
export function claudeLaunchArgs(root, home = homedir()) {
  const excludes = [];
  for (let dir = dirname(root); ; dir = dirname(dir)) {
    excludes.push(join(dir, "CLAUDE.md"), join(dir, "CLAUDE.local.md"));
    // ~/.claude/rules holds the user's own rules, which should keep applying.
    if (dir !== home) excludes.push(join(dir, ".claude/rules/**"));
    if (dir === dirname(dir)) break;
  }
  return ["--settings", JSON.stringify({ claudeMdExcludes: excludes })];
}
