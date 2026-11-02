// Minimum patched Node.js releases for CVE-2026-111497 (Brotli decoder RCE,
// reachable through fetch). Node 25 is end of life and never got the fix.
// https://nodejs.org/en/blog/vulnerability/october-2026-security-releases
// Keep package.json#engines.node in step with the lowest line here.

const PATCHED = { 24: [24, 22, 1], 26: [26, 12, 1] };

function parse(version) {
  const m = /^v?(\d+)\.(\d+)\.(\d+)/.exec(String(version ?? ""));
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

function atLeast(a, b) {
  for (let i = 0; i < 3; i += 1) {
    if (a[i] !== b[i]) return a[i] > b[i];
  }
  return true;
}

/**
 * Check a Node version string against the patched floor.
 * Returns { ok: true } or { ok: false, message } with the exact upgrade step.
 */
export function checkNodeVersion(version = process.versions.node) {
  const v = parse(version);
  const shown = String(version).replace(/^v/, "");
  if (!v) {
    return {
      ok: false,
      message: `Could not read the Node.js version (${version}). Install Node.js 24.22.1 or newer.`,
    };
  }
  const [major] = v;
  if (PATCHED[major]) {
    if (atLeast(v, PATCHED[major])) return { ok: true };
    const need = PATCHED[major].join(".");
    return {
      ok: false,
      message: `Node.js ${shown} has a known security hole (CVE-2026-111497, Brotli decoder). Upgrade to Node.js ${need} or newer: install the latest ${major}.x from https://nodejs.org/.`,
    };
  }
  if (major > 26) return { ok: true };
  if (major === 25) {
    return {
      ok: false,
      message: `Node.js ${shown} is end of life and has no fix for CVE-2026-111497 (Brotli decoder). Upgrade to Node.js 24.22.1 or newer (24 LTS recommended): https://nodejs.org/.`,
    };
  }
  return {
    ok: false,
    message: `careerrat needs Node.js 24.22.1 or newer (you have ${shown}). Upgrade from https://nodejs.org/.`,
  };
}

/** Print the upgrade text and exit 1 when the running Node is unpatched. */
export function requirePatchedNode() {
  // Electron bundles its own Node, which a user can't upgrade. The desktop build
  // takes its fixes from Electron releases and is being retired.
  if (process.versions.electron) return;
  const result = checkNodeVersion();
  if (!result.ok) {
    process.stderr.write(`careerrat: ${result.message}\n`);
    process.exit(1);
  }
}
