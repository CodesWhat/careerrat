import { readAuthorization, writeAuthorization } from "./authorization.mjs";

// CR121: how CareerRat may reach the person whose workspace this is, and whether they
// agreed to it. Stored inside the person's internal/authorization.json so purge and
// backup take it with them. Nothing here sends anything; notify.mjs enforces it.
export const DEFAULT_QUIET_HOURS = Object.freeze({ start: "21:00", end: "08:00" });
export const CHANNELS = Object.freeze(["email"]);

const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const CLOCK_SHAPE = /^([01]\d|2[0-3]):[0-5]\d$/;
const STOP_WORDS = new Set(["stop", "stopall", "unsubscribe", "cancel", "end", "quit"]);

export class ContactError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "ContactError";
    this.code = code;
  }
}

function clean(value) {
  return String(value ?? "").trim();
}

function validTimezone(zone) {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

export function parseQuietHours(raw) {
  const match = clean(raw).match(/^(\d{2}:\d{2})\s*-\s*(\d{2}:\d{2})$/);
  if (!match || !CLOCK_SHAPE.test(match[1]) || !CLOCK_SHAPE.test(match[2])) {
    throw new ContactError("CONTACT_BAD_QUIET_HOURS", 'Quiet hours look like "21:00-08:00".');
  }
  return { start: match[1], end: match[2] };
}

export function readContact(base, name) {
  const data = readAuthorization(base, name);
  const contact = data.contact && typeof data.contact === "object" ? data.contact : {};
  return {
    email: clean(contact.email) || null,
    phone: clean(contact.phone) || null,
    timezone: clean(contact.timezone) || null,
    quietHours: contact.quietHours?.start
      ? { start: contact.quietHours.start, end: contact.quietHours.end }
      : { ...DEFAULT_QUIET_HOURS },
    optIns: Array.isArray(data.optIns) ? data.optIns : [],
  };
}

export function setContact({ base, name, email, phone, timezone, quietHours }) {
  const data = readAuthorization(base, name);
  const contact = { ...(data.contact || {}) };
  if (email !== undefined) {
    const value = clean(email);
    if (!EMAIL_SHAPE.test(value)) {
      throw new ContactError("CONTACT_BAD_EMAIL", `"${value}" is not an email address.`);
    }
    contact.email = value;
  }
  if (phone !== undefined) contact.phone = clean(phone);
  if (timezone !== undefined) {
    const value = clean(timezone);
    if (!validTimezone(value)) {
      throw new ContactError(
        "CONTACT_BAD_TIMEZONE",
        `"${value}" is not a timezone. Use an IANA name like America/Chicago.`
      );
    }
    contact.timezone = value;
  }
  if (quietHours !== undefined) contact.quietHours = parseQuietHours(quietHours);
  writeAuthorization(base, name, { ...data, contact });
  return readContact(base, name);
}

// The standing opt-in for a channel: the latest entry that hasn't been revoked.
export function activeOptIn(contact, channel) {
  for (let i = contact.optIns.length - 1; i >= 0; i--) {
    const entry = contact.optIns[i];
    if (entry.channel === channel) return entry.revokedAt ? null : entry;
  }
  return null;
}

export function optIn({ base, name, channel, evidence, now = new Date() }) {
  if (!CHANNELS.includes(channel)) {
    throw new ContactError("CONTACT_BAD_CHANNEL", `Unknown channel "${channel}". Use: email.`);
  }
  const proof = clean(evidence);
  if (!proof) {
    throw new ContactError(
      "CONTACT_EVIDENCE_REQUIRED",
      `Opt-in needs evidence of their yes: careerrat --for ${name} people contact opt-in ${channel} --evidence "<how they agreed>"`
    );
  }
  const data = readAuthorization(base, name);
  const contact = readContact(base, name);
  if (channel === "email" && !contact.email) {
    throw new ContactError(
      "CONTACT_NO_ADDRESS",
      `Set their email first: careerrat --for ${name} people contact set --email <address>`
    );
  }
  const entry = { channel, optedInAt: now.toISOString(), evidence: proof, revokedAt: null };
  writeAuthorization(base, name, { ...data, optIns: [...contact.optIns, entry] });
  return entry;
}

export function optOut({ base, name, channel, now = new Date(), reason }) {
  const data = readAuthorization(base, name);
  const contact = readContact(base, name);
  const optIns = contact.optIns.slice();
  let revoked = null;
  for (let i = optIns.length - 1; i >= 0; i--) {
    if (optIns[i].channel === channel) {
      if (!optIns[i].revokedAt) {
        optIns[i] = {
          ...optIns[i],
          revokedAt: now.toISOString(),
          ...(reason ? { revokedBy: reason } : {}),
        };
        revoked = optIns[i];
      }
      break;
    }
  }
  if (revoked) writeAuthorization(base, name, { ...data, optIns });
  return revoked;
}

export function isStopKeyword(text) {
  return STOP_WORDS.has(
    clean(text)
      .toLowerCase()
      .replace(/[^a-z]/g, "")
  );
}

// A STOP reply on a channel revokes that channel's opt-in. Returns the revoked entry,
// or null when the text wasn't a stop word or there was nothing to revoke.
export function applyStopKeyword({ base, name, channel, text, now }) {
  if (!isStopKeyword(text)) return null;
  return optOut({ base, name, channel, now, reason: "stop reply" });
}
