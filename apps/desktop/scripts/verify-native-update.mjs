#!/usr/bin/env node

import { spawn, spawnSync } from "node:child_process";
import { createPrivateKey, randomUUID, sign as signBytes } from "node:crypto";
import {
  closeSync,
  createReadStream,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  nativeUpdateAcceptancePointerPath,
  NATIVE_UPDATE_ACCEPTANCE_ARG,
} from "../native-update-acceptance.mjs";
import { selectMacUpdateZip, verifyMacUpdateFeed } from "../release-verification.mjs";

const desktopRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const repositoryRoot = join(desktopRoot, "..", "..");
const productName = "CareerRat";
const bootstrapPriorVersion = "0.16.3";
const acceptancePrivateKeyName = "NATIVE_UPDATE_ACCEPTANCE_PRIVATE_KEY";
const childCredentialNames = [
  "CSC_LINK",
  "CSC_KEY_PASSWORD",
  "APPLE_API_KEY",
  "APPLE_API_KEY_ID",
  "APPLE_API_ISSUER",
  acceptancePrivateKeyName,
  "GH_TOKEN",
  "GITHUB_TOKEN",
];

function stableVersionParts(value) {
  const match = String(value || "").match(/^v?(\d+)\.(\d+)\.(\d+)$/);
  return match ? match.slice(1).map(Number) : null;
}

function compareVersions(left, right) {
  const leftParts = stableVersionParts(left);
  const rightParts = stableVersionParts(right);
  if (!leftParts || !rightParts) throw new Error("A stable X.Y.Z version is required.");
  for (let index = 0; index < leftParts.length; index += 1) {
    if (leftParts[index] !== rightParts[index]) return leftParts[index] - rightParts[index];
  }
  return 0;
}

export function selectPriorPublishedRelease(releases, expectedVersion) {
  if (!stableVersionParts(expectedVersion)) {
    throw new Error(`Desktop version is not semantic X.Y.Z: ${expectedVersion}`);
  }
  const eligible = (Array.isArray(releases) ? releases : []).filter((release) => {
    return (
      release?.draft !== true &&
      release?.prerelease !== true &&
      stableVersionParts(release?.tag_name) &&
      compareVersions(release.tag_name, expectedVersion) < 0
    );
  });
  eligible.sort((left, right) => compareVersions(right.tag_name, left.tag_name));
  if (eligible.length === 0) {
    throw new Error(`No prior published stable release exists before ${expectedVersion}.`);
  }
  return eligible[0];
}

export function choosePriorAcceptanceKind({
  priorVersion,
  publishedFeedAvailable,
  acceptanceHookPresent,
} = {}) {
  if (publishedFeedAvailable && acceptanceHookPresent) return "published";
  if (priorVersion === bootstrapPriorVersion) return "bootstrap";
  if (!publishedFeedAvailable) {
    throw new Error(`Prior published updater feed is missing for ${priorVersion}.`);
  }
  throw new Error(
    `Prior published app ${priorVersion} does not contain the native update acceptance hook.`
  );
}

export function signAcceptanceRequest({ requestBytes, privateKey }) {
  const bytes = Buffer.isBuffer(requestBytes) ? requestBytes : Buffer.from(requestBytes);
  const key = createPrivateKey(privateKey);
  if (key.asymmetricKeyType !== "ed25519") {
    throw new Error("Native update acceptance requires an Ed25519 PKCS#8 private key.");
  }
  return signBytes(null, bytes, key);
}

export function writeSignedAcceptanceRequest({ requestPath, requestBytes, privateKey }) {
  const bytes = Buffer.isBuffer(requestBytes) ? requestBytes : Buffer.from(requestBytes);
  const signature = signAcceptanceRequest({ requestBytes: bytes, privateKey });
  const signaturePath = join(dirname(requestPath), "request.sig");
  writeFileSync(requestPath, bytes, { mode: 0o600 });
  writeFileSync(signaturePath, `${signature.toString("base64")}\n`, { mode: 0o600 });
  return signaturePath;
}

export function sanitizeAcceptanceChildEnv(env = {}) {
  const childEnv = { ...env };
  for (const name of childCredentialNames) delete childEnv[name];
  return childEnv;
}

