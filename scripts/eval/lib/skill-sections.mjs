// scripts/eval/lib/skill-sections.mjs — extracts named "## Heading" sections
// verbatim out of a skill's SKILL.md, so a harness always replays the CURRENT
// rules text (not a hand-copied, driftable snapshot). Both the phase2 scripts
// and scripts/eval/skill-shape-qa.mjs read from this file rather than
// embedding their own copy of any skill's prose.

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

// loadSkillMd(repoRoot, skillName) — generic reader for any
// `.agents/skills/<skillName>/SKILL.md`. loadSearchJobsSkill below is kept as
// a thin, unchanged wrapper so phase2-ai-lane.mjs's existing call site never
// has to change.
export function loadSkillMd(repoRoot, skillName) {
  return readFileSync(`${repoRoot}/.agents/skills/${skillName}/SKILL.md`, "utf8");
}

export function loadSearchJobsSkill(repoRoot) {
  return loadSkillMd(repoRoot, "search-jobs");
}
