#!/usr/bin/env node

// careerrat fact-check: reject a draft that adds a number, tool, employer or
// name the candidate's own material never mentions (CR103). For drafts the
// skills write by hand (outreach, notes, cover letters); the packet engine
// runs the same check in code on everything it generates.
//
// Usage:
//   node src/cli/fact-check.mjs FILE [--company NAME] [--role TITLE] [--allow "A,B"] [--source FILE]... [--json]
//
// Sources default to the workspace: source résumé, profile, evidence claims,
// confirmed stories. --source adds extra files (or replaces the workspace
// with --no-workspace). Exit 0 clean, 1 unverified facts, 2 bad input.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dbExists } from "../core/db/connection.mjs";
import {
  candidateArtifactGet,
  candidateConfigGet,
  deepIngestConfirmedForGeneration,
} from "../core/db/verbs.mjs";
import { checkArtifactFacts } from "../core/packet/fact-check.mjs";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));

function parseArgs(argv) {
  const opts = { file: null, sources: [], allow: [], json: false, workspace: true };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--json") opts.json = true;
    else if (a === "--no-workspace") opts.workspace = false;
    else if (a === "--company") opts.company = argv[++i];
    else if (a === "--role") opts.role = argv[++i];
    else if (a === "--allow") opts.allow.push(...String(argv[++i] || "").split(","));
    else if (a === "--source") opts.sources.push(argv[++i]);
    else if (a === "--help" || a === "-h") opts.help = true;
    else if (a.startsWith("-")) opts.bad = `unknown option ${a}`;
    else opts.file = a;
  }
  return opts;
}

function workspaceContext(env) {
  if (!dbExists({ repoRoot: ROOT, env })) return {};
  const config = candidateConfigGet({ repoRoot: ROOT, env });
  const sourceResume = candidateArtifactGet({
    repoRoot: ROOT,
    env,
    id: "source-resume",
    kind: "source-resume",
  });
  const deepIngest = deepIngestConfirmedForGeneration({ repoRoot: ROOT, env });
  return {
    profile: config.profile || {},
    evidence: config.evidence || { claims: [] },
    honesty: config.honesty || {},
    ...(sourceResume ? { sourceResume } : {}),
    storiesLearnings: deepIngest.storyBank || [],
  };
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    console.log(
      'usage: careerrat fact-check FILE [--company NAME] [--role TITLE] [--allow "A,B"] [--source FILE]... [--no-workspace] [--json]'
    );
    return 0;
  }
  if (opts.bad || !opts.file) {
    console.error(opts.bad || "fact-check: a draft FILE is required");
    return 2;
  }
  let text;
  let extra;
  try {
    text = readFileSync(opts.file, "utf8");
    extra = opts.sources.map((file) => readFileSync(file, "utf8"));
  } catch (err) {
    console.error(`fact-check: ${err.message}`);
    return 2;
  }
  const base = opts.workspace ? workspaceContext(process.env) : {};
  const context = {
    ...base,
    factSources: extra,
    app: { company: opts.company, role: opts.role },
  };
  const result = checkArtifactFacts({ texts: text, context, extraAllow: opts.allow });
  if (opts.json) console.log(JSON.stringify(result, null, 2));
  else if (result.ok)
    console.log("fact-check: every number and name in the draft is in your material.");
  else {
    console.log("fact-check: unverified facts, fix or confirm with the candidate:");
    for (const v of result.violations) console.log(`  - ${v.message}`);
  }
  return result.ok ? 0 : 1;
}

process.exitCode = main();
