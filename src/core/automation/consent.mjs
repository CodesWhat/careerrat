// consent.mjs — the decision layer for opt-in browser automation.
//
// Everything authenticated-browser is OPT-IN and DEFAULTS OFF: no
// candidate/automation.yml means nothing is automated. This module is the single
// place that answers "may I drive a logged-in browser for capability C on platform
// P?" so no skill hardcodes that policy in prose. The predicate is a hard
// three-part AND (capability global switch · per-platform switch · per-platform ToS
// consent) — see AGENTS.md → Browser Automation Contract.
//
// Reads are dependency-free (parseYaml + the repo schema validator). Writes reuse
// the gate-writer text primitives so candidate/automation.yml is patched
// comment-preserving, schema-validated, and atomically — same safety as gate-as-data.

import { copyFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { displayPath, userPath } from "../paths/workspace.mjs";
import { atomicWriteFile, findKeyPath, setScalar, validateText } from "../profile/gate-writer.mjs";
import { validate } from "../profile/schema-validator.mjs";
import { parseYaml } from "../profile/yaml.mjs";
import { PROVIDERS } from "./session.mjs";

const DEFAULT_ROOT = fileURLToPath(new URL("../../..", import.meta.url));

export const AUTOMATION_FILE = "candidate/automation.yml";
export const AUTOMATION_TEMPLATE = "templates/automation.example.yml";
export const AUTOMATION_SCHEMA = "config/automation.schema.json";

// ---------------------------------------------------------------------------
// Canonical capability/platform model — the single source of truth in code.
// Mirrors templates/automation.example.yml and config/automation.schema.json.
// `phase` ties each to the M12 build order; `platforms` is the applicable set.
// ---------------------------------------------------------------------------

export const CAPABILITIES = {
  status_polling: {
    phase: 1,
    label: "Portal status polling",
    summary: "read application status from ATS dashboards (read-only)",
    platforms: ["greenhouse", "workday", "ashby", "lever"],
  },
  authenticated_search: {
    phase: 2,
    label: "Authenticated search scanning",
    summary: "logged-in saved-search scraping",
    platforms: ["linkedin", "indeed", "wellfound", "glassdoor"],
  },
  messaging: {
    phase: 3,
    label: "In-platform messaging",
    summary: "read in-platform DMs into communications[]",
    platforms: ["linkedin", "wellfound"],
  },
  one_click_apply: {
    phase: 4,
    label: "Authenticated one-click apply",
    summary: "modal-driven apply under the apply-job submit gate",
    platforms: ["linkedin"],
  },
  profile_optimize: {
    phase: 5,
    label: "LinkedIn profile optimize (read + suggest)",
    summary: "read the profile and suggest honest, evidence-backed rewrites (read-only)",
    platforms: ["linkedin"],
  },
  profile_apply: {
    phase: 5,
    label: "LinkedIn profile apply (write approved edits)",
    summary: "write the approved profile rewrites back through the session browser",
    platforms: ["linkedin"],
  },
  mail_access: {
    phase: 6,
    label: "Session webmail access",
    summary: "read one recent verification-code email or opted-in webmail recruiting updates",
    platforms: ["gmail", "outlook", "webmail"],
  },
  relationship_sourcing: {
    phase: 7,
    label: "Relationship sourcing",
    summary: "find likely recruiters, hiring-team members, or warm contacts for review",
    platforms: ["linkedin", "wellfound"],
  },
  calendar_sync: {
    phase: 8,
    label: "Calendar provider sync",
    summary: "write confirmed tracker events to real calendar providers or local automation tools",
    platforms: ["apple_calendar", "google_calendar", "outlook_calendar", "automation_tools"],
  },
  calendar_read: {
    phase: 8,
    label: "Calendar free/busy read",
    summary:
      "read the candidate's real calendar (work or personal) for free/busy so interviews can be scheduled around existing commitments; busy blocks are stored opaque (no titles/attendees)",
    platforms: ["apple_calendar", "google_calendar", "outlook_calendar", "work_calendar"],
  },
};

export const CAPABILITY_KEYS = Object.keys(CAPABILITIES);

// Every platform referenced by any capability, plus the consent ledger order.
export const PLATFORMS = Array.from(
  new Set(CAPABILITY_KEYS.flatMap((k) => CAPABILITIES[k].platforms))
).sort();

export function isCapability(name) {
  return Object.hasOwn(CAPABILITIES, name);
}

export function isPlatform(name) {
  return PLATFORMS.includes(name);
}

// ---------------------------------------------------------------------------
// The all-OFF synthetic — what an absent (or empty) automation.yml means.
// ---------------------------------------------------------------------------

export function defaultAutomation() {
  const consent = {};
  for (const p of PLATFORMS) consent[p] = false;
  const capabilities = {};
  for (const [cap, def] of Object.entries(CAPABILITIES)) {
    const platforms = {};
    for (const p of def.platforms) platforms[p] = false;
    capabilities[cap] = { enabled: false, platforms };
  }
  return {
    version: 1,
    consent,
    capabilities,
    session: { provider: "extension", profile_root: null },
  };
}

// ---------------------------------------------------------------------------
// loadAutomation — read + validate. Absent file => all-OFF synthetic, exists:false.
// ---------------------------------------------------------------------------

export function loadAutomation({ root = DEFAULT_ROOT } = {}) {
  const path = userPath({ repoRoot: root }, AUTOMATION_FILE);
  const display = displayPath({ repoRoot: root }, AUTOMATION_FILE);
  if (!existsSync(path)) {
    return {
      exists: false,
      valid: true,
      errors: [],
      data: defaultAutomation(),
      path: display,
    };
  }
  let data;
  try {
    data = parseYaml(readFileSync(path, "utf8"));
  } catch (err) {
    return {
      exists: true,
      valid: false,
      errors: [{ path: "", message: `YAML parse error: ${err.message}` }],
      data: defaultAutomation(),
      path: display,
    };
  }
  const schemaPath = join(root, AUTOMATION_SCHEMA);
  const schema = existsSync(schemaPath) ? JSON.parse(readFileSync(schemaPath, "utf8")) : null;
  const { valid, errors } = schema ? validate(data, schema) : { valid: true, errors: [] };
  return {
    exists: true,
    valid,
    errors,
    data: data && typeof data === "object" ? data : defaultAutomation(),
    path: display,
  };
}

// ---------------------------------------------------------------------------
// mayRun — the hard predicate. allowed iff global ∧ platform ∧ consent.
// Accepts a preloaded `data`, or loads from `root`. Returns { allowed, reasons,
// checks } so callers can show the user exactly which switch is off.
// ---------------------------------------------------------------------------

export function mayRun({ capability, platform, data, root = DEFAULT_ROOT } = {}) {
  const reasons = [];
  if (!isCapability(capability)) {
    return { allowed: false, reasons: [`unknown capability "${capability}"`], checks: {} };
  }
  if (!CAPABILITIES[capability].platforms.includes(platform)) {
    return {
      allowed: false,
      reasons: [
        `${capability} does not apply to platform "${platform}" (applies to: ${CAPABILITIES[capability].platforms.join(", ")})`,
      ],
      checks: {},
    };
  }

  const cfg = data || loadAutomation({ root }).data;
  const cap = cfg.capabilities?.[capability] || {};
  const globalOn = cap.enabled === true;
  const platformOn = !!(cap.platforms && cap.platforms[platform] === true);
  const consentOn = !!(cfg.consent && cfg.consent[platform] === true);

  if (!globalOn)
    reasons.push(
      `capability "${capability}" is disabled (enable: \`careerrat automation enable ${capability} --write\`)`
    );
  if (!platformOn)
    reasons.push(
      `platform "${platform}" is off for ${capability} (enable: \`careerrat automation enable ${capability} ${platform} --write\`)`
    );
  if (!consentOn)
    reasons.push(
      `ToS consent for "${platform}" not recorded (record: \`careerrat automation consent ${platform} --write\`)`
    );

  const allowed = globalOn && platformOn && consentOn;
  return {
    allowed,
    reasons,
    checks: { global: globalOn, platform: platformOn, consent: consentOn },
  };
}

// ---------------------------------------------------------------------------
// status — the full matrix for `automation status`, doctor, and skills.
// ---------------------------------------------------------------------------

export function automationStatus({ root = DEFAULT_ROOT } = {}) {
  const loaded = loadAutomation({ root });
  const cfg = loaded.data;

  const capabilities = CAPABILITY_KEYS.map((cap) => {
    const def = CAPABILITIES[cap];
    const node = cfg.capabilities?.[cap] || {};
    const globalOn = node.enabled === true;
    const platforms = def.platforms.map((platform) => {
      const verdict = mayRun({ capability: cap, platform, data: cfg });
      return {
        platform,
        enabled: !!(node.platforms && node.platforms[platform] === true),
        consent: !!(cfg.consent && cfg.consent[platform] === true),
        allowed: verdict.allowed,
      };
    });
    return {
      capability: cap,
      phase: def.phase,
      label: def.label,
      summary: def.summary,
      enabled: globalOn,
      liveCount: platforms.filter((p) => p.allowed).length,
      platforms,
    };
  });

  const liveCount = capabilities.reduce((n, c) => n + c.liveCount, 0);
  const session = {
    provider: cfg.session?.provider || "extension",
    profileRoot: cfg.session?.profile_root || null,
  };

  return {
    exists: loaded.exists,
    valid: loaded.valid,
    errors: loaded.errors,
    liveCount,
    capabilities,
    consent: Object.fromEntries(
      PLATFORMS.map((p) => [p, !!(cfg.consent && cfg.consent[p] === true)])
    ),
    session,
  };
}

// ---------------------------------------------------------------------------
// ensureAutomationFile — scaffold candidate/automation.yml from the template on
// first write (opt-in: the first `enable`/`consent` creates it).
// ---------------------------------------------------------------------------

export function ensureAutomationFile({ root = DEFAULT_ROOT } = {}) {
  const dest = userPath({ repoRoot: root }, AUTOMATION_FILE);
  const display = displayPath({ repoRoot: root }, AUTOMATION_FILE);
  if (existsSync(dest)) return { created: false, path: display };
  mkdirSync(dirname(dest), { recursive: true });
  copyFileSync(join(root, AUTOMATION_TEMPLATE), dest);
  return { created: true, path: display };
}

// ---------------------------------------------------------------------------
// resolveEditPath — map an edit intent to the dotted YAML path + human label.
// kind: "consent" | "capability" | "platform".
// ---------------------------------------------------------------------------

export function resolveEditPath({ kind, capability, platform }) {
  if (kind === "consent") {
    if (!isPlatform(platform))
      throw new Error(`unknown platform "${platform}". Known: ${PLATFORMS.join(", ")}`);
    return { parts: ["consent", platform], label: `consent for ${platform}` };
  }
  if (kind === "session") {
    return { parts: ["session", "provider"], label: "session browser provider" };
  }
  if (!isCapability(capability))
    throw new Error(`unknown capability "${capability}". Known: ${CAPABILITY_KEYS.join(", ")}`);
  if (kind === "capability") {
    return {
      parts: ["capabilities", capability, "enabled"],
      label: `${capability} (global switch)`,
    };
  }
  if (kind === "platform") {
    if (!CAPABILITIES[capability].platforms.includes(platform)) {
      throw new Error(
        `${capability} does not apply to "${platform}" (applies to: ${CAPABILITIES[capability].platforms.join(", ")})`
      );
    }
    return {
      parts: ["capabilities", capability, "platforms", platform],
      label: `${capability} on ${platform}`,
    };
  }
  throw new Error(`unknown edit kind "${kind}"`);
}

// ---------------------------------------------------------------------------
// planAutomationEdit — pure (no fs): compute the comment-preserving next text for
// a single boolean toggle, validated against the schema. Mirrors computeGateEdit.
// ---------------------------------------------------------------------------

export function planAutomationEdit({
  kind,
  capability,
  platform,
  value,
  currentText,
  schema = null,
}) {
  const { parts, label } = resolveEditPath({ kind, capability, platform });
  const scaffoldedText = scaffoldAutomationPath(currentText, { kind, capability, platform });
  const patch = setScalar(scaffoldedText, parts, value === true);
  if (!patch.ok) return { ok: false, error: patch.error };

  const validation = patch.changed ? validateText(patch.text, schema) : { valid: true, errors: [] };
  return {
    ok: true,
    path: parts.join("."),
    label,
    value: value === true,
    previous: patch.previous,
    changed: patch.changed,
    valid: validation.valid,
    errors: validation.errors,
    nextText: patch.text,
  };
}

function scaffoldAutomationPath(text, { kind, capability, platform }) {
  let next = text;
  if (kind === "consent") {
    next = ensureMappingBlock(next, [], "consent");
    next = ensureMappingScalar(next, ["consent"], platform, false);
    return next;
  }
  if (kind === "capability" || kind === "platform") {
    next = ensureMappingBlock(next, [], "capabilities");
    next = ensureCapabilityBlock(next, capability);
    next = ensureMappingScalar(next, ["capabilities", capability], "enabled", false);
    next = ensureMappingBlock(next, ["capabilities", capability], "platforms");
    for (const p of CAPABILITIES[capability].platforms) {
      next = ensureMappingScalar(next, ["capabilities", capability, "platforms"], p, false);
    }
  }
  return next;
}

function ensureCapabilityBlock(text, capability) {
  const lines = text.split("\n");
  if (findKeyPath(lines, ["capabilities", capability])) return text;

  const capabilities = findKeyPath(lines, ["capabilities"]);
  if (!capabilities) return text;

  const insertAt = blockEnd(lines, capabilities.index, capabilities.indent);
  const childIndent = capabilities.indent + 2;
  const platformIndent = childIndent + 4;
  const block = [
    `${" ".repeat(childIndent)}${capability}:`,
    `${" ".repeat(childIndent + 2)}enabled: false`,
    `${" ".repeat(childIndent + 2)}platforms:`,
    ...CAPABILITIES[capability].platforms.map((p) => `${" ".repeat(platformIndent)}${p}: false`),
  ];
  lines.splice(insertAt, 0, ...block);
  return lines.join("\n");
}

function ensureMappingBlock(text, parentParts, key) {
  const lines = text.split("\n");
  const targetParts = [...parentParts, key];
  if (findKeyPath(lines, targetParts)) return text;

  if (parentParts.length === 0) {
    const insertAt = topLevelInsertIndex(lines);
    lines.splice(insertAt, 0, `${key}:`);
    return lines.join("\n");
  }

  const parent = findKeyPath(lines, parentParts);
  if (!parent) return text;
  const insertAt = lastDirectChildIndex(lines, parent) + 1;
  lines.splice(insertAt, 0, `${" ".repeat(parent.indent + 2)}${key}:`);
  return lines.join("\n");
}

function ensureMappingScalar(text, parentParts, key, defaultValue) {
  const lines = text.split("\n");
  const targetParts = [...parentParts, key];
  if (findKeyPath(lines, targetParts)) return text;

  const parent = findKeyPath(lines, parentParts);
  if (!parent) return text;
  const insertAt = lastDirectChildIndex(lines, parent) + 1;
  lines.splice(insertAt, 0, `${" ".repeat(parent.indent + 2)}${key}: ${defaultValue}`);
  return lines.join("\n");
}

function lastDirectChildIndex(lines, parent) {
  const end = blockEnd(lines, parent.index, parent.indent);
  let last = parent.index;
  for (let i = parent.index + 1; i < end; i++) {
    if (isSkippable(lines[i])) continue;
    if (indentOf(lines[i]) === parent.indent + 2) last = i;
  }
  return last;
}

function topLevelInsertIndex(lines) {
  let last = lines.length;
  while (last > 0 && lines[last - 1] === "") last--;
  return last;
}

function blockEnd(lines, keyIndex, keyIndent) {
  for (let i = keyIndex + 1; i < lines.length; i++) {
    if (isSkippable(lines[i])) continue;
    if (indentOf(lines[i]) <= keyIndent) return i;
  }
  return lines.length;
}

function indentOf(line) {
  return line.length - line.trimStart().length;
}

function isSkippable(line) {
  return line.trim() === "" || line.trimStart().startsWith("#");
}

// ---------------------------------------------------------------------------
// planSessionEdit — pure (no fs): compute the comment-preserving next text for
// the session-browser provider (a STRING, not a boolean — so it can't reuse
// planAutomationEdit). The provider must be one the substrate knows about. The
// edit only chooses WHICH provider drives the session; mayRun() is untouched —
// provider is HOW a session runs, never WHETHER a capability is allowed.
// ---------------------------------------------------------------------------

export function planSessionEdit({ provider, currentText, schema = null }) {
  if (!PROVIDERS[provider]) {
    return {
      ok: false,
      error: `unknown session provider "${provider}". Known: ${Object.keys(PROVIDERS).join(", ")}`,
    };
  }
  const { parts, label } = resolveEditPath({ kind: "session" });
  const patch = setScalar(currentText, parts, provider);
  if (!patch.ok) return { ok: false, error: patch.error };

  const validation = patch.changed ? validateText(patch.text, schema) : { valid: true, errors: [] };
  return {
    ok: true,
    path: parts.join("."),
    label,
    value: provider,
    previous: patch.previous,
    changed: patch.changed,
    valid: validation.valid,
    errors: validation.errors,
    nextText: patch.text,
  };
}

export { atomicWriteFile };