export function selectPriorFeedAssets(release, version) {
  const names = (Array.isArray(release?.assets) ? release.assets : [])
    .map((asset) => asset?.name)
    .filter((name) => typeof name === "string");
  const metadata = names.filter((name) => name === "latest-mac.yml");
  const zipNames = names.filter((name) => name.endsWith(".zip"));
  if (metadata.length === 0 && zipNames.length === 0) return null;
  if (metadata.length !== 1) {
    throw new Error(`Prior release ${version} must contain exactly one latest-mac.yml.`);
  }
  let zipName;
  try {
    zipName = selectMacUpdateZip(zipNames, version);
  } catch (error) {
    throw new Error(
      `Prior release ${version} must contain exactly one updater ZIP: ${error?.message || error}`
    );
  }
  return { zipName, metadataName: metadata[0] };
}

export function hasNativeAcceptanceHook(asarEntries) {
  return String(asarEntries || "")
    .split(/\r?\n/)
    .some((entry) => /(?:^|[\\/])native-update-acceptance\.mjs$/.test(entry.trim()));
}

export function previousDesktopVersion(version) {
  const match = String(version || "").match(/^(\d+)\.(\d+)\.(\d+)$/);
  if (!match) throw new Error(`Desktop version is not semantic X.Y.Z: ${version}`);
  const [, majorText, minorText, patchText] = match;
  const major = Number(majorText);
  const minor = Number(minorText);
  const patch = Number(patchText);
  if (patch > 0) return `${major}.${minor}.${patch - 1}`;
  if (minor > 0) return `${major}.${minor - 1}.999`;
  if (major > 0) return `${major - 1}.999.999`;
  throw new Error("Desktop version 0.0.0 has no valid lower acceptance version.");
}

export function verifyNativeUpdateResult({ result, fromVersion, expectedVersion }) {
  if (!result || typeof result !== "object" || Array.isArray(result)) {
    throw new Error("Native update acceptance did not write a result object.");
  }
  if (result.fromVersion !== fromVersion) {
    throw new Error(
      `Native update acceptance started from ${result.fromVersion || "no version"}, expected ${fromVersion}.`
    );
  }
  if (result.expectedVersion !== expectedVersion) {
    throw new Error(
      `Native update acceptance expected ${result.expectedVersion || "no version"}, not ${expectedVersion}.`
    );
  }
  if (result.observedVersion !== expectedVersion) {
    throw new Error(
      `Native update acceptance did not report version ${expectedVersion}; it reported ${result.observedVersion || "no version"}.`
    );
  }
  if (result.sentinelPreserved !== true) {
    throw new Error("Native update acceptance did not preserve the CAREERRAT_HOME sentinel.");
  }
  if (result.ok !== true) {
    throw new Error("Native update acceptance reported failure.");
  }
  return true;
}

function runChecked(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    ...options,
  });
  if (result.error || result.status !== 0) {
    const output = [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
    throw new Error(
      `${command} failed${result.error ? `: ${result.error.message}` : ` with status ${result.status}`}${output ? `\n${output}` : ""}`
    );
  }
  return result;
}

function readPackagedVersion(appPath) {
  return runChecked("/usr/libexec/PlistBuddy", [
    "-c",
    "Print :CFBundleShortVersionString",
    join(appPath, "Contents", "Info.plist"),
  ]).stdout.trim();
}

function readDeveloperId(appPath) {
  runChecked("codesign", ["--verify", "--deep", "--strict", appPath]);
  const output = runChecked("codesign", ["--display", "--verbose=4", appPath]).stderr;
  const authority = output.match(/^Authority=(Developer ID Application: .+)$/m)?.[1] || null;
  const team = output.match(/^TeamIdentifier=(\S+)$/m)?.[1] || null;
  if (!authority || !team) {
    throw new Error(`${appPath} is not signed with a Developer ID Application identity.`);
  }
  return { authority, team };
}

function verifyGatekeeper(appPath) {
  runChecked("spctl", ["--assess", "--type", "execute", "--verbose=2", appPath]);
}

