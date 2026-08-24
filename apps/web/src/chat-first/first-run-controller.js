import { parseConfirmBlocks } from "../onboarding/confirmBlocks.js";
import { setupDisclosureRows, setupProgressFromState } from "../onboarding/onboardingSetup.js";

function list(value) {
  return Array.isArray(value) ? value : [];
}

const FIRST_ROLE_SUGGESTION = {
  id: "suggest:targets",
  label: "Staff SWE · ML infra",
};

const FIRST_RUN_RUNTIME_PRIORITY = new Map([
  ["claude", 0],
  ["codex", 1],
]);
const EXTRACTED_FACT_KINDS = new Set(["authorization", "candidate_patch", "evidence_claim"]);
const EXPLICIT_ACTION_LABELS = {
  consent_capability: ["Allow", "Not now"],
  consent_mode: ["Use this setup", "Keep current"],
  company_add: ["Add company", "Not now"],
  companies_suggest: ["Show suggestions", "Not now"],
};

export function isFirstRunExtractedFact(block) {
  return EXTRACTED_FACT_KINDS.has(block?.kind);
}

export function runtimeSelectionReady(state) {
  if (state?.providerFallback === true) return true;
  const selectedId = String(state?.selectedId || "").trim();
  if (!selectedId) return false;
  return list(state?.runtimes).some(
    (runtime) => runtime?.id === selectedId && runtime?.ready === true
  );
}

export function firstRunRuntimeChoices(state) {
  return list(state?.runtimes)
    .sort(
      (left, right) =>
        (FIRST_RUN_RUNTIME_PRIORITY.get(left.id) ?? 2) -
        (FIRST_RUN_RUNTIME_PRIORITY.get(right.id) ?? 2)
    )
    .map((runtime) => ({
      id: runtime.id,
      name: runtime.name,
      detected: runtime.available === true,
      ready: runtime.ready === true,
      selected: runtime.id === state?.selectedId,
      recommended: runtime.id === "claude",
      status: runtime.status,
      action: runtime.action,
    }));
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
    return {
      fields: [
        editorField(
          "titles",
          "Target role titles",
          "textarea",
          lineValue(list(targeting.role_buckets).flatMap((bucket) => list(bucket?.titles))),
          { placeholder: "One role title per line", rows: 5 }
        ),
      ],
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
          { placeholder: "One claim per line. Add supporting evidence after ::", rows: 9 }
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
    return {
      fields: [
        editorField("name", "Name", "text", candidate.full_name || ""),
        editorField("email", "Email", "email", candidate.email || ""),
        editorField("phone", "Phone", "text", candidate.phone || ""),
        editorField("home", "Home market", "text", location.home || candidate.location || ""),
        editorField(
          "minimumBase",
          "Minimum base salary",
          "number",
          Number.isFinite(minimumBase) && minimumBase > 0 ? String(minimumBase) : "",
          { min: "0", step: "1000" }
        ),
        editorField("remote", "Remote", "checkbox", "", { checked: location.remote === true }),
        editorField("hybrid", "Hybrid", "checkbox", "", { checked: location.hybrid === true }),
        editorField("onsite", "On-site", "checkbox", "", { checked: location.onsite === true }),
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
  const { text, blocks } = parseConfirmBlocks(raw);
  const suggested =
    blocks.length === 0 && /what kind of role are you actually after/i.test(text)
      ? [FIRST_ROLE_SUGGESTION]
      : [];
  return {
    id,
    role: "assistant",
    text,
    blocks,
    options: blocks.length
      ? blocks.flatMap((block, index) =>
          isFirstRunExtractedFact(block)
            ? []
            : (EXPLICIT_ACTION_LABELS[block.kind] || []).map((label, actionIndex) => ({
                id: `${actionIndex === 0 ? "confirm" : "decline"}:${index}`,
                label,
              }))
        )
      : suggested,
    allowTypedAnswer: true,
  };
}

function companyExamples(state) {
  return list(state?.data?.targeting?.company_preferences?.examples);
}

export async function applyFirstRunConfirmation(block, { api, state } = {}) {
  if (block?.kind === "authorization") {
    await api.saveCandidateFile("profile", { authorization: block.patch });
    await api.saveCandidateFile("form-defaults", {
      work_authorization: block.patch.work_authorized ? "Yes" : "No",
      requires_sponsorship: block.patch.requires_sponsorship ? "Yes" : "No",
    });
    return "Work authorization saved";
  }
  if (block?.kind === "candidate_patch") {
    await api.saveCandidateFile(block.payload.doc, block.payload.patch);
    return "Saved";
  }
  if (block?.kind === "evidence_claim") {
    await api.saveEvidenceSeed([{ claim: block.payload.claim, evidence: block.payload.evidence }]);
    return "Evidence saved";
  }
  if (block?.kind === "companies_suggest") {
    await api.createCompanyProposals({});
    return "Company suggestions ready";
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
      capabilities: { [capability]: { enabled: true, platforms: { [platform]: true } } },
      consent: { [platform]: true },
    });
    return "Permission granted";
  }
  throw new Error(`Unsupported first-run confirmation: ${block?.kind || "unknown"}`);
}
