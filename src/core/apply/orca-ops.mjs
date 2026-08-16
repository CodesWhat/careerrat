import { execFile } from "node:child_process";

// ---------------------------------------------------------------------------
// Orca CLI plumbing
// ---------------------------------------------------------------------------

function orcaExecutable(env) {
  const configured = String(env?.ORCA_CLI_COMMAND || "").trim();
  if (configured && !/\s/.test(configured)) return configured;
  return process.platform === "linux" && !env?.ORCA_WORKTREE_ID ? "orca-ide" : "orca";
}

export function runOrcaCommand(args, { env = process.env, cwd } = {}) {
  return new Promise((resolve, reject) => {
    execFile(
      orcaExecutable(env),
      args,
      {
        cwd,
        env,
        encoding: "utf8",
        maxBuffer: 12 * 1024 * 1024,
        timeout: 30_000,
        windowsHide: true,
      },
      (error, stdout) => {
        let payload = null;
        try {
          payload = JSON.parse(String(stdout || ""));
        } catch {
          payload = null;
        }
        if (error || !payload?.ok) {
          const failure = new Error(
            payload?.error?.message || error?.message || "The Orca browser command failed."
          );
          failure.code = payload?.error?.code || error?.code || "ORCA_BROWSER_FAILED";
          reject(failure);
          return;
        }
        resolve(payload.result || {});
      }
    );
  });
}

// ---------------------------------------------------------------------------
// Snapshot normalization — pinned NormalizedSnapshot contract, shared with the
// future Playwright ops adapter: { origin, pageText, refs: { [ref]: { role, name, required } } }.
// `required` is parsed once here from the raw "[required, ref=eN]" markers so
// the driver never re-parses accessibility-tree text for it.
// ---------------------------------------------------------------------------

function requiredRefsFromText(snapshotText) {
  const required = new Set();
  for (const line of String(snapshotText || "").split(/\r?\n/)) {
    const match = line.match(/ref=([\w-]+)/);
    if (match && /\[.*\brequired\b.*\]/.test(line)) required.add(match[1]);
  }
  return required;
}

function normalizeSnapshot(raw = {}) {
  const requiredRefs = requiredRefsFromText(raw.snapshot);
  const refs = {};
  for (const [ref, entry] of Object.entries(raw.refs || {})) {
    refs[ref] = {
      role: entry?.role,
      name: entry?.name,
      required: requiredRefs.has(ref),
    };
  }
  return { origin: raw.origin, pageText: raw.snapshot, refs };
}

// ---------------------------------------------------------------------------
// createOrcaOps — Orca CLI implementation of the provider-neutral ops contract.
// ---------------------------------------------------------------------------

export function createOrcaOps({ runOrcaImpl } = {}) {
  return {
    async openTab({ url }) {
      const opened = await runOrcaImpl(["tab", "create", "--url", url, "--json"]);
      return { pageId: String(opened?.browserPageId || "").trim() };
    },
    async snapshot({ pageId }) {
      const raw = await runOrcaImpl(["snapshot", "--page", pageId, "--json"]);
      return normalizeSnapshot(raw);
    },
    async fillField({ pageId, ref, value }) {
      return runOrcaImpl([
        "fill",
        "--page",
        pageId,
        "--element",
        `@${ref}`,
        "--value",
        String(value),
        "--json",
      ]);
    },
    async selectOption({ pageId, ref, value }) {
      return runOrcaImpl([
        "select",
        "--page",
        pageId,
        "--element",
        `@${ref}`,
        "--value",
        String(value),
        "--json",
      ]);
    },
    async toggleField({ pageId, ref }) {
      return runOrcaImpl(["check", "--page", pageId, "--element", `@${ref}`, "--json"]);
    },
    async clickButton({ pageId, ref }) {
      return runOrcaImpl(["click", "--page", pageId, "--element", `@${ref}`, "--json"]);
    },
    async upload({ pageId, ref, files }) {
      return runOrcaImpl([
        "upload",
        "--page",
        pageId,
        "--element",
        `@${ref}`,
        "--files",
        files,
        "--json",
      ]);
    },
    async screenshot({ pageId }) {
      const shot = await runOrcaImpl(["screenshot", "--page", pageId, "--json"]);
      return { data: shot.data, format: shot.format };
    },
  };
}