function loadReleaseHistory() {
  const response = runChecked("gh", [
    "api",
    "repos/CodesWhat/careerrat/releases",
    "--paginate",
    "--slurp",
  ]);
  const pages = JSON.parse(response.stdout);
  if (!Array.isArray(pages)) throw new Error("GitHub returned invalid release history.");
  return pages.flatMap((page) => (Array.isArray(page) ? page : []));
}

function downloadPriorFeed({ release, assets, outputDir }) {
  mkdirSync(outputDir, { recursive: true });
  for (const name of [assets.zipName, assets.metadataName]) {
    runChecked("gh", [
      "release",
      "download",
      release.tag_name,
      "--repo",
      "CodesWhat/careerrat",
      "--pattern",
      name,
      "--dir",
      outputDir,
    ]);
  }
  return {
    zipPath: join(outputDir, assets.zipName),
    metadataPath: join(outputDir, assets.metadataName),
  };
}

function findExtractedApp(root) {
  const matches = [];
  const pending = [root];
  while (pending.length > 0) {
    const current = pending.pop();
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const path = join(current, entry.name);
      if (entry.name === `${productName}.app`) matches.push(path);
      else pending.push(path);
    }
  }
  if (matches.length !== 1) {
    throw new Error(`Prior updater ZIP must contain exactly one ${productName}.app.`);
  }
  return matches[0];
}

function inspectAcceptanceHook(appPath) {
  const asarPath = join(appPath, "Contents", "Resources", "app.asar");
  if (!existsSync(asarPath)) return false;
  const asar = join(repositoryRoot, "node_modules", ".bin", "asar");
  const asarListing = runChecked(asar, ["list", asarPath]).stdout;
  return hasNativeAcceptanceHook(asarListing);
}

function buildPreviousPackage({ fromVersion, outputDir }) {
  const builder = join(repositoryRoot, "node_modules", ".bin", "electron-builder");
  if (!existsSync(builder)) throw new Error(`electron-builder is missing: ${builder}`);
  runChecked(
    builder,
    [
      "--mac",
      "zip",
      "--arm64",
      "--publish",
      "never",
      `-c.directories.output=${outputDir}`,
      `-c.extraMetadata.version=${fromVersion}`,
    ],
    {
      cwd: desktopRoot,
      env: process.env,
      stdio: "inherit",
      timeout: 1_200_000,
    }
  );
  const appPath = join(outputDir, "mac-arm64", `${productName}.app`);
  if (!existsSync(appPath)) throw new Error(`Previous packaged app is missing: ${appPath}`);
  return appPath;
}

async function resolvePriorApp({ expectedVersion, scratch }) {
  const release = selectPriorPublishedRelease(loadReleaseHistory(), expectedVersion);
  const priorVersion = release.tag_name.slice(1);
  let assets;
  try {
    assets = selectPriorFeedAssets(release, priorVersion);
  } catch (error) {
    if (priorVersion !== bootstrapPriorVersion) throw error;
    assets = null;
  }

  if (!assets) {
    choosePriorAcceptanceKind({
      priorVersion,
      publishedFeedAvailable: false,
      acceptanceHookPresent: false,
    });
    return {
      appPath: buildPreviousPackage({
        fromVersion: priorVersion,
        outputDir: join(scratch, "bootstrap-dist"),
      }),
      priorVersion,
      source: "bootstrap",
    };
  }

  const { zipPath, metadataPath } = downloadPriorFeed({
    release,
    assets,
    outputDir: join(scratch, "prior-release"),
  });
  const feed = await verifyMacUpdateFeed({
    zipPath,
    metadataPath,
    expectedVersion: priorVersion,
  });
  if (!feed.ok) {
    throw new Error(
      `Prior published updater feed failed integrity checks:\n${feed.failures.map((failure) => `${failure.label}: ${failure.output}`).join("\n")}`
    );
  }

  const extractedDir = join(scratch, "prior-app");
  mkdirSync(extractedDir, { recursive: true });
  runChecked("ditto", ["-x", "-k", zipPath, extractedDir]);
  const appPath = findExtractedApp(extractedDir);
  if (readPackagedVersion(appPath) !== priorVersion) {
    throw new Error(`Prior published app does not report version ${priorVersion}.`);
  }
  readDeveloperId(appPath);
  verifyGatekeeper(appPath);
  const acceptanceHookPresent = inspectAcceptanceHook(appPath);
  const source = choosePriorAcceptanceKind({
    priorVersion,
    publishedFeedAvailable: true,
    acceptanceHookPresent,
  });
  if (source === "published") return { appPath, priorVersion, source };
  return {
    appPath: buildPreviousPackage({
      fromVersion: priorVersion,
      outputDir: join(scratch, "bootstrap-dist"),
    }),
    priorVersion,
    source,
  };
}

