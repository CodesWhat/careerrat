const STATIC_PREVIEW = import.meta.env.VITE_STATIC_PREVIEW === "true";

const PREVIEW_COMPANIES = [
  { name: "Sweetgreen", domain: "sweetgreen.com" },
  { name: "Anthropic", domain: "anthropic.com" },
  { name: "Ramp", domain: "ramp.com" },
  { name: "Stripe", domain: "stripe.com" },
  { name: "Glean", domain: "glean.com" },
  { name: "LangChain", domain: "langchain.com" },
  { name: "Juniper Square", domain: "junipersquare.com" },
  { name: "Hightouch", domain: "hightouch.com" },
  { name: "Perplexity", domain: "perplexity.ai" },
];

const DEFAULT_ONBOARD_STATE = {
  keyConfigured: true,
  sourceResumePresent: true,
  searchSourcesPresent: true,
  files: [
    { name: "profile", exists: true, valid: true },
    { name: "targeting", exists: true, valid: true },
    { name: "modes", exists: true, valid: true },
    { name: "form-defaults", exists: true, valid: true },
  ],
  data: {
    profile: {
      candidate: {
        full_name: "Sam Preview",
        email: "sam.preview@example.com",
        phone: "(555) 010-2048",
        location: "New York, NY",
        linkedin: "https://linkedin.com/in/sam-preview",
        github: "https://github.com/sampreview",
        portfolio: "https://sam-preview.example.com",
        headline: "Senior AI product engineer building production systems",
        domain: "Applied AI, developer tools, and product engineering",
      },
      compensation: { minimum_base: 190000 },
      location: { home: "New York, NY", remote: true },
    },
    targeting: {
      role_buckets: [
        {
          name: "Primary",
          priority: "primary",
          titles: ["Senior AI Developer", "Applied AI Engineer", "AI Product Engineer"],
          notes: "Production AI systems, product integration, evals, and user-facing automation.",
          fit_signals: [
            "production AI systems",
            "LLM implementation",
            "evals and evaluation loops",
          ],
          down_signals: ["frontend-only", "research-only"],
        },
      ],
      keep_signals: ["production AI systems", "developer tools", "measurable business outcomes"],
      cut_signals: ["Heavy travel", "Onsite-only", "Below comp floor"],
      tracked_companies: ["Anthropic", "Ramp", "Stripe", "Glean", "Sweetgreen"],
      search_preferences: { cadence: { mode: "daily", recommended_from: "default" } },
    },
    modes: {
      usage_mode: "standard",
      application_mode: "balanced",
      agent_voice: "standard",
    },
    "form-defaults": {
      auto_submit: false,
      eeo_default: "Prefer not to answer",
      linkedin: "https://linkedin.com/in/sam-preview",
      github: "https://github.com/sampreview",
      portfolio: "https://sam-preview.example.com",
      additional_links: [{ label: "Writing", url: "https://sam-preview.example.com/writing" }],
    },
    setup: {
      readiness: {
        search_ready: true,
        gate_ready: true,
        apply_ready: true,
        deep_ingest_complete: false,
      },
      missing: {
        search_ready: [],
        gate_ready: [],
        apply_ready: [],
        deep_ingest_complete: ["deeper evidence bank"],
      },
    },
    sourcing: {
      sourceSetup: {
        deterministicSources: { attempted: 3, rss: 1, supportedAtsCompanies: 2, skipped: 0 },
      },
      firstSearchRun: {
        status: "not_started",
        summary: { sourcesAttempted: 0, rolesFound: 0 },
      },
    },
  },
};

let previewState = clone(DEFAULT_ONBOARD_STATE);

export function isStaticPreviewApi() {
  return STATIC_PREVIEW;
}

export function getStaticPreviewAuthState() {
  return {
    hasClerkProvider: false,
    isLoaded: true,
    isSignedIn: true,
    user: {
      firstName: "Sam",
      fullName: "Sam Preview",
      id: "preview-user",
      primaryEmailAddress: { emailAddress: "sam.preview@example.com" },
    },
  };
}

