import { userInfo } from "node:os";
import { openDb } from "../db/connection.mjs";
import { openAnswerNeedsFromGaps } from "../packet/answer-needs.mjs";
import { readAuthorization } from "../people/authorization.mjs";
import { readContact } from "../people/contact.mjs";
import { assertCanNotify, notifyPerson, readNotificationLog } from "./person-notify.mjs";
import { resolveTransport } from "./transports.mjs";

// CR122: the operator-run roundup. A plain-text summary of what CareerRat did for one
// person in a window: verified submissions, status changes, and the NEEDS YOU
// questions still waiting on them. Only company, role, status and dates go in. Money,
// SSN/DOB and background-check material never does, even if it shows up in a question.
const DEFAULT_WINDOW_DAYS = 7;
const CLOSED_STATUSES = new Set([
  "accepted",
  "archived",
  "closed",
  "cut",
  "declined",
  "hired",
  "rejected",
  "skipped",
  "withdrawn",
]);
const SENSITIVE =
  /\b(salary|compensation|comp|current[_ ]?base|base pay|pay (expectation|range)s?|desired pay|floor|equity|ssn|social security|date of birth|dob|birth ?date|background[- ]?check|checkr|sterling|hireright|fcra|tax id)\b|\d{3}-\d{2}-\d{4}|\$\s?\d/i;
const SENSITIVE_QUESTION =
  "A question about personal details is waiting. Open CareerRat to answer it.";

function clean(value) {
  return String(value ?? "")
    .replace(/\s+/g, " ")
    .trim();
}

export function dayKey(date, timeZone) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: timeZone || "UTC",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

function niceDate(value, timeZone) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return clean(value);
  return new Intl.DateTimeFormat("en-US", {
    timeZone: timeZone || "UTC",
    month: "short",
    day: "numeric",
  }).format(date);
}

