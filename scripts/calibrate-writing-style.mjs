#!/usr/bin/env node
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { displayPath, userPath } from "../src/core/paths/workspace.mjs";
import {
  analyzeWritingSamples,
  discoverWritingSamples,
  renderWritingStyleProfile,
} from "../src/core/profile/writing-style.mjs";

const NOT_CALIBRATED_MARKER = "Not calibrated: no writing samples were provided.";
const ROOT = fileURLToPath(new URL("..", import.meta.url));
const pathCtx = { repoRoot: ROOT };
const sampleDir = userPath(pathCtx, "workspace/writing-samples");
const outputPath = userPath(pathCtx, "candidate/writing-style.md");

mkdirSync(sampleDir, { recursive: true });
mkdirSync(userPath(pathCtx, "candidate"), { recursive: true });

const files = readdirSync(sampleDir).map((file) => join(sampleDir, file));
const samplePaths = discoverWritingSamples(files);

if (samplePaths.length === 0) {
  const existing = existsSync(outputPath) ? readFileSync(outputPath, "utf8") : null;
  if (existing !== null && !existing.includes(NOT_CALIBRATED_MARKER)) {
    console.log(
      `No writing samples found. Existing ${displayPath(pathCtx, "candidate/writing-style.md")} left unchanged.`
    );
    process.exit(0);
  }
  if (existing === null) writeFileSync(outputPath, fallbackProfile());
  // Not calibrated is not "done". Exit non-zero so a skill can't treat a
  // placeholder style file as a passed gate.
  console.error(
    `Not calibrated: no writing samples in ${displayPath(pathCtx, "workspace/writing-samples")}. Draft in a plain, neutral voice and ask the user for a few writing samples.`
  );
  process.exit(3);
}

const samples = samplePaths.map((path) => ({
  path,
  text: readFileSync(path, "utf8"),
}));
const analysis = analyzeWritingSamples(samples);
const date = new Date().toISOString().slice(0, 10);
writeFileSync(outputPath, renderWritingStyleProfile({ date, analysis }));
console.log(
  `Wrote ${displayPath(pathCtx, "candidate/writing-style.md")} from ${samplePaths.length} sample(s).`
);

function fallbackProfile() {
  const date = new Date().toISOString().slice(0, 10);
  return `# Writing Style Profile

_Generated ${date}. ${NOT_CALIBRATED_MARKER}_

Read this before drafting cover letters, essays, outreach, or application answers.

## Agent Instructions

- This style is not calibrated. Draft in a plain, neutral voice and ask the user for a few writing samples to calibrate from.
- First-person, plain, confident, human.
- Kill corporate-speak, breathless buzzwords, triadic adjective stacks, and em-dash pileups.
- Lead with concrete shipped work and honest constraints.
- Do not import facts from writing samples. Style only.
`;
}
