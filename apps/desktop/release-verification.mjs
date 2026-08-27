import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, readFileSync, statSync } from "node:fs";
import { basename } from "node:path";

const NOTARIZATION_CREDENTIALS =
  "Configure APPLE_API_KEY/APPLE_API_KEY_ID/APPLE_API_ISSUER, " +
  "APPLE_ID/APPLE_APP_SPECIFIC_PASSWORD/APPLE_TEAM_ID, or APPLE_KEYCHAIN/APPLE_KEYCHAIN_PROFILE.";

export function verifyDesktopRelease({ appPath, dmgPath, run = runCommand }) {
  const specs = [
    {
      id: "app-signature",
      label: "App signature",
      command: "codesign",
      args: ["--verify", "--deep", "--strict", appPath],
    },
    {
      id: "notarization-ticket",
      label: "DMG notarization ticket",
      command: "xcrun",
      args: ["stapler", "validate", dmgPath],
    },
    {
      id: "gatekeeper",
      label: "Gatekeeper assessment",
      command: "spctl",
      args: ["--assess", "--type", "open", "--context", "context:primary-signature", dmgPath],
    },
  ];

  const checks = specs.map((spec) => {
    const result = run(spec.command, spec.args);
    return {
      ...spec,
      ok: result.status === 0 && !result.error,
      status: result.status,
      output: [result.stdout, result.stderr, result.error?.message].filter(Boolean).join("\n").trim(),
    };
  });
  const failures = checks.filter((check) => !check.ok);

  return {
    ok: failures.length === 0,
    checks,
    failures,
    summary:
      failures.length === 0
        ? "Desktop release is signed, notarized, and Gatekeeper-ready."
        : `Desktop release is not signed, notarized, and Gatekeeper-ready. ${NOTARIZATION_CREDENTIALS}`,
  };
}

export async function verifyMacUpdateFeed({ zipPath, metadataPath, expectedVersion }) {
  let entry;
  try {
    entry = readFirstMacUpdateFile(readFileSync(metadataPath, "utf8"));
  } catch (error) {
    const check = {
      id: "updater-metadata",
      label: "macOS updater metadata",
      ok: false,
      output: error instanceof Error ? error.message : String(error),
    };
    return { ok: false, checks: [check], failures: [check] };
  }

  const actualName = basename(zipPath);
  const actualSize = statSync(zipPath).size;
  const actualSha512 = await sha512File(zipPath);
  const checks = [
    {
      id: "updater-version",
      label: "Updater version",
      ok: entry.version === expectedVersion,
      output:
        entry.version === expectedVersion
          ? ""
          : `Expected version ${expectedVersion}, metadata records ${entry.version}.`,
    },
    {
      id: "updater-filename",
      label: "Updater ZIP filename",
      ok: entry.url === actualName && entry.path === actualName,
      output:
        entry.url === actualName && entry.path === actualName
          ? ""
          : `Expected ${actualName}, metadata names ${entry.url} and ${entry.path}.`,
    },
    {
      id: "updater-size",
      label: "Updater ZIP size",
      ok: entry.size === actualSize,
      output:
        entry.size === actualSize
          ? ""
          : `Expected ${actualSize} bytes, metadata records ${entry.size}.`,
    },
    {
      id: "updater-sha512",
      label: "Updater ZIP SHA-512",
      ok: entry.sha512 === actualSha512,
      output: entry.sha512 === actualSha512 ? "" : "latest-mac.yml SHA-512 does not match the ZIP.",
    },
  ];
  const failures = checks.filter((check) => !check.ok);
  return { ok: failures.length === 0, checks, failures };
}

export function selectMacUpdateZip(names, version) {
  const escapedVersion = String(version || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const versionPattern = new RegExp(`(?<![0-9.])${escapedVersion}(?![0-9.])`);
  const matches = (Array.isArray(names) ? names : []).filter(
    (name) => String(name).endsWith(".zip") && versionPattern.test(String(name))
  );
  if (matches.length !== 1) {
    throw new Error(`Expected exactly one updater ZIP for ${version}, found ${matches.length}.`);
  }
  return matches[0];
}

function readFirstMacUpdateFile(source) {
  let inFiles = false;
  let entry = null;
  let fileEntryCount = 0;
  const fileUrls = [];

  const lines = String(source || "").split(/\r?\n/);
  const versionLines = lines.filter((line) => /^version:\s*\S/.test(line));
  if (versionLines.length !== 1) {
    throw new Error("latest-mac.yml must have one top-level version.");
  }
  const version = yamlScalar(versionLines[0].replace(/^version:\s*/, ""));

  for (const line of lines) {
    if (/^files:\s*$/.test(line)) {
      inFiles = true;
      continue;
    }
    if (!inFiles) continue;
    if (/^\S/.test(line)) break;

    const first = line.match(/^\s{2}-\s+url:\s*(.+?)\s*$/);
    if (first) {
      const url = yamlScalar(first[1]);
      fileUrls.push(url);
      fileEntryCount += 1;
      if (!entry) entry = { url, sha512: null, size: null };
      continue;
    }
    if (!entry || fileEntryCount !== 1) continue;

    const field = line.match(/^\s{4}(sha512|size):\s*(.+?)\s*$/);
    if (!field) continue;
    if (field[1] === "sha512") entry.sha512 = yamlScalar(field[2]);
    if (field[1] === "size") entry.size = Number(yamlScalar(field[2]));
  }

  if (
    fileUrls.length !== 1 ||
    fileUrls.some((url) => url !== basename(url) || !url.endsWith(".zip"))
  ) {
    throw new Error(
      "latest-mac.yml must contain only local ZIP assets and exactly one updater ZIP."
    );
  }
  if (!entry?.url || !entry.sha512 || !Number.isSafeInteger(entry.size) || entry.size < 0) {
    throw new Error("latest-mac.yml has no complete updater ZIP entry.");
  }
  if (entry.url !== basename(entry.url) || !entry.url.endsWith(".zip")) {
    throw new Error("latest-mac.yml must name one local ZIP asset.");
  }
  const pathLine = lines.find((line) => /^path:\s*\S/.test(line));
  entry.path = pathLine ? yamlScalar(pathLine.replace(/^path:\s*/, "")) : null;
  if (!entry.path || entry.path !== basename(entry.path) || !entry.path.endsWith(".zip")) {
    throw new Error("latest-mac.yml must have one local updater ZIP path.");
  }
  return { ...entry, version };
}

function yamlScalar(value) {
  const raw = String(value || "").trim();
  if (
    raw.length >= 2 &&
    ((raw.startsWith('"') && raw.endsWith('"')) ||
      (raw.startsWith("'") && raw.endsWith("'")))
  ) {
    return raw.slice(1, -1);
  }
  return raw;
}

async function sha512File(path) {
  const hash = createHash("sha512");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("base64");
}

function runCommand(command, args) {
  return spawnSync(command, args, { encoding: "utf8" });
}
