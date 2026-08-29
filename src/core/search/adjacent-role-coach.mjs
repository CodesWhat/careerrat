import { createHash } from "node:crypto";

import { createBinaryChoicePrompt, createChoicePrompt } from "../agent/choice-prompt.mjs";
import { runBoundedAI } from "../ai/bounded-ai.mjs";

const MIN_DIRECTIONS = 3;
const MAX_DIRECTIONS = 5;
const ROLE_FILTER_KEYS = [
  "title",
  "titleMismatch",
  "title-mismatch",
  "titleRelevance",
  "role",
  "roleRelevance",
  "relevance",
];

const adjacentRoleSchema = Object.freeze({
  type: "object",
  required: ["roles"],
  additionalProperties: false,
  properties: {
    roles: {
      type: "array",
      minItems: MIN_DIRECTIONS,
      maxItems: MAX_DIRECTIONS,
      items: {
        type: "object",
        required: ["title", "evidence_refs"],
        additionalProperties: false,
        properties: {
          title: { type: "string", minLength: 2, maxLength: 100 },
          evidence_refs: {
            type: "array",
            minItems: 1,
            maxItems: 3,
            items: { type: "string", minLength: 1, maxLength: 120 },
          },
        },
      },
    },
  },
});

const AI_LABELS = Object.freeze({
  skill: "search-jobs",
  action: "coach-adjacent-roles",
  operation: "coaching:adjacent-role-proposal",
});

const MANUAL_FALLBACK = Object.freeze({
  available: true,
  reason: "CareerRat can suggest directions from the candidate's saved evidence.",
  action: "Review the saved evidence and choose which directions to explore.",
});

function finiteCount(value, fallback = 0) {
  const count = Number(value);
  return Number.isFinite(count) && count >= 0 ? count : fallback;
}

function presentedCount(summary = {}) {
  return finiteCount(summary.presented ?? summary.new ?? summary.qualified, 0);
}

function scannedCount(summary = {}) {
  return finiteCount(
    summary.reconciled ?? summary.scanned ?? summary.offerCount ?? summary.found,
    0
  );
}

function attemptedCount(summary = {}) {
  return finiteCount(summary.attemptedSources ?? summary.searched, 0);
}

function roleFilteredCount(summary = {}) {
  const counts = summary.reasonCounts;
  if (!counts || typeof counts !== "object" || Array.isArray(counts)) return 0;
  return Math.max(...ROLE_FILTER_KEYS.map((key) => finiteCount(counts[key], 0)));
}

