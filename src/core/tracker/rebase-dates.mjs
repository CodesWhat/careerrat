// rebase-dates.mjs — evergreen date-rebase core for the demo fixture. Shifts every
// standalone ISO date/datetime string by the whole-day delta between a tracker's
// `meta.demoAnchor` and a reference "today", so the seeded search always reads as
// current: interviews stay in the near future, applications stay in the past, the
// freshness pill stays recent.
//
// Pure (no fs) so it can live in shipped `src/` and be shared by both callers:
//   - scripts/rebase-demo-dates.mjs — CLI used by build:demo on a throwaway copy.
//   - db/demo-seed.mjs — `careerrat data init --demo` rebases to real-today on every
//     seed, keeping the live dev dashboard current without mutating the committed
//     fixture.
//
// Only values that are EXACTLY an ISO date or datetime are shifted (full-string match),
// so prose that merely mentions a date ("screen cleared 06-12") is never touched. Format
// is preserved: date-only stays YYYY-MM-DD, datetime keeps its time-of-day and Z suffix.

const DAY_MS = 86_400_000;
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
const ISO_DT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z$/;

function midnightUtc(ymd) {
  const [y, m, d] = ymd.split("-").map(Number);
  return Date.UTC(y, m - 1, d);
}

function shiftValue(value, deltaMs) {
  if (typeof value !== "string") return value;
  if (DATE_ONLY.test(value)) {
    return new Date(midnightUtc(value) + deltaMs).toISOString().slice(0, 10);
  }
  if (ISO_DT.test(value)) {
    const hadMillis = /\.\d{3}Z$/.test(value);
    const iso = new Date(new Date(value).getTime() + deltaMs).toISOString();
    return hadMillis ? iso : iso.replace(/\.\d{3}Z$/, "Z");
  }
  return value;
}

function walk(node, deltaMs, counter) {
  if (Array.isArray(node)) {
    for (let i = 0; i < node.length; i++) {
      const next = walk(node[i], deltaMs, counter);
      if (next !== node[i]) node[i] = next;
    }
    return node;
  }
  if (node && typeof node === "object") {
    for (const key of Object.keys(node)) {
      const next = walk(node[key], deltaMs, counter);
      if (next !== node[key]) node[key] = next;
    }
    return node;
  }
  if (typeof node === "string") {
    const shifted = shiftValue(node, deltaMs);
    if (shifted !== node) counter.n++;
    return shifted;
  }
  return node;
}

export function daysBetween(fromYmd, toYmd) {
  return Math.round((midnightUtc(toYmd) - midnightUtc(fromYmd)) / DAY_MS);
}

// Shift every ISO date/datetime string in an arbitrary parsed tree by deltaMs, in
// place. A zero delta is a no-op. Used to keep activity-log timestamps in lockstep
// with the rebased tracker tree.
export function shiftTreeByMs(node, deltaMs) {
  if (!deltaMs) return node;
  walk(node, deltaMs, { n: 0 });
  return node;
}

// Rebase a parsed tracker object in place by the whole-day delta between its
// meta.demoAnchor and referenceToday (real today by default). Returns a summary
// (including deltaMs so callers can shift sibling data like activity events), or
// null when the object carries no usable demoAnchor — real workspaces never do, so
// this is a safe no-op guard for the shared import path.
export function rebaseTrackerData(data, referenceToday) {
  const anchor = data?.meta?.demoAnchor;
  if (!anchor || !DATE_ONLY.test(anchor)) return null;
  const todayYmd = referenceToday || new Date().toISOString().slice(0, 10);
  const deltaDays = daysBetween(anchor, todayYmd);
  const deltaMs = deltaDays * DAY_MS;
  const counter = { n: 0 };
  if (deltaMs) walk(data, deltaMs, counter);
  return {
    fromAnchor: anchor,
    toAnchor: data?.meta?.demoAnchor,
    deltaDays,
    deltaMs,
    count: counter.n,
  };
}
