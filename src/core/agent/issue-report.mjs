// issue-report.mjs — the redaction + assembly core behind the report-issue
// skill's Ask row (issue.report / issue.record-filed in workspace-agent.mjs).
// This module never shells out, never calls `gh`, and never publishes
// anything itself — it only builds a redacted title/body and a prefilled
// GitHub URL for the user to review and file themselves (see
// .agents/skills/report-issue/SKILL.md). Redaction fails closed: any doubt
// about whether a piece of text is safe drops it rather than includes it.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { requireDb } from "../db/connection.mjs";
import { candidateConfigGet } from "../db/verbs/candidate.mjs";
import { findCompLeak, findCurrentBaseToken } from "../profile/comp-guard.mjs";

// This file lives at src/core/agent/issue-report.mjs — three levels up from
// its own directory (src/core/agent -> src/core -> src -> repo root) is the
// repo root, same convention as src/core/version.mjs.
const REPO_ROOT = fileURLToPath(new URL("../../..", import.meta.url));

// The upstream issue tracker's base URL, derived once from package.json's
// own `bugs.url` rather than a second hardcoded repo slug.
const ISSUE_REPO_BASE_URL = (() => {
  try {
    const pkg = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8"));
    const bugsUrl = String(pkg?.bugs?.url || "").trim();
    return bugsUrl ? bugsUrl.replace(/\/issues\/?$/i, "") : null;
  } catch {
    return null;
  }
})();

// Error-code families that mean "this candidate's setup needs attention,"
// not "CareerRat has a defect." issue.report still offers to file (the user
// may know better than the heuristic), but the card surfaces this as a hint
// toward Settings/doctor first.
export const CONFIG_FAMILY_CODES = new Set([
  "NO_DATABASE",
  "VALIDATION_FAILED",
  "missing_key",
  "NO_AI_ROUTE",
  "SDK_NOT_INSTALLED",
]);

// Generic, developer-facing descriptions for the workspace-intent error-code
// families a report might reference (see workspace-agent-route.mjs's
// CONFLICT_CODES / 400 list for the vocabulary). No interpolation — these
// strings can never carry candidate data because they never read anything
// but the code itself.
export const ERROR_CODE_DESCRIPTIONS = {
  JOB_REFERENCE_NOT_FOUND: "A natural-language reference to a saved job did not resolve.",
  JOB_REFERENCE_AMBIGUOUS:
    "A natural-language reference to a saved job matched more than one record.",
  COMMUNICATION_REFERENCE_NOT_FOUND:
    "A natural-language reference to a saved communication thread did not resolve.",
  COMMUNICATION_REFERENCE_AMBIGUOUS:
    "A natural-language reference to a saved communication thread matched more than one record.",
  APPLICATION_NOT_VERIFIED: "An application action ran before its submission could be verified.",
  COMMUNICATION_CHANNEL_UNSUPPORTED:
    "The communication thread's channel is not one CareerRat can act on directly.",
  COMMUNICATION_DRAFT_REQUIRED: "An action needed a draft reply that had not been created yet.",
  COMMUNICATION_DRAFT_PLACEHOLDER: "A draft still contained unresolved placeholder text.",
  COMMUNICATION_EXECUTOR_UNAVAILABLE:
    "The supervised browser executor for communications was not available.",
  COMMUNICATION_NOT_DRAFTABLE:
    "The communication thread could not be drafted in its current state.",
  COMMUNICATION_NOT_VERIFIED: "A communication action ran before it could be verified.",
  COMMUNICATION_COMP_LEAK:
    "A communication draft referenced a private compensation figure and was blocked.",
  SETTINGS_CHANGE_INVALID: "A settings change request had an invalid or missing value.",
  SETTINGS_CHANGE_UNSUPPORTED:
    "A settings change request named a field CareerRat does not support changing this way.",
  STRATEGY_APPLY_STALE:
    "A strategy recommendation was applied after the underlying review had gone stale.",
  STRATEGY_APPLY_UNSUPPORTED:
    "A strategy recommendation named a change CareerRat does not know how to apply.",
  STRATEGY_APPLY_INVALID: "A strategy recommendation had an invalid or missing value.",
  VALIDATION_FAILED: "A candidate config write failed schema validation.",
  NO_DATABASE: "No workspace database was found for this repo root.",
  ACTION_FAILED: "A workspace action failed without a more specific error code.",
};
const FALLBACK_ERROR_DESCRIPTION = "CareerRat reported an error without a recognized code.";

