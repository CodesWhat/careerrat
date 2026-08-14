function value(env, name) {
  return String(env?.[name] || "").trim();
}

export function resolveNotaryCredentials(env = {}) {
  const profile = value(env, "APPLE_KEYCHAIN_PROFILE");
  if (profile) {
    const args = ["--keychain-profile", profile];
    const keychain = value(env, "APPLE_KEYCHAIN");
    if (keychain) args.push("--keychain", keychain);
    return args;
  }

  const apiKey = value(env, "APPLE_API_KEY");
  const apiKeyId = value(env, "APPLE_API_KEY_ID");
  const apiIssuer = value(env, "APPLE_API_ISSUER");
  if (apiKey && apiKeyId && apiIssuer) {
    return ["--key", apiKey, "--key-id", apiKeyId, "--issuer", apiIssuer];
  }

  const appleId = value(env, "APPLE_ID");
  const password = value(env, "APPLE_APP_SPECIFIC_PASSWORD");
  const teamId = value(env, "APPLE_TEAM_ID");
  if (appleId && password && teamId) {
    return ["--apple-id", appleId, "--password", password, "--team-id", teamId];
  }

  throw new Error(
    "Apple notarization credentials are missing. Set APPLE_KEYCHAIN_PROFILE, " +
      "APPLE_API_KEY/APPLE_API_KEY_ID/APPLE_API_ISSUER, or " +
      "APPLE_ID/APPLE_APP_SPECIFIC_PASSWORD/APPLE_TEAM_ID."
  );
}

export function parseDeveloperIdAuthority(output) {
  const match = String(output || "").match(
    /^Authority=(Developer ID Application:[^\r\n]+)$/m
  );
  if (!match) throw new Error("The packaged app has no Developer ID Application signing authority.");
  return match[1];
}

export function releaseDmgContainer({ dmgPath, signingIdentity, env = {}, run }) {
  if (!dmgPath) throw new Error("The DMG path is required.");
  if (!signingIdentity) throw new Error("The Developer ID signing identity is required.");
  if (typeof run !== "function") throw new TypeError("run must be a function");

  const credentials = resolveNotaryCredentials(env);
  const steps = [
    {
      label: "DMG signing",
      command: "codesign",
      args: ["--force", "--sign", signingIdentity, dmgPath],
    },
    {
      label: "DMG notarization",
      command: "xcrun",
      args: ["notarytool", "submit", dmgPath, ...credentials, "--wait"],
    },
    {
      label: "DMG stapling",
      command: "xcrun",
      args: ["stapler", "staple", dmgPath],
    },
  ];

  for (const step of steps) {
    const result = run(step.command, step.args);
    if (result?.status !== 0) throw new Error(`${step.label} failed.`);
  }
}
