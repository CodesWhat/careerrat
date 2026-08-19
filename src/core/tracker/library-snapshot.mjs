import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { dbExists } from "../db/connection.mjs";
import { candidateConfigGet } from "../db/verbs/candidate.mjs";
import { buildDeepIngestViewModel } from "../deep-ingest/view-model.mjs";
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

function sourceReferenceFields(item = {}) {
  const fields = {};
  if (item.sourceId) fields.sourceId = String(item.sourceId);
  if (item.sourceProposalId) fields.sourceProposalId = String(item.sourceProposalId);
  if (item.artifactPath) fields.sourceArtifactId = String(item.artifactPath);
  const refs = [fields.sourceId, fields.sourceProposalId, fields.sourceArtifactId].filter(Boolean);
  if (refs.length) fields.sourceRef = refs.join(" / ");
  return fields;
}

function sourceLinkedNote(note, item) {
  const refs = sourceReferenceFields(item);
  if (!refs.sourceRef) return note;
  return compact(`${note} Source: ${refs.sourceRef}`, 180);
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
    .map((claim, index) => {
      const note = claim.allowed_wording?.[0]
        ? compact(claim.allowed_wording[0], 150)
        : "Use only with the evidence wording already confirmed in the bank.";
      return {
        kind: "evidence",
        label: "Evidence bank",
        // The claim's own candidate_evidence_claims id — Library's edit-in-
        // place Save/Delete (POST /api/onboard/candidate/evidence and
        // .../evidence/remove) target this exact id, never a derived slug.
        id: String(claim.id || ""),
        title: titleFromClaim(claim.claim),
        summary: compact(
          sentence(claim.claim, claim.allowed_wording?.[0] || "Reusable evidence."),
          156
        ),
        tags: signalTags(claim.role_signals, claim.metrics, index),
        note: sourceLinkedNote(note, claim),
        // Raw editable fields (schema field names verbatim — see
        // evidence-writer.mjs's CLAIM_FIELDS) for the Library drawer's Edit
        // form, distinct from the derived title/summary/note above.
        metadata: {
          claim: claim.claim || "",
          evidence: claim.evidence || "",
          metrics: listOrEmpty(claim.metrics),
          links: listOrEmpty(claim.links),
          allowed_wording: listOrEmpty(claim.allowed_wording),
          forbidden_wording: listOrEmpty(claim.forbidden_wording),
          // The full stored claim, untouched — candidateEvidenceMerge writes
          // whatever object it's handed as the row's new, COMPLETE data (it
          // doesn't merge onto the previous row), so the Library drawer's
          // Save must spread its edits onto this, not onto the curated
          // fields above, or fields like role_signals/sourceId that aren't
          // exposed in the Edit form would be silently dropped on save.
          raw: { ...claim },
        },
        ...sourceReferenceFields(claim),
      };
    });
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
      const lead = metrics[0] ? `${metrics[0]}: ` : "";
      const note = openQuestions.length
        ? compact(`Needs context: ${openQuestions[0]}`, 150)
        : listOrEmpty(story.prompts)[0]
          ? compact(`Best for: ${story.prompts[0]}`, 150)
          : "Use for interview prep and behavioral screens.";
      return {
        kind: "story",
        label: "Story bank",
        // The deep_ingest_story_bank row's own id — Library's edit-in-place
        // Save/Delete (POST /api/deep-ingest/confirmed/update|remove,
        // lane: "story_bank") target this exact id.
        id: String(story.id || ""),
        title: compact(story.title || "Interview story", 80),
        summary: compact(
          `${lead}${story.result || story.situation || listOrEmpty(story.prompts)[0] || "Reusable STAR story."}`,
          156
        ),
        tags: tags.slice(0, 5),
        note: sourceLinkedNote(note, story),
        metadata: {
          star: {
            situation: story.situation || null,
            task: story.task || null,
            action: story.action || null,
            result: story.result || null,
            reflection: story.reflection || null,
          },
          evidenceIds: listOrEmpty(story.evidence_ids),
          source: sourceReferenceFields(story),
          // Flat raw editable fields, keyed with the row's own field names
          // verbatim (config/stories.schema.json's snake_case convention —
          // the same names deep_ingest_story_bank rows are written with, see
          // tests/deep-ingest-db.test.mjs's story_bank confirm() fixture) so
          // the Library drawer's Edit form can post them straight back
          // through POST /api/deep-ingest/confirmed/update unchanged. (The
          // `star` object above stays for existing readers of that shape;
          // these flat siblings are the source of truth for editing.)
          title: story.title || "",
          situation: story.situation || "",
          task: story.task || "",
          action: story.action || "",
          result: story.result || "",
          reflection: story.reflection || "",
          metrics,
          landed,
          open_questions: openQuestions,
          competencies: listOrEmpty(story.competencies),
          role_signals: listOrEmpty(story.role_signals),
          prompts: listOrEmpty(story.prompts),
        },
        ...sourceReferenceFields(story),
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

function voiceCards(rows) {
  return rows.map((row) => ({
    kind: "voice",
    label: "Writing voice",
    // The deep_ingest_writing_voice row's own id — Library's edit-in-place
    // Save/Delete (lane: "writing_voice") target this exact id.
    id: String(row.id || ""),
    title: compact(row.summary || row.voiceSummary || "Writing voice", 80),
    summary: compact(row.summary || row.voiceSummary || "Reusable writing voice guidance.", 156),
    tags: [tag("Concise", "plum"), tag("Technical", "sky"), tag("Confirmed", "teal")],
    note: sourceLinkedNote(
      row.doPhrases?.[0] || row.do_phrases?.[0] || "Use for profile, outreach, and packet copy.",
      row
    ),
    metadata: {
      doPhrases: listOrEmpty(row.doPhrases || row.do_phrases),
      avoidPhrases: listOrEmpty(row.avoidPhrases || row.avoid_phrases),
      source: sourceReferenceFields(row),
      // Raw editable summary for the Library drawer's Edit form (doPhrases/
      // avoidPhrases above are already raw+editable).
      summary: row.summary || row.voiceSummary || "",
    },
    ...sourceReferenceFields(row),
  }));
}

function honestyCards(rows) {
  return rows.map((row) => ({
    kind: "honesty",
    label: "Honesty boundary",
    // The deep_ingest_honesty_boundaries row's own id — Library's edit-in-
    // place Save/Delete (lane: "honesty_boundaries") target this exact id.
    id: String(row.id || ""),
    title: compact(
      row.text || row.forbiddenWording || row.allowedWording || "Honesty boundary",
      80
    ),
    summary: compact(
      row.allowedWording || row.reason || row.text || "Confirmed honesty boundary.",
      156
    ),
    tags: [tag(labelizeSignal(row.boundaryType || "boundary"), "coral"), tag("Confirmed", "teal")],
    note: sourceLinkedNote(row.text || "Use this boundary before outbound reuse.", row),
    metadata: {
      boundaryType: row.boundaryType || null,
      allowedWording: row.allowedWording || null,
      forbiddenWording: row.forbiddenWording || null,
      source: sourceReferenceFields(row),
      // Raw editable text/reason for the Library drawer's Edit form
      // (boundaryType/allowedWording/forbiddenWording above are already
      // raw+editable).
      text: row.text || "",
      reason: row.reason || "",
    },
    ...sourceReferenceFields(row),
  }));
}

function roleSignalCards(rows) {
  return rows.map((row) => ({
    kind: "role_signal",
    label: "Role signal",
    // The deep_ingest_role_signals row's own id — Library's edit-in-place
    // Save/Delete (lane: "role_signals") target this exact id.
    id: String(row.id || ""),
    title: compact(row.text || row.roleFamily || "Role signal", 80),
    summary: compact(row.rationale || row.text || "Confirmed role signal.", 156),
    tags: [
      tag(labelizeSignal(row.roleFamily), "plum"),
      tag(labelizeSignal(row.signalType), row.signalType === "cut" ? "coral" : "teal"),
    ].filter((item) => item.label),
    note: sourceLinkedNote(row.rationale || row.text || "Use for keep/cut role matching.", row),
    metadata: {
      roleFamily: row.roleFamily || null,
      signalType: row.signalType || null,
      source: sourceReferenceFields(row),
      // Raw editable text/rationale for the Library drawer's Edit form
      // (roleFamily/signalType above are already raw+editable).
      text: row.text || "",
      rationale: row.rationale || "",
    },
    ...sourceReferenceFields(row),
  }));
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

function buildDeepIngestGaps(model, claims) {
  const gaps = [];
  for (const proposal of Array.isArray(model?.openGaps) ? model.openGaps : []) {
    const body = proposal.reason || proposal.proposal?.items?.[0]?.prompt || proposal.status;
    if (!body) continue;
    gaps.push({
      tone: proposal.status === "not_available" ? "coral" : "gold",
      title: proposal.status === "not_available" ? "Not available" : "Open gap",
      body: compact(body, 150),
      ...sourceReferenceFields(proposal),
    });
  }
  for (const lane of Array.isArray(model?.lanes) ? model.lanes : []) {
    if (!lane.todo) continue;
    gaps.push({
      tone: "gold",
      title: "Deferred lane",
      body: compact(lane.todo, 150),
    });
  }
  return gaps.length ? gaps.slice(0, 4) : buildGaps(claims);
}

function buildSnapshotFromDeepIngest(model, evidence = null) {
  const confirmed = model?.confirmed || {};
  // Confirmed onboarding/manual evidence lives in the same canonical
  // candidate_evidence_claims table as Deep ingest confirmations, but it has
  // no Deep ingest source/proposal id. The Deep ingest view model intentionally
  // filters those rows out of its own provenance-scoped `confirmed.evidence`
  // collection. Library is the candidate's complete reusable bank, so prefer
  // the canonical candidate evidence document when the DB loader supplies it.
  // Unconfirmed Deep ingest proposals are never written there, which keeps the
  // trust boundary intact while making onboarding evidence visible.
  const claims = Array.isArray(evidence?.claims)
    ? evidence.claims
    : Array.isArray(confirmed.evidence)
      ? confirmed.evidence
      : [];
  const storyBank = Array.isArray(confirmed.storyBank) ? confirmed.storyBank : [];
  const writingVoice = Array.isArray(confirmed.writingVoice) ? confirmed.writingVoice : [];
  const honestyBoundaries = Array.isArray(confirmed.honestyBoundaries)
    ? confirmed.honestyBoundaries
    : [];
  const roleSignals = Array.isArray(confirmed.roleSignals) ? confirmed.roleSignals : [];
  const gaps = buildDeepIngestGaps(model, claims);
  const cards = [
    ...storyCards(storyBank),
    ...evidenceCards(claims),
    ...voiceCards(writingVoice),
    ...honestyCards(honestyBoundaries),
    ...roleSignalCards(roleSignals),
  ];

  const metrics = {
    claims: claims.length,
    stories: storyBank.length,
    voice: writingVoice.length,
    honesty: honestyBoundaries.length,
    roleSignals: roleSignals.length,
    gaps: gaps.length && gaps[0].title !== "No urgent gaps" ? gaps.length : 0,
  };

  return {
    metrics,
    index: [
      { label: "Evidence bank", value: String(metrics.claims) },
      { label: "Story bank", value: String(metrics.stories) },
      { label: "Writing voice", value: metrics.voice ? "Ready" : "Missing" },
      { label: "Honesty", value: String(metrics.honesty) },
      { label: "Role signals", value: String(metrics.roleSignals) },
      { label: "Claim gaps", value: String(metrics.gaps) },
    ],
    filters: filterCounts(claims, storyBank),
    cards,
    readiness: {
      proof: claims.filter((claim) => listOrEmpty(claim.allowed_wording).length).length,
      stories: storyBank.length,
      voice: writingVoice.length ? 1 : 0,
      honesty: honestyBoundaries.length,
      roleSignals: roleSignals.length,
    },
    gaps,
    storyLanes: storyLanes(storyBank),
  };
}

export function buildLibrarySnapshot({
  evidence = {},
  stories = {},
  writingStyleText = "",
  deepIngest = null,
} = {}) {
  if (deepIngest) return buildSnapshotFromDeepIngest(deepIngest, evidence);

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

export function loadLibrarySnapshot({ root = DEFAULT_ROOT, env } = {}) {
  if (dbExists({ repoRoot: root, env })) {
    const candidate = candidateConfigGet({ repoRoot: root, env });
    return buildLibrarySnapshot({
      evidence: candidate.evidence,
      deepIngest: buildDeepIngestViewModel({ repoRoot: root, env }),
    });
  }

  return buildLibrarySnapshot({
    evidence: loadCandidateDoc("evidence", { repoRoot: root }) || {},
    stories: readYamlIfExists(root, "candidate/stories.yml") || {},
    writingStyleText: readTextIfExists(root, "candidate/writing-style.md"),
  });
}
