// Function-family lexicon for job-title adjacency. A title's "function" is the
// kind of work it names (frontend, design, program management, ...), as
// opposed to its seniority tier or its engineering/manager noun. The lexicon
// is deliberately field-neutral: each cluster is a set of words employers use
// interchangeably for one lane, and a target's clusters are derived from the
// words of its own titles rather than from a hard-coded job family.

const ENGINEERING_KINDS = new Set(["developer", "engineer", "engineering"]);

// `engineeringOnly` words count only when the title also names an engineering
// kind ("Design Engineer" is frontend work; "Design Lead" is design).
// `designOnly` words count only when it does not. `managerIsRole` marks
// lanes where "manager"/"lead" is the job noun, not a people-management tier
// ("Program Manager", "Delivery Manager").
const CLUSTERS = [
  {
    id: "web-frontend",
    words: ["frontend", "front", "ui", "web", "react", "vue", "angular", "svelte", "css"],
  },
  { id: "web-frontend", words: ["design", "ux"], engineeringOnly: true },
  {
    id: "backend-infra",
    words: [
      "backend",
      "server",
      "infrastructure",
      "cloud",
      "systems",
      "distributed",
      "storage",
      "compute",
      "observability",
      "reliability",
      "devops",
      "sre",
      "database",
      "databases",
    ],
  },
  { id: "mobile", words: ["mobile", "ios", "android"] },
  {
    id: "data",
    words: ["data", "analytics", "analyst", "ml"],
    phrases: ["machine learning"],
  },
  { id: "qa", words: ["qa", "sdet", "quality", "test"] },
  { id: "security", words: ["security", "cybersecurity", "appsec"] },
  {
    id: "design",
    words: ["design", "designer", "designers", "ux", "ui", "interaction", "experience"],
    designOnly: true,
  },
  {
    id: "program-ops",
    words: [
      "program",
      "project",
      "delivery",
      "implementation",
      "operations",
      "strategy",
      "transformation",
      "portfolio",
      "pmo",
      "bizops",
    ],
    phrases: ["chief of staff"],
    managerIsRole: true,
  },
  {
    id: "product-mgmt",
    words: [],
    phrases: ["product manager", "product management", "product owner", "product lead"],
  },
  {
    id: "sales",
    words: ["sales", "gtm", "revenue"],
    phrases: ["account executive", "business development"],
  },
  { id: "marketing", words: ["marketing", "seo", "content"] },
  { id: "recruiting", words: ["recruiter", "recruiting", "talent"] },
  { id: "support", words: ["support", "success"] },
  {
    id: "finance",
    words: ["accountant", "accounting", "finance", "financial", "controller"],
  },
  { id: "legal", words: ["legal", "counsel", "attorney", "paralegal"] },
];

function tokens(title) {
  return String(title || "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
}

/**
 * Function clusters a title belongs to, as a Map of cluster id to
 * `{ managerIsRole }`. Empty when the title names no known function.
 */
export function titleFunctionClusters(title) {
  const words = tokens(title);
  const set = new Set(words);
  const text = ` ${words.join(" ")} `;
  const engineering = words.some((word) => ENGINEERING_KINDS.has(word));
  const found = new Map();
  for (const cluster of CLUSTERS) {
    if (cluster.engineeringOnly && !engineering) continue;
    if (cluster.designOnly && engineering) continue;
    const hit =
      cluster.words.some((word) => set.has(word)) ||
      (cluster.phrases || []).some((phrase) => text.includes(` ${phrase} `));
    if (hit) found.set(cluster.id, { managerIsRole: cluster.managerIsRole === true });
  }
  return found;
}

/**
 * How an actual title's function relates to a target title's:
 *   "shared"   both name a function and at least one is common
 *   "conflict" both name a function and none is common (a different lane)
 *   "unknown"  one side names no known function, so function says nothing
 * `managerIsRole` is true when the shared lane treats "manager" as the job
 * noun rather than a people-management level.
 */
export function titleFunctionRelation(actualTitle, targetTitle) {
  const actual = titleFunctionClusters(actualTitle);
  const target = titleFunctionClusters(targetTitle);
  if (actual.size === 0 || target.size === 0) return { relation: "unknown", managerIsRole: false };
  const shared = [...target.keys()].filter((id) => actual.has(id));
  if (shared.length === 0) return { relation: "conflict", managerIsRole: false };
  return {
    relation: "shared",
    managerIsRole: shared.some((id) => target.get(id).managerIsRole),
  };
}
