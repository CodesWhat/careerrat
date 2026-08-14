import { mkdirSync, writeFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { runBoundedAI } from "../ai/bounded-ai.mjs";
import { appRegisterPacketArtifacts } from "../db/verbs.mjs";
import { lintArtifact } from "../documents/placeholder-lint.mjs";
import {
  buildCoverLetterScaffold,
  buildStructuredResumeMarkdown,
  containsForbiddenPhrase,
  forbiddenWordingFor,
  validateAtsSafe,
} from "../documents/tailor.mjs";
import { resolveUserPaths } from "../paths/workspace.mjs";
import { draftPacketAnswers as draftPacketAnswersCore } from "./answers.mjs";
import { buildPacketContext } from "./context.mjs";
import { selectPacketStories } from "./deep-ingest-sources.mjs";
import { loadPacketQuestionCapture } from "./questions.mjs";
import {
  packetCoverLetterProposalSchema,
  packetResumeProposalSchema,
} from "./schemas/packet-schemas.mjs";

const COVER_LABELS = Object.freeze({
  skill: "packet-engine",
  action: "draft-cover-letter",
  operation: "packet:cover-letter",
});

const RESUME_LABELS = Object.freeze({
  skill: "packet-engine",
  action: "draft-resume",
  operation: "packet:resume",
});

function cleanText(value) {
  return String(value || "").trim();
}

function slugPart(value) {
  return (
    String(value || "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60) || "application"
  );
}

function withoutPrivateFields(value) {
  if (Array.isArray(value)) return value.map(withoutPrivateFields);
  if (!value || typeof value !== "object") return value;
  const out = {};
  for (const [key, child] of Object.entries(value)) {
    if (
      key === "current_base" ||
      key === "currentBase" ||
      key === "current_compensation" ||
      key === "privateCandidateData"
    ) {
      continue;
    }
    out[key] = withoutPrivateFields(child);
  }
  return out;
}

function workspaceDisplayPath(relPath) {
  return `workspace/${relPath.replaceAll(sep, "/")}`;
}

function appFromContext(context = {}) {
  return context.app || context.application || {};
}

function artifactsFromContext(context = {}) {
  return appFromContext(context).artifacts || {};
}

function profileFromContext(context = {}) {
  const profile = context.profile || context.candidate || {};
  if (profile.candidate) return withoutPrivateFields(profile);
  return withoutPrivateFields({
    candidate: {
      full_name: profile.full_name || profile.name || "Candidate",
      email: profile.email || "",
      phone: profile.phone || "",
      location: profile.location || "",
      linkedin: profile.linkedin || "",
      github: profile.github || "",
    },
  });
}

function evidenceFromContext(context = {}) {
  const claims = Array.isArray(context.evidence?.claims) ? context.evidence.claims : [];
  return { ...(context.evidence || {}), claims };
}

function honestyFromContext(context = {}) {
  return context.honesty || { education: { add_education_section: false }, tools: {} };
}

function normalizeQuestionCapture(input, context = {}) {
  const artifacts = artifactsFromContext(context);
  const packetSummary = appFromContext(context).packetManifest?.questions;
  const questions = Array.isArray(input?.questions)
    ? input.questions
    : Array.isArray(input?.answerable)
      ? input.answerable
      : Array.isArray(packetSummary?.answerableIds)
        ? packetSummary.answerableIds.map((id) => ({
            id: String(id),
            label: String(id),
            type: "text",
            required: false,
          }))
        : [];
  return {
    source: input?.source || "manual",
    path: artifacts.packetQuestionsSource || input?.path || packetSummary?.source || null,
    capturedAt: input?.capturedAt || packetSummary?.capturedAt || null,
    questions,
    excluded: Array.isArray(input?.excluded) ? input.excluded : [],
  };
}

export function enumeratePacketSources(context = {}, questionCapture = null) {
  const app = appFromContext(context);
  const artifacts = artifactsFromContext(context);
  const capture = normalizeQuestionCapture(questionCapture, context);
  const sources = {
    candidateProfile: profileFromContext(context),
    sourceResume: withoutPrivateFields(context.sourceResume || null),
    resumeFacts: withoutPrivateFields(context.resumeFacts || null),
    confirmedEvidence: withoutPrivateFields(evidenceFromContext(context)),
    storiesLearnings: withoutPrivateFields(context.storiesLearnings || []),
    writingVoice: cleanText(context.writingVoice),
    honestyBoundaries: withoutPrivateFields(honestyFromContext(context)),
    deepIngest: withoutPrivateFields(context.deepIngest || {}),
    capturedJobBody: withoutPrivateFields({
      path: artifacts.jd || context.job?.path || null,
      body: context.job?.body || "",
    }),
    capturedQuestions: withoutPrivateFields({
      path: capture.path,
      questions: capture.questions,
      excluded: capture.excluded,
    }),
    companyResearch: withoutPrivateFields(context.companyResearch || null),
    companyIntelligence: withoutPrivateFields(
      context.companyIntelligence || context.publicCompanyIntel || null
    ),
    publicCompanyJobBoardContext: withoutPrivateFields(
      context.publicCompanyJobBoardContext || null
    ),
  };

  if (app.company && !sources.companyIntelligence) {
    sources.companyIntelligence = { company: app.company };
  }
  return sources;
}

function reviewed(value) {
  return Boolean(
    value?.reviewed ||
      value?.status === "reviewed" ||
      value?.status === "confirmed" ||
      value?.status === "approved"
  );
}

function withSource(source, value) {
  if (!value || typeof value !== "object") return { source, value };
  return { source, ...value };
}

export function splitConfirmedAndProposedPacketSources(sources = {}) {
  const claimableEvidence = Array.isArray(sources.confirmedEvidence?.claims)
    ? sources.confirmedEvidence.claims.map((claim) => {
        const { forbidden_wording: _forbidden, ...safeClaim } = claim;
        return withSource("confirmedEvidence", safeClaim);
      })
    : [];
  const claimableContext = [];
  const gapContext = [];

  for (const item of sources.storiesLearnings || []) {
    (reviewed(item) ? claimableContext : gapContext).push(withSource("storiesLearnings", item));
  }
  for (const item of sources.deepIngest?.reviewed || []) {
    (reviewed(item) ? claimableContext : gapContext).push(withSource("deepIngest", item));
  }
  for (const item of sources.deepIngest?.rawProposals || []) {
    gapContext.push(withSource("deepIngest", item));
  }

  for (const [source, value] of [
    ["companyResearch", sources.companyResearch],
    ["companyIntelligence", sources.companyIntelligence],
    ["publicCompanyJobBoardContext", sources.publicCompanyJobBoardContext],
  ]) {
    if (!value) continue;
    (reviewed(value) ? claimableContext : gapContext).push(withSource(source, value));
  }

  return { claimableEvidence, claimableContext, gapContext };
}

// Confirmed honesty-boundary rows (Library) live on the packet context as
// context.honestyBoundariesConfirmed — the FULL uncapped BoundaryRow[] the
// deep-ingest reader verb produces (never the capped/stripped prompt-display
// projection below; enforcement needs completeness, see
// promotion-pipeline-design-2026-07-19.md Decision 6/9). Absent on legacy/
// pre-wiring contexts, so this always degrades to [] (today's behavior).
function boundaryRowsFromContext(context = {}) {
  return Array.isArray(context.honestyBoundariesConfirmed)
    ? context.honestyBoundariesConfirmed
    : [];
}

function forbiddenFor(context = {}) {
  return forbiddenWordingFor(
    evidenceFromContext(context).claims,
    honestyFromContext(context),
    boundaryRowsFromContext(context)
  );
}

const CONFIRMED_BOUNDARY_DISPLAY_CAP = 20;

// Prompt-visible projection of confirmed honesty-boundary rows: most-recent
// (rows already arrive updated_at DESC, id ASC from the reader verb) capped
// at 20, forbiddenWording always stripped (mirrors the existing evidence-
// claim forbidden_wording strip in splitConfirmedAndProposedPacketSources),
// and an allowedWording value dropped when it case-insensitively contains an
// already-enforced forbidden phrase — displaying "allowed: X" alongside an
// enforced "never say X" would contradict the enforcement the model must obey.
function projectConfirmedBoundaries(boundaryRows, forbidden) {
  const rows = Array.isArray(boundaryRows) ? boundaryRows : [];
  return rows.slice(0, CONFIRMED_BOUNDARY_DISPLAY_CAP).map((row) => {
    const { forbiddenWording: _forbiddenWording, ...rest } = row || {};
    const allowedWording = cleanText(rest.allowedWording);
    const allowedConflicts =
      allowedWording && forbidden.some((phrase) => containsForbiddenPhrase(allowedWording, phrase));
    return { ...rest, allowedWording: allowedConflicts ? "" : allowedWording };
  });
}

// Prompt-visible projection of role-signal rows already filtered to the
// application's own role family (selectPacketRoleSignals) — drop
// roleFamily/updatedAt, keep only what the framing clause below needs.
function projectRoleSignals(roleSignals) {
  return (Array.isArray(roleSignals) ? roleSignals : []).map((row) => ({
    id: row?.id,
    signalType: row?.signalType,
    text: row?.text,
    rationale: row?.rationale,
  }));
}

const STORY_SELECTION_PURPOSES = new Set(["resume", "cover-letter", "answers"]);

// Purpose-specific story projection: context.storiesLearnings holds the full
// claimable story set (Worker A's context wiring); the caps/shape/scoring
// that differ per surface (résumé metadata hints vs. cover-letter/answers
// full STAR prose) live in selectPacketStories, called here at prompt-build
// time so each artifact's prompt only ever contains what was scored relevant
// to THIS job. "general" (buildPromptVisibleSources's default purpose) never
// selects stories — only the three purposes selectPacketStories understands.
function storiesForPurpose(context, purpose) {
  if (!STORY_SELECTION_PURPOSES.has(purpose)) return [];
  const storyBank = Array.isArray(context.storiesLearnings) ? context.storiesLearnings : [];
  if (!storyBank.length) return [];
  const queryText = cleanText(context.job?.body);
  return selectPacketStories({ storyBank, queryText, purpose }) || [];
}

// The AI-prompt-visible projection of enumeratePacketSources(): confirmed
// evidence and reviewed context stay claimable, but raw/proposed deep-ingest
// material and unreviewed research (gapContext) never reach the model — only
// the source categories they came from do, as a gap listing (10-04-PLAN.md:
// raw/proposed material is gap context only, never prompt-visible prose).
//
// `purpose` selects the deep-ingest confirmed-lane projection
// (promotion-pipeline-design-2026-07-19.md): résumé gets story *metadata
// hints* only (storyHints, no story ids ever citable — see
// validatePacketEvidenceIds); cover-letter/answers get up to 4 full stories,
// citable via `story:<id>` scoped to that artifact's own prompt. roleSignals
// and the confirmed-boundary projection are purpose-independent — they're
// framing/enforcement context every surface can safely see. Every new key is
// OMITTED (not emptied) when its projection has nothing, so a context with no
// confirmed deep-ingest rows produces byte-identical prompt JSON to the
// pre-wiring engine.
export function buildPromptVisibleSources(
  context = {},
  questionCapture = null,
  { purpose = "general" } = {}
) {
  const sources = enumeratePacketSources(context, questionCapture);
  const split = splitConfirmedAndProposedPacketSources(sources);
  const forbidden = forbiddenFor(context);
  const confirmedBoundaries = projectConfirmedBoundaries(
    context.honestyBoundariesConfirmed,
    forbidden
  );
  const roleSignals = projectRoleSignals(context.roleSignals);
  const storyHints = storiesForPurpose(context, purpose);
  return {
    candidateProfile: sources.candidateProfile,
    sourceResume: sources.sourceResume,
    resumeFacts: sources.resumeFacts,
    writingVoice: sources.writingVoice,
    honestyBoundaries: confirmedBoundaries.length
      ? { ...sources.honestyBoundaries, confirmedBoundaries }
      : sources.honestyBoundaries,
    ...(roleSignals.length ? { roleSignals } : {}),
    ...(storyHints.length ? { storyHints } : {}),
    capturedJobBody: sources.capturedJobBody,
    capturedQuestions: sources.capturedQuestions,
    confirmedEvidence: { ...sources.confirmedEvidence, claims: split.claimableEvidence },
    confirmedContext: split.claimableContext,
    unconfirmedAreas: [...new Set(split.gapContext.map((item) => item.source))].sort(),
  };
}

function privateLeakMessage(text) {
  if (
    /PRIVATE_CURRENT|current[_ -]?base|current compensation|current salary|current pay/i.test(text)
  ) {
    return "private current compensation appears in packet proposal";
  }
  if (/\bunreviewed\b|\braw\b|\bproposed\b/i.test(text)) {
    return "unreviewed raw/proposed material appears in packet proposal";
  }
  return null;
}

// Generalized grounding check: the allowed-id set is evidence claim ids
// unioned with `story:<id>` ids for the stories actually selected into THAT
// artifact's own prompt (promptStories — pass the same storyHints array that
// went into building the prompt this proposal was drafted against). A story
// absent from that set (e.g. cited in a cover letter but never included in
// the answers prompt) is not citable there — grounding is artifact-specific,
// not a global "any confirmed story anywhere" allowance. `validatePacket
// EvidenceIds` is kept as the original exported name (alias below) — callers
// that never pass promptStories (résumé validation never does; no story ids
// are ever valid there) see byte-identical behavior to before this generalized.
export function validatePacketGroundedIds({
  context = {},
  proposals = [],
  promptStories = [],
} = {}) {
  const allowed = new Set([
    ...evidenceFromContext(context).claims.map((claim) => String(claim.id)),
    ...(Array.isArray(promptStories) ? promptStories : []).map((story) => `story:${story.id}`),
  ]);
  const forbidden = forbiddenFor(context);
  const gaps = [];

  for (const proposal of proposals) {
    const text = cleanText(proposal?.text || proposal?.answer);
    const ids = Array.isArray(proposal?.evidenceIds) ? proposal.evidenceIds.map(String) : [];
    const issues = [];
    const privateIssue = privateLeakMessage(text);
    if (privateIssue) issues.push(privateIssue);
    if (/^NEEDS YOU:/i.test(text)) issues.push("user confirmation is required");
    const missing = ids.filter((id) => !allowed.has(id));
    if (!ids.length && !/^NEEDS YOU:/i.test(text)) issues.push("confirmed evidence ID is required");
    if (missing.length) issues.push(`missing evidence IDs: ${missing.join(", ")}`);
    const forbiddenHits = forbidden.filter((phrase) => containsForbiddenPhrase(text, phrase));
    if (forbiddenHits.length) issues.push(`forbidden wording: ${forbiddenHits.join(", ")}`);
    if (issues.length) {
      gaps.push({
        kind: proposal?.kind || "proposal",
        message: issues.join("; "),
      });
    }
  }

  return { ok: gaps.length === 0, gaps };
}

export const validatePacketEvidenceIds = validatePacketGroundedIds;

function promptForCoverLetter(visibleSources) {
  return [
    "Draft concise cover-letter prose blocks using only confirmed local evidence.",
    "Return JSON matching packetCoverLetterProposalSchema.",
    "",
    JSON.stringify(visibleSources, null, 2),
  ].join("\n");
}

export async function draftCoverLetterBlocks({
  repoRoot,
  env = process.env,
  context = {},
  call,
  runAI = runBoundedAI,
} = {}) {
  // Built once so the same storyHints selection both goes into the prompt
  // and scopes validatePacketEvidenceIds's allowed `story:<id>` set below —
  // a story absent from THIS letter's own prompt is never citable in it.
  const visibleSources = buildPromptVisibleSources(context, null, { purpose: "cover-letter" });
  const aiResult = await runAI({
    labels: COVER_LABELS,
    schema: packetCoverLetterProposalSchema,
    manual: {
      available: true,
      reason: "packet-cover-letter-review",
      action: "Review and complete the cover letter manually.",
    },
    structuredMode: "native-preferred",
    call,
    messages: [{ role: "user", content: promptForCoverLetter(visibleSources) }],
    system:
      'Draft cover letter blocks. Every block must list at least one id from confirmedEvidence.claims or storyHints (cite a story as "story:<id>") in its evidenceIds array, and only ids from those lists — never a story id outside the storyHints provided here. If a block cannot be grounded that way, start its text with "NEEDS YOU:" and leave evidenceIds empty. roleSignals are the candidate\'s confirmed framing preferences (keep = emphasize, cut = de-emphasize) and never license stating anything not already grounded in confirmedEvidence.claims or storyHints. Do not include private compensation or unconfirmed claims.',
    outputName: "packet_cover_letter_blocks",
    // A full multi-block letter plus JSON overhead regularly exceeds 1800
    // tokens; a mid-JSON max_tokens truncation parses as failure and the
    // whole draft degrades to a NEEDS YOU punt.
    maxTokens: 4000,
    root: repoRoot,
    env,
  });

  // The packet lane never writes a degraded cover letter: an AI-call failure
  // is a real error, not a NEEDS YOU punt — throw so the caller (generatePacket
  // -> the /api/packet/generate route) surfaces it instead of persisting a
  // placeholder artifact.
  if (!aiResult.body?.ok) {
    const err = new Error(
      `document generation needs AI (${aiResult.body?.error?.message || aiResult.body?.code || "AI call failed"}) — check your AI settings and retry`
    );
    err.code = "PACKET_AI_UNAVAILABLE";
    err.details = aiResult.body?.error?.code || aiResult.body?.code || null;
    throw err;
  }

  const blocks = (aiResult.body.data?.blocks || []).map((block) => ({
    text: cleanText(block.text),
    evidenceIds: Array.isArray(block.evidenceIds) ? block.evidenceIds.map(String) : [],
  }));
  const validation = validatePacketEvidenceIds({
    context,
    proposals: blocks.map((block) => ({ kind: "coverLetter", ...block })),
    promptStories: visibleSources.storyHints,
  });
  // A block the model honestly marked NEEDS YOU is a confirmation gap, not a
  // contract violation — keep it (and the grounded blocks around it) inline,
  // the way the answers flow does. Only hard violations (missing/unknown
  // evidence IDs, private leaks, forbidden wording) fail the draft outright —
  // the packet lane never writes a degraded cover letter for those either.
  const hardGaps = validation.gaps.filter((gap) => gap.message !== "user confirmation is required");
  if (!blocks.length || hardGaps.length) {
    const violationMessages = (
      hardGaps.length ? hardGaps : [{ message: "cover-letter draft produced no usable blocks" }]
    ).map((gap) => gap.message);
    const err = new Error(
      `AI cover-letter draft failed grounding validation (${violationMessages.join("; ")}) — regenerate to retry`
    );
    err.code = "PACKET_COVER_INVALID";
    throw err;
  }
  return {
    blocks,
    uploadReady: validation.ok,
    ai: aiResult.body.ai,
    manual: { required: !validation.ok },
    ...(validation.ok ? {} : { gaps: validation.gaps }),
  };
}

function promptForResume(context = {}) {
  return [
    "Tailor the candidate's résumé to the target job using only the provided sources.",
    "Return JSON matching packetResumeProposalSchema.",
    "",
    JSON.stringify(buildPromptVisibleSources(context, null, { purpose: "resume" }), null, 2),
  ].join("\n");
}

function normalizeResumeText(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

// Pure/deterministic grounding check for an AI resume proposal: every
// structural fact it claims (employer, title, dated years) must actually
// appear in the candidate's real imported résumé text, not just be
// plausible-sounding. This runs regardless of what the model's schema
// validation already passed — the schema can't check facts against sources.
// Skills are deliberately NOT checked here — see draftResumeProposal's
// lenient skills pass, which drops individual unmatched items instead of
// failing the whole proposal.
export function validateResumeProposal({ context = {}, proposal = {} } = {}) {
  const sourceText = normalizeResumeText(context.sourceResume?.text);
  const rawSourceText = String(context.sourceResume?.text || "");
  const violations = [];

  const checkYears = (dates, label) => {
    if (!dates) return;
    const years = String(dates).match(/\b(19|20)\d{2}\b/g) || [];
    for (const year of years) {
      if (!rawSourceText.includes(year)) {
        violations.push(`resume ${label} dates "${dates}" year ${year} not found in source résumé`);
      }
    }
  };

  for (const entry of proposal.experience || []) {
    const company = normalizeResumeText(entry.company);
    if (!company || !sourceText.includes(company)) {
      violations.push(`resume entry company "${entry.company}" not found in source résumé`);
    }
    checkYears(entry.dates, "entry");
    for (const role of entry.roles || []) {
      const title = normalizeResumeText(role.title);
      if (!title || !sourceText.includes(title)) {
        violations.push(`resume role title "${role.title}" not found in source résumé`);
      }
      checkYears(role.dates, "role");
    }
  }

  const leakText = [
    proposal.summary,
    ...(proposal.experience || []).flatMap((entry) =>
      (entry.roles || []).flatMap((role) => role.bullets || [])
    ),
    ...(proposal.sections || []).flatMap((section) => section.bullets || []),
  ].join("\n");
  const leakIssue = privateLeakMessage(leakText);
  if (leakIssue) violations.push(leakIssue);

  return { ok: violations.length === 0, violations };
}

// Safety trims (silent, never fail) — bound how much a runaway proposal can
// inflate the artifact regardless of what schema validation already passed.
// Shared by the initial AI call and the one-shot grounding-correction retry
// below so both attempts get the exact same shaping before validation.
function buildResumeProposalFromAiData(data = {}) {
  return {
    summary: cleanText(data.summary),
    experience: (Array.isArray(data.experience) ? data.experience : [])
      .slice(0, 8)
      .map((entry) => ({
        company: cleanText(entry.company),
        location: cleanText(entry.location),
        dates: cleanText(entry.dates),
        roles: (Array.isArray(entry.roles) ? entry.roles : []).slice(0, 6).map((role) => ({
          title: cleanText(role.title),
          dates: cleanText(role.dates),
          bullets: (Array.isArray(role.bullets) ? role.bullets : [])
            .map((bullet) => cleanText(bullet))
            .filter((bullet) => bullet.length > 0)
            .slice(0, 8),
        })),
      })),
    sections: (Array.isArray(data.sections) ? data.sections : []).slice(0, 3).map((section) => ({
      heading: cleanText(section.heading),
      bullets: (Array.isArray(section.bullets) ? section.bullets : [])
        .map((bullet) => cleanText(bullet))
        .filter((bullet) => bullet.length > 0),
    })),
    skillGroups: (Array.isArray(data.skillGroups) ? data.skillGroups : [])
      .slice(0, 6)
      .map((group) => ({
        label: cleanText(group.label),
        items: (Array.isArray(group.items) ? group.items : [])
          .map((item) => cleanText(item))
          .filter(Boolean),
      })),
    education: (Array.isArray(data.education) ? data.education : [])
      .map((entry) => cleanText(entry))
      .filter(Boolean),
  };
}

// The one-shot grounding-correction retry message: lists the exact
// violations validateResumeProposal found, verbatim, plus the rejected draft
// for context, and instructs the model to fix ONLY those facts against the
// candidate's real source résumé rather than rewriting the whole thing.
function resumeGroundingCorrectionMessage({ violations, priorData }) {
  return {
    role: "user",
    content: [
      "The résumé draft you returned failed grounding validation against sourceResume.text:",
      ...violations.map((violation) => `- ${violation}`),
      "",
      "Your previous draft:",
      JSON.stringify(priorData),
      "",
      "Fix ONLY the facts listed above so they match sourceResume.text exactly — do not change anything else. Return the corrected JSON matching packetResumeProposalSchema.",
    ].join("\n"),
  };
}

export async function draftResumeProposal({
  repoRoot,
  env = process.env,
  context = {},
  call,
  runAI = runBoundedAI,
} = {}) {
  // The packet lane never writes a degraded résumé: every failure path below
  // throws instead of falling back to the deterministic claims-list resume —
  // generatePacket only reaches buildSourceArtifacts on success.
  if (!cleanText(context.sourceResume?.text)) {
    const err = new Error(
      "no source résumé on file — import your résumé (onboarding Resume step) before generating documents"
    );
    err.code = "NO_SOURCE_RESUME";
    throw err;
  }

  const baseMessages = [{ role: "user", content: promptForResume(context) }];
  const runResumeAI = (messages) =>
    runAI({
      labels: RESUME_LABELS,
      schema: packetResumeProposalSchema,
      manual: {
        available: true,
        reason: "packet-resume-review",
        action: "Review and tailor the resume manually.",
      },
      structuredMode: "native-preferred",
      call,
      messages,
      system:
        "Tailor the candidate's résumé for the target job. Use ONLY facts present in sourceResume.text, candidateProfile, and confirmedEvidence.claims. Never invent or alter employers, titles, dates, numbers, or metrics. Group roles held at the same employer under one experience entry with the employer's location and overall dates; every company and title must appear verbatim in sourceResume.text. Write a summary paragraph that names the target role and company and honestly mirrors the job description's language. Select and order the material most relevant to the job description; omit weak or irrelevant bullets instead of padding. Group skills into 3-5 skillGroups whose labels echo the job description's priorities; include a certifications group only if certifications appear in the sources; every skill item must appear somewhere in the sources. Optionally include up to 3 extra sections (e.g. Open Source, Projects) only when the source material supports them. Do not include private compensation or unconfirmed claims." +
        " storyHints, roleSignals, and writingVoice are selection and style directives only — they guide what to emphasize and how to phrase it, never a source of new facts, and no résumé bullet may cite a story id. roleSignals are the candidate's confirmed framing preferences (keep = emphasize, cut = de-emphasize) and never license stating anything not already grounded in sourceResume.text, candidateProfile, or confirmedEvidence.claims.",
      outputName: "packet_resume_proposal",
      // The nested experience/roles/sections/skillGroups structure plus a full
      // bullet set regularly exceeds 8000 tokens; a mid-JSON max_tokens
      // truncation parses as failure — see the !aiResult.body?.ok throw below,
      // which surfaces that as PACKET_AI_UNAVAILABLE rather than degrading.
      maxTokens: 10000,
      root: repoRoot,
      env,
    });

  let aiResult = await runResumeAI(baseMessages);

  if (!aiResult.body?.ok) {
    const err = new Error(
      `document generation needs AI (${aiResult.body?.error?.message || aiResult.body?.code || "AI call failed"}) — check your AI settings and retry`
    );
    err.code = "PACKET_AI_UNAVAILABLE";
    err.details = aiResult.body?.error?.code || aiResult.body?.code || null;
    throw err;
  }

  let proposal = buildResumeProposalFromAiData(aiResult.body.data);
  let validation = validateResumeProposal({ context, proposal });

  if (!validation.ok) {
    // One correction pass: ask the model to fix ONLY the flagged facts
    // against the real source résumé instead of discarding the whole draft.
    // A second unresolved failure (bad retry validation, or the retry call
    // itself failing) throws — there is no further fallback.
    const retryResult = await runResumeAI([
      ...baseMessages,
      resumeGroundingCorrectionMessage({
        violations: validation.violations,
        priorData: aiResult.body.data,
      }),
    ]);
    const retryOk = Boolean(retryResult.body?.ok);
    const retryProposal = retryOk ? buildResumeProposalFromAiData(retryResult.body.data) : null;
    const retryValidation = retryOk
      ? validateResumeProposal({ context, proposal: retryProposal })
      : null;

    if (!retryOk || !retryValidation.ok) {
      const violations =
        retryValidation && !retryValidation.ok ? retryValidation.violations : validation.violations;
      const err = new Error(
        `AI resume draft failed grounding validation (${violations.join("; ")}) — regenerate to retry`
      );
      err.code = "PACKET_RESUME_INVALID";
      throw err;
    }

    aiResult = retryResult;
    proposal = retryProposal;
    validation = retryValidation;
  }

  // Lenient skills pass: unlike company/title/dates (hard facts that must
  // survive verbatim), a skill mention is routinely paraphrased ("React" vs
  // "React.js") — so an unmatched skill item is dropped individually rather
  // than discarding the whole proposal. Checked against a wider haystack
  // (source résumé + candidate profile + evidence claim text) since a real
  // skill can legitimately live in any of those, not just the résumé body.
  const haystack = normalizeResumeText(
    [
      context.sourceResume?.text,
      JSON.stringify(profileFromContext(context)),
      ...(evidenceFromContext(context).claims || []).map((claim) => claim.claim),
    ]
      .filter(Boolean)
      .join(" ")
  );
  const droppedSkills = [];
  const skillGroups = proposal.skillGroups
    .map((group) => ({
      ...group,
      items: group.items.filter((item) => {
        const found = haystack.includes(normalizeResumeText(item));
        if (!found) droppedSkills.push(item);
        return found;
      }),
    }))
    .filter((group) => group.items.length > 0);
  const cleanedProposal = { ...proposal, skillGroups };
  const skillsGap = droppedSkills.length
    ? [
        {
          kind: "resume",
          message: `skills omitted (not found in sources): ${droppedSkills.join(", ")}`,
        },
      ]
    : [];

  return { proposal: cleanedProposal, ai: aiResult.body.ai, gaps: skillsGap };
}

function questionLabelById(capture) {
  return new Map((capture.questions || []).map((q) => [String(q.id), q.label || String(q.id)]));
}

function renderAnswersMarkdown({ answers = [], questionCapture }) {
  const labels = questionLabelById(questionCapture);
  const sections = ["# Application Answers"];
  for (const answer of answers) {
    const question = answer.question || labels.get(String(answer.questionId)) || answer.questionId;
    sections.push(`## ${question}\n\n${answer.answer || "NEEDS YOU: draft this answer."}`);
  }
  if (answers.length === 0) {
    sections.push("NEEDS YOU: answer any required non-EEO application questions.");
  }
  return sections.join("\n\n");
}

function renderManualCoverLetter({ context, reason }) {
  const profile = profileFromContext(context);
  const company = context.job?.frontmatter?.company || appFromContext(context).company || "";
  const role = context.job?.frontmatter?.role || appFromContext(context).role || "";
  return [
    `Re: Application${role ? ` ${role}` : ""}${company ? ` at ${company}` : ""}`,
    "",
    company ? `Dear ${company} Hiring Team,` : "Dear Hiring Team,",
    "",
    `NEEDS YOU: ${reason}`,
    "",
    "Sincerely,",
    profile.candidate.full_name || "Candidate",
  ].join("\n");
}

function assertAtsSafe(name, markdown, { allowNeedsYou = false } = {}) {
  const lint = lintArtifact(markdown);
  const blocking = allowNeedsYou
    ? lint.findings.filter((finding) => finding.pattern !== "needs-you-marker")
    : lint.findings;
  if (blocking.length) {
    throw new Error(`${name} contains unresolved placeholders`);
  }
  const ats = validateAtsSafe(markdown);
  if (!ats.ok) {
    throw new Error(`${name} is not ATS-safe: ${ats.issues.join("; ")}`);
  }
}

function buildSourceArtifacts({
  context,
  questionCapture,
  coverLetter,
  resumeProposal = null,
  answers,
  services = {},
  skipAnswers = false,
}) {
  const profile = profileFromContext(context);
  const evidence = evidenceFromContext(context);
  const honesty = honestyFromContext(context);
  const boundaryRows = boundaryRowsFromContext(context);
  const job = {
    ...(context.job || {}),
    frontmatter: {
      company: appFromContext(context).company || context.job?.frontmatter?.company || "",
      role: appFromContext(context).role || context.job?.frontmatter?.role || "",
      ...(context.job?.frontmatter || {}),
    },
  };

  // The packet lane never writes a degraded résumé: draftResumeProposal now
  // throws on every failure path (no source résumé, AI unavailable, grounding
  // validation), so generatePacket only reaches this function with a
  // validated proposal in hand — resumeProposal.proposal is required, not
  // optional. An assembly failure here is a real bug, not a fallback trigger,
  // and propagates (wrapped) rather than degrading to the deterministic
  // claims-list resume.
  let resume;
  try {
    resume = (services.buildStructuredResumeMarkdown || buildStructuredResumeMarkdown)({
      profile,
      proposal: resumeProposal.proposal,
      evidence,
      honesty,
      boundaryRows,
    });
  } catch (err) {
    const wrapped = new Error(err?.message || "resume assembly failed");
    wrapped.code = "PACKET_RESUME_ERROR";
    throw wrapped;
  }

  const coverBlocks = coverLetter.blocks || [];
  const coverHasNeedsYou = coverBlocks.some((block) => /^NEEDS YOU:/i.test(block.text || ""));
  const coverLetterMarkdown = coverHasNeedsYou
    ? renderManualCoverLetter({
        context: { ...context, job },
        reason:
          coverBlocks.find((block) => /^NEEDS YOU:/i.test(block.text || ""))?.gap ||
          "confirm the cover-letter proof points.",
      })
    : (services.buildCoverLetterScaffold || buildCoverLetterScaffold)({
        profile,
        job,
        evidence,
        blocks: coverBlocks.map((block) => block.text),
        boundaryRows,
      });
  assertAtsSafe("resume", resume);
  assertAtsSafe("coverLetter", coverLetterMarkdown, { allowNeedsYou: coverHasNeedsYou });

  // Artifacts-only generation (no question capture yet) skips the answers
  // artifact entirely rather than writing a placeholder NEEDS YOU file — see
  // generatePacket's skipAnswers/BAD_QUESTION_CAPTURE handling.
  if (skipAnswers) {
    return { resume, coverLetter: coverLetterMarkdown };
  }
  const answersMarkdown = renderAnswersMarkdown({ answers: answers.answers, questionCapture });
  assertAtsSafe("answers", answersMarkdown, { allowNeedsYou: true });
  return { resume, coverLetter: coverLetterMarkdown, answers: answersMarkdown };
}

function sourceBase({ context, appId }) {
  const app = appFromContext(context);
  return `${slugPart(app.company)}-${slugPart(app.role)}-${slugPart(appId)}`;
}

function writeWorkspaceArtifacts({
  repoRoot,
  env,
  appId,
  context,
  sources,
  manifest,
  formats = [],
}) {
  const { workspaceDir } = resolveUserPaths({ repoRoot, env });
  const tailoredDir = join(workspaceDir, "tailored");
  mkdirSync(tailoredDir, { recursive: true });
  const base = sourceBase({ context, appId });
  const writes = {
    resumeSource: [`${base}-resume.md`, sources.resume],
    coverLetterSource: [`${base}-cover-letter.md`, sources.coverLetter],
    // Omitted entirely (not written as an empty/placeholder file) when the
    // answers artifact was skipped — see buildSourceArtifacts.
    ...(sources.answers != null ? { answersSource: [`${base}-answers.md`, sources.answers] } : {}),
    packetManifest: [`${base}-packet-manifest.json`, `${JSON.stringify(manifest, null, 2)}\n`],
  };

  const artifacts = {};
  for (const [key, [file, body]] of Object.entries(writes)) {
    const full = join(tailoredDir, file);
    writeFileSync(full, body, "utf8");
    artifacts[key] = workspaceDisplayPath(relative(workspaceDir, full));
  }

  const selectedFormats = formats.includes("docx") ? ["pdf", "docx"] : ["pdf"];
  for (const format of selectedFormats) {
    for (const [key, body] of Object.entries(sources)) {
      const artifactKey =
        key === "coverLetter"
          ? `coverLetter${format === "pdf" ? "Pdf" : "Docx"}`
          : `${key}${format === "pdf" ? "Pdf" : "Docx"}`;
      const fileKind = key === "coverLetter" ? "cover-letter" : key;
      const full = join(tailoredDir, `${base}-${fileKind}.${format}`);
      const content = format === "pdf" ? `%PDF-1.4\n% CareerRat packet artifact\n${body}\n` : body;
      writeFileSync(full, content, format === "pdf" ? "utf8" : "utf8");
      artifacts[artifactKey] = workspaceDisplayPath(relative(workspaceDir, full));
    }
  }

  // BUG: the read path (GET /api/packet, isGatedIn, GET /api/packet/artifact
  // in packet-route.mjs) and the older appRegisterArtifact write path both
  // key off the plain artifacts.resume/coverLetter/answers fields, not the
  // finer-grained <kind>Source/<kind>Pdf/<kind>Docx keys above. Stamp the
  // plain keys too, pointed at the source markdown (the representation the
  // read path renders inline as {path, markdown, html}), preserving the
  // <kind>GeneratedAt stamp convention appRegisterArtifact uses.
  artifacts.resume = artifacts.resumeSource;
  artifacts.resumeGeneratedAt = manifest.generatedAt;
  artifacts.coverLetter = artifacts.coverLetterSource;
  artifacts.coverLetterGeneratedAt = manifest.generatedAt;
  if (artifacts.answersSource) {
    artifacts.answers = artifacts.answersSource;
    artifacts.answersGeneratedAt = manifest.generatedAt;
  }

  return artifacts;
}

async function loadCaptureForGeneration({ repoRoot, env, appId, context, questionCapture }) {
  if (questionCapture) return normalizeQuestionCapture(questionCapture, context);
  if (repoRoot && appId) {
    try {
      return normalizeQuestionCapture(
        await loadPacketQuestionCapture({ repoRoot, env, appId }),
        context
      );
    } catch (err) {
      // No capture ever recorded degrades to "no capture" below. A capture
      // that WAS recorded but fails to load (corrupt JSON, failed schema
      // validation) is a real error and must not be masked as "no capture".
      if (err?.code === "NOT_FOUND") return normalizeQuestionCapture(null, context);
      throw err;
    }
  }
  return normalizeQuestionCapture(null, context);
}

function manifestFor({
  appId,
  questionCapture,
  answers,
  sources,
  sourceSplit,
  gaps,
  uploadReady,
  deepIngestWarnings = [],
}) {
  const generatedAt = new Date().toISOString();
  const artifacts = {};
  const answerIds = (answers.answers || []).map((answer) => String(answer.questionId));
  return {
    applicationId: appId,
    generatedAt,
    uploadReady,
    status: uploadReady ? "upload-ready" : "reviewable",
    gapCount: gaps.length,
    questions: questionCapture.questions,
    excludedQuestions: questionCapture.excluded,
    questionCaptureSource: questionCapture.path,
    // No capture (the artifacts-only degrade path) → no lineage to point at;
    // a null source fails the manifest schema's string requirement.
    ...(questionCapture.path
      ? {
          answerLineage: {
            answeredQuestionIds: answerIds,
            excludedQuestionIds:
              answers.excludedQuestionIds || questionCapture.excluded.map((q) => q.id),
            source: questionCapture.path,
          },
        }
      : {}),
    artifacts,
    sources: {
      present: Object.fromEntries(
        Object.entries(sources).map(([key, value]) => [
          key,
          Array.isArray(value) ? value.length > 0 : Boolean(value),
        ])
      ),
      claimableEvidenceIds: sourceSplit.claimableEvidence.map((item) => String(item.id)),
      gapContextCount: sourceSplit.gapContext.length,
    },
    gaps,
    // Advisory-only, separate from gaps[]: gaps[] gates uploadReady
    // (generatePacket requires gaps.length === 0), so privacy-skipped/
    // malformed deep-ingest rows (context.deepIngestDiagnostics — reader.
    // skipped) must never be folded in there, or a stale/malformed Library
    // row would silently block an otherwise-complete packet from ever
    // becoming upload-ready. This field is purely informational.
    deepIngestWarnings,
  };
}

function dbManifestFor({ manifest, context, artifacts }) {
  const existingQuestions = appFromContext(context).packetManifest?.questions;
  // In the artifacts-only degrade path (no question capture) there is no
  // capture source to point at — packetManifestSchema's questions.source is a
  // workspacePath, so a null-source fallback fails validation
  // (BAD_PACKET_MANIFEST). Omit the questions section entirely instead of
  // fabricating one; the manifest schema doesn't require it.
  const fallbackQuestions = manifest.questionCaptureSource
    ? {
        source: manifest.questionCaptureSource,
        capturedAt: manifest.generatedAt,
        answerableCount: manifest.questions.length,
        excludedCount: manifest.excludedQuestions.length,
        answerableIds: manifest.questions.map((q) => String(q.id)),
        excludedIds: manifest.excludedQuestions.map((q) => String(q.id)),
        demographicSectionPresent: false,
      }
    : undefined;
  const questions = existingQuestions || fallbackQuestions;
  const dbManifest = { ...manifest, artifacts };
  // `manifest.questions` is the captured-question ARRAY (manifestFor); the DB
  // manifest wants the summary OBJECT here — never let the array leak through.
  if (questions) dbManifest.questions = questions;
  else delete dbManifest.questions;
  return dbManifest;
}

function gapObjects(...lists) {
  return lists
    .flat()
    .filter(Boolean)
    .map((gap) =>
      typeof gap === "string"
        ? { kind: "review", message: gap }
        : {
            kind: gap.kind || gap.reason || "review",
            message: gap.message || gap.reason || "review",
          }
    );
}

export async function generatePacket({
  repoRoot,
  env = process.env,
  appId,
  applicationId,
  applyIntent = false,
  formats = ["pdf"],
  context,
  questionCapture,
  services = {},
  draftCoverLetterBlocks: coverDraft = draftCoverLetterBlocks,
  draftResumeProposal: resumeDraft = draftResumeProposal,
  draftPacketAnswers = draftPacketAnswersCore,
  exportPacketArtifacts,
  coverLetterCall,
  resumeCall,
  packetAnswersCall,
} = {}) {
  const id = cleanText(
    applicationId || appId || context?.applicationId || appFromContext(context).id
  );
  if (!id) {
    const err = new Error("generatePacket: applicationId is required");
    err.code = "BAD_REQUEST";
    throw err;
  }
  const packetContext =
    context ||
    buildPacketContext({
      repoRoot,
      env,
      applicationId: id,
    });
  const capture = await loadCaptureForGeneration({
    repoRoot,
    env,
    appId: id,
    context: packetContext,
    questionCapture,
  });
  const hasQuestionCapture = Boolean(capture.path) || capture.questions.length > 0;
  // applyIntent (the submit-ready path, e.g. apply-job) still hard-requires a
  // real question capture so the answers artifact can be produced before an
  // ATS submission. The artifacts-only path (the Jobs drawer's "generate
  // resume + cover letter") degrades instead of failing — see skipAnswers
  // below and buildSourceArtifacts.
  if (!hasQuestionCapture && applyIntent) {
    const err = new Error(
      `no application questions captured for "${id}" — capture the form questions first (packet questions step) and retry`
    );
    err.code = "BAD_QUESTION_CAPTURE";
    throw err;
  }
  const skipAnswers = !hasQuestionCapture;
  const sourceMap = enumeratePacketSources(packetContext, capture);
  const sourceSplit = splitConfirmedAndProposedPacketSources(sourceMap);
  // The resume and cover-letter drafts are independent AI calls (different
  // schemas, different prompts) — run them concurrently rather than
  // sequentially. answers stays sequential where it already was.
  const [resumeProposal, coverLetter] = await Promise.all([
    resumeDraft({ repoRoot, env, context: packetContext, call: resumeCall }),
    coverDraft({ repoRoot, env, context: packetContext, call: coverLetterCall }),
  ]);
  const answers = await draftPacketAnswers({
    repoRoot,
    env,
    appId: id,
    context: packetContext,
    questions: capture,
    call: packetAnswersCall,
  });
  const sources = buildSourceArtifacts({
    context: packetContext,
    questionCapture: capture,
    coverLetter,
    resumeProposal,
    answers,
    services,
    skipAnswers,
  });
  // Grounding is artifact-specific: a story selected into the cover letter's
  // own prompt is not automatically citable in an answer (and vice versa),
  // so each artifact validates against its own storyHints selection rather
  // than one pooled set — recomputed here deterministically (same context +
  // purpose draftCoverLetterBlocks/draftPacketAnswers used to build their
  // own prompts) rather than threaded back through their return values.
  const coverValidation = validatePacketEvidenceIds({
    context: packetContext,
    proposals: (coverLetter.blocks || []).map((block) => ({ kind: "coverLetter", ...block })),
    promptStories: storiesForPurpose(packetContext, "cover-letter"),
  });
  const answersValidation = validatePacketEvidenceIds({
    context: packetContext,
    proposals: (answers.answers || [])
      // Deterministic disclosure answers (work auth / sponsorship / salary
      // floor / notice period) are structured facts sourced from onboarding,
      // not AI claims needing an evidence citation — and a disclosure salary
      // answer states the candidate's ask-side minimum_base floor, not
      // current compensation, so it must never be run through the
      // private-leak check either. Excluding them from proposals entirely
      // covers both.
      .filter((answer) => !answer.disclosure)
      .map((answer) => ({
        kind: "answer",
        text: answer.answer,
        evidenceIds: answer.evidenceIds || [],
      })),
    promptStories: storiesForPurpose(packetContext, "answers"),
  });
  const validation = {
    ok: coverValidation.ok && answersValidation.ok,
    gaps: [...coverValidation.gaps, ...answersValidation.gaps],
  };
  const lintGaps = Object.entries(sources).flatMap(([kind, markdown]) =>
    lintArtifact(markdown)
      .findings.filter((finding) => finding.pattern === "needs-you-marker")
      .map((finding) => ({ kind, message: finding.text }))
  );
  // Explicit skip record for the artifacts-only degrade path (BAD_QUESTION_
  // CAPTURE relaxation above) — the UI needs to see *why* no answers artifact
  // exists rather than inferring it from a missing key.
  const skippedAnswersGap = skipAnswers
    ? [
        {
          kind: "answers",
          message:
            "answers artifact skipped — no application questions captured yet; capture the form questions (packet questions step), then regenerate, to produce answers",
        },
      ]
    : [];
  const gaps = gapObjects(
    validation.gaps,
    coverLetter.gaps,
    resumeProposal?.gaps,
    answers.gaps,
    lintGaps,
    skippedAnswersGap
  );
  const uploadReady =
    Boolean(applyIntent) &&
    gaps.length === 0 &&
    validation.ok &&
    coverLetter.uploadReady !== false &&
    answers.uploadReady !== false;
  const manifest = manifestFor({
    appId: id,
    questionCapture: capture,
    answers,
    sources: sourceMap,
    sourceSplit,
    gaps,
    uploadReady,
    deepIngestWarnings: Array.isArray(packetContext?.deepIngestDiagnostics)
      ? packetContext.deepIngestDiagnostics
      : [],
  });

  let artifacts = {};
  if (repoRoot) {
    artifacts = writeWorkspaceArtifacts({
      repoRoot,
      env,
      appId: id,
      context: packetContext,
      sources,
      manifest,
      formats,
    });
    manifest.artifacts = artifacts;

    if (typeof exportPacketArtifacts === "function") {
      await exportPacketArtifacts({ repoRoot, env, appId: id, sources, manifest, formats });
    }

    appRegisterPacketArtifacts({
      repoRoot,
      env,
      id,
      artifacts,
      manifest: dbManifestFor({ manifest, context: packetContext, artifacts }),
      note: uploadReady ? "packet upload-ready" : "packet reviewable",
    });
  }

  return {
    appId: id,
    applicationId: id,
    submitted: false,
    uploadReady,
    status: uploadReady ? "upload-ready" : "reviewable",
    artifacts,
    manifest,
    sources,
    gaps,
    manual: { required: !uploadReady },
  };
}
