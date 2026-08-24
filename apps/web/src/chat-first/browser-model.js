function asArray(value) {
  if (Array.isArray(value)) return value;
  if (value instanceof Set) return [...value];
  return [];
}

export function selectionIds(selection) {
  return asArray(selection).map(String);
}

export function selectedJobs(jobs, selection) {
  const selected = new Set(selectionIds(selection));
  return asArray(jobs).filter((job) => selected.has(String(job?.id)));
}

export function fitBarWidth(fit) {
  const value = (Number(fit) - 60) * 2.5;
  return Math.max(0, Math.min(100, Math.round(value)));
}

export function buildCartView(jobs) {
  const selected = asArray(jobs);
  const count = selected.length;
  let fitTotal = 0;
  let evaluationCount = 0;
  let compPendingCount = 0;
  for (const job of selected) {
    fitTotal += Number(job?.fit) || 0;
    if (job?.evaluationRequired) evaluationCount += 1;
    if (!/✓|cleared|works|above|pass/i.test(String(job?.compStatus || ""))) {
      compPendingCount += 1;
    }
  }
  return {
    count,
    title: count === 0 ? "CART" : count === 1 ? "SELECTED · 1" : `CART · ${count} JOBS`,
    averageFit: count > 0 ? Math.round(fitTotal / count) : 0,
    evaluationCount,
    compPendingCount,
    draftLabel: `Draft ${count === 1 ? "1 packet" : `${count} packets`} (resume + cover)`,
    applyLabel: "Draft, then gate each apply",
    chatLabel: count === 1 ? "Chat about this" : `Chat about these ${count}`,
  };
}

export function pipelineRowsWithWidths(rows) {
  const list = asArray(rows);
  let maximum = 0;
  for (const row of list) maximum = Math.max(maximum, Number(row?.count) || 0);
  return list.map((row) => ({
    ...row,
    width: maximum > 0 ? Math.round(((Number(row?.count) || 0) / maximum) * 100) : 0,
  }));
}

function filterKey(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

export function filterSearchJobs(jobs, filters = {}, now = new Date()) {
  const query = String(filters.query || "")
    .trim()
    .toLowerCase();
  return asArray(jobs).filter((job) => {
    const fit = Number(job?.fit);
    if (filters.fit80 && Number.isFinite(fit) && fit < 80) return false;
    if (
      filters.comp &&
      !/✓|cleared|works|above|pass/i.test(
        `${job?.compStatus || ""} ${job?.comp || ""} ${job?.base || ""}`
      )
    ) {
      return false;
    }
    if (
      filters.remote &&
      !/remote/i.test(`${job?.mode || ""} ${job?.location || ""} ${job?.stage || ""}`)
    ) {
      return false;
    }
    if (
      filters.stage &&
      filters.stage !== "all" &&
      filterKey(job?.stage || job?.stageLabel || job?.status) !== filters.stage
    ) {
      return false;
    }
    if (
      filters.source &&
      filters.source !== "all" &&
      filterKey(job?.sourceLabel || job?.channel || job?.source) !== filters.source
    ) {
      return false;
    }
    if (filters.posted && filters.posted !== "all") {
      const days = Number.parseInt(filters.posted, 10);
      const postedAt = new Date(job?.postedAt || job?.datePosted || "");
      const current = now instanceof Date ? now : new Date(now);
      const age = current.getTime() - postedAt.getTime();
      if (
        !Number.isFinite(days) ||
        !Number.isFinite(postedAt.getTime()) ||
        !Number.isFinite(current.getTime()) ||
        age < 0 ||
        age > days * 86_400_000
      ) {
        return false;
      }
    }
    if (!query) return true;
    return `${job?.company || ""} ${job?.role || ""} ${job?.stage || ""} ${job?.location || ""} ${job?.sourceLabel || ""}`
      .toLowerCase()
      .includes(query);
  });
}

export function filterFiles(files, selected = "All") {
  const filter = String(selected || "All").toLowerCase();
  if (filter === "all") return asArray(files);
  return asArray(files).filter((file) => {
    const kind = String(file?.kind || "").toLowerCase();
    if (filter.startsWith("resume")) return kind.includes("resume");
    if (filter.startsWith("cover")) return kind.includes("cover");
    if (filter.startsWith("stor")) return kind.includes("stor");
    if (filter.startsWith("evidence")) return kind.includes("evidence");
    return /job description|interview dossier|application answers|offer/.test(kind);
  });
}

export function filterPeople(people, selected = "all") {
  if (selected !== "needs-touch") return asArray(people);
  return asArray(people).filter((person) => person?.needsTouch === true);
}
