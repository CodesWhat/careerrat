import { verify as verifySignature } from "node:crypto";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { writeFileAtomic } from "./atomic-write.mjs";

export const NATIVE_UPDATE_ACCEPTANCE_ARG = "--native-update-acceptance=";
const NATIVE_UPDATE_ACCEPTANCE_POINTER = "native-update-acceptance.json";
const NATIVE_UPDATE_ACCEPTANCE_PUBLIC_KEY_PEM = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEANfnG6EFAhjClfzXS4qv9cpVPhMmTuyUC+khrcBE3Q10=
-----END PUBLIC KEY-----
`;
const NATIVE_UPDATE_ACCEPTANCE_SIGNATURE_FILE = "request.sig";

function parseJsonFile(path, label) {
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(`${label} is unreadable: ${error?.message || error}`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${label} must be a JSON object.`);
  }
  return parsed;
}

function loadSignedRequest(path, publicKey) {
  let requestBytes;
  let signature;
  try {
    requestBytes = readFileSync(path);
    const encoded = readFileSync(join(dirname(path), NATIVE_UPDATE_ACCEPTANCE_SIGNATURE_FILE), "utf8").trim();
    signature = Buffer.from(encoded, "base64");
    if (
      !encoded ||
      encoded.length % 4 !== 0 ||
      !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded) ||
      signature.length !== 64 ||
      signature.toString("base64") !== encoded ||
      !verifySignature(null, requestBytes, publicKey, signature)
    ) {
      throw new Error("invalid signature");
    }
  } catch {
    throw new Error("Native update acceptance requires a valid Ed25519 signature.");
  }

  let request;
  try {
    request = JSON.parse(requestBytes.toString("utf8"));
  } catch (error) {
    throw new Error(`Native update acceptance request is unreadable: ${error?.message || error}`);
  }
  if (!request || typeof request !== "object" || Array.isArray(request)) {
    throw new Error("Native update acceptance request must be a JSON object.");
  }
  return request;
}

function nonemptyString(value, label) {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text) throw new Error(`${label} is required.`);
  return text;
}

function positiveInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${label} must be a positive integer.`);
  }
  return value;
}

function literalLoopbackFeed(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Native update acceptance requires a literal loopback feed URL.");
  }
  if (
    url.protocol !== "http:" ||
    !["127.0.0.1", "[::1]"].includes(url.hostname) ||
    !url.port ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new Error("Native update acceptance requires a literal loopback feed URL.");
  }
  return url.href;
}

function loadRequest(requestPath, publicKey) {
  if (!isAbsolute(requestPath)) {
    throw new Error("Native update acceptance requires an absolute request path.");
  }
  const canonicalRequestPath = resolve(requestPath);
  const root = dirname(canonicalRequestPath);
  const request = loadSignedRequest(canonicalRequestPath, publicKey);
  const fromVersion = nonemptyString(request.fromVersion, "Acceptance starting version");
  const expectedVersion = nonemptyString(request.expectedVersion, "Acceptance expected version");
  if (fromVersion === expectedVersion) {
    throw new Error("Native update acceptance requires two different app versions.");
  }
  const sentinel = nonemptyString(request.sentinel, "Acceptance sentinel");
  const durableCandidateName = nonemptyString(
    request.durableCandidateName,
    "Acceptance durable candidate name"
  );
  const expectedMigrationCeiling = positiveInteger(
    request.expectedMigrationCeiling,
    "Acceptance migration ceiling"
  );
  return {
    requestPath: canonicalRequestPath,
    root,
    feedUrl: literalLoopbackFeed(request.feedUrl),
    fromVersion,
    expectedVersion,
    sentinel,
    durableCandidateName,
    expectedMigrationCeiling,
    homeDir: join(root, "careerrat-home"),
    sentinelPath: join(root, "careerrat-home", "acceptance-sentinel.txt"),
    resultPath: join(root, "result.json"),
  };
}

async function fetchJson(url, { method = "GET", body } = {}) {
  const response = await fetch(url, {
    method,
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const payload = await response.json();
  if (!response.ok || payload?.ok !== true) {
    throw new Error(
      payload?.error || `Native update acceptance request failed (${response.status}).`
    );
  }
  return payload;
}

export async function bootNativeUpdateAcceptance({ boot, timeoutMs = 60_000 } = {}) {
  if (typeof boot !== "function") throw new TypeError("boot must be a function");
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
    throw new TypeError("timeoutMs must be a positive integer");
  }
  let timer;
  try {
    return await Promise.race([
      Promise.resolve().then(boot),
      new Promise((_, rejectPromise) => {
        timer = setTimeout(
          () =>
            rejectPromise(
              new Error(`Native update normal boot timed out after ${timeoutMs}ms.`)
            ),
          timeoutMs
        );
        timer.unref?.();
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export async function seedNativeUpdateAcceptanceState({
  acceptance,
  baseUrl,
  requestJson = fetchJson,
} = {}) {
  if (acceptance?.mode !== "start") {
    throw new Error("Native update acceptance start context is required.");
  }
  const origin = new URL(baseUrl).origin;
  await requestJson(`${origin}/api/data/candidate/init`, { method: "POST", body: {} });
  await requestJson(`${origin}/api/data/candidate/config`, {
    method: "POST",
    body: {
      name: "profile",
      patch: { candidate: { full_name: acceptance.durableCandidateName } },
    },
  });
}

export async function inspectNativeUpdateAcceptanceState({
  acceptance,
  baseUrl,
  readMigrationState,
  requestJson = fetchJson,
} = {}) {
  if (acceptance?.mode !== "complete") {
    throw new Error("Native update acceptance restart context is required.");
  }
  if (typeof readMigrationState !== "function") {
    throw new TypeError("readMigrationState must be a function");
  }
  const origin = new URL(baseUrl).origin;
  const config = await requestJson(`${origin}/api/data/candidate/config`);
  const migration = await readMigrationState();
  return {
    durableCandidateName: config?.data?.profile?.candidate?.full_name || null,
    migrationVersion: migration?.version,
    migrationCeiling: migration?.ceiling,
  };
}

export function nativeUpdateAcceptancePointerPath(userDataDir) {
  return join(userDataDir, NATIVE_UPDATE_ACCEPTANCE_POINTER);
}

export function resolveNativeUpdateAcceptance({
  argv = [],
  isPackaged = false,
  platform = process.platform,
  currentVersion,
  userDataDir,
  acceptancePublicKey = NATIVE_UPDATE_ACCEPTANCE_PUBLIC_KEY_PEM,
} = {}) {
  const explicit = argv.filter((arg) => String(arg).startsWith(NATIVE_UPDATE_ACCEPTANCE_ARG));
  const pointerPath = nativeUpdateAcceptancePointerPath(userDataDir);
  if (explicit.length > 1) {
    throw new Error("Native update acceptance accepts one request path.");
  }

  if (explicit.length === 1) {
    if (!isPackaged || platform !== "darwin") {
      throw new Error("Native update acceptance is available only in packaged macOS CareerRat.");
    }
    const requestPath = explicit[0].slice(NATIVE_UPDATE_ACCEPTANCE_ARG.length);
    const request = loadRequest(requestPath, acceptancePublicKey);
    if (request.fromVersion !== currentVersion) {
      throw new Error(
        `Native update acceptance expected version ${request.fromVersion}, found ${currentVersion}.`
      );
    }
    if (readFileSync(request.sentinelPath, "utf8") !== request.sentinel) {
      throw new Error("Native update acceptance sentinel does not match the request.");
    }
    return { ...request, mode: "start", pointerPath };
  }

  if (!isPackaged || platform !== "darwin" || !existsSync(pointerPath)) return null;
  let pointer;
  try {
    pointer = parseJsonFile(pointerPath, "Native update acceptance restart marker");
  } catch {
    return null;
  }
  const requestPath = typeof pointer.requestPath === "string" ? pointer.requestPath : "";
  if (!requestPath) return null;
  const request = loadRequest(requestPath, acceptancePublicKey);
  return { ...request, mode: "complete", pointerPath, observedVersion: currentVersion };
}

export async function beginNativeUpdateAcceptance({
  acceptance,
  updater,
  createController,
  requestInstall,
} = {}) {
  if (acceptance?.mode !== "start") {
    throw new Error("Native update acceptance start context is required.");
  }
  if (typeof updater?.setFeedURL !== "function") {
    throw new Error("Native update acceptance requires the macOS updater.");
  }

  updater.disableDifferentialDownload = true;
  updater.setFeedURL({ provider: "generic", url: acceptance.feedUrl });
  return new Promise((resolvePromise, rejectPromise) => {
    let installing = false;
    let controller;
    const fail = (error) => {
      if (installing) return;
      rejectPromise(error instanceof Error ? error : new Error(String(error)));
    };

    controller = createController({
      updater,
      platform: "darwin",
      selfUpdateSupported: true,
      currentVersion: acceptance.fromVersion,
      persisted: { enabled: true, lastCheckedAt: null, skippedVersion: null },
      persist() {},
      log() {},
      push(state) {
        if (state.phase === "error") {
          fail(new Error(state.message || "Native update acceptance download failed."));
          return;
        }
        if (state.phase !== "ready" || installing) return;
        if (state.version !== acceptance.expectedVersion) {
          fail(
            new Error(
              `Native update acceptance expected ${acceptance.expectedVersion}, got ${state.version}.`
            )
          );
          return;
        }
        installing = true;
        writeFileAtomic(
          acceptance.pointerPath,
          `${JSON.stringify({ requestPath: acceptance.requestPath })}\n`
        );
        const install =
          typeof requestInstall === "function"
            ? requestInstall(controller)
            : controller.install();
        if (!install) {
          installing = false;
          fail(new Error("Native update acceptance could not start the native installer."));
          return;
        }
        resolvePromise({ installStarted: true });
      },
    });

    Promise.resolve(controller.checkNow({ manual: true })).catch(fail);
  });
}

export function completeNativeUpdateAcceptance({
  acceptance,
  currentVersion,
  canonicalState,
  removePointer = (path) => rmSync(path, { force: true }),
  writeResult = writeFileAtomic,
} = {}) {
  if (acceptance?.mode !== "complete") {
    throw new Error("Native update acceptance restart context is required.");
  }
  let sentinelPreserved = false;
  try {
    sentinelPreserved = readFileSync(acceptance.sentinelPath, "utf8") === acceptance.sentinel;
  } catch {
    sentinelPreserved = false;
  }
  const durableRowPreserved =
    canonicalState?.durableCandidateName === acceptance.durableCandidateName;
  const observedMigrationVersion = canonicalState?.migrationVersion;
  const migrationCeilingRespected =
    observedMigrationVersion === acceptance.expectedMigrationCeiling &&
    canonicalState?.migrationCeiling === acceptance.expectedMigrationCeiling;
  const result = {
    ok:
      currentVersion === acceptance.expectedVersion &&
      sentinelPreserved &&
      durableRowPreserved &&
      migrationCeilingRespected,
    fromVersion: acceptance.fromVersion,
    expectedVersion: acceptance.expectedVersion,
    observedVersion: currentVersion,
    sentinelPreserved,
    durableRowPreserved,
    observedMigrationVersion,
    expectedMigrationCeiling: acceptance.expectedMigrationCeiling,
    migrationCeilingRespected,
  };
  removePointer(acceptance.pointerPath);
  writeResult(acceptance.resultPath, `${JSON.stringify(result)}\n`);
  return result;
}
