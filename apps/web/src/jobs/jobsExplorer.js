export const SORT_KEYS = ["action", "company", "role", "base", "mode", "fit", "stage", "applied"];

export const DEFAULT_EXPLORER_STATE = {
  stage: "all",
  query: "",
  view: "table",
  showTerminal: false,
  sortKey: "fit",
  sortDir: -1,
  funnelCollapsed: false,
  showGhosted: false,
  hideStale: false,
  action: "all",
  mode: "all",
  source: "all",
  minComp: "",
  minFit: "",
  reviewOnly: false,
};

const ALLOWED = {
  view: new Set(["table", "cards"]),
  mode: new Set(["all", "remote", "hybrid", "onsite", "relo"]),
  source: new Set(["all", "referral", "recruiter", "board", "portal", "sourced"]),
  action: new Set([
    "all",
    "needs-action",
    "interview",
    "stale",
    "ghosted",
    "missing-comp",
    "high-fit",
    "watch",
    "review",
  ]),
  sortKey: new Set(SORT_KEYS),
};

const STAGE_ORDER = {
  sourced: 0,
  "reviewed-hold": 0.5,
  "manual-apply": 1,
  applied: 1,
  screen: 2,
  interview: 2.1,
  assessment: 2.3,
  technical: 2.5,
  "hiring-manager": 2.7,
  onsite: 3,
  final: 4,
  offer: 5,
  accepted: 6,
  rejected: 90,
  withdrawn: 91,
};

const ACTION_ORDER = {
  "needs-action": 0,
  interview: 1,
  "missing-comp": 2,
  ghosted: 3,
  stale: 4,
  review: 5,
  "high-fit": 6,
  watch: 7,
  active: 8,
  archived: 90,
};

const NAMED_STAGE_FILTERS = new Set([
  "screen",
  "interview",
  "assessment",
  "technical",
  "hiring-manager",
  "onsite",
  "final",
  "offer",
  "accepted",
]);

function toFiniteNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function cleanNumberString(value, max) {
  const number = Number(String(value || "").trim());
  if (!Number.isFinite(number) || number <= 0) return "";
  return String(Math.min(max, Math.round(number)));
}

function isApplication(row) {
  return row?.source === "application";
}

function rowCompK(row) {
  const base = Number(row?.baseK);
  if (Number.isFinite(base) && base > 0) return base;
  const midpoint = Number(row?.compMidpointK);
  return Number.isFinite(midpoint) && midpoint > 0 ? midpoint : 0;
}

export function stageOrder(stage) {
  return STAGE_ORDER[stage] ?? 0;
}

export function rowMatchesStage(row, stage = "all", options = {}) {
  const selectedStage = stage || "all";
  const showTerminal = Boolean(options.showTerminal);

  if (selectedStage === "all") return showTerminal || !row?.terminal;
  if (selectedStage.startsWith("src-")) {
    return isApplication(row) && row?.sourceBucket === selectedStage;
  }
  if (selectedStage === "awaiting") {
    return isApplication(row) && !row?.terminal && stageOrder(row?.stage) < 2;
  }
  if (selectedStage === "heardback") {
    return isApplication(row) && (row?.terminal || stageOrder(row?.stage) >= 2);
  }
  if (selectedStage === "terminal") return isApplication(row) && Boolean(row?.terminal);
  if (selectedStage === "stale") return isApplication(row) && Boolean(row?.stale);
  if (selectedStage === "ghosted") return isApplication(row) && Boolean(row?.ghosted);
  if (selectedStage.startsWith("reached-")) {
    return isApplication(row) && row?.sankeyStage === selectedStage.slice("reached-".length);
  }
  if (NAMED_STAGE_FILTERS.has(selectedStage)) {
    return (
      isApplication(row) && !row?.terminal && stageOrder(row?.stage) >= stageOrder(selectedStage)
    );
  }
  if (!showTerminal && row?.terminal) return false;
  return row?.stage === selectedStage;
}

export function rowMatchesFilters(row, filters = {}) {
  const state = sanitizeExplorerState(filters);

  if (state.stage !== "ghosted" && !state.showGhosted && row?.ghosted) return false;
  if (state.stage !== "stale" && state.hideStale && row?.stale) return false;
  if (!rowMatchesStage(row, state.stage, { showTerminal: state.showTerminal })) return false;

  if (state.query) {
    const haystack = String(row?.searchText || "").toLowerCase();
    if (!haystack.includes(state.query)) return false;
  }
  if (state.mode !== "all" && row?.mode !== state.mode) return false;
  if (state.source !== "all") {
    if (state.source === "sourced") {
      if (row?.source !== "sourced") return false;
    } else if (row?.channel !== state.source) {
      return false;
    }
  }
  if (state.action !== "all") {
    if (state.action === "high-fit") {
      if (!row?.highFit) return false;
    } else if (state.action === "review") {
      if (!row?.needsReview) return false;
    } else if (state.action === "interview") {
      if (!row?.interviewPath) return false;
    } else if (row?.actionState !== state.action && row?.workstream !== state.action) {
      return false;
    }
  }
  if (state.reviewOnly && !row?.needsReview) return false;

  const minComp = Number(state.minComp || 0);
  if (minComp > 0 && rowCompK(row) < minComp) return false;
  const minFit = Number(state.minFit || 0);
  if (minFit > 0 && toFiniteNumber(row?.fit) < minFit) return false;

  return true;
}

