#!/usr/bin/env node
// CareerRat questions CLI — fetch a job's real application-form questions
// without a browser (Greenhouse/Ashby API, or --paste for everything else).
//
// Usage:
//   careerrat questions <workspace/jobs/foo.md>   Fetch, write foo.md.questions.json
//   careerrat questions <job-posting-url>         Fetch, print JSON to stdout
//   careerrat questions <path|url> --json         Always print JSON to stdout
//   careerrat questions <path|url> --paste        Read questions from stdin instead of fetching
//   careerrat questions --help
//
// Zero LLM cost: one HTTP GET (or stdin parse), no browser automation.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";

import { fetchFormQuestions, parseManualQuestions } from "../core/apply/form-questions.mjs";
import { parseSavedJob } from "../core/evaluate/gate.mjs";

const args = process.argv.slice(2);
const json = args.includes("--json");
const paste = args.includes("--paste");

if (args.includes("--help") || args.includes("-h") || args.length === 0) {
  printHelp();
  process.exit(args.length === 0 ? 1 : 0);
}

const target = args.find((a) => !a.startsWith("-"));
if (!target) {
  console.error(
    "Provide a saved job .md path or a job posting URL. See: careerrat questions --help"
  );
  process.exit(1);
}

run(target).then(
  (code) => process.exit(code),
  (err) => {
    console.error(err?.message ? err.message : String(err));
    process.exit(1);
  }
);

// ---------------------------------------------------------------------------

async function run(arg) {
  const isUrl = /^https?:\/\//i.test(arg);
  let jobUrl = arg;
  let outPath = null;

  if (!isUrl) {
    const jobPath = isAbsolute(arg) ? arg : join(process.cwd(), arg);
    if (!existsSync(jobPath)) {
      console.error(`Job file not found: ${jobPath}`);
      return 1;
    }
    const saved = parseSavedJob(readFileSync(jobPath, "utf8"));
    const source = saved.frontmatter?.source;
    if (!source || typeof source !== "string") {
      console.error(
        `Job file has no usable posting URL — expected a "source" key in frontmatter: ${jobPath}`
      );
      return 1;
    }
    jobUrl = source;
    outPath = `${jobPath}.questions.json`;
  }

  let result;
  if (paste) {
    const text = readStdin();
    if (!text.trim()) {
      console.error("--paste needs question text on stdin (pipe it in).");
      return 1;
    }
    result = parseManualQuestions(text, { url: jobUrl });
  } else {
    try {
      result = await fetchFormQuestions(jobUrl);
    } catch (err) {
      console.error(err?.message ? err.message : String(err));
      return 1;
    }
  }

  if (outPath) {
    writeFileSync(outPath, `${JSON.stringify(result, null, 2)}\n`);
  }

  if (json) {
    console.log(JSON.stringify(result, null, 2));
  } else if (outPath) {
    console.log(summarize(result));
    console.log(`Wrote ${outPath}`);
  } else {
    console.log(JSON.stringify(result, null, 2));
  }

  return 0;
}

function readStdin() {
  try {
    return readFileSync(0, "utf8");
  } catch {
    return "";
  }
}

function summarize(result) {
  const questions = Array.isArray(result?.questions) ? result.questions : [];
  const total = questions.length;
  const required = questions.filter((q) => q.required).length;

  const typeCounts = new Map();
  for (const q of questions) {
    typeCounts.set(q.type, (typeCounts.get(q.type) || 0) + 1);
  }
  const typesLine =
    [...typeCounts.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([type, count]) => `${type}:${count}`)
      .join(", ") || "none";

  const demoNote = result?.demographicSectionPresent
    ? " (demographic/EEOC section present, excluded)"
    : "";

  return `${total} question${total === 1 ? "" : "s"} (${required} required)${demoNote}\nTypes: ${typesLine}`;
}

function printHelp() {
  console.log(`careerrat questions — fetch a job's real application-form questions, no browser

Usage:
  careerrat questions <workspace/jobs/foo.md>   Fetch, write foo.md.questions.json
  careerrat questions <job-posting-url>         Fetch, print JSON to stdout
  careerrat questions <path|url> --json         Always print JSON to stdout
  careerrat questions <path|url> --paste        Read questions from stdin instead of fetching
  careerrat questions --help

Supported providers: Greenhouse, Ashby (deterministic API/page fetch).
Anything else (Lever, Workday, ...): paste the questions instead.
  cat questions.txt | careerrat questions workspace/jobs/foo.md --paste`);
}
