// manifest.mjs — validates a bundled plugin's manifest.json against the plugin
// contract. Plugins under plugins/<name>/ are code we ship, never user-added or
// remote code, so this is a bounded-capability contract (what a plugin may read,
// what it may fetch, which consent capability gates it) rather than a plugin
// marketplace format. Never throws: a malformed manifest is a validation result,
// not an exception, so callers (the runner, listBundledPlugins) can report it
// plainly instead of crashing.

const NAME_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const SEMVER_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

// The closed set of context slices a plugin may declare it reads. Anything
// outside this set (profile, evidence, honesty, form defaults, comp) is never
// reachable through the plugin context regardless of what a manifest claims.
const PLUGIN_READ_KEYS = ["role", "company", "jd", "targeting"];

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

// Guards manifest.entry against escaping the plugin's own directory. Bundled
// plugins ship with the repo, so this isn't defending against a hostile
// manifest today, but the runner joins this value onto a filesystem path and
// dynamically imports it, so it stays a real check rather than an assumption.
function isSafeRelativeEntry(value) {
  if (!isNonEmptyString(value)) return false;
  if (value.startsWith("/") || value.startsWith("\\")) return false;
  if (/(^|[/\\])\.\.(?:[/\\]|$)/.test(value)) return false;
  return true;
}

export function validateManifest(obj) {
  const errors = [];
  const source = obj && typeof obj === "object" && !Array.isArray(obj) ? obj : {};

  if (!isNonEmptyString(source.name) || !NAME_RE.test(source.name)) {
    errors.push('name must be a kebab-case string (e.g. "h1b-sponsor")');
  }
  if (!isNonEmptyString(source.version) || !SEMVER_RE.test(source.version)) {
    errors.push('version must be a semver string (e.g. "1.0.0")');
  }
  if (!isNonEmptyString(source.description)) {
    errors.push("description is required");
  }
  if (
    source.capability !== null &&
    source.capability !== undefined &&
    !isNonEmptyString(source.capability)
  ) {
    errors.push("capability must be a string or null");
  }
  if (!Array.isArray(source.reads)) {
    errors.push("reads must be an array");
  } else {
    const unknown = source.reads.filter((r) => !PLUGIN_READ_KEYS.includes(r));
    if (unknown.length) {
      errors.push(
        `reads contains unknown entries: ${unknown.join(", ")} (allowed: ${PLUGIN_READ_KEYS.join(", ")})`
      );
    }
  }
  if (!Array.isArray(source.fetchHosts)) {
    errors.push("fetchHosts must be an array");
  } else if (source.fetchHosts.some((h) => !isNonEmptyString(h) || h.includes("/"))) {
    errors.push("fetchHosts must contain only non-empty hostnames (no scheme or path)");
  }
  if (!isSafeRelativeEntry(source.entry)) {
    errors.push("entry must be a relative path inside the plugin's own directory");
  }

  if (errors.length) return { ok: false, manifest: null, errors };

  return {
    ok: true,
    errors: [],
    manifest: {
      name: source.name,
      version: source.version,
      description: source.description,
      capability: source.capability ?? null,
      reads: source.reads.slice(),
      fetchHosts: source.fetchHosts.map((h) => String(h).toLowerCase()),
      entry: source.entry,
    },
  };
}