export async function staticPreviewApiFetch(path, options = {}) {
  const url = new URL(path, "https://preview.rolester.local");
  const method = String(options.method || "GET").toUpperCase();

  if (url.pathname === "/api/onboard/state" && method === "GET") {
    syncReadiness();
    return clone(previewState);
  }

  if (url.pathname === "/api/onboard/init" && method === "POST") {
    previewState = clone(DEFAULT_ONBOARD_STATE);
    return { ok: true, preview: true };
  }

  if (url.pathname === "/api/onboard/draft") {
    return { draft: { stepIndex: 0, completedIndexes: [], draftSeeds: {}, updatedAt: null } };
  }

  if (url.pathname === "/api/runtime/config" && method === "GET") {
    return {
      ai: { available: false, route: "static-preview" },
      chatSkills: [],
      discovery: {
        chatHandoffs: false,
        companyProposals: true,
        manualCompanySeeds: true,
      },
      skills: [],
    };
  }

  if (url.pathname === "/api/onboard/resume" && method === "POST") {
    const seed = resumeSeedFromText(parseBody(options.body).text);
    applyResumeSeed(seed);
    return seed;
  }

  if (url.pathname === "/api/onboard/evidence-seed" && method === "POST") {
    previewState.data.evidence = parseBody(options.body).claims || [];
    return { ok: true, claims: previewState.data.evidence };
  }

  if (url.pathname.startsWith("/api/onboard/candidate/") && method === "POST") {
    const name = decodeURIComponent(url.pathname.split("/").pop() || "");
    const patch = parseBody(options.body).data || {};
    previewState.data[name] = mergeDeep(previewState.data[name] || {}, patch);
    markFileReady(name);
    syncReadiness();
    return { ok: true, data: clone(previewState.data[name]) };
  }

  if (url.pathname === "/api/onboard/write-config" && method === "POST") {
    previewState.searchSourcesPresent = true;
    syncReadiness();
    return {
      ok: true,
      written: [
        "candidate/profile.yml",
        "candidate/targeting.yml",
        "candidate/modes.yml",
        "config/search-sources.yml",
      ],
    };
  }

  if (url.pathname === "/api/logos/search" && method === "GET") {
    const query = url.searchParams.get("q") || "";
    return {
      ok: true,
      results: PREVIEW_COMPANIES.filter((company) =>
        `${company.name} ${company.domain}`.toLowerCase().includes(query.toLowerCase())
      ).slice(0, 6),
    };
  }

  if (url.pathname === "/api/assist/suggest" && method === "POST") {
    const body = parseBody(options.body);
    return {
      ok: true,
      data: {
        suggestions:
          body.kind === "titles"
            ? ["AI Platform Engineer", "Staff Applied AI Engineer", "Product AI Lead"]
            : ["production AI systems", "RAG", "agents", "model routing"],
      },
      manual: true,
    };
  }

  if (url.pathname === "/api/discovery/company-proposals") {
    return {
      data: {
        batch: {
          batchId: "preview-company-batch",
          proposals: PREVIEW_COMPANIES.slice(0, 5).map((company, index) => ({
            proposalId: `preview-company-${index}`,
            version: 1,
            company,
            roleSeen: index % 2 ? "AI Product Engineer" : "Applied AI Engineer",
            confidenceTier: index < 3 ? "High confidence" : "Medium confidence",
          })),
        },
      },
    };
  }

  if (url.pathname === "/api/discovery/company-proposal-decisions" && method === "POST") {
    return { data: { decision: "accepted" } };
  }

  if (url.pathname === "/api/boards/preview" && method === "POST") {
    return {
      linkedin: {
        label: "LinkedIn saved search",
        url: "https://www.linkedin.com/jobs/search/?keywords=Applied%20AI%20Engineer",
      },
      rss: {
        label: "YC Work at a Startup",
        url: "https://www.ycombinator.com/jobs",
      },
    };
  }

  if (url.pathname === "/api/boards/add" && method === "POST") {
    previewState.searchSourcesPresent = true;
    syncReadiness();
    return { ok: true };
  }

  if (url.pathname === "/api/sourcing/first-run/start" && method === "POST") {
    const run = {
      status: "completed",
      summary: {
        rolesFound: 7,
        sourcesAttempted: 5,
        cadenceRecommendation: { mode: "daily" },
      },
    };
    previewState.data.sourcing.firstSearchRun = run;
    previewState.data.firstSearchRun = run;
    return { run };
  }

  return { ok: true, preview: true };
}

