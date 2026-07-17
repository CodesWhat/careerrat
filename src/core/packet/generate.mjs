import { mkdirSync, writeFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { runBoundedAI } from "../ai/bounded-ai.mjs";
import { appRegisterPacketArtifacts } from "../db/verbs.mjs";
import { lintArtifact } from "../documents/placeholder-lint.mjs";
import {
  buildCoverLetterScaffold,
  buildResumeMarkdown,
  buildShortAnswer,
  forbiddenWordingFor,
  validateAtsSafe,
} from "../documents/tailor.mjs";
import { resolveUserPaths } from "../paths/workspace.mjs";
import { draftPacketAnswers as draftPacketAnswersCore } from "./answers.mjs";
import { buildPacketContext } from "./context.mjs";
import { loadPacketQuestionCapture } from "./questions.mjs";
import { packetCoverLetterProposalSchema } from "./schemas/packet-schemas.mjs";

const COVER_LABELS = Object.freeze({
  skill: "packet-engine",
  action: "draft-cover-letter",
  operation: "packet:cover-letter",
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

// The AI-prompt-visible projection of enumeratePacketSources(): confirmed
// evidence and reviewed context stay claimable, but raw/proposed deep-ingest
// material and unreviewed research (gapContext) never reach the model — only
// the source categories they came from do, as a gap listing (10-04-PLAN.md:
// raw/proposed material is gap context only, never prompt-visible prose).
export function buildPromptVisibleSources(context = {}, questionCapture = null) {
  const sources = enumeratePacketSources(context, questionCapture);
  const split = splitConfirmedAndProposedPacketSources(sources);
  return {
    candidateProfile: sources.candidateProfile,
    sourceResume: sources.sourceResume,
    resumeFacts: sources.resumeFacts,
    writingVoice: sources.writingVoice,
    honestyBoundaries: sources.honestyBoundaries,
    capturedJobBody: sources.capturedJobBody,
    capturedQuestions: sources.capturedQuestions,
    confirmedEvidence: { ...sources.confirmedEvidence, claims: split.claimableEvidence },
    confirmedContext: split.claimableContext,
    unconfirmedAreas: [...new Set(split.gapContext.map((item) => item.source))].sort(),
  };
}

function forbiddenFor(context = {}) {
  return forbiddenWordingFor(evidenceFromContext(context).claims, honestyFromContext(context));
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

export function validatePacketEvidenceIds({ context = {}, proposals = [] } = {}) {
  const allowed = new Set(evidenceFromContext(context).claims.map((claim) => String(claim.id)));
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
    const forbiddenHits = forbidden.filter((phrase) =>
      text.toLowerCase().includes(String(phrase).toLowerCase())
    );
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

function promptForCoverLetter(context = {}) {
  return [
    "Draft concise cover-letter prose blocks using only confirmed local evidence.",
    "Return JSON matching packetCoverLetterProposalSchema.",
    "",
    JSON.stringify(buildPromptVisibleSources(context), null, 2),
  ].join("\n");
}

function needsYouBlock(reason) {
  return {
    text: `NEEDS YOU: ${reason}`,
    evidenceIds: [],
    uploadReady: false,
    gap: reason,
  };
}

export async function draftCoverLetterBlocks({
  repoRoot,
  env = process.env,
  context = {},
  call,
  runAI = runBoundedAI,
} = {}) {
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
    messages: [{ role: "user", content: promptForCoverLetter(context) }],
    system:
      'Draft cover letter blocks. Every block must list at least one id from confirmedEvidence.claims in its evidenceIds array, and only ids from that list. If a block cannot be grounded in a listed claim, start its text with "NEEDS YOU:" and leave evidenceIds empty. Do not include private compensation or unconfirmed claims.',
    outputName: "packet_cover_letter_blocks",
    // A full multi-block letter plus JSON overhead regularly exceeds 1800
    // tokens; a mid-JSON max_tokens truncation parses as failure and the
    // whole draft degrades to a NEEDS YOU punt.
    maxTokens: 4000,
    root: repoRoot,
    env,
  });

  if (!aiResult.body?.ok) {
    return {
      blocks: [needsYouBlock(aiResult.body?.error?.message || "draft cover-letter proof")],
      uploadReady: false,
      ai: aiResult.body?.ai || { used: false },
      manual: { required: true, code: aiResult.body?.code || "PACKET_COVER_REVIEW" },
    };
  }

  const blocks = (aiResult.body.data?.blocks || []).map((block) => ({
    text: cleanText(block.text),
    evidenceIds: Array.isArray(block.evidenceIds) ? block.evidenceIds.map(String) : [],
  }));
  const validation = validatePacketEvidenceIds({
    context,
    proposals: blocks.map((block) => ({ kind: "coverLetter", ...block })),
  });
  // A block the model honestly marked NEEDS YOU is a confirmation gap, not a
  // contract violation — keep it (and the grounded blocks around it) inline,
  // the way the answers flow does. Only hard violations (missing/unknown
  // evidence IDs, private leaks, forbidden wording) discard the draft.
  const hardGaps = validation.gaps.filter((gap) => gap.message !== "user confirmation is required");
  if (!blocks.length || hardGaps.length) {
    return {
      blocks: [needsYouBlock(hardGaps[0]?.message || "confirm cover-letter evidence")],
      uploadReady: false,
      ai: aiResult.body.ai,
      manual: { required: true },
      gaps: validation.gaps,
    };
  }
  return {
    blocks,
    uploadReady: validation.ok,
    ai: aiResult.body.ai,
    manual: { required: !validation.ok },
    ...(validation.ok ? {} : { gaps: validation.gaps }),
  };
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
  answers,
  services = {},
  skipAnswers = false,
}) {
  const profile = profileFromContext(context);
  const evidence = evidenceFromContext(context);
  const honesty = honestyFromContext(context);
  const job = {
    ...(context.job || {}),
    frontmatter: {
      company: appFromContext(context).company || context.job?.frontmatter?.company || "",
      role: appFromContext(context).role || context.job?.frontmatter?.role || "",
      ...(context.job?.frontmatter || {}),
    },
  };
  const resume = (services.buildResumeMarkdown || buildResumeMarkdown)({
    profile,
    evidence,
    job,
    honesty,
  });
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
      const full = join(tailoredDir, `${base}-${key}.${format}`);
      const content = format === "pdf" ? `%PDF-1.4\n% Rolester packet artifact\n${body}\n` : body;
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
  context,
  questionCapture,
  answers,
  sources,
  sourceSplit,
  gaps,
  uploadReady,
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
  draftPacketAnswers = draftPacketAnswersCore,
  exportPacketArtifacts,
  coverLetterCall,
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
  const coverLetter = await coverDraft({
    repoRoot,
    env,
    context: packetContext,
    call: coverLetterCall,
  });
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
    answers,
    services,
    skipAnswers,
  });
  const validation = validatePacketEvidenceIds({
    context: packetContext,
    proposals: [
      ...(coverLetter.blocks || []).map((block) => ({ kind: "coverLetter", ...block })),
      // Deterministic disclosure answers (work auth / sponsorship / salary
      // floor / notice period) are structured facts sourced from onboarding,
      // not AI claims needing an evidence citation — and a disclosure salary
      // answer states the candidate's ask-side minimum_base floor, not
      // current compensation, so it must never be run through the
      // private-leak check either. Excluding them from proposals entirely
      // covers both.
      ...(answers.answers || [])
        .filter((answer) => !answer.disclosure)
        .map((answer) => ({
          kind: "answer",
          text: answer.answer,
          evidenceIds: answer.evidenceIds || [],
        })),
    ],
  });
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
    context: packetContext,
    questionCapture: capture,
    answers,
    sources: sourceMap,
    sourceSplit,
    gaps,
    uploadReady,
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
