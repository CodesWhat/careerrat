#!/usr/bin/env node

// careerrat rules: corrections the person made, proposed as writing rules.
//
// A correction ("don't open with 'I am writing to'") can become a standing writing
// rule, but only after they accept it. At most five proposals per session, each with
// their verbatim words. Accepting writes the rule to candidate honesty style
// (prefer / avoid) through the recorded-change writer, so it shows in the change
// history and can be undone. A correction that states a fact about the person is
// refused; facts go to evidence.
//
// Usage:
//   node src/cli/rules.mjs propose --kind prefer|avoid --rule TEXT --quote TEXT
//        [--session ID] [--write] [--json]
//   node src/cli/rules.mjs list [--session ID] [--json]
//   node src/cli/rules.mjs accept <id> [--write] [--json]
//   node src/cli/rules.mjs dismiss <id> [--write] [--json]
//
// propose, accept and dismiss are DRY RUNS until --write. The session defaults to
// $CAREERRAT_SESSION, then today's date.

import { fileURLToPath } from "node:url";
import { patchRecordedCandidateConfig } from "../core/agent/recorded-config-write.mjs";
import { dbExists } from "../core/db/connection.mjs";
import {
  candidateArtifactGet,
  candidateArtifactPut,
  candidateConfigGet,
} from "../core/db/verbs/candidate.mjs";
import { buildProposal } from "../core/profile/correction-rules.mjs";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const ARTIFACT_ID = "rule-proposals";

const opts = { positional: [], write: false, json: false, root: ROOT };
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === "--write") opts.write = true;
  else if (a === "--json") opts.json = true;
  else if (a === "--kind") opts.kind = argv[++i];
  else if (a === "--rule") opts.rule = argv[++i];
  else if (a === "--quote") opts.quote = argv[++i];
  else if (a === "--session") opts.session = argv[++i];
  else if (a === "--root") opts.root = argv[++i];
  else if (a === "--help" || a === "-h") opts.help = true;
  else opts.positional.push(a);
}

if (opts.help || opts.positional.length === 0) {
  printHelp();
  process.exit(opts.help ? 0 : 1);
}

const ctx = { repoRoot: opts.root };
const [verb, arg] = opts.positional;
const session =
  opts.session || process.env.CAREERRAT_SESSION || new Date().toISOString().slice(0, 10);

function out(payload, text) {
  if (opts.json) console.log(JSON.stringify(payload, null, 2));
  else console.log(text);
}

function fail(error, reason, code = 1) {
  if (opts.json)
    console.log(JSON.stringify({ ok: false, error, ...(reason ? { reason } : {}) }, null, 2));
  else console.error(`rules: ${error}`);
  process.exit(code);
}

if (!dbExists(ctx)) fail("no CareerRat data yet. Run careerrat data init first.", "no-db");

function loadProposals() {
  const stored = candidateArtifactGet({ ...ctx, id: ARTIFACT_ID });
  return Array.isArray(stored?.proposals) ? stored.proposals : [];
}

function saveProposals(proposals) {
  candidateArtifactPut({ ...ctx, id: ARTIFACT_ID, kind: "rule-proposals", data: { proposals } });
}

function describe(p) {
  return `${p.id}  [${p.status}] ${p.kind}: ${p.rule}\n    you said: "${p.quote}"`;
}

if (verb === "list") {
  const all = loadProposals().filter((p) => !opts.session || p.session === opts.session);
  out(
    { ok: true, proposals: all },
    all.length ? all.map(describe).join("\n") : "No rule proposals."
  );
  process.exit(0);
}

if (verb === "propose") {
  const existing = loadProposals();
  const built = buildProposal({
    session,
    kind: opts.kind,
    rule: opts.rule,
    quote: opts.quote,
    existing,
  });
  if (!built.ok) fail(built.error, built.reason, 2);
  if (!opts.write) {
    out(
      { ok: true, dryRun: true, proposal: built.proposal },
      `Would propose:\n${describe(built.proposal)}\nDry run - pass --write to save it.`
    );
    process.exit(0);
  }
  saveProposals([...existing, built.proposal]);
  out(
    { ok: true, written: true, proposal: built.proposal },
    `Proposed ${built.proposal.id}. Accept it with: careerrat rules accept ${built.proposal.id} --write`
  );
  process.exit(0);
}

if (verb === "accept" || verb === "dismiss") {
  if (!arg) fail(`Usage: rules ${verb} <id> [--write]`, "no-id");
  const proposals = loadProposals();
  const target = proposals.find((p) => p.id === arg);
  if (!target) fail(`no proposal with id ${arg}. Run: careerrat rules list`, "not-found", 2);
  if (target.status !== "proposed") fail(`${arg} is already ${target.status}.`, "not-proposed", 2);

  if (verb === "dismiss") {
    if (!opts.write) {
      out(
        { ok: true, dryRun: true, proposal: target },
        `Would dismiss ${arg}. Pass --write to do it.`
      );
      process.exit(0);
    }
    const updated = { ...target, status: "dismissed", decidedAt: new Date().toISOString() };
    saveProposals(proposals.map((p) => (p.id === arg ? updated : p)));
    out({ ok: true, written: true, proposal: updated }, `Dismissed ${arg}.`);
    process.exit(0);
  }

  const current = candidateConfigGet(ctx).honesty?.style?.[target.kind];
  const list = Array.isArray(current) ? current : [];
  const already = list.some((r) => String(r).toLowerCase() === target.rule.toLowerCase());
  if (!opts.write) {
    out(
      { ok: true, dryRun: true, proposal: target, alreadyARule: already },
      `Would add to style.${target.kind}: ${target.rule}${already ? " (already there)" : ""}\nDry run - pass --write to save it. You can undo it afterwards.`
    );
    process.exit(0);
  }
  let history;
  if (!already) {
    ({ history } = patchRecordedCandidateConfig({
      ...ctx,
      name: "honesty",
      patch: { style: { [target.kind]: [...list, target.rule] } },
      writes: [{ path: `style.${target.kind}`, label: `a ${target.kind} writing rule` }],
      writer: "rules.accept",
    }));
  }
  const updated = { ...target, status: "accepted", decidedAt: new Date().toISOString() };
  saveProposals(proposals.map((p) => (p.id === arg ? updated : p)));
  out(
    { ok: true, written: true, proposal: updated, history: history ?? null },
    already
      ? `${arg} was already a rule. Marked accepted.`
      : `Added to style.${target.kind}: ${target.rule}. Undo it from the change history.`
  );
  process.exit(0);
}

fail(`unknown command "${verb}". Commands: propose, list, accept, dismiss.`, "unknown", 1);

function printHelp() {
  console.log(`careerrat rules: corrections the person made, proposed as writing rules

Usage:
  node src/cli/rules.mjs propose --kind prefer|avoid --rule TEXT --quote TEXT [--session ID] [--write]
  node src/cli/rules.mjs list [--session ID] [--json]
  node src/cli/rules.mjs accept <id> [--write]
  node src/cli/rules.mjs dismiss <id> [--write]

At most 5 proposals per session, each with the person's exact words. Nothing becomes a
rule until accept --write, which is recorded and can be undone. A correction that
states a fact about the person is refused; use careerrat evidence for facts.`);
}