function titleCase(name) {
  return name
    .split("-")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

export function operatorName({ base, name, env = process.env }) {
  const fromEnv = clean(env.CAREERRAT_OPERATOR_NAME);
  if (fromEnv) return fromEnv;
  const records = readAuthorization(base, name).records;
  const recorded = clean(records.at(-1)?.recordedBy);
  if (recorded) return recorded;
  try {
    return userInfo().username;
  } catch {
    return "your operator";
  }
}

function label(app) {
  const company = clean(app.company) || "A company";
  const role = clean(app.role);
  return role ? `${company}, ${role}` : company;
}

export function resolveWindow({ base, name, since, now = new Date() }) {
  const contact = readContact(base, name);
  let from;
  let defaulted = false;
  if (since) {
    from = new Date(since);
    if (Number.isNaN(from.getTime())) {
      throw new Error(`--since "${since}" isn't a date. Try 2026-10-26.`);
    }
  } else {
    defaulted = true;
    const last = readNotificationLog(base, name)
      .filter((entry) => entry.kind === "roundup")
      .map((entry) => Date.parse(entry.sentAt))
      .filter(Number.isFinite)
      .sort((a, b) => b - a)[0];
    from = last ? new Date(last) : new Date(now.getTime() - DEFAULT_WINDOW_DAYS * 86_400_000);
  }
  const sinceDay = dayKey(from, contact.timezone);
  const untilDay = dayKey(now, contact.timezone);
  return {
    from,
    until: now,
    sinceDay,
    untilDay,
    defaulted,
    windowKey: `roundup:${sinceDay}..${untilDay}`,
  };
}

export function buildRoundup({ repoRoot, env, base, name, window, operator }) {
  const db = openDb({ repoRoot, env });
  const contact = readContact(base, name);
  const tz = contact.timezone;
  const inWindow = (value) => {
    const time = Date.parse(value);
    return Number.isFinite(time) && time >= window.from.getTime() && time <= window.until.getTime();
  };

  const apps = db
    .prepare("SELECT data FROM applications ORDER BY rowid ASC")
    .all()
    .map((row) => JSON.parse(row.data))
    .filter((app) => !app.demo);

  const applied = apps
    .filter((app) => app.appliedAt && inWindow(app.appliedAt))
    .sort((a, b) => Date.parse(a.appliedAt) - Date.parse(b.appliedAt))
    .map((app) => `${label(app)} (${niceDate(app.appliedAt, tz)})`)
    .filter((line) => !SENSITIVE.test(line));

  const changes = db
    .prepare("SELECT at, data FROM activity_events WHERE type = 'status_change' ORDER BY at ASC")
    .all()
    .map((row) => ({ at: row.at, event: JSON.parse(row.data) }))
    .filter(({ at, event }) => inWindow(at) && !(event.tags || []).includes("status:applied"))
    .map(({ at, event }) => `${clean(event.title)} (${niceDate(at, tz)})`)
    .filter((line) => !SENSITIVE.test(line));

  const questions = [];
  for (const app of apps) {
    if (CLOSED_STATUSES.has(clean(app.status).toLowerCase())) continue;
    for (const need of openAnswerNeedsFromGaps(app.packetManifest?.gaps)) {
      const text = SENSITIVE.test(need.question) ? SENSITIVE_QUESTION : clean(need.question);
      questions.push(`${label(app)}: ${text}`);
    }
  }

  const sections = [];
  if (applied.length) {
    sections.push(`Applied (${applied.length})`, ...applied.map((line) => `- ${line}`), "");
  }
  if (changes.length) {
    sections.push(`Status changes (${changes.length})`, ...changes.map((line) => `- ${line}`), "");
  }
  if (questions.length) {
    sections.push(
      `Waiting on you (${questions.length})`,
      ...questions.map((line, index) => `${index + 1}. ${line}`),
      ""
    );
  }
  const empty = sections.length === 0;
  const text = [
    `Hi ${titleCase(name)},`,
    "",
    `Here's where your job search stands since ${niceDate(window.from, tz)}.`,
    "",
    ...(empty ? ["Nothing new in this window.", ""] : sections),
    ...(questions.length
      ? ["Answer these in CareerRat, or tell me and I'll walk through them with you.", ""]
      : []),
    `CareerRat, run by ${operator}`,
    "Reply STOP to pause these.",
    "",
  ].join("\n");

  return {
    subject: `Your job search roundup, ${niceDate(window.until, tz)}`,
    text,
    empty,
    counts: { applied: applied.length, statusChanges: changes.length, questions: questions.length },
  };
}

// Runs one roundup. Dry run returns the message. `send` goes through the gates, the
// idempotency check and a transport, and records the send in the person's notification log.
export async function runRoundup({
  repoRoot,
  env = process.env,
  base,
  name,
  since,
  send = false,
  ignoreQuietHours = false,
  now = new Date(),
  transportOverride,
}) {
  const window = resolveWindow({ base, name, since, now });
  const operator = operatorName({ base, name, env });
  const roundup = buildRoundup({ repoRoot, env, base, name, window, operator });
  const result = { ...roundup, window, sent: false, skipped: null };
  if (!send) return result;

  if (roundup.empty) return { ...result, skipped: "nothing to report in this window" };
  const prior = readNotificationLog(base, name).find(
    (entry) =>
      entry.kind === "roundup" &&
      (entry.windowKey === window.windowKey ||
        (window.defaulted && entry.untilDay === window.untilDay))
  );
  if (prior) return { ...result, skipped: `already sent for this window on ${prior.sentAt}` };

  const contact = assertCanNotify({
    base,
    name,
    to: readContact(base, name).email,
    now,
    ignoreQuietHours,
  });
  const resolved = transportOverride || resolveTransport(env);
  const entry = await notifyPerson({
    base,
    name,
    to: contact.email,
    subject: roundup.subject,
    text: roundup.text,
    transport: resolved.transport,
    from: resolved.from,
    kind: "roundup",
    windowKey: window.windowKey,
    extra: { untilDay: window.untilDay },
    now,
    ignoreQuietHours,
  });
  return { ...result, sent: true, entry };
}
