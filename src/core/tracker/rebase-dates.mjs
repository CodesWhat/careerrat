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
// Structured values and unambiguous date tokens inside demo prose are shifted together.
// Format is preserved: date-only stays YYYY-MM-DD, datetime keeps its time-of-day and Z
// suffix, and "Jun 24" / "June 24" retain short / long month style. Ambiguous numeric
// prose such as "06-12" is intentionally untouched.

const DAY_MS = 86_400_000;
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
const ISO_DT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z$/;
const EMBEDDED_ISO = /\b\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z)?\b/g;
const MONTH_DAY =
  /\b(January|February|March|April|May|June|July|August|September|October|November|December|Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)\s+([0-3]?\d)(?:,\s*(\d{4}))?\b/g;
const MONTH_INDEX = new Map(
  [
    ["jan", 0],
    ["feb", 1],
    ["mar", 2],
    ["apr", 3],
    ["may", 4],
    ["jun", 5],
    ["jul", 6],
    ["aug", 7],
    ["sep", 8],
    ["sept", 8],
    ["oct", 9],
    ["nov", 10],
    ["dec", 11],
  ].map(([name, index]) => [name, index])
);
const MONTH_SHORT = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];
const MONTH_LONG = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

function midnightUtc(ymd) {
  const [y, m, d] = ymd.split("-").map(Number);
  return Date.UTC(y, m - 1, d);
}

function nearestImplicitYear(month, day, anchorYmd) {
  const anchor = midnightUtc(anchorYmd);
  const anchorYear = Number(anchorYmd.slice(0, 4));
  return [anchorYear - 1, anchorYear, anchorYear + 1].sort(
    (a, b) =>
      Math.abs(Date.UTC(a, month, day) - anchor) - Math.abs(Date.UTC(b, month, day) - anchor)
  )[0];
}

function shiftProseDates(value, deltaMs, anchorYmd) {
  let shifted = value.replace(EMBEDDED_ISO, (token) => shiftValue(token, deltaMs));
  if (!anchorYmd || !DATE_ONLY.test(anchorYmd)) return shifted;
  shifted = shifted.replace(MONTH_DAY, (token, monthName, rawDay, rawYear) => {
    const month = MONTH_INDEX.get(monthName.toLowerCase().slice(0, 3));
    const day = Number(rawDay);
    if (month == null || day < 1 || day > 31) return token;
    const year = rawYear ? Number(rawYear) : nearestImplicitYear(month, day, anchorYmd);
    const original = Date.UTC(year, month, day);
    const parsed = new Date(original);
    if (parsed.getUTCMonth() !== month || parsed.getUTCDate() !== day) return token;
    const next = new Date(original + deltaMs);
    const longStyle = monthName.length > 3;
    const renderedMonth = (longStyle ? MONTH_LONG : MONTH_SHORT)[next.getUTCMonth()];
    const renderedYear = rawYear ? `, ${next.getUTCFullYear()}` : "";
    return `${renderedMonth} ${next.getUTCDate()}${renderedYear}`;
  });
  return shifted;
}

function shiftValue(value, deltaMs, anchorYmd) {
  if (typeof value !== "string") return value;
  if (DATE_ONLY.test(value)) {
    return new Date(midnightUtc(value) + deltaMs).toISOString().slice(0, 10);
  }
  if (ISO_DT.test(value)) {
    const hadMillis = /\.\d{3}Z$/.test(value);
    const iso = new Date(new Date(value).getTime() + deltaMs).toISOString();
    return hadMillis ? iso : iso.replace(/\.\d{3}Z$/, "Z");
  }
  return shiftProseDates(value, deltaMs, anchorYmd);
}

function walk(node, deltaMs, counter, anchorYmd) {
  if (Array.isArray(node)) {
    for (let i = 0; i < node.length; i++) {
      const next = walk(node[i], deltaMs, counter, anchorYmd);
      if (next !== node[i]) node[i] = next;
    }
    return node;
  }
  if (node && typeof node === "object") {
    for (const key of Object.keys(node)) {
      const next = walk(node[key], deltaMs, counter, anchorYmd);
      if (next !== node[key]) node[key] = next;
    }
    return node;
  }
  if (typeof node === "string") {
    const shifted = shiftValue(node, deltaMs, anchorYmd);
    if (shifted !== node) counter.n++;
    return shifted;
  }
  return node;
}

function daysBetween(fromYmd, toYmd) {
  return Math.round((midnightUtc(toYmd) - midnightUtc(fromYmd)) / DAY_MS);
}

// Shift every ISO date/datetime string in an arbitrary parsed tree by deltaMs, in
// place. A zero delta is a no-op. Used to keep activity-log timestamps in lockstep
// with the rebased tracker tree.
export function shiftTreeByMs(node, deltaMs, anchorYmd) {
  if (!deltaMs) return node;
  walk(node, deltaMs, { n: 0 }, anchorYmd);
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
  if (deltaMs) walk(data, deltaMs, counter, anchor);
  return {
    fromAnchor: anchor,
    toAnchor: data?.meta?.demoAnchor,
    deltaDays,
    deltaMs,
    count: counter.n,
  };
}
