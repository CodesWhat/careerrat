#!/usr/bin/env node

// careerrat apply — the submit gate for the terminal (agent-driven) apply path.
//
// In the terminal workspace the agent fills the application form itself. It
// never presses the final Submit. It calls `apply submit`, which reads the live
// form from the session browser, runs the same submit checks the browser app's
// apply driver uses, and presses Submit once only when every one passes.
// Otherwise it refuses, hands the job to the person (manual-apply status, a note
// naming what's missing) and exits 1.
//
// Usage:
//   node src/cli/apply.mjs submit <job-id> --page <page-id> [--json]
//   node src/cli/apply.mjs --help
//
// The checks: submit mode is auto, the posting isn't on LinkedIn, no earlier
// Submit press, a KEEP (or approved REVIEW) verdict, no open "NEEDS YOU"
// answer, the page is the posting's own site or a known ATS, no captcha or
// verification step, no required field blank, every required upload attached,
// and exactly one positively labelled Submit application button.
//
// Exit codes: 0 submitted (confirmed or not, see state), 1 refused, 2 error.
import { fileURLToPath } from "node:url";
import { runApplySubmit } from "../core/apply/submit-gate.mjs";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));

function parseArgs(argv) {
  const opts = { positional: [], json: false, root: ROOT, env: process.env };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--json") opts.json = true;
    else if (a === "--help" || a === "-h") opts.help = true;
    else if (a === "--page") opts.page = argv[++i];
    else if (a === "--root") opts.root = argv[++i];
    else opts.positional.push(a);
  }
  return opts;
}

const opts = parseArgs(process.argv.slice(2));

function printHelp() {
  console.log(`careerrat apply: submit gate for agent-filled applications

Usage:
  node src/cli/apply.mjs submit <job-id> --page <page-id> [--json]

Commands:
  submit    Read the live form in the session browser, run the submit checks, and
            press Submit once only if they all pass. On any failure it presses
            nothing, sets the job to manual-apply with a note of what's missing,
            and exits 1. The agent never presses Submit itself.

Options:
  --page ID     The session browser page holding the filled form (required).
  --json        Machine-readable output: { ok, submitted, state, reasons[] }.
  --root DIR    Repo root (default: the careerrat install).

Reason codes: MANUAL_SUBMIT_MODE, LINKEDIN_NEVER_AUTO_SUBMIT, ALREADY_SUBMITTED,
GATE_NOT_CLEARED, ANSWER_NEEDED, SESSION_UNREACHABLE, UNTRUSTED_ORIGIN,
HUMAN_CHALLENGE, REQUIRED_FIELDS_BLANK, UPLOAD_MISSING, NO_SUBMIT_BUTTON.

Only the Orca session browser can be reached from this command. With any other
provider it refuses with SESSION_UNREACHABLE and hands the form to the person.`);
}

function fail(message) {
  if (opts.json)
    console.log(JSON.stringify({ ok: false, state: "error", error: message }, null, 2));
  else console.error(`apply: ${message}`);
  process.exit(2);
}

if (opts.help || opts.positional.length === 0) {
  printHelp();
  process.exit(opts.help ? 0 : 2);
}

const [verb, id] = opts.positional;
if (verb !== "submit") fail(`unknown command "${verb}". Commands: submit. See --help.`);
if (!id) fail("submit requires <job-id>");

let result;
try {
  result = await runApplySubmit({ repoRoot: opts.root, env: opts.env, id, pageId: opts.page });
} catch (error) {
  fail(error?.message || String(error));
}

if (opts.json) {
  console.log(JSON.stringify(result, null, 2));
} else if (result.ok) {
  console.log(result.message);
  console.log(`Next: ${result.nextAction}`);
} else {
  console.error(`Not submitted: ${result.message}`);
  console.error("The job is now manual-apply. Hand the form to the person and say what's missing.");
}
process.exit(result.ok ? 0 : 1);
