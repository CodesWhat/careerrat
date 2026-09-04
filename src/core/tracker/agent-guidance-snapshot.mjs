// agent-guidance-snapshot.mjs — best-effort load of `careerrat doctor --json`'s
// `agentGuidance` block, for dashboard consumers (both the legacy render and
// M10's GET /api/data/dashboard). Extracted (M10, no behavior change) out of
// src/cli/tracker.mjs so the two callers share one implementation rather than
// two hand-copies drifting apart.
//
// Isolated in a CHILD PROCESS (not an in-process import of doctor.mjs)
// deliberately: doctor.mjs is a CLI entry script whose top-level module body
// IS the doctor run (including a `process.exit()` at the end) — importing it
// directly would execute the full doctor check as a side effect of loading
// this module, which is never what a dashboard render wants. Any failure
// (missing file, non-zero exit, unparsable stdout) degrades to `null` rather
// than throwing — agentGuidance is informational, never a hard dependency of
// a dashboard render.
import { execFile, spawnSync } from "node:child_process";
import { join } from "node:path";

function parseGuidance(stdout) {
  if (!stdout) return null;
  try {
    const data = JSON.parse(stdout);
    return data?.agentGuidance ?? null;
  } catch {
    return null;
  }
}

export function loadAgentGuidanceSnapshot({ root, env = process.env } = {}) {
  // ELECTRON_RUN_AS_NODE, scoped to this one child: under the desktop shell
  // process.execPath is the Electron binary, and without it this spawnSync
  // booted a whole new GUI app instance per dashboard request — each of
  // which served its own dashboard and spawned more (a GUI fork bomb).
  // A plain node parent ignores the variable entirely.
  const result = spawnSync(
    process.execPath,
    [join(root, "src/cli/doctor.mjs"), "--json", "--guidance-only"],
    {
      cwd: root,
      env: { ...env, ELECTRON_RUN_AS_NODE: "1" },
      encoding: "utf8",
    }
  );
  if (result.error || !result.stdout) return null;
  return parseGuidance(result.stdout);
}

function runDoctorAsync({ root, env }) {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [join(root, "src/cli/doctor.mjs"), "--json", "--guidance-only"],
      {
        cwd: root,
        env: { ...env, ELECTRON_RUN_AS_NODE: "1" },
        encoding: "utf8",
      },
      (error, stdout) => resolve(error ? null : parseGuidance(stdout))
    );
  });
}

export function createAgentGuidanceSnapshotLoader({
  runDoctor = runDoctorAsync,
  now = () => Date.now(),
  ttlMs = 30_000,
} = {}) {
  const entries = new Map();

  return async function loadAgentGuidance({ root, env = process.env } = {}) {
    const key = `${root || ""}\u0000${env.CAREERRAT_HOME || ""}`;
    const current = entries.get(key);
    const readAt = now();
    if (current?.hasValue && current.expiresAt > readAt) return current.value;
    if (current?.inFlight) return current.inFlight;

    const inFlight = Promise.resolve(runDoctor({ root, env }))
      .catch(() => null)
      .then((value) => {
        const resolved = value ?? (current?.hasValue ? current.value : null);
        entries.set(key, {
          hasValue: true,
          value: resolved,
          expiresAt: now() + ttlMs,
          inFlight: null,
        });
        return resolved;
      });
    entries.set(key, {
      hasValue: current?.hasValue ?? false,
      value: current?.value ?? null,
      expiresAt: current?.expiresAt ?? 0,
      inFlight,
    });
    return inFlight;
  };
}

export const loadAgentGuidanceSnapshotAsync = createAgentGuidanceSnapshotLoader();
