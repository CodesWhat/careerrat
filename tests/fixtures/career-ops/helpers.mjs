import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../../..");
export const NODE = process.execPath;

let passed = 0;
let failed = 0;
let warnings = 0;
const failureMessages = [];

export function pass() {
  passed += 1;
}

export function fail(message) {
  failed += 1;
  failureMessages.push(String(message));
}

export function warn() {
  warnings += 1;
}

export function results() {
  return { passed, failed, warnings, failureMessages: [...failureMessages] };
}

export function run(command, args = [], options = {}) {
  try {
    return execFileSync(command, args, {
      cwd: ROOT,
      encoding: "utf8",
      timeout: 30_000,
      ...options,
    }).trim();
  } catch {
    return null;
  }
}

export async function captureConsoleErrors(fn) {
  const errors = [];
  const original = console.error;
  console.error = (message) => errors.push(message);
  try {
    const result = await fn();
    return { result, errors };
  } finally {
    console.error = original;
  }
}
