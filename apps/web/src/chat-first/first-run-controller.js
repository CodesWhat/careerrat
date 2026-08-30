import { parseChatAnswerMode } from "../../../../src/core/ai/chat-answer-mode.mjs";
import { parseConfirmBlocks } from "../onboarding/confirmBlocks.js";
import { setupDisclosureRows, setupProgressFromState } from "../onboarding/onboardingSetup.js";
import { emptyAnnualCashWorksheet } from "./annual-cash-worksheet.js";

function list(value) {
  return Array.isArray(value) ? value : [];
}

const FIRST_ROLE_SUGGESTION = {
  id: "suggest:targets",
  label: "Staff SWE · ML infra",
};

const EXTRACTED_FACT_KINDS = new Set(["authorization", "candidate_patch", "evidence_claim"]);
const EXPLICIT_ACTION_LABELS = {
  consent_capability: ["Allow", "Not now"],
  consent_mode: ["Use this setup", "Keep current"],
  company_add: ["Add company", "Not now"],
  companies_suggest: ["Show suggestions", "Not now"],
};

const RUNTIME_PRESENTATION_LABELS = {
  ready: "Ready",
  auth_required: "Auth required",
  check_failed: "Needs a retry",
  unavailable: "Unavailable",
};

function normalizedRuntimeValue(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, "_")
    .replaceAll(/^_+|_+$/g, "");
}

export function runtimeIsSupported(runtime) {
  return runtime?.supported === true;
}

export function runtimePresentation(runtime = {}) {
  if (!runtimeIsSupported(runtime)) {
    return { state: "unavailable", label: RUNTIME_PRESENTATION_LABELS.unavailable };
  }
  const status = normalizedRuntimeValue(runtime.status);
  if (status === "authentication_required") {
    return {
      state: "auth_required",
      label: RUNTIME_PRESENTATION_LABELS.auth_required,
    };
  }
  if (status === "completion_probe_failed") {
    return {
      state: "check_failed",
      label: RUNTIME_PRESENTATION_LABELS.check_failed,
    };
  }

  const available =
    runtime.available === true || runtime.detected === true || runtime.ready === true;
  if (!available) {
    return {
      state: "unavailable",
      label: RUNTIME_PRESENTATION_LABELS.unavailable,
    };
  }
  if (runtime.ready === true && runtime.selectable === true) {
    return { state: "ready", label: RUNTIME_PRESENTATION_LABELS.ready };
  }
  return { state: "unavailable", label: RUNTIME_PRESENTATION_LABELS.unavailable };
}

function runtimeIsSelectable(runtime, presentation = runtimePresentation(runtime)) {
  return runtime?.ready === true && runtime?.selectable === true && presentation.state === "ready";
}

export function isFirstRunExtractedFact(block) {
  return EXTRACTED_FACT_KINDS.has(block?.kind);
}

export function runtimeSelectionReady(state) {
  if (state?.providerFallback === true) return false;
  const selectedId = String(state?.selectedId || "").trim();
  if (!selectedId) return false;
  return list(state?.runtimes).some(
    (runtime) => runtime?.id === selectedId && runtimeIsSelectable(runtime)
  );
}

export function firstRunRuntimeChoices(state) {
  const seen = new Set();
  return list(state?.runtimes)
    .flatMap((runtime) => {
      if (!runtime || typeof runtime !== "object" || Array.isArray(runtime)) return [];
      const id = String(runtime.id || "").trim();
      if (!id || seen.has(id)) return [];
      seen.add(id);
      return [{ ...runtime, id }];
    })
    .filter(runtimeIsSupported)
    .map((runtime) => {
      const presentation = runtimePresentation(runtime);
      return {
        id: runtime.id,
        name: String(runtime.name || runtime.id).trim() || runtime.id,
        detected: runtime.available === true || runtime.detected === true || runtime.ready === true,
        ready: runtime.ready === true,
        supported: true,
        selectable: runtimeIsSelectable(runtime, presentation),
        capabilities: runtime.capabilities,
        presentationState: presentation.state,
        presentationLabel: presentation.label,
        selected: runtime.id === state?.selectedId,
        status: runtime.status,
        action: runtime.action,
        actionLabel: runtime.actionLabel || null,
        probeMessage: runtime.probeMessage || null,
        installUrl: runtime.installUrl || null,
        capabilityReason: runtime.capabilityReason || null,
      };
    })
    .sort((left, right) => left.name.localeCompare(right.name) || left.id.localeCompare(right.id));
}

export function firstRunAgentName(state, fallback = "Paul") {
  return String(state?.data?.modes?.agent_name || fallback || "Paul").trim() || "Paul";
}

