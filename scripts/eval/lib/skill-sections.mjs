// scripts/eval/lib/skill-sections.mjs — extracts named "## Heading" sections
// verbatim out of .agents/skills/search-jobs/SKILL.md, so the Phase 2 harness
// always replays the CURRENT triage rules text (not a hand-copied, driftable
// snapshot). Both phase2 scripts read from this file rather than embedding
// their own copy of the skill prose.

import { readFileSync } from "node:fs";

// extractSection(markdown, headingText) — headingText must match the "## "
// (or "### ") line exactly (case-sensitive, minus the leading hashes).
// Returns the section body (excluding the heading line itself) up to the
// next heading of the same or shallower depth, or the end of the file.
export function extractSection(markdown, headingText) {
  const lines = markdown.split("\n");
  const headingRe = /^(#{1,6})\s+(.*)$/;
  let startIdx = -1;
  let startDepth = 0;
  for (let i = 0; i < lines.length; i++) {
    const m = headingRe.exec(lines[i]);
    if (m && m[2].trim() === headingText) {
      startIdx = i;
      startDepth = m[1].length;
      break;
    }
  }
  if (startIdx === -1) {
    throw new Error(`extractSection: heading not found: "${headingText}"`);
  }
  let endIdx = lines.length;
  for (let i = startIdx + 1; i < lines.length; i++) {
    const m = headingRe.exec(lines[i]);
    if (m && m[1].length <= startDepth) {
      endIdx = i;
      break;
    }
  }
  return lines
    .slice(startIdx + 1, endIdx)
    .join("\n")
    .trim();
}

export function loadSearchJobsSkill(repoRoot) {
  return readFileSync(`${repoRoot}/.agents/skills/search-jobs/SKILL.md`, "utf8");
}