// The marker workspace-agent.mjs (the caller) maps to the candidate-safe
// actionError ISSUE_REPORT_COMP_LEAK. This module never fabricates the
// candidate-facing copy itself — that string lives once, in the caller.
export const ISSUE_REPORT_COMP_LEAK_MARKER = "ISSUE_REPORT_COMP_LEAK";

function compLeakRefusal() {
  return Object.assign(new Error("issue report text referenced private or identifying data"), {
    code: ISSUE_REPORT_COMP_LEAK_MARKER,
  });
}

// Bare comp-figure heuristic ("$150,000", "150k") — distinct from
// findCompLeak's phrase-based current-salary guard. Flags for review rather
// than refusing: a candidate may legitimately want to mention a target
// figure in their own bug description.
const COMP_FIGURE_RE = /\$\s?\d{2,3}[,.]?\d{3}\b|\b\d{2,3}k\b/i;

// Collapses any path fragment that runs through workspace/, candidate/, or
// .careerrat/ down to <workspace>/<rest> — this also absorbs whatever
// directory structure (including a /Users/<name>/... prefix) led up to it,
// so the repo layout and the home directory both disappear in one pass.
// Whatever home-directory prefix is left over (unrelated to a workspace
// path) still normalizes to ~/.
function normalizeDiagnosticPaths(text) {
  let working = String(text ?? "");
  working = working.replace(
    /(?:[^\s"'`]*\/)?(?:workspace|candidate|\.careerrat)\/([^\s"'`]*)/gi,
    (_match, rest) => `<workspace>/${rest}`
  );
  working = working.replace(/\/(?:Users|home)\/[^/\s"'`]+/gi, "~");
  working = working.replace(/[A-Za-z]:\\Users\\[^\\\s"'`]+/g, "~");
  return working;
}

// Collapses whitespace runs to a single space, for comparison purposes only
// (never used to mutate visible diagnostic text — wrapped stack traces keep
// their real line breaks in the output).
function collapseWhitespace(value) {
  return String(value ?? "").replace(/\s+/g, " ");
}

// A phone-shaped identifier is (almost) all digits and formatting characters
// with at least 7 digits once formatting is stripped. Anything with letters
// (a street address, a name) never qualifies.
function phoneDigits(id) {
  if (!/^[\d\s()+.-]+$/.test(id)) return null;
  const digits = id.replace(/\D/g, "");
  return digits.length >= 7 ? digits : null;
}

// Builds a case-insensitive match pattern for one identifier: phone-shaped
// identifiers match on digits with optional formatting between each one (so
// "(555) 123-4567", "555.123.4567", and "5551234567" all hit the same
// stored "555-123-4567"); everything else matches word-by-word with \s+
// between words so wrapped or re-flowed text ("Acme\nCorp") still matches a
// single-line identifier ("Acme Corp").
function identifierPattern(id) {
  const digits = phoneDigits(id);
  if (digits) {
    // \D* (not \D?): a single formatting boundary can be more than one
    // character wide, e.g. "(555) 123-4567" has ") " (two chars) between
    // the area code and the exchange.
    return digits.split("").join("\\D*");
  }
  return id
    .split(" ")
    .map((word) => word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("\\s+");
}

// Rewrites known-unsafe path shapes and scrubs every tracked identifier
// (candidate name/email/phone, application company/role strings — see
// collectIdentifiers) out of `text`. Fails closed: if a post-scrub residue
// check still finds an identifier, or findCompLeak fires on the scrubbed
// text, the whole string is dropped rather than partially redacted.
export function redactDiagnosticText(text, { identifiers = [] } = {}) {
  // NFC once, up front, so visually-identical identifiers built from
  // different Unicode compositions (e.g. combining accents) still line up
  // with what collectIdentifiers stored.
  let working = normalizeDiagnosticPaths(String(text ?? "").normalize("NFC"));

  const cleanIdentifiers = Array.from(
    new Set(
      (Array.isArray(identifiers) ? identifiers : [])
        .map((id) => collapseWhitespace(String(id ?? "").normalize("NFC")).trim())
        .filter((id) => id.length >= 3)
    )
  );
  for (const id of cleanIdentifiers) {
    working = working.replace(new RegExp(identifierPattern(id), "gi"), "<redacted>");
  }

  // Same NFC + whitespace-collapse normalization on both sides of the
  // residue compare, so a leftover identifier that only differs by
  // composition or line-wrapping can't slip past as a false negative.
  const normalizedWorking = collapseWhitespace(working.normalize("NFC")).toLowerCase();
  const residue = cleanIdentifiers.some((id) => normalizedWorking.includes(id.toLowerCase()));
  if (residue || findCompLeak(working)) {
    return { text: null, dropped: true };
  }
  return { text: working, dropped: false };
}

// The tracked identity surface for this workspace: company + role strings
// off every application/sourced/communication record, plus the candidate's
// own name/email/phone. Never includes current_base or any comp figure —
// this collects names to scrub, not compensation to read.
export function collectIdentifiers({ repoRoot, env } = {}) {
  const identifiers = new Set();
  const add = (value) => {
    const clean = collapseWhitespace(String(value ?? "").normalize("NFC")).trim();
    if (clean.length >= 3) identifiers.add(clean);
  };

  try {
    const db = requireDb({ repoRoot, env });
    for (const table of ["applications", "sourced", "communications"]) {
      try {
        const rows = db.prepare(`SELECT data FROM ${table}`).all();
        for (const row of rows) {
          let data;
          try {
            data = JSON.parse(row.data);
          } catch {
            continue;
          }
          add(data?.company);
          add(data?.role);
        }
      } catch {
        // Table missing in this schema version — skip it, not the whole report.
      }
    }
  } catch {
    // No database available — identifiers stay whatever candidate config adds below.
  }

  try {
    const profile = candidateConfigGet({ repoRoot, env })?.profile || {};
    const candidate = profile.candidate || {};
    const location = profile.location || {};
    add(candidate.full_name);
    add(candidate.preferred_name);
    add(candidate.email);
    add(candidate.phone);
    // location.home is the current schema; candidate.location is a legacy
    // field some older workspaces still carry (see db/verbs/candidate.mjs).
    add(location.home);
    add(candidate.location);
    if (Array.isArray(location.relocation)) {
      for (const entry of location.relocation) {
        if (typeof entry === "string") add(entry);
      }
    }
  } catch {
    // Candidate config may be absent — identifiers stay whatever the db loop above added.
  }

  return Array.from(identifiers);
}

function truncateTitle(text) {
  const compact = String(text ?? "")
    .replace(/\s+/g, " ")
    .trim();
  return compact.length > 60 ? `${compact.slice(0, 59)}…` : compact;
}

// Builds the redacted {title, body} for a CareerRat bug report. Throws
// (marker: ISSUE_REPORT_COMP_LEAK_MARKER) rather than silently editing the
// candidate's own words whenever their free-text description carries a
// comp-leak phrase or an identifier the redaction pass can't safely drop.
export function buildIssueReport({
  repoRoot,
  env,
  description,
  lastError,
  version,
  nodeVersion,
  platform,
} = {}) {
  const identifiers = collectIdentifiers({ repoRoot, env });
  const rawDescription = String(description ?? "").trim();

  if (findCompLeak(rawDescription)) throw compLeakRefusal();
  const compFlagged = COMP_FIGURE_RE.test(rawDescription);

  let descriptionText = "";
  if (rawDescription) {
    const redacted = redactDiagnosticText(rawDescription, { identifiers });
    if (redacted.dropped) throw compLeakRefusal();
    descriptionText = redacted.text;
  }

  const code = lastError?.code ? String(lastError.code) : null;
  const genericDescription = code
    ? ERROR_CODE_DESCRIPTIONS[code] || FALLBACK_ERROR_DESCRIPTION
    : null;

  let errorMessageDropped = false;
  let scrubbedErrorMessage = "";
  if (code && !ERROR_CODE_DESCRIPTIONS[code] && lastError?.message) {
    const redactedMessage = redactDiagnosticText(String(lastError.message), { identifiers });
    // Machine-generated text fails closed: unlike the user's own
    // description (compFlagged, below), a bare comp figure surviving
    // redaction here has no human in the loop who chose to write it, so it
    // gets dropped outright rather than flagged for review.
    if (
      redactedMessage.dropped ||
      (redactedMessage.text && COMP_FIGURE_RE.test(redactedMessage.text))
    ) {
      errorMessageDropped = true;
    } else if (redactedMessage.text) {
      scrubbedErrorMessage = redactedMessage.text;
    }
  }

  const configHint = Boolean(code && CONFIG_FAMILY_CODES.has(code));

  const bodyLines = [
    "## What happened",
    descriptionText || "No description was provided.",
    "",
    "## Error",
    code ? `${code}: ${genericDescription}` : "No recent error was recorded in this session.",
  ];
  if (scrubbedErrorMessage) {
    bodyLines.push("", "```", scrubbedErrorMessage, "```");
  } else if (errorMessageDropped) {
    bodyLines.push("", "(error text withheld because it referenced workspace data)");
  }
  bodyLines.push(
    "",
    "## Environment",
    `- CareerRat: ${version || "unknown"}`,
    `- Node: ${nodeVersion || "unknown"}`,
    `- Platform: ${platform || "unknown"}`,
    "",
    "_This report was assembled and redacted by CareerRat._"
  );

  let body = bodyLines.join("\n");
  if (body.length > 4000) body = `${body.slice(0, 3999)}…`;

  const title = descriptionText
    ? truncateTitle(descriptionText)
    : code
      ? truncateTitle(`${code}: ${genericDescription.replace(/\.$/, "")}`)
      : "CareerRat issue report";

  if (findCurrentBaseToken(`${title}\n${body}`) || findCompLeak(`${title}\n${body}`)) {
    throw compLeakRefusal();
  }

  return {
    title,
    body,
    state: { hasError: Boolean(code), configHint, compFlagged, errorMessageDropped },
  };
}

const MAX_ENCODED_URL_LENGTH = 6000;
const TRUNCATION_SUFFIX = "\n\n[truncated - paste the full report from CareerRat]";

function issueUrlFor(title, body) {
  return `${ISSUE_REPO_BASE_URL}/issues/new?title=${encodeURIComponent(title)}&body=${encodeURIComponent(body)}&labels=bug`;
}

// Builds the prefilled new-issue URL for the redacted {title, body}. If the
// encoded URL is too long for a browser address bar, truncates the body at a
// whole line and appends a note pointing back at the full report in
// CareerRat instead of cutting mid-sentence.
export function buildIssueUrl({ title, body }) {
  if (!ISSUE_REPO_BASE_URL) {
    throw new Error("CareerRat could not determine the upstream repo to file this issue against.");
  }

  const fullUrl = issueUrlFor(title, body);
  if (fullUrl.length <= MAX_ENCODED_URL_LENGTH) {
    return { url: fullUrl, truncated: false };
  }

  const lines = String(body ?? "").split("\n");
  let kept = "";
  for (const line of lines) {
    const candidate = kept ? `${kept}\n${line}` : line;
    if (issueUrlFor(title, `${candidate}${TRUNCATION_SUFFIX}`).length > MAX_ENCODED_URL_LENGTH) {
      break;
    }
    kept = candidate;
  }
  return { url: issueUrlFor(title, `${kept}${TRUNCATION_SUFFIX}`), truncated: true };
}