function displayLines(value) {
  const text = String(value || "").trim();
  if (!text || text === "Not provided") return [];
  return text
    .split(/\s+·\s+/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function lineValue(values) {
  return [
    ...new Set(
      list(values)
        .map((value) => String(value || "").trim())
        .filter(Boolean)
    ),
  ].join("\n");
}

function editorField(id, label, type, value = "", extra = {}) {
  return { id, label, type, value, ...extra };
}

const REMOTE_SCOPE_OPTIONS = [
  { value: "off", label: "Not open to remote roles" },
  { value: "home-country", label: "Remote within my home country" },
  { value: "worldwide", label: "Remote worldwide" },
];

function buildKnowledgeEditor(key, state) {
  const data = state?.data || {};
  const profile = data.profile || {};
  const candidate = profile.candidate || {};
  const targeting = data.targeting || {};
  const evidence = data.evidence || {};
  if (key === "engine") return { mode: "settings", fields: [] };
  if (key === "resume") {
    return {
      fields: [
        editorField("resumeText", "Resume text", "textarea", "", {
          placeholder: "Paste the complete updated resume text",
          rows: 12,
        }),
      ],
    };
  }
  if (key === "roles") {
    const roleBuckets = list(targeting.role_buckets).map((bucket) => ({
      ...bucket,
      titles: [...list(bucket?.titles)],
    }));
    return {
      roleBuckets,
      fields: (roleBuckets.length ? roleBuckets : [{ name: "Primary targets", titles: [] }]).map(
        (bucket, index) =>
          editorField(
            index === 0 ? "titles" : `titles:${index}`,
            roleBuckets.length > 1
              ? `${bucket.name || `Target lane ${index + 1}`} titles`
              : "Target role titles",
            "textarea",
            lineValue(bucket.titles),
            { placeholder: "One role title per line", rows: 5 }
          )
      ),
    };
  }
  if (key === "companies") {
    const preferences = targeting.company_preferences || {};
    const focus = [
      ...list(preferences.industries),
      ...list(preferences.organization_types),
      ...list(preferences.sizes),
      ...list(preferences.stages),
      ...list(preferences.business_models),
      ...list(preferences.values),
      ...list(preferences.geographies),
    ];
    return {
      fields: [
        editorField("focus", "Company focus", "textarea", lineValue(focus), {
          placeholder: "One industry, company type, size, stage, or value per line",
          rows: 5,
        }),
        editorField("examples", "Example companies", "textarea", lineValue(preferences.examples), {
          placeholder: "One example company per line",
          rows: 4,
        }),
      ],
    };
  }
  if (key === "evidence") {
    const claims = list(evidence.claims);
    return {
      existingClaimIds: claims.map((claim) => claim?.id).filter(Boolean),
      existingClaims: claims.map((claim) => ({ ...claim })),
      fields: [
        editorField(
          "claims",
          "Evidence claims",
          "textarea",
          claims
            .map((claim) =>
              [claim?.claim, claim?.evidence]
                .filter((value) => String(value || "").trim())
                .join(" :: ")
            )
            .filter(Boolean)
            .join("\n"),
          {
            placeholder: "One claim per line. Add supporting evidence after ::",
            rows: 9,
          }
        ),
      ],
    };
  }
  if (key === "guardrails") {
    return {
      fields: [
        editorField("signals", "Dealbreakers", "textarea", lineValue(targeting.cut_signals), {
          placeholder: "One dealbreaker per line",
          rows: 6,
        }),
      ],
    };
  }
  if (key === "quickFacts") {
    const location = profile.location || {};
    const minimumBase = Number(profile.compensation?.minimum_base);
    const minimumAnnualEarnings = Number(profile.compensation?.minimum_annual_earnings);
    const hasMinimumBase = Number.isFinite(minimumBase) && minimumBase > 0;
    const hasMinimumAnnualEarnings =
      Number.isFinite(minimumAnnualEarnings) && minimumAnnualEarnings > 0;
    const useAnnualCash = hasMinimumAnnualEarnings && !hasMinimumBase;
    const compensationFields = [
      editorField(
        "compensationFloorType",
        "How should CareerRat screen pay?",
        "select",
        hasMinimumBase && hasMinimumAnnualEarnings
          ? "both"
          : useAnnualCash
            ? "annual-cash"
            : "guaranteed-base",
        {
          options: [
            { value: "guaranteed-base", label: "Guaranteed base pay only" },
            { value: "annual-cash", label: "Annual cash earnings only" },
            { value: "both", label: "Keep both floors" },
          ],
        }
      ),
      editorField(
        "minimumBase",
        "Minimum guaranteed base pay",
        "number",
        hasMinimumBase ? String(minimumBase) : "",
        { min: "0", step: "1000" }
      ),
      editorField(
        "annualCashWorksheet",
        "Minimum annual cash earnings",
        "annual-cash-worksheet",
        emptyAnnualCashWorksheet(hasMinimumAnnualEarnings ? minimumAnnualEarnings : null),
        { currency: profile.compensation?.currency || "USD" }
      ),
    ];
    return {
      fields: [
        editorField("name", "Name", "text", candidate.full_name || ""),
        editorField("email", "Email", "email", candidate.email || ""),
        editorField("phone", "Phone", "text", candidate.phone || ""),
        editorField("home", "Home market", "text", location.home || candidate.location || ""),
        ...compensationFields,
        editorField(
          "remoteScope",
          "Remote job eligibility",
          "select",
          location.remote === true
            ? location.remote_scope === "worldwide"
              ? "worldwide"
              : "home-country"
            : "off",
          { options: REMOTE_SCOPE_OPTIONS }
        ),
        editorField("hybrid", "Hybrid", "checkbox", "", {
          checked: location.hybrid === true,
        }),
        editorField("onsite", "On-site", "checkbox", "", {
          checked: location.onsite === true,
        }),
      ],
    };
  }
  if (key === "authorization") {
    const authorization = profile.authorization || {};
    return {
      fields: [
        editorField("workAuthorized", "Authorized to work", "checkbox", "", {
          checked: authorization.work_authorized === true,
        }),
        editorField("requiresSponsorship", "Requires sponsorship", "checkbox", "", {
          checked: authorization.requires_sponsorship === true,
        }),
      ],
    };
  }
  return null;
}

export function buildFirstRunKnowledge(state, runtime) {
  const progressByKey = setupProgressFromState(state);
  const rows = setupDisclosureRows({ state, runtime });
  const items = list(state?.setupProgress?.items);
  const firstIncomplete = items.find((item) => item?.done !== true)?.key;
  return {
    progress: {
      completed: Number(state?.setupProgress?.completedCount) || 0,
      total: Number(state?.setupProgress?.total) || items.length,
    },
    items: items.map((item) => {
      const row = rows.find((candidate) => candidate.key === item.key);
      const done = progressByKey[item.key] === true;
      const lines = displayLines(row?.value);
      return {
        id: item.key,
        label: row?.label || item.key,
        status: done
          ? "complete"
          : lines.length > 0
            ? "populated"
            : item.key === firstIncomplete
              ? "active"
              : "pending",
        lines,
        editor: buildKnowledgeEditor(item.key, state),
        placeholder: done ? undefined : "comes next",
      };
    }),
  };
}

export function firstRunAssistantMessage(raw, id) {
  const parsedAnswer = parseChatAnswerMode(raw);
  const parsed = parseConfirmBlocks(parsedAnswer.text);
  const text = parsed.text;
  const blocks = parsed.blocks;
  const suggested =
    blocks.length === 0 && /what kind of role are you actually after/i.test(text)
      ? [FIRST_ROLE_SUGGESTION]
      : [];
  const options = blocks.length
    ? blocks.flatMap((block, index) =>
        isFirstRunExtractedFact(block)
          ? []
          : (EXPLICIT_ACTION_LABELS[block.kind] || []).map((label, actionIndex) => ({
              id: `${actionIndex === 0 ? "confirm" : "decline"}:${index}`,
              label,
            }))
      )
    : suggested;
  return {
    id,
    role: "assistant",
    text,
    blocks,
    ...(options.length === 0 && parsedAnswer.answerMode
      ? { answerMode: parsedAnswer.answerMode }
      : {}),
    options,
    allowTypedAnswer: true,
  };
}

function companyExamples(state) {
  return list(state?.data?.targeting?.company_preferences?.examples);
}

export async function applyFirstRunConfirmation(block, { api, state, onCompanyOperation } = {}) {
  if (block?.kind === "authorization") {
    await api.saveCandidateFile("profile", { authorization: block.patch });
    await api.saveCandidateFile("form-defaults", {
      work_authorization: block.patch.work_authorized ? "Yes" : "No",
      requires_sponsorship: block.patch.requires_sponsorship ? "Yes" : "No",
    });
    return "Work authorization saved";
  }
  if (block?.kind === "candidate_patch") {
    if (
      block.payload?.doc === "form-defaults" &&
      Object.hasOwn(block.payload?.patch || {}, "voluntary_self_identification")
    ) {
      throw new Error("Voluntary self-identification is owned by local Application defaults");
    }
    await api.saveCandidateFile(block.payload.doc, block.payload.patch);
    return "Saved";
  }
  if (block?.kind === "evidence_claim") {
    await api.saveEvidenceSeed([{ claim: block.payload.claim, evidence: block.payload.evidence }]);
    return "Evidence saved";
  }
  if (block?.kind === "companies_suggest") {
    const started = await api.createCompanyProposals({});
    if (started?.operation) onCompanyOperation?.(started.operation);
    return ["queued", "running"].includes(started?.operation?.status)
      ? "Finding company suggestions in the background"
      : "Company suggestions ready";
  }
  if (block?.kind === "company_add") {
    const preferences = state?.data?.targeting?.company_preferences || {};
    const examples = [...new Set([...companyExamples(state), block.payload.name])];
    await api.saveCandidateFile("targeting", {
      company_preferences: { ...preferences, confirmed: true, examples },
    });
    return `${block.payload.name} saved`;
  }
  if (block?.kind === "consent_mode") {
    await api.saveCandidateFile("automation", { setup_mode: block.payload });
    return block.payload === "advanced" ? "Advanced permissions ready" : "Basic permissions kept";
  }
  if (block?.kind === "consent_capability") {
    const { capability, platform } = block.payload;
    await api.saveCandidateFile("automation", {
      setup_mode: "advanced",
      capabilities: {
        [capability]: { enabled: true, platforms: { [platform]: true } },
      },
      consent: { [platform]: true },
    });
    return "Permission granted";
  }
  throw new Error(`Unsupported first-run confirmation: ${block?.kind || "unknown"}`);
}
