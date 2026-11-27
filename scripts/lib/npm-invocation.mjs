import { existsSync } from "node:fs";
import { win32 } from "node:path";

function npmInvocation(args, options = {}) {
  const env = options.env || process.env;
  const execPath = options.execPath || process.execPath;
  const npmCliPath = env.npm_execpath;

  if (!npmCliPath) {
    throw new Error("npm CLI path is unavailable. Run this command through an npm script.");
  }

  return {
    file: execPath,
    args: [npmCliPath, ...args],
  };
}

// For scripts that may run without `npm run` (so no npm_execpath). On Windows
// npm is `npm.cmd`, which execFileSync can only start through a shell; elsewhere
// plain `npm` is fine. Prefers the Node-driven form whenever npm_execpath exists.
export function npmCommand(args, options = {}) {
  const env = options.env || process.env;
  const platform = options.platform || process.platform;
  if (env.npm_execpath) {
    const { file, args: nodeArgs } = npmInvocation(args, options);
    return { file, args: nodeArgs, shell: false };
  }
  if (platform === "win32") {
    // Prefer the npm CLI that ships next to node.exe: no cmd.exe, so no quoting.
    const exists = options.exists || existsSync;
    const execPath = options.execPath || process.execPath;
    const cli = win32.join(win32.dirname(execPath), "node_modules", "npm", "bin", "npm-cli.js");
    if (exists(cli)) return { file: execPath, args: [cli, ...args], shell: false };
    return { file: "npm.cmd", args: args.map(quoteForCmd), shell: true };
  }
  return { file: "npm", args, shell: false };
}

// cmd.exe splits unquoted arguments on spaces, so a temp path like
// "C:\Users\a b\Temp" breaks. Wrap anything with whitespace or cmd
// metacharacters in double quotes and double any embedded quotes.
function quoteForCmd(arg) {
  if (arg !== "" && !/[\s"&|<>^()%!,;=]/.test(arg)) return arg;
  return `"${arg.replaceAll('"', '""')}"`;
}
