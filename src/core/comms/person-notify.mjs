import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { personRoot } from "../paths/people.mjs";
import { activeOptIn, readContact } from "../people/contact.mjs";

// CR120/CR121: the one door for agent-to-person notifications. CareerRat may send to the
// person whose workspace it is, at the address in their contact record, once they've
// opted in. Anything else is refused here, before a transport is touched. Employer and
// recruiter mail never comes through this module: it stays draft-only.
export class NotifyError extends Error {
  constructor(code, message, extra = {}) {
    super(message);
    this.name = "NotifyError";
    this.code = code;
    Object.assign(this, extra);
  }
}

const LOG_RELPATH = join("internal", "notifications.json");

function notificationLogPath(base, name) {
  return join(personRoot(base, name), LOG_RELPATH);
}

export function readNotificationLog(base, name) {
  const path = notificationLogPath(base, name);
  if (!existsSync(path)) return [];
  try {
    const data = JSON.parse(readFileSync(path, "utf8"));
    return Array.isArray(data.entries) ? data.entries : [];
  } catch {
    return [];
  }
}

function appendNotificationLog(base, name, entry) {
  const path = notificationLogPath(base, name);
  const entries = [...readNotificationLog(base, name), entry];
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, `${JSON.stringify({ person: name, entries }, null, 2)}\n`, { mode: 0o600 });
  chmodSync(path, 0o600);
}

function localMinutes(now, timeZone) {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(now);
  const get = (type) => Number(parts.find((part) => part.type === type)?.value ?? 0);
  return get("hour") * 60 + get("minute");
}

function clockMinutes(clock) {
  const [hours, minutes] = clock.split(":").map(Number);
  return hours * 60 + minutes;
}

function quietHoursState({ now = new Date(), timezone, quietHours }) {
  const minutes = localMinutes(now, timezone);
  const start = clockMinutes(quietHours.start);
  const end = clockMinutes(quietHours.end);
  const quiet =
    start === end
      ? false
      : start < end
        ? minutes >= start && minutes < end
        : minutes >= start || minutes < end;
  return { quiet, resumesAt: quietHours.end };
}

function sameAddress(left, right) {
  return (
    String(left || "")
      .trim()
      .toLowerCase() ===
    String(right || "")
      .trim()
      .toLowerCase()
  );
}

// Checks, in order: a contact address exists, `to` is that address, the person opted in,
// and it isn't their quiet hours. Returns the contact on success.
export function assertCanNotify({
  base,
  name,
  channel = "email",
  to,
  now = new Date(),
  ignoreQuietHours = false,
}) {
  const contact = readContact(base, name);
  if (!contact.email) {
    throw new NotifyError(
      "NOTIFY_NO_CONTACT",
      `No contact address for ${name}. Set one: careerrat --for ${name} people contact set --email <address>`
    );
  }
  if (!sameAddress(to, contact.email)) {
    throw new NotifyError(
      "NOTIFY_ADDRESS_NOT_REGISTERED",
      `Refusing to notify ${to}: it isn't ${name}'s registered contact address. CareerRat only sends to the person whose workspace it is.`
    );
  }
  if (!activeOptIn(contact, channel)) {
    throw new NotifyError(
      "NOTIFY_NO_OPT_IN",
      `${name} hasn't opted in to ${channel} messages (or opted out). Record their yes: careerrat --for ${name} people contact opt-in ${channel} --evidence "<how they agreed>"`
    );
  }
  if (!ignoreQuietHours) {
    if (!contact.timezone) {
      throw new NotifyError(
        "NOTIFY_NO_TIMEZONE",
        `No timezone for ${name}, so quiet hours can't be checked. Set one: careerrat --for ${name} people contact set --timezone America/Chicago (or pass --now to skip the check)`
      );
    }
    const state = quietHoursState({
      now,
      timezone: contact.timezone,
      quietHours: contact.quietHours,
    });
    if (state.quiet) {
      throw new NotifyError(
        "NOTIFY_QUIET_HOURS",
        `It's quiet hours for ${name} (${contact.timezone}); rerun after ${state.resumesAt} or pass --now.`,
        { resumesAt: state.resumesAt, timezone: contact.timezone }
      );
    }
  }
  return contact;
}

export async function notifyPerson({
  base,
  name,
  channel = "email",
  to,
  subject,
  text,
  transport,
  from,
  kind = "notification",
  windowKey = null,
  extra = {},
  now = new Date(),
  ignoreQuietHours = false,
}) {
  assertCanNotify({ base, name, channel, to, now, ignoreQuietHours });
  const result = await transport.send({ from, to, subject, text });
  const entry = {
    kind,
    channel,
    to,
    subject,
    sentAt: now.toISOString(),
    transport: transport.name,
    messageId: result?.id ?? null,
    ...(windowKey ? { windowKey } : {}),
    ...extra,
  };
  appendNotificationLog(base, name, entry);
  return entry;
}
