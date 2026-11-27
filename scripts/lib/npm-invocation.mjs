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
  if (platform === "win32") return { file: "npm.cmd", args, shell: true };
  return { file: "npm", args, shell: false };
}
