#!/usr/bin/env node

// careerrat recruiter-check: flag outreach that may not be from a real recruiter.
//
// Read-only, flag-only. Checks the sender domain against the company's real domain,
// whether the role is posted on the company's own careers page (you tell it what you
// found), and whether the message asks you to run code or pay anything. Nothing is
// fetched or executed. Used by evaluate-job (outreach on a role) and email-comms
// (inbound recruiter mail).
//
// Usage:
//   node src/cli/recruiter-check.mjs --sender ADDRESS [--company-domain DOMAIN]
//        [--posting found|missing] [--body TEXT | --body-file FILE] [--json]

import { readFileSync } from "node:fs";
import { assessRecruiterSignal } from "../core/evaluate/recruiter-signal.mjs";

const opts = { json: false };
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === "--json") opts.json = true;
  else if (a === "--sender") opts.sender = argv[++i];
  else if (a === "--company-domain") opts.companyDomain = argv[++i];
  else if (a === "--posting") opts.posting = argv[++i];
  else if (a === "--body") opts.body = argv[++i];
  else if (a === "--body-file") opts.bodyFile = argv[++i];
  else if (a === "--help" || a === "-h") opts.help = true;
}

if (opts.help) {
  console.log(`careerrat recruiter-check: flag outreach that may not be a real recruiter (read-only)

Usage:
  node src/cli/recruiter-check.mjs --sender ADDRESS [--company-domain DOMAIN]
       [--posting found|missing] [--body TEXT | --body-file FILE] [--json]

A flag, never a verdict: a suspect result means confirm the contact through the
company's own careers page before replying with anything personal.`);
  process.exit(0);
}

function fail(msg) {
  if (opts.json) console.log(JSON.stringify({ ok: false, error: msg }));
  else console.error(`recruiter-check: ${msg}`);
  process.exit(1);
}

if (opts.posting && !["found", "missing"].includes(opts.posting)) {
  fail('--posting must be "found" or "missing"');
}
let text = opts.body || "";
if (opts.bodyFile) {
  try {
    text = readFileSync(opts.bodyFile, "utf8");
  } catch (err) {
    fail(`could not read ${opts.bodyFile}: ${err.message}`);
  }
}
const result = assessRecruiterSignal({
  senderEmail: opts.sender,
  companyDomain: opts.companyDomain,
  publicPosting: opts.posting ? opts.posting === "found" : undefined,
  text,
});
if (opts.json) {
  console.log(JSON.stringify({ ok: true, ...result }, null, 2));
} else if (result.verdict === "clear") {
  console.log("RECRUITER SIGNAL: clear");
} else {
  console.log(`RECRUITER SIGNAL: suspect - ${result.reason}`);
  if (result.warning) console.log(`WARNING: ${result.warning}`);
}
