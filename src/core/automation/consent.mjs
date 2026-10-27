// consent.mjs: the decision layer for browser automation.
//
// Every capability is ON by default per workspace; the operator turns one off with
// a single switch (`careerrat automation disable <capability> [platform] --write`).
// There is no ToS consent ledger, setup mode, or scoped grant any more. This module
// is the single place that answers "may I drive a logged-in browser for capability C
// on platform P?" so no skill hardcodes that policy in prose. The predicate is:
// the capability applies to the platform, and neither the capability switch nor the
// platform switch is explicitly false. Safety checks that are not consent
// (origin checks, captcha/2FA halts, mail_access never-send scope, comp-leak guards,
// application limits) live in their own modules and are unchanged.
//
// Reads are dependency-free (parseYaml + the repo schema validator). Writes reuse
// the gate-writer text primitives so candidate/automation.yml is patched
// comment-preserving, schema-validated, and atomically — same safety as gate-as-data.

import { copyFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { displayPath, userPath } from "../paths/workspace.mjs";
import { candidateConfigSource, loadCandidateDoc } from "../profile/config-store.mjs";
import { atomicWriteFile, findKeyPath, setScalar, validateText } from "../profile/gate-writer.mjs";
import { validate } from "../profile/schema-validator.mjs";
import { parseYaml } from "../profile/yaml.mjs";
import {
  describeProviders,
  detectPlaywrightTooling,
  detectSession,
  PROVIDERS,
} from "./session.mjs";

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
  messaging: {
    phase: 3,
    label: "In-platform messaging",
    summary: "read in-platform DMs into communications[]",
    platforms: ["linkedin", "wellfound"],
  },
  authenticated_apply_preparation: {
    phase: 4,
    label: "Authenticated apply preparation",
    summary: "fill the modal, then submit or stop per the submit setting",
    platforms: [
      "greenhouse",
      "lever",
      "ashby",
      "workable",
      "smartrecruiters",
      "linkedin",
      "external_ats",
    ],
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

// Every platform referenced by any capability.
export const PLATFORMS = Array.from(
  new Set(CAPABILITY_KEYS.flatMap((k) => CAPABILITIES[k].platforms))
).sort();

export function isCapability(name) {
  return Object.hasOwn(CAPABILITIES, name);
}

// ---------------------------------------------------------------------------
// The all-ON default: what an absent (or empty) automation config means.
// ---------------------------------------------------------------------------

export function defaultAutomation() {
  const capabilities = {};
  for (const [cap, def] of Object.entries(CAPABILITIES)) {
    const platforms = {};
    for (const p of def.platforms) platforms[p] = true;
    capabilities[cap] = { enabled: true, platforms };
  }
  return {
    version: 1,
    capabilities_default: "on",
    capabilities,
    session: { provider: "auto" },
  };
}

// normalizeAutomationConfig: the one place that reconciles a stored automation
// doc with the on-by-default contract. A doc carrying `capabilities_default: "on"`
// was written under the new contract, so its explicit false values are real
// operator choices and only missing keys are filled (as on). A doc without the
// marker predates the change: its false values are just the old off default, so
// every capability key (plus the retired consent/setup_mode keys) is dropped and
// the effective config is the all-on default merged with the doc's other keys
// (session, submit, anything else). Pure: never touches disk, so loading never writes.
export function normalizeAutomationConfig(stored) {
  const doc = stored && typeof stored === "object" && !Array.isArray(stored) ? stored : {};
  if (doc.capabilities_default === "on") return deepMerge(defaultAutomation(), doc);
  const { capabilities: _c, consent: _k, setup_mode: _m, capabilities_default: _d, ...rest } = doc;
  return deepMerge(defaultAutomation(), rest);
}

// mergeAutomationDefaults: the normalized view of a stored automation doc, so a
// newly-added capability (or a doc that predates one) reads on instead of
// `undefined`. Used by the CLI's DB-mode edit path (src/cli/automation.mjs), the
// DB patch path, and the settings.explain/settings.apply Ask intents
// (workspace-agent.mjs) so every surface computes the same "current value".
export function mergeAutomationDefaults(data) {
  return normalizeAutomationConfig(data);
}

function deepMerge(base, patch) {
  if (Array.isArray(patch)) return patch.slice();
  if (!patch || typeof patch !== "object") return patch;
  const out = { ...(base && typeof base === "object" && !Array.isArray(base) ? base : {}) };
  for (const [key, value] of Object.entries(patch)) {
    out[key] =
      value && typeof value === "object" && !Array.isArray(value)
        ? deepMerge(out[key], value)
        : Array.isArray(value)
          ? value.slice()
          : value;
  }
  return out;
}

// Setup modes were retired. 72b-2/72b-3 remove the remaining callers.
export function automationModePatch() {
  return {};
}

// ---------------------------------------------------------------------------
// loadAutomation: read + validate. Absent file => all-ON default, exists:false.
// ---------------------------------------------------------------------------

export function loadAutomation({ root = DEFAULT_ROOT, env = process.env } = {}) {
  const path = userPath({ repoRoot: root, env }, AUTOMATION_FILE);
  const display = displayPath({ repoRoot: root, env }, AUTOMATION_FILE);
  const source = candidateConfigSource({ repoRoot: root, env });
  if (source === "db") {
    const data = loadCandidateDoc("automation", { repoRoot: root, env }) || {};
    const schemaPath = join(root, AUTOMATION_SCHEMA);
    const schema = existsSync(schemaPath) ? JSON.parse(readFileSync(schemaPath, "utf8")) : null;
    const { valid, errors } = schema ? validate(data, schema) : { valid: true, errors: [] };
    return {
      exists: true,
      valid,
      errors,
      data: normalizeAutomationConfig(data),
      path: display,
      source,
    };
  }
  if (!existsSync(path)) {
    return {
      exists: false,
      valid: true,
      errors: [],
      data: defaultAutomation(),
      path: display,
      source,
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
      source,
    };
  }
  const schemaPath = join(root, AUTOMATION_SCHEMA);
  const schema = existsSync(schemaPath) ? JSON.parse(readFileSync(schemaPath, "utf8")) : null;
  const { valid, errors } = schema ? validate(data, schema) : { valid: true, errors: [] };
  return {
    exists: true,
    valid,
    errors,
    data: normalizeAutomationConfig(data),
    path: display,
    source,
  };
}

// ---------------------------------------------------------------------------
// Submit mode — the one resolver for whether the agent presses the final Submit.
// `submit: auto | manual` is a top-level key in candidate/automation.yml. Absent
// key (or absent file) means "auto"; "manual" keeps the human-presses-Submit
// behavior and only applies when it is set explicitly. Anything else is an error.
// ---------------------------------------------------------------------------

const SUBMIT_MODES = ["auto", "manual"];

export function resolveSubmitMode(config) {
  if (!config || typeof config !== "object" || !Object.hasOwn(config, "submit")) return "auto";
  const value = config.submit;
  if (!SUBMIT_MODES.includes(value)) {
    throw new Error(`candidate/automation.yml: submit must be "auto" or "manual"`);
  }
  return value;
}

export function loadSubmitMode({ root = DEFAULT_ROOT, env = process.env } = {}) {
  const loaded = loadAutomation({ root, env });
  // A corrupt file must not silently read as "auto" for someone who set "manual".
  const parseError = loaded.errors.find((err) =>
    String(err.message).startsWith("YAML parse error")
  );
  if (parseError) throw new Error(`candidate/automation.yml is unreadable: ${parseError.message}`);
  return resolveSubmitMode(loaded.data);
}

// ---------------------------------------------------------------------------
// mayRun: the predicate. allowed iff the capability applies to the platform and
// neither the capability switch nor the platform switch is explicitly false.
// Missing keys mean on. Accepts a preloaded `data`, or loads from `root`. Returns
// { allowed, reasons, checks } so callers can show the user exactly which switch
// is off and the command that turns it back on.
// ---------------------------------------------------------------------------

export function mayRun({
  capability,
  platform,
  data,
  root = DEFAULT_ROOT,
  env = process.env,
} = {}) {
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

  const cfg = data || loadAutomation({ root, env }).data;
  const cap = cfg?.capabilities?.[capability] || {};
  const globalOn = cap.enabled !== false;
  const platformOn = cap.platforms?.[platform] !== false;

  if (!globalOn)
    reasons.push(
      `capability "${capability}" is turned off (turn on: \`careerrat automation enable ${capability} --write\`)`
    );
  if (!platformOn)
    reasons.push(
      `platform "${platform}" is turned off for ${capability} (turn on: \`careerrat automation enable ${capability} ${platform} --write\`)`
    );

  return {
    allowed: globalOn && platformOn,
    reasons,
    checks: { global: globalOn, platform: platformOn },
  };
}

// ---------------------------------------------------------------------------
// status — the full matrix for `automation status`, doctor, and skills.
// ---------------------------------------------------------------------------

export function automationStatus({
  root = DEFAULT_ROOT,
  env = process.env,
  playwrightToolingDependencies,
} = {}) {
  const loaded = loadAutomation({ root, env });
  const cfg = loaded.data;

  const capabilities = CAPABILITY_KEYS.map((cap) => {
    const def = CAPABILITIES[cap];
    const node = cfg.capabilities?.[cap] || {};
    const globalOn = node.enabled !== false;
    const platforms = def.platforms.map((platform) => {
      const verdict = mayRun({ capability: cap, platform, data: cfg });
      return {
        platform,
        enabled: node.platforms?.[platform] !== false,
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
  const detectedSession = detectSession({ data: cfg, repoRoot: root, env });
  const session = {
    provider: detectedSession.configuredProvider,
    effectiveProvider: detectedSession.provider,
    profileRoot: detectedSession.profileRoot,
    presence: detectedSession.presence,
    tooling: {
      playwright: detectPlaywrightTooling(playwrightToolingDependencies),
    },
    options: describeProviders({ env }).map(({ id, label, needs, automatedApply }) => ({
      id,
      label,
      needs,
      automatedApply,
    })),
  };

  let submit = "auto";
  try {
    submit = resolveSubmitMode(cfg);
  } catch {
    // An invalid value is already reported through loaded.errors.
  }

  return {
    exists: loaded.exists,
    valid: loaded.valid,
    errors: loaded.errors,
    submit,
    liveCount,
    capabilities,
    session,
  };
}

// ---------------------------------------------------------------------------
// ensureAutomationFile — scaffold candidate/automation.yml from the template on
// first write (the first `enable`/`disable` creates it).
// ---------------------------------------------------------------------------

export function ensureAutomationFile({ root = DEFAULT_ROOT, env = process.env } = {}) {
  const dest = userPath({ repoRoot: root, env }, AUTOMATION_FILE);
  const display = displayPath({ repoRoot: root, env }, AUTOMATION_FILE);
  if (existsSync(dest)) return { created: false, path: display };
  mkdirSync(dirname(dest), { recursive: true });
  copyFileSync(join(root, AUTOMATION_TEMPLATE), dest);
  return { created: true, path: display };
}

// ---------------------------------------------------------------------------
// resolveEditPath — map an edit intent to the dotted YAML path + human label.
// kind: "capability" | "platform" | "session" | "submit".
// ---------------------------------------------------------------------------

export function resolveEditPath({ kind, capability, platform }) {
  if (kind === "session") {
    return { parts: ["session", "provider"], label: "session browser provider" };
  }
  if (kind === "submit") {
    return { parts: ["submit"], label: "final submit mode" };
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

function scaffoldAutomationPath(text, { kind, capability }) {
  let next = text;
  if (kind === "capability" || kind === "platform") {
    next = ensureMappingBlock(next, [], "capabilities");
    next = ensureCapabilityBlock(next, capability);
    next = ensureMappingScalar(next, ["capabilities", capability], "enabled", true);
    next = ensureMappingBlock(next, ["capabilities", capability], "platforms");
    for (const p of CAPABILITIES[capability].platforms) {
      next = ensureMappingScalar(next, ["capabilities", capability, "platforms"], p, true);
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
    `${" ".repeat(childIndent + 2)}enabled: true`,
    `${" ".repeat(childIndent + 2)}platforms:`,
    ...CAPABILITIES[capability].platforms.map((p) => `${" ".repeat(platformIndent)}${p}: true`),
  ];
  lines.splice(insertAt, 0, ...block);
  return lines.join("\n");
}

// Scaffold a top-level scalar key (e.g. `submit`) that predates this field
// on an older automation.yml. No-op if the key already exists.
function ensureTopLevelScalar(text, key, defaultValue) {
  const lines = text.split("\n");
  if (findKeyPath(lines, [key])) return text;
  const insertAt = topLevelInsertIndex(lines);
  lines.splice(insertAt, 0, `${key}: ${defaultValue}`);
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
// migrateLegacyAutomationText: the legacy-file write-path half of
// normalizeAutomationConfig. A candidate/automation.yml without the
// `capabilities_default: on` marker holds off values from the old default, so the
// next write starts from the on-by-default template instead and carries over only
// the doc's submit and session choices. Text that already has the marker is
// returned untouched (comments and explicit false values preserved).
// ---------------------------------------------------------------------------

export function migrateLegacyAutomationText(currentText, templateText) {
  let doc = null;
  try {
    doc = parseYaml(currentText);
  } catch {
    return currentText;
  }
  if (!doc || typeof doc !== "object" || doc.capabilities_default === "on") return currentText;
  let next = templateText;
  const carry = [];
  if (doc.submit === "auto" || doc.submit === "manual") carry.push([["submit"], doc.submit]);
  if (typeof doc.session?.provider === "string") {
    carry.push([["session", "provider"], doc.session.provider]);
  }
  if (typeof doc.session?.profile_root === "string") {
    carry.push([["session", "profile_root"], doc.session.profile_root]);
  }
  for (const [parts, value] of carry) {
    const patch = setScalar(next, parts, value);
    if (patch.ok) next = patch.text;
  }
  return next;
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

// ---------------------------------------------------------------------------
// planSubmitEdit: pure (no fs), comment-preserving next text for the final
// submit mode (`auto` | `manual`). Absent key reads as auto, so a missing key
// scaffolds as auto before the edit.
// ---------------------------------------------------------------------------

export function planSubmitEdit({ submit, currentText, schema = null }) {
  if (!SUBMIT_MODES.includes(submit)) {
    return { ok: false, error: 'submit mode must be "auto" or "manual"' };
  }
  const { parts, label } = resolveEditPath({ kind: "submit" });
  const scaffoldedText = ensureTopLevelScalar(currentText, "submit", "auto");
  const patch = setScalar(scaffoldedText, parts, submit);
  if (!patch.ok) return { ok: false, error: patch.error };

  const validation = patch.changed ? validateText(patch.text, schema) : { valid: true, errors: [] };
  return {
    ok: true,
    path: parts.join("."),
    label,
    value: submit,
    previous: patch.previous,
    changed: patch.changed,
    valid: validation.valid,
    errors: validation.errors,
    nextText: patch.text,
  };
}

export { atomicWriteFile };
