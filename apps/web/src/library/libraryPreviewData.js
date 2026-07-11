// apps/web/src/library/libraryPreviewData.js — dev-only fallback data for
// LibraryPage.jsx, shown when the live dashboard snapshot carries no
// library content (see hasLibraryContent()/libraryForNext() there) or no
// per-job document artifacts (see hasDocumentContent()/documentsForNext()).
// Shaped like buildLibrarySnapshot()/buildSnapshotFromDeepIngest()'s real
// output (src/core/tracker/library-snapshot.mjs) and jobDetailFromRow()'s
// `artifacts` list (src/core/tracker/dashboard-data.js). `metrics` carries
// only the honesty/roleSignals fields the page still reads (to decide
// whether to show the deep-ingest-only type filters) — the index/filters/
// readiness/gaps/storyLanes fields the old scoreboard and summary panels
// consumed are gone along with that UI.

export const PREVIEW_LIBRARY = {
  preview: true,
  metrics: {
    claims: 18,
    stories: 12,
    voice: 1,
    honesty: 3,
    roleSignals: 4,
    gaps: 2,
  },
  cards: [
    {
      id: "preview-ai-proof",
      kind: "evidence",
      label: "Evidence",
      title: "Production AI systems proof",
      summary:
        "Built production AI systems with routing, evaluation loops, and measurable business outcomes.",
      note: "Use for applied AI engineer, AI platform, and enterprise AI interviews.",
      tags: [
        { label: "Applied AI", tone: "teal" },
        { label: "Metrics", tone: "gold" },
      ],
    },
    {
      id: "preview-hightouch-story",
      kind: "story",
      label: "STAR Story",
      title: "AI productivity rollout",
      summary:
        "Turned a messy internal workflow into an AI-assisted loop with human review and clear adoption metrics.",
      note: "Best for product-minded engineering rounds and manager screens.",
      tags: [
        { label: "Applied AI", tone: "teal" },
        { label: "Leadership", tone: "plum" },
      ],
    },
    {
      id: "preview-platform-story",
      kind: "story",
      label: "STAR Story",
      title: "Platform migration leadership",
      summary:
        "Led a platform migration without breaking delivery by staging risk, measuring regressions, and aligning teams.",
      note: "Use when the role asks for systems ownership, migrations, or cross-team execution.",
      tags: [
        { label: "Platform", tone: "sky" },
        { label: "Leadership", tone: "plum" },
      ],
    },
    {
      id: "preview-voice",
      kind: "voice",
      label: "Writing voice",
      title: "Direct, evidence-first application voice",
      summary:
        "Concise, specific, and outcome-led. Avoids hype and keeps claims tied to proof already in the bank.",
      note: "Use as a guardrail when tailoring resumes, cover letters, and recruiter replies.",
      tags: [
        { label: "Concise", tone: "plum" },
        { label: "Honest edge", tone: "gold" },
      ],
    },
    {
      id: "preview-comp-proof",
      kind: "evidence",
      label: "Evidence",
      title: "Senior scope and ownership",
      summary:
        "Owned ambiguous technical problems end to end, created decision clarity, and reduced operational drag.",
      note: "Good support for senior/staff leveling conversations.",
      tags: [
        { label: "Leadership", tone: "plum" },
        { label: "Platform", tone: "sky" },
      ],
    },
    {
      id: "preview-honesty-degree",
      kind: "honesty",
      label: "Honesty boundary",
      title: "No formal CS degree",
      summary: "Confirmed boundary: never imply a completed CS degree in outbound copy.",
      note: "Use this boundary before outbound reuse.",
      tags: [
        { label: "Education", tone: "coral" },
        { label: "Confirmed", tone: "teal" },
      ],
    },
    {
      id: "preview-role-signal-platform",
      kind: "role_signal",
      label: "Role signal",
      title: "Platform engineering: keep",
      summary: "Confirmed fit for platform/infra-leaning applied AI roles.",
      note: "Use for keep/cut role matching.",
      tags: [
        { label: "Platform", tone: "plum" },
        { label: "Keep", tone: "teal" },
      ],
    },
  ],
};

// Mirrors the SHAPE of jobDetailFromRow()'s `artifacts` list
// (dashboard-data.js:3861-3875) once flattened across jobs by
// collectLibraryDocuments() in LibraryPage.jsx — one entry per
// artifact, carrying the parent job's company/role/detailId the real
// per-job gather attaches.
export const PREVIEW_DOCUMENTS = [
  {
    id: "preview-doc-juniper-resume",
    kind: "Resume",
    note: "resume-juniper-square-senior-applied-ai-engineer.pdf",
    company: "Juniper Square",
    role: "Senior Applied AI Engineer",
    detailId: "preview-juniper",
  },
  {
    id: "preview-doc-juniper-cover",
    kind: "Cover letter",
    note: "cover-letter-juniper-square.pdf",
    company: "Juniper Square",
    role: "Senior Applied AI Engineer",
    detailId: "preview-juniper",
  },
  {
    id: "preview-doc-notion-resume",
    kind: "Resume",
    note: "resume-notion-applied-ai-engineer.pdf",
    company: "Notion",
    role: "Applied AI Engineer",
    detailId: "preview-notion",
  },
  {
    id: "preview-doc-notion-jd",
    kind: "Job description",
    note: "Source link is available from the drawer header.",
    company: "Notion",
    role: "Applied AI Engineer",
    detailId: "preview-notion",
  },
  {
    id: "preview-doc-greenhouse-resume",
    kind: "Resume",
    note: "resume-greenhouse-senior-ai-platform-engineer.pdf",
    company: "Greenhouse",
    role: "Senior AI Platform Engineer",
    detailId: "preview-greenhouse",
  },
  {
    id: "preview-doc-stripe-cover",
    kind: "Cover letter",
    note: "cover-letter-stripe-ai-product-engineer.pdf",
    company: "Stripe",
    role: "AI Product Engineer",
    detailId: "preview-stripe",
  },
];
