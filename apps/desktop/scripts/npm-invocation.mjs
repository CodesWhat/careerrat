export function npmInvocation(args, options = {}) {
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
