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

// For scripts that may run without `npm run` (so no npm_execpath). Always uses
// the npm that launched the script (npm_execpath), so CI's corepack-pinned npm
// is the one that runs. On Windows npm is `npm.cmd`, which can only start
// through a shell, so without npm_execpath we throw rather than guess an npm
// or quote arguments for cmd.exe. Elsewhere plain `npm` is fine.
export function npmCommand(args, options = {}) {
  const env = options.env || process.env;
  const platform = options.platform || process.platform;
  if (env.npm_execpath) return npmInvocation(args, options);
  if (platform === "win32") {
    throw new Error(
      "npm_execpath is not set. On Windows run this through npm (for example `npm run smoke:packed-install`) so the selected npm is used."
    );
  }
  return { file: "npm", args };
}