export function staticPreviewResumeSeed(name = "preview-resume.pdf") {
  return resumeSeedFromText(`Preview resume uploaded from ${name}`);
}

function resumeSeedFromText(_text) {
  return {
    source: "ai",
    sections: { education: 1, experience: 4, other: 1, projects: 2, skills: 12 },
    profileSeed: {
      candidate: {
        full_name: "Sam Preview",
        email: "sam.preview@example.com",
        phone: "(555) 010-2048",
        location: "New York, NY",
        linkedin: "https://linkedin.com/in/sam-preview",
        github: "https://github.com/sampreview",
        portfolio: "https://sam-preview.example.com",
      },
    },
    evidenceSeed: {
      claims: [
        {
          claim: "Built production LLM workflows with eval loops",
          evidence: "Shipped routing and evaluation systems used by product teams.",
        },
        {
          claim: "Led cross-functional AI product launches",
          evidence: "Partnered with design, data, and platform teams from discovery to rollout.",
        },
      ],
    },
    targetingSeed: {
      role_buckets: DEFAULT_ONBOARD_STATE.data.targeting.role_buckets,
      keep_signals: DEFAULT_ONBOARD_STATE.data.targeting.keep_signals,
      tracked_companies: DEFAULT_ONBOARD_STATE.data.targeting.tracked_companies,
    },
  };
}

function applyResumeSeed(seed) {
  previewState.data.profile = mergeDeep(previewState.data.profile || {}, seed.profileSeed || {});
  previewState.data.targeting = mergeDeep(
    previewState.data.targeting || {},
    seed.targetingSeed || {}
  );
  previewState.sourceResumePresent = true;
  markFileReady("profile");
  syncReadiness();
}

function markFileReady(name) {
  const files = Array.isArray(previewState.files) ? previewState.files : [];
  if (!files.some((file) => file.name === name)) {
    files.push({ name, exists: true, valid: true });
  }
  previewState.files = files.map((file) =>
    file.name === name ? { ...file, exists: true, valid: true } : file
  );
}

function syncReadiness() {
  const targeting = previewState.data.targeting || {};
  const profile = previewState.data.profile || {};
  const hasTitles = (targeting.role_buckets || []).some((bucket) => bucket?.titles?.length);
  const hasCompanies = (targeting.tracked_companies || []).length > 0;
  const hasGuardrails = (targeting.cut_signals || []).length > 0;
  const hasCandidate = Boolean(profile.candidate?.full_name || profile.candidate?.email);
  const searchReady = Boolean(previewState.sourceResumePresent && hasTitles && hasCompanies);
  const gateReady = Boolean(searchReady && hasGuardrails);
  const applyReady = Boolean(gateReady && hasCandidate);

  previewState.data.setup = {
    readiness: {
      search_ready: searchReady,
      gate_ready: gateReady,
      apply_ready: applyReady,
      deep_ingest_complete: false,
    },
    missing: {
      search_ready: [
        previewState.sourceResumePresent ? "" : "source resume",
        hasTitles ? "" : "role titles",
        hasCompanies ? "" : "company targets",
      ].filter(Boolean),
      gate_ready: hasGuardrails ? [] : ["guardrails"],
      apply_ready: hasCandidate ? [] : ["profile basics"],
      deep_ingest_complete: ["deeper evidence bank"],
    },
  };
}

function parseBody(body) {
  if (!body) return {};
  if (typeof body === "string") {
    try {
      return JSON.parse(body);
    } catch {
      return {};
    }
  }
  return body;
}

function mergeDeep(current, patch) {
  if (!isPlainObject(current) || !isPlainObject(patch)) return clone(patch);
  const next = { ...current };
  for (const [key, value] of Object.entries(patch)) {
    next[key] =
      isPlainObject(value) && isPlainObject(next[key]) ? mergeDeep(next[key], value) : clone(value);
  }
  return next;
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}
