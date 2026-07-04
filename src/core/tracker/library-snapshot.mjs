import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { userPath } from "../paths/workspace.mjs";
import { loadCandidateDoc } from "../profile/config-store.mjs";
import { parseYaml } from "../profile/yaml.mjs";

const DEFAULT_ROOT = fileURLToPath(new URL("../../..", import.meta.url));

const TONES = ["teal", "sky", "gold", "plum", "coral"];

function readYamlIfExists(root, relPath) {
  const path = userPath({ repoRoot: root }, relPath);
  if (!existsSync(path)) return null;
  return parseYaml(readFileSync(path, "utf8"));
}

function readTextIfExists(root, relPath) {
  const path = userPath({ repoRoot: root }, relPath);
  if (!existsSync(path)) return "";
  return readFileSync(path, "utf8");
}

function listOrEmpty(value) {
  return Array.isArray(value) ? value.map((item) => String(item || "").trim()).filter(Boolean) : [];
}

function cleanText(value) {
  return String(value == null ? "" : value)
    .replace(/\bcurrent_base\b/gi, "")
    .replace(/\bcurrentBase\b/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function sentence(value, fallback = "") {
  const text = cleanText(value);
  if (!text) return fallback;
  const [first] = text.split(/(?<=[.!?])\s+/);
  return first || fallback;
}

function compact(value, max = 132) {
  const text = cleanText(value);
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1).trim()}...`;
}

function titleFromClaim(claim) {
  const text = cleanText(claim);
  if (!text) return "Evidence";
  const [head] = text.split(/\s+(?:--|-|—)\s+/);
  return compact(head.replace(/\.$/, ""), 64);
}

function labelizeSignal(value) {
  const normalized = cleanText(value).toLowerCase();
  if (!normalized) return "";
  if (normalized === "ai" || normalized === "applied ai") return "Applied AI";
  if (normalized === "iam") return "IAM";
  if (normalized === "llms") return "LLMs";
  const connectors = new Set(["and", "or", "of", "the", "to", "vs", "for", "a", "an", "in", "on"]);
  return normalized
    .split(/\s+/)
    .map((part, index) => {
      // Keep lowercase connector words lowercase (except as the first word) so a
      // multi-word competency reads "MCP and tool-building", not "MCP AND Tool-building".
      if (index > 0 && connectors.has(part)) return part;
      if (part.length <= 3) return part.toUpperCase();
      return part[0].toUpperCase() + part.slice(1);
    })
    .join(" ");
}

function tag(label, tone = "teal") {
  return { label: cleanText(label), tone };
}

function signalTags(signals, metrics, offset = 0) {
  const tags = listOrEmpty(signals)
    .slice(0, 2)
    .map((signal, index) => tag(labelizeSignal(signal), TONES[(index + offset) % TONES.length]));
  if (listOrEmpty(metrics).length) tags.push(tag("Metrics-backed", "gold"));
  return tags.filter((item) => item.label).slice(0, 3);
}

function claimScore(claim) {
  const signals = listOrEmpty(claim.role_signals);
  const metrics = listOrEmpty(claim.metrics);
  const text = [claim.claim, ...signals].join(" ").toLowerCase();
  let score = metrics.length * 12 + signals.length;
  if (/\b(agent|llm|rag|applied ai|production ai|tool-calling)\b/.test(text)) score += 20;
  if (/\b(identity|iam|security|access)\b/.test(text)) score += 8;
  return score;
}

function evidenceCards(claims) {
  return [...claims]
    .sort((a, b) => claimScore(b) - claimScore(a))
    .map((claim, index) => ({
      kind: "evidence",
      label: "Evidence bank",
      title: titleFromClaim(claim.claim),
      summary: compact(
        sentence(claim.claim, claim.allowed_wording?.[0] || "Reusable evidence."),
        156
      ),
      tags: signalTags(claim.role_signals, claim.metrics, index),
      note: claim.allowed_wording?.[0]
        ? compact(claim.allowed_wording[0], 150)
        : "Use only with the evidence wording already confirmed in the bank.",
    }));
}

function storyRank(story) {
  // Strongest, most-proven stories lead: metrics first, then "landed" provenance.
  return listOrEmpty(story.metrics).length * 2 + listOrEmpty(story.landed).length;
}

function storyCards(stories) {
  return [...stories]
    .sort((a, b) => storyRank(b) - storyRank(a))
    .map((story, index) => {
      const metrics = listOrEmpty(story.metrics);
      const landed = listOrEmpty(story.landed);
      const openQuestions = listOrEmpty(story.open_questions);
      const tags = signalTags(
        [...listOrEmpty(story.competencies), ...listOrEmpty(story.role_signals)],
        story.metrics,
        index + 1
      );
      // Reusability signals: where it has landed, and whether it still needs context.
      if (landed.length) tags.push(tag(`Landed: ${landed.join(", ")}`, "teal"));
      if (openQuestions.length) tags.push(tag("Needs context", "coral"));
      const lead = metrics[0] ? `${metrics[0]} — ` : "";
      return {
        kind: "story",
        label: "Story bank",
        title: compact(story.title || "Interview story", 80),
        summary: compact(
          `${lead}${story.result || story.situation || listOrEmpty(story.prompts)[0] || "Reusable STAR story."}`,
          156
        ),
        tags: tags.slice(0, 5),
        note: openQuestions.length
          ? compact(`Needs context: ${openQuestions[0]}`, 150)
          : listOrEmpty(story.prompts)[0]
            ? compact(`Best for: ${story.prompts[0]}`, 150)
            : "Use for interview prep and behavioral screens.",
      };
    });
}

function voiceCard(writingStyleText) {
  const bullet =
    writingStyleText
      .split("\n")
      .map((line) => line.trim().replace(/^-\s*/, ""))
      .find((line) => /^Lead impact|^First-person|^Plain|^Use the existing/i.test(line)) ||
    "Plain, confident, evidence-backed writing.";
  return {
    kind: "voice",
    label: "Writing voice",
    title: "Direct technical narrative",
    summary: compact(bullet, 156),
    tags: [tag("Concise", "plum"), tag("Technical", "sky"), tag("Honest edge", "gold")],
    note: "Use for recruiter replies, short answers, prep packets, and profile rewrites.",
  };
}

function filterCounts(claims, stories) {
  const counts = new Map();
  const add = (signal) => {
    const label = labelizeSignal(signal);
    if (!label) return;
    counts.set(label, (counts.get(label) || 0) + 1);
  };
  for (const claim of claims) {
    for (const signal of listOrEmpty(claim.role_signals)) add(signal);
  }
  for (const story of stories) {
    for (const signal of listOrEmpty(story.role_signals)) add(signal);
  }
  const metricsBacked =
    claims.filter((claim) => listOrEmpty(claim.metrics).length).length +
    stories.filter((story) => listOrEmpty(story.metrics).length).length;
  if (metricsBacked) counts.set("Metrics-backed", metricsBacked);
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 5)
    .map(([label, count]) => ({ label, count }));
}

function buildGaps(claims) {
  const gaps = [];
  const seen = new Set();
  const pushGap = (gap) => {
    const key = cleanText(gap.body).toLowerCase();
    if (!key || seen.has(key)) return;
    seen.add(key);
    gaps.push(gap);
  };
  // This callout is for GENUINE open items the user must confirm or resolve before
  // a claim goes into outbound copy — not for settled policy. So we only surface
  // claim-specific `forbidden_wording` (a banned phrasing tied to one claim).
  //
  // We deliberately do NOT surface `honesty.tools.do_not_claim` /
  // `claims.do_not_fabricate` here: those are SETTLED, permanent boundaries (e.g.
  // "no college degree", "don't claim Okta as an owned IdP"), already shown as
  // standing policy in Settings → Honesty Boundaries. Rendering decided policy as
  // "Needs confirmation" wrongly framed it as open work and multiplied into N
  // phantom action items. (See ui-change-queue C2.)
  for (const claim of claims) {
    for (const wording of listOrEmpty(claim.forbidden_wording)) {
      pushGap({ tone: "coral", title: "Do not use yet", body: compact(wording, 150) });
    }
  }
  if (!gaps.length) {
    gaps.push({
      tone: "teal",
      title: "No urgent gaps",
      body: "Evidence, stories, and writing guidance are ready for normal reuse.",
    });
  }
  return gaps.slice(0, 4);
}

function storyLanes(stories) {
  const lanes = [];
  for (const story of stories) {
    const lane = listOrEmpty(story.competencies)[0] || listOrEmpty(story.role_signals)[0];
    if (!lane) continue;
    lanes.push({
      tone: TONES[lanes.length % TONES.length],
      body: `${labelizeSignal(lane)}: ${compact(story.title || "story", 108)}`,
    });
    if (lanes.length >= 3) break;
  }
  if (!lanes.length) {
    lanes.push({ tone: "teal", body: "Add STAR stories to make interview prep more reusable." });
  }
  return lanes;
}

export function buildLibrarySnapshot({ evidence = {}, stories = {}, writingStyleText = "" } = {}) {
  const claims = Array.isArray(evidence.claims) ? evidence.claims : [];
  const storyBank = Array.isArray(stories.stories) ? stories.stories : [];
  const gaps = buildGaps(claims);
  const hasVoice = Boolean(cleanText(writingStyleText));
  // The whole bank, not a teaser: every story + every claim flows into the Library
  // browser (segment / search / tag filters + drawer already handle any count).
  // Stories lead so the reusable interview bank is what you see first under "All".
  const cards = [...storyCards(storyBank), ...evidenceCards(claims)];
  if (hasVoice) cards.push(voiceCard(writingStyleText));

  const metrics = {
    claims: claims.length,
    stories: storyBank.length,
    gaps: gaps.length && gaps[0].title !== "No urgent gaps" ? gaps.length : 0,
  };

  return {
    metrics,
    index: [
      { label: "Evidence bank", value: String(metrics.claims) },
      { label: "Story bank", value: String(metrics.stories) },
      { label: "Writing voice", value: hasVoice ? "Ready" : "Missing" },
      { label: "Claim gaps", value: String(metrics.gaps) },
    ],
    filters: filterCounts(claims, storyBank),
    cards,
    readiness: {
      proof: claims.filter((claim) => listOrEmpty(claim.allowed_wording).length).length,
      stories: storyBank.length,
      voice: hasVoice ? 1 : 0,
    },
    gaps,
    storyLanes: storyLanes(storyBank),
  };
}

export function loadLibrarySnapshot({ root = DEFAULT_ROOT } = {}) {
  return buildLibrarySnapshot({
    evidence: loadCandidateDoc("evidence", { repoRoot: root }) || {},
    stories: readYamlIfExists(root, "candidate/stories.yml") || {},
    writingStyleText: readTextIfExists(root, "candidate/writing-style.md"),
  });
}
