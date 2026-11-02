import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import { userPath } from "../paths/workspace.mjs";

function shimFor({ node, bin, platform }) {
  if (platform === "win32") {
    const quote = (value) => `"${value.replaceAll("%", "%%")}"`;
    return {
      name: "careerrat.cmd",
      text: `@echo off\r\n${quote(node)} ${quote(bin)} %*\r\n`,
    };
  }
  const quote = (value) => `'${value.replaceAll("'", `'\\''`)}'`;
  return {
    name: "careerrat",
    text: `#!/bin/sh\nexec ${quote(node)} ${quote(bin)} "$@"\n`,
  };
}

// Make `careerrat` inside the agent pane run this exact checkout or package,
// not whichever install comes first on PATH. Returns the environment to use.
export function withCareerratShim({
  repoRoot,
  env = process.env,
  platform = process.platform,
  node = process.execPath,
}) {
  const dir = userPath({ repoRoot, env }, ".internal/tui/bin");
  const { name, text } = shimFor({
    node,
    bin: join(repoRoot, "bin", "careerrat.mjs"),
    platform,
  });
  const file = join(dir, name);
  mkdirSync(dir, { recursive: true });
  let current = null;
  try {
    current = readFileSync(file, "utf8");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  if (current !== text) {
    const temp = join(dir, `.${name}.${process.pid}.tmp`);
    try {
      writeFileSync(temp, text, { mode: 0o755 });
      chmodSync(temp, 0o755);
      renameSync(temp, file);
    } catch (error) {
      rmSync(temp, { force: true });
      throw error;
    }
  }
  const pathKey =
    platform === "win32"
      ? (Object.keys(env).find((k) => k.toLowerCase() === "path") ?? "Path")
      : "PATH";
  return {
    ...env,
    [pathKey]: env[pathKey] ? `${dir}${delimiter}${env[pathKey]}` : dir,
  };
}