function optionalNumber(value) {
  if (value === null || value === undefined || String(value).trim() === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function cleanCompletion(run) {
  const summary = run?.summary;
  if (run?.status !== "completed" || !summary || typeof summary !== "object") return false;
  if (run.error) return false;
  if (finiteCount(summary.errorCount, 0) > 0) return false;
  if (Array.isArray(summary.errors) && summary.errors.length > 0) return false;
  return attemptedCount(summary) > 0 || scannedCount(summary) > 0;
}

export function adjacentRoleCoachingTrigger(run) {
  if (!cleanCompletion(run)) return null;
  const summary = run.summary;
  const presented = presentedCount(summary);
  const scanned = scannedCount(summary);
  const roleFiltered = roleFilteredCount(summary);
  if (presented === 0) return { kind: "zero-result", presented, scanned, roleFiltered };
  const clearlyRoleNarrow =
    presented <= 1 &&
    scanned >= 20 &&
    roleFiltered >= 15 &&
    roleFiltered / Math.max(1, scanned) >= 0.6;
  return clearlyRoleNarrow ? { kind: "over-narrow", presented, scanned, roleFiltered } : null;
}

function cleanLine(value, max = 240) {
  const text = String(value ?? "")
    .replace(/```[\s\S]*?```/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return text.length <= max ? text : `${text.slice(0, Math.max(1, max - 1)).trimEnd()}…`;
}

function normalizeTitle(value) {
  return cleanLine(value, 100)
    .replace(/[.!?]+$/g, "")
    .trim();
}

function titleKey(value) {
  return normalizeTitle(value).toLocaleLowerCase("en-US");
}

function roleFamilyKey(value) {
  const levelWords = new Set([
    "assistant",
    "associate",
    "chief",
    "coordinator",
    "director",
    "head",
    "junior",
    "lead",
    "manager",
    "principal",
    "senior",
    "supervisor",
  ]);
  return titleKey(value)
    .replace(/&/g, " and ")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .split(" ")
    .filter((word) => word && word !== "and" && !levelWords.has(word))
    .join(" ");
}

function titleCase(value) {
  const text = String(value || "")
    .trim()
    .replace(/\s+/g, " ")
    .toLocaleLowerCase("en-US");
  return text ? `${text[0].toLocaleUpperCase("en-US")}${text.slice(1)}` : "";
}

function roleTitleFromSignal(signal) {
  const text = cleanLine(signal, 90).replace(/[.!?]+$/g, "");
  if (!text) return "";
  const titled = titleCase(text);
  return /\b(?:role|roles|operations|management|coordination|support|enablement|leadership|sales|service|logistics|training)$/i.test(
    text
  )
    ? titled
    : `${titled} roles`;
}

function candidateEvidence(config = {}) {
  return (Array.isArray(config.evidence?.claims) ? config.evidence.claims : [])
    .map((claim) => ({
      id: cleanLine(claim?.id, 120),
      claim: cleanLine(claim?.claim, 220),
      evidence: cleanLine(claim?.evidence, 300),
      roleSignals: (Array.isArray(claim?.role_signals) ? claim.role_signals : [])
        .map((signal) => cleanLine(signal, 90))
        .filter(Boolean)
        .slice(0, 8),
    }))
    .filter((claim) => claim.id && claim.claim && claim.evidence);
}

function targetedTitleKeys(config = {}) {
  const exact = new Set();
  const families = new Set();
  for (const bucket of config.targeting?.role_buckets || []) {
    for (const title of bucket?.titles || []) {
      const key = titleKey(title);
      const family = roleFamilyKey(title);
      if (key) exact.add(key);
      if (family) families.add(family);
    }
  }
  return { exact, families };
}

function roleId(title) {
  return `role-${createHash("sha256").update(titleKey(title)).digest("hex").slice(0, 16)}`;
}

function roleWhy(title, claims) {
  const claim = claims[0];
  const text = claim
    ? `Your experience with “${claim.claim}” is the clearest bridge into ${title}.`
    : `This direction is grounded in experience already saved in your profile.`;
  return cleanLine(text, 220);
}

function normalizeRole({ title, evidenceRefs }, { claimsById, existing, used }) {
  const cleanTitle = normalizeTitle(title);
  const key = titleKey(cleanTitle);
  const family = roleFamilyKey(cleanTitle);
  if (
    !cleanTitle ||
    existing.exact.has(key) ||
    (family && existing.families.has(family)) ||
    used.has(key)
  ) {
    return null;
  }
  const refs = [...new Set((Array.isArray(evidenceRefs) ? evidenceRefs : []).map(String))]
    .filter((id) => claimsById.has(id))
    .slice(0, 3);
  if (!refs.length) return null;
  used.add(key);
  const claims = refs.map((id) => claimsById.get(id));
  return {
    id: roleId(cleanTitle),
    title: cleanTitle,
    why: roleWhy(cleanTitle, claims),
    evidenceRefs: refs,
  };
}

function fallbackRoles({ claims, existing, used }) {
  const claimsById = new Map(claims.map((claim) => [claim.id, claim]));
  const roles = [];
  for (const claim of claims) {
    for (const signal of claim.roleSignals) {
      const role = normalizeRole(
        { title: roleTitleFromSignal(signal), evidenceRefs: [claim.id] },
        { claimsById, existing, used }
      );
      if (role) roles.push(role);
      if (roles.length >= MAX_DIRECTIONS) return roles;
    }
  }
  return roles;
}

function proposalId(runId, roles) {
  return `adjacent-${createHash("sha256")
    .update(`${String(runId || "search")}\0${roles.map((role) => role.id).join("\0")}`)
    .digest("hex")
    .slice(0, 20)}`;
}

function explanationFor(trigger) {
  return trigger.kind === "over-narrow"
    ? "This search found very little because most roles missed the title filter. Your experience points to a few nearby directions that may fit better."
    : "This search found no matches, but that does not mean there is no good work for you. The search may be too narrow, and your saved experience points to a few nearby directions.";
}

function promptContext(config, trigger, claims) {
  const compensation = config.profile?.compensation || {};
  const location = config.profile?.location || {};
  return {
    search: trigger,
    candidate: {
      headline: cleanLine(config.profile?.candidate?.headline, 200),
      domain: cleanLine(config.profile?.candidate?.domain, 120),
    },
    location: {
      home: cleanLine(location.home, 160),
      remote: location.remote === true,
      remote_scope: cleanLine(location.remote_scope, 40),
      hybrid: location.hybrid === true,
      onsite: location.onsite === true,
      relocation: (Array.isArray(location.relocation) ? location.relocation : [])
        .map((value) => cleanLine(value, 160))
        .filter(Boolean),
    },
    compensation: {
      currency: cleanLine(compensation.currency || "USD", 20),
      minimum_base: optionalNumber(compensation.minimum_base),
      target_base: optionalNumber(compensation.target_base),
      target_total_comp: optionalNumber(compensation.target_total_comp),
    },
    currentTargets: (config.targeting?.role_buckets || []).map((bucket) => ({
      name: cleanLine(bucket?.name, 100),
      priority: cleanLine(bucket?.priority, 40),
      titles: (bucket?.titles || []).map((title) => cleanLine(title, 100)).filter(Boolean),
    })),
    evidence: claims.map(({ id, claim, evidence, roleSignals }) => ({
      id,
      claim,
      evidence,
      role_signals: roleSignals,
    })),
  };
}

export async function generateAdjacentRoleProposal({
  repoRoot,
  env = process.env,
  run,
  config = {},
  call,
  runAI = runBoundedAI,
  signal,
} = {}) {
  const trigger = adjacentRoleCoachingTrigger(run);
  if (!trigger) {
    const error = new Error("This search does not need adjacent-role coaching.");
    error.code = "ADJACENT_ROLE_COACHING_NOT_APPLICABLE";
    throw error;
  }
  const claims = candidateEvidence(config);
  const claimsById = new Map(claims.map((claim) => [claim.id, claim]));
  const existing = targetedTitleKeys(config);
  const used = new Set();
  const context = promptContext(config, trigger, claims);
  const aiResult = await runAI({
    labels: AI_LABELS,
    schema: adjacentRoleSchema,
    manual: MANUAL_FALLBACK,
    structuredMode: "native-preferred",
    maxRetries: 0,
    outputName: "adjacent_role_proposal",
    maxTokens: 1200,
    root: repoRoot,
    env,
    call,
    aiOperation: "coach.deep",
    signal,
    system:
      "You are a practical career coach. Use natural, conversational plain English. Suggest credible adjacent role directions using only the saved evidence provided. Return only the requested structured response.",
    messages: [
      {
        role: "user",
        content: [
          "Suggest three to five adjacent role directions that are not already in currentTargets.",
          "Every suggestion must cite one to three evidence ids from the supplied evidence. Do not invent experience, qualifications, or a provider-specific capability.",
          JSON.stringify(context),
        ].join("\n\n"),
      },
    ],
  });

  const aiRoles = aiResult.body?.ok
    ? (aiResult.body.data?.roles || []).flatMap((role) => {
        const normalized = normalizeRole(
          { title: role?.title, evidenceRefs: role?.evidence_refs },
          { claimsById, existing, used }
        );
        return normalized ? [normalized] : [];
      })
    : [];
  const fallback = aiRoles.length < MIN_DIRECTIONS ? fallbackRoles({ claims, existing, used }) : [];
  const roles = [...aiRoles, ...fallback].slice(0, MAX_DIRECTIONS);
  if (roles.length < MIN_DIRECTIONS) {
    const error = new Error(
      "I do not have enough saved evidence to suggest new directions yet. Tell me about work you have done well, and I can help broaden the search."
    );
    error.code = "ADJACENT_ROLE_EVIDENCE_TOO_THIN";
    throw error;
  }
  return {
    id: proposalId(run?.id, roles),
    version: 1,
    searchRunId: String(run?.id || ""),
    trigger,
    explanation: explanationFor(trigger),
    roles,
    source: aiRoles.length >= MIN_DIRECTIONS ? "ai" : "saved-evidence",
    ai: aiResult.body?.ai || { used: false },
  };
}

function proposalRoles(proposal) {
  const roles = Array.isArray(proposal?.roles) ? proposal.roles : [];
  if (roles.length < MIN_DIRECTIONS || roles.length > MAX_DIRECTIONS) {
    const error = new Error("CareerRat could not build a useful set of role directions.");
    error.code = "BAD_ADJACENT_ROLE_PROPOSAL";
    throw error;
  }
  return roles;
}

export function adjacentRoleChoiceQuestion(proposal) {
  return `${cleanLine(proposal?.explanation, 600)}\n\nWhich directions sound worth exploring?`;
}

export function buildAdjacentRoleChoicePrompt({ proposal, threadId, messageId } = {}) {
  const roles = proposalRoles(proposal);
  const question = adjacentRoleChoiceQuestion(proposal);
  return createChoicePrompt(
    {
      threadId,
      messageId,
      question,
      mode: "multi",
      minSelections: 1,
      maxSelections: roles.length,
      allowText: true,
      submitLabel: "Talk about these",
      options: roles.map((role) => ({
        id: role.id,
        label: role.title,
        description: role.why,
        aliases: [],
      })),
    },
    {
      actionRefs: Object.fromEntries(
        roles.map((role) => [role.id, { type: "chat.reply", input: { text: role.title } }])
      ),
    }
  );
}

function adjacentRoleConfirmationQuestion({ proposal, selectedRoleIds } = {}) {
  const selected = new Set((Array.isArray(selectedRoleIds) ? selectedRoleIds : []).map(String));
  const roles = proposalRoles(proposal).filter((role) => selected.has(role.id));
  if (!roles.length) {
    const error = new Error("Choose at least one role direction first.");
    error.code = "BAD_ADJACENT_ROLE_SELECTION";
    throw error;
  }
  const labels = roles.map((role) => role.title);
  const joined =
    labels.length === 1 ? labels[0] : `${labels.slice(0, -1).join(", ")} and ${labels.at(-1)}`;
  return `You picked ${joined}. Should I add ${labels.length === 1 ? "it" : "those"} as stretch targets and run a new search?`;
}

export function buildAdjacentRoleConfirmationPrompt({
  proposal,
  selectedRoleIds,
  threadId,
  messageId,
} = {}) {
  return createBinaryChoicePrompt({
    threadId,
    messageId,
    question: adjacentRoleConfirmationQuestion({ proposal, selectedRoleIds }),
  });
}

export function mergeAdjacentRoleTargets({ targeting = {}, roles = [] } = {}) {
  const roleBuckets = (Array.isArray(targeting.role_buckets) ? targeting.role_buckets : []).map(
    (bucket) => ({
      ...bucket,
      titles: Array.isArray(bucket?.titles) ? [...bucket.titles] : [],
    })
  );
  const existing = new Set(
    roleBuckets.flatMap((bucket) => bucket.titles.map((title) => titleKey(title))).filter(Boolean)
  );
  const added = [];
  for (const role of Array.isArray(roles) ? roles : []) {
    const title = normalizeTitle(role?.title);
    const key = titleKey(title);
    if (!title || !key || existing.has(key)) continue;
    existing.add(key);
    added.push(title);
  }
  if (!added.length) return { roleBuckets, added };
  let exploration = roleBuckets.find(
    (bucket) => String(bucket?.name || "").toLocaleLowerCase("en-US") === "career exploration"
  );
  if (!exploration) {
    exploration = {
      name: "Career exploration",
      priority: "stretch",
      titles: [],
      notes: "Candidate-confirmed adjacent directions from career coaching.",
    };
    roleBuckets.push(exploration);
  }
  exploration.titles.push(...added);
  return { roleBuckets, added };
}
