import { spawnSync } from "node:child_process";

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

function runCommand(command, args) {
  return spawnSync(command, args, { encoding: "utf8" });
}