function serveFile(request, response, filePath) {
  const size = statSync(filePath).size;
  const range = String(request.headers.range || "").match(/^bytes=(\d+)-(\d*)$/);
  let start = 0;
  let end = Math.max(0, size - 1);
  let status = 200;
  if (range) {
    start = Number(range[1]);
    end = range[2] ? Number(range[2]) : end;
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || end >= size) {
      response.writeHead(416, { "Content-Range": `bytes */${size}` });
      response.end();
      return;
    }
    status = 206;
  }
  const headers = {
    "Accept-Ranges": "bytes",
    "Content-Length": String(size === 0 ? 0 : end - start + 1),
    "Content-Type": filePath.endsWith(".yml") ? "text/yaml" : "application/octet-stream",
  };
  if (status === 206) headers["Content-Range"] = `bytes ${start}-${end}/${size}`;
  response.writeHead(status, headers);
  if (request.method === "HEAD" || size === 0) {
    response.end();
    return;
  }
  const stream = createReadStream(filePath, { start, end });
  stream.on("error", () => response.destroy());
  stream.pipe(response);
}

function createLoopbackFeed(files) {
  const allowed = new Map(files.map((path) => [basename(path), path]));
  return createServer((request, response) => {
    if (!request.url || !["GET", "HEAD"].includes(request.method || "")) {
      response.writeHead(405);
      response.end();
      return;
    }
    let name;
    try {
      const pathname = decodeURIComponent(new URL(request.url, "http://127.0.0.1").pathname);
      name = pathname.startsWith("/") ? pathname.slice(1) : pathname;
    } catch {
      response.writeHead(400);
      response.end();
      return;
    }
    const filePath = allowed.get(name);
    if (!filePath || name !== basename(name)) {
      response.writeHead(404);
      response.end();
      return;
    }
    serveFile(request, response, filePath);
  });
}

function listen(server) {
  return new Promise((resolvePromise, rejectPromise) => {
    server.once("error", rejectPromise);
    server.listen(0, "127.0.0.1", () => {
      server.removeListener("error", rejectPromise);
      resolvePromise(server.address().port);
    });
  });
}

function closeServer(server) {
  if (!server?.listening) return Promise.resolve();
  return new Promise((resolvePromise) => {
    server.close(resolvePromise);
    server.closeAllConnections?.();
  });
}

async function waitForResult({ resultPath, logPath, child, timeoutMs = 420_000 }) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(resultPath)) {
      try {
        return JSON.parse(readFileSync(resultPath, "utf8"));
      } catch {
        // The app writes atomically, but let one more interval settle if the
        // filesystem reports the rename before this process can read it.
      }
    }
    if (child.exitCode !== null && child.exitCode !== 0) {
      const output = existsSync(logPath) ? readFileSync(logPath, "utf8").trim() : "";
      throw new Error(
        `Previous packaged app exited with status ${child.exitCode} before the update completed${output ? `\n${output}` : ""}`
      );
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 500));
  }
  const output = existsSync(logPath) ? readFileSync(logPath, "utf8").trim() : "";
  throw new Error(
    `Native update acceptance timed out waiting for the restarted app${output ? `\n${output}` : ""}`
  );
}

