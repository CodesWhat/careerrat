#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const desktopRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

export function verifyPackagedSmoke({ appPath, dataDir, run = spawnSync }) {
  const executable = join(appPath, "Contents", "MacOS", "CareerRat");
  const childEnv = { ...process.env, CAREERRAT_HOME: dataDir };
  delete childEnv.CSC_LINK;
  delete childEnv.CSC_KEY_PASSWORD;
  delete childEnv.APPLE_API_KEY;
  delete childEnv.APPLE_API_KEY_ID;
  delete childEnv.APPLE_API_ISSUER;
  const result = run(executable, ["--smoke"], {
    encoding: "utf8",
    env: childEnv,
    timeout: 240_000,
  });
  const output = `${result.stdout || ""}\n${result.stderr || ""}`.trim();

  if (result.error || result.status !== 0) {
    throw new Error(
      `signed packaged app smoke failed${
        result.error ? `: ${result.error.message}` : ` with status ${result.status}`
      }${output ? `\n${output}` : ""}`
    );
  }
  if (!/SMOKE OK\s+http:\/\/127\.0\.0\.1:\d+/.test(output)) {
    throw new Error(`signed packaged app smoke did not report success${output ? `\n${output}` : ""}`);
  }
  return output;
}

async function main() {
  if (process.platform !== "darwin") {
    throw new Error("Signed packaged app verification must run on macOS.");
  }

  const pkg = JSON.parse(readFileSync(join(desktopRoot, "package.json"), "utf8"));
  const productName = pkg.build?.productName || "CareerRat";
  const appPath = join(desktopRoot, "dist", "mac-arm64", `${productName}.app`);
  if (!existsSync(appPath)) throw new Error(`Signed packaged app is missing: ${appPath}`);

  const scratch = mkdtempSync(join(tmpdir(), "careerrat-packaged-smoke-"));
  try {
    const output = verifyPackagedSmoke({ appPath, dataDir: join(scratch, "data") });
    process.stdout.write(`${output}\nPACKAGED SMOKE OK ${productName}.app\n`);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
