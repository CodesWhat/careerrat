import { createServer } from "node:net";

export function parseRecordedPid(value) {
  const text = String(value ?? "").trim();
  if (!/^[1-9]\d*$/.test(text)) return null;
  const pid = Number(text);
  return Number.isSafeInteger(pid) ? pid : null;
}

export function commandMatchesTrackerScript(command, trackerScript) {
  const expected = String(trackerScript || "")
    .trim()
    .replaceAll("\\", "/");
  if (!expected) return false;
  const actual = String(command || "").replaceAll("\\", "/");
  const escaped = expected.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?:^|[\\s"'])${escaped}(?=$|[\\s"'])`).test(actual);
}

export function trackerCommandPort(command, { defaultPort = 7777 } = {}) {
  const match = String(command || "").match(/(?:^|\s)--port(?:=|\s+)(\S+)/);
  if (!match) return defaultPort;
  if (!/^[1-9]\d*$/.test(match[1])) return null;
  const port = Number(match[1]);
  return Number.isInteger(port) && port <= 65535 ? port : null;
}

export function classifyLocalAppRuntime({
  health,
  installedVersion,
  recordedPid,
  recordedProcessIsTracker = false,
} = {}) {
  if (!health?.responding) return { state: "absent" };
  if (!health.careerrat) return { state: "foreign" };

  const runningVersion = String(health.version || "").trim() || null;
  const runningPid = parseRecordedPid(health.pid);
  const ownedPid = parseRecordedPid(recordedPid);
  const pidProvesOwnership =
    runningPid != null &&
    ownedPid != null &&
    runningPid === ownedPid &&
    recordedProcessIsTracker === true;
  const legacyCommandProvesOwnership =
    runningPid == null && ownedPid != null && recordedProcessIsTracker === true;
  const ownershipProved = pidProvesOwnership || legacyCommandProvesOwnership;
  if (runningVersion && runningVersion === String(installedVersion || "").trim()) {
    if (health.productVerified === true || ownershipProved) {
      return { state: "current", pid: runningPid ?? ownedPid };
    }
    return { state: "foreign" };
  }
  if (ownershipProved) {
    return { state: "stale-owned", pid: ownedPid, runningVersion };
  }
  return health.productVerified === true
    ? { state: "stale-unowned", runningVersion }
    : { state: "foreign" };
}

export async function readLocalAppHealth(
  baseUrl,
  { fetchImpl = globalThis.fetch, timeoutMs = 500 } = {}
) {
  const url = new URL("/api/health", baseUrl).href;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  timer.unref?.();
  try {
    const response = await fetchImpl(url, { signal: controller.signal });
    if (!response?.ok) {
      return {
        responding: true,
        careerrat: false,
        productVerified: false,
        version: null,
        pid: null,
      };
    }
    let body;
    try {
      body = await response.json();
    } catch {
      return {
        responding: true,
        careerrat: false,
        productVerified: false,
        version: null,
        pid: null,
      };
    }
    const version = typeof body?.version === "string" ? body.version.trim() : "";
    const careerrat = body?.ok === true && version.length > 0;
    const productVerified = careerrat && body?.product === "careerrat";
    return {
      responding: true,
      careerrat,
      productVerified,
      version: careerrat ? version : null,
      pid: careerrat ? parseRecordedPid(body.pid) : null,
    };
  } catch {
    return {
      responding: false,
      careerrat: false,
      productVerified: false,
      version: null,
      pid: null,
    };
  } finally {
    clearTimeout(timer);
  }
}

function isLoopbackPortAvailable(port) {
  return new Promise((resolve) => {
    const server = createServer();
    server.unref();
    server.once("error", () => resolve(false));
    server.listen(port, "127.0.0.1", () => {
      server.close(() => resolve(true));
    });
  });
}

export async function findAvailableLoopbackPort({
  startPort,
  maxAttempts = 20,
  isAvailable = isLoopbackPortAvailable,
} = {}) {
  const first = Number(startPort);
  if (!Number.isInteger(first) || first < 1 || first > 65535) return null;
  for (let offset = 0; offset < maxAttempts && first + offset <= 65535; offset += 1) {
    const candidate = first + offset;
    if (await isAvailable(candidate)) return candidate;
  }
  return null;
}