async function main() {
  if (process.platform !== "darwin" || process.arch !== "arm64") {
    throw new Error("Native update acceptance requires an arm64 macOS runner.");
  }

  const pkg = JSON.parse(readFileSync(join(desktopRoot, "package.json"), "utf8"));
  const expectedVersion = pkg.version;
  const acceptancePrivateKey = process.env[acceptancePrivateKeyName];
  if (!acceptancePrivateKey?.trim()) {
    throw new Error(`${acceptancePrivateKeyName} is required for native update acceptance.`);
  }
  const distDir = join(desktopRoot, "dist");
  const candidateApp = join(distDir, "mac-arm64", `${productName}.app`);
  const metadataPath = join(distDir, "latest-mac.yml");
  const zipPath = join(distDir, selectMacUpdateZip(readdirSync(distDir), expectedVersion));
  for (const path of [candidateApp, metadataPath, zipPath]) {
    if (!existsSync(path)) throw new Error(`Native update acceptance input is missing: ${path}`);
  }
  const feedCheck = await verifyMacUpdateFeed({ zipPath, metadataPath, expectedVersion });
  if (!feedCheck.ok) {
    throw new Error(
      `Native update acceptance feed failed integrity checks:\n${feedCheck.failures.map((failure) => `${failure.label}: ${failure.output}`).join("\n")}`
    );
  }
  if (readPackagedVersion(candidateApp) !== expectedVersion) {
    throw new Error(`Final packaged app does not report version ${expectedVersion}.`);
  }

  const scratch = mkdtempSync(join(tmpdir(), "careerrat-native-update-"));
  const pointerPath = nativeUpdateAcceptancePointerPath(
    join(homedir(), "Library", "Application Support", productName)
  );
  let server = null;
  let child = null;
  let logFd = null;
  try {
    if (existsSync(pointerPath)) {
      throw new Error(`A native update acceptance restart marker already exists: ${pointerPath}`);
    }

    const {
      appPath: previousApp,
      priorVersion: fromVersion,
      source: priorSource,
    } = await resolvePriorApp({ expectedVersion, scratch });
    if (readPackagedVersion(previousApp) !== fromVersion) {
      throw new Error(`Previous packaged app does not report version ${fromVersion}.`);
    }
    const candidateIdentity = readDeveloperId(candidateApp);
    const previousIdentity = readDeveloperId(previousApp);
    verifyGatekeeper(previousApp);
    if (
      candidateIdentity.authority !== previousIdentity.authority ||
      candidateIdentity.team !== previousIdentity.team
    ) {
      throw new Error("N and N+1 are not signed by the same Developer ID Application identity.");
    }

    const feedFiles = [metadataPath, zipPath];
    const blockmapPath = `${zipPath}.blockmap`;
    if (existsSync(blockmapPath)) feedFiles.push(blockmapPath);
    server = createLoopbackFeed(feedFiles);
    const port = await listen(server);

    const homeDir = join(scratch, "careerrat-home");
    mkdirSync(homeDir, { recursive: true });
    const sentinel = randomUUID();
    writeFileSync(join(homeDir, "acceptance-sentinel.txt"), sentinel);
    const requestPath = join(scratch, "request.json");
    const resultPath = join(scratch, "result.json");
    const requestBytes = Buffer.from(
      `${JSON.stringify({
        feedUrl: `http://127.0.0.1:${port}/`,
        fromVersion,
        expectedVersion,
        sentinel,
      })}\n`
    );
    writeSignedAcceptanceRequest({
      requestPath,
      requestBytes,
      privateKey: acceptancePrivateKey,
    });

    const logPath = join(scratch, "app.log");
    logFd = openSync(logPath, "a");
    child = spawn(
      join(previousApp, "Contents", "MacOS", productName),
      [`${NATIVE_UPDATE_ACCEPTANCE_ARG}${requestPath}`],
      {
        cwd: scratch,
        env: sanitizeAcceptanceChildEnv(process.env),
        stdio: ["ignore", logFd, logFd],
      }
    );
    const result = await waitForResult({ resultPath, logPath, child });
    verifyNativeUpdateResult({ result, fromVersion, expectedVersion });
    if (readFileSync(join(homeDir, "acceptance-sentinel.txt"), "utf8") !== sentinel) {
      throw new Error("CAREERRAT_HOME sentinel changed during the native update.");
    }
    process.stdout.write(
      `NATIVE UPDATE ACCEPTANCE OK ${fromVersion} -> ${expectedVersion} (${priorSource})\n`
    );
  } finally {
    if (child?.exitCode === null) child.kill("SIGTERM");
    if (logFd !== null) closeSync(logFd);
    await closeServer(server);
    rmSync(pointerPath, { force: true });
    rmSync(scratch, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