export function sortValue(row, key) {
  if (key === "fit") return toFiniteNumber(row?.fit);
  if (key === "base") return rowCompK(row);
  if (key === "action") return ACTION_ORDER[row?.actionState] ?? 50;
  if (key === "stage") return stageOrder(row?.stage);
  if (key === "applied") return row?.appliedAt || row?.appliedLabel || "";
  return row?.[key] || "";
}

export function sortRows(
  rows,
  key = DEFAULT_EXPLORER_STATE.sortKey,
  dir = DEFAULT_EXPLORER_STATE.sortDir
) {
  const sortKey = ALLOWED.sortKey.has(key) ? key : DEFAULT_EXPLORER_STATE.sortKey;
  const direction = Number(dir) === 1 ? 1 : -1;
  return [...(Array.isArray(rows) ? rows : [])]
    .map((row, index) => ({ row, index }))
    .sort((a, b) => {
      const av = sortValue(a.row, sortKey);
      const bv = sortValue(b.row, sortKey);
      if (typeof av === "number" && typeof bv === "number") {
        const result = (av - bv) * direction;
        return result || a.index - b.index;
      }
      return String(av).localeCompare(String(bv)) * direction || a.index - b.index;
    })
    .map((entry) => entry.row);
}

export function stageLabelFor(stage, sankey) {
  if (stage === "all") return "All Active";
  if (stage === "terminal") return "Rejected / withdrawn";
  if (stage === "stale") return "Going stale";
  if (stage === "ghosted") return "Ghosted";
  const node = (Array.isArray(sankey?.nodes) ? sankey.nodes : []).find(
    (item) => (item.filter || item.id) === stage
  );
  if (node?.label) return node.label;
  return String(stage || "")
    .replace(/[-_]/g, " ")
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

export function railActionToFilters(action) {
  const next = {
    ...DEFAULT_EXPLORER_STATE,
    view: "table",
  };
  if (action === "high-fit") {
    next.action = "high-fit";
    next.minFit = "80";
  } else if (action === "needs-action") {
    next.action = "needs-action";
  } else if (action === "manual-review") {
    next.action = "review";
    next.reviewOnly = true;
    next.sortKey = "fit";
    next.sortDir = -1;
  } else if (action === "interview-path") {
    next.action = "interview";
    next.stage = "interview";
    next.sortKey = "stage";
    next.sortDir = -1;
  } else if (action === "stale-applications") {
    next.action = "stale";
    next.sortKey = "action";
    next.sortDir = 1;
  } else if (action === "missing-comp") {
    next.action = "missing-comp";
    next.sortKey = "action";
    next.sortDir = 1;
  } else if (action === "terminal") {
    next.stage = "terminal";
    next.sortKey = "applied";
    next.sortDir = -1;
  }
  return next;
}

export function sanitizeExplorerState(raw = {}) {
  const value = raw && typeof raw === "object" ? raw : {};
  const stage =
    typeof value.stage === "string" && value.stage.trim()
      ? value.stage.trim()
      : DEFAULT_EXPLORER_STATE.stage;
  const sortDir = Number(value.sortDir) === 1 ? 1 : -1;
  return {
    ...DEFAULT_EXPLORER_STATE,
    stage,
    query: String(value.query || "")
      .trim()
      .toLowerCase()
      .slice(0, 120),
    view: ALLOWED.view.has(value.view) ? value.view : DEFAULT_EXPLORER_STATE.view,
    showTerminal: Boolean(value.showTerminal) && stage === "all",
    sortKey: ALLOWED.sortKey.has(value.sortKey) ? value.sortKey : DEFAULT_EXPLORER_STATE.sortKey,
    sortDir,
    funnelCollapsed: Boolean(value.funnelCollapsed),
    showGhosted: Boolean(value.showGhosted),
    hideStale: Boolean(value.hideStale),
    action: ALLOWED.action.has(value.action) ? value.action : DEFAULT_EXPLORER_STATE.action,
    mode: ALLOWED.mode.has(value.mode) ? value.mode : DEFAULT_EXPLORER_STATE.mode,
    source: ALLOWED.source.has(value.source) ? value.source : DEFAULT_EXPLORER_STATE.source,
    minComp: cleanNumberString(value.minComp, 2000),
    minFit: cleanNumberString(value.minFit, 100),
    reviewOnly: Boolean(value.reviewOnly),
  };
}
