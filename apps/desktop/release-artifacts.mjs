export function canonicalMacDmgName(version) {
  const value = String(version || "").trim();
  if (!/^\d+\.\d+\.\d+$/.test(value)) throw new Error("A stable desktop version is required.");
  return `CareerRat-${value}-arm64.dmg`;
}

export function selectMacReleaseArtifacts({ names, version } = {}) {
  const entries = Array.isArray(names) ? names.filter((name) => typeof name === "string") : [];
  const canonicalDmg = canonicalMacDmgName(version);
  const dmgs = entries.filter((name) => name.endsWith(".dmg"));
  if (dmgs.length !== 1 || dmgs[0] !== canonicalDmg) {
    throw new Error(`Release output must contain exactly ${canonicalDmg} and no other DMG.`);
  }
  const zipPattern = new RegExp(`^CareerRat-${String(version).replace(/\./g, "\\.")}-.*\\.zip$`);
  const zips = entries.filter((name) => zipPattern.test(name));
  if (zips.length !== 1) {
    throw new Error(`Release output must contain exactly one updater ZIP for ${version}.`);
  }
  if (!entries.includes("latest-mac.yml")) {
    throw new Error("Release output must contain latest-mac.yml.");
  }
  const selected = [canonicalDmg, zips[0]];
  if (entries.includes(`${zips[0]}.blockmap`)) selected.push(`${zips[0]}.blockmap`);
  selected.push("latest-mac.yml");
  return selected;
}
