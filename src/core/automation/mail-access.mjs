import { mayRun } from "./consent.mjs";

export const MAIL_ACCESS_CAPABILITY = "mail_access";
const MAIL_ACCESS_PLATFORMS = ["gmail", "outlook", "webmail"];
export const MAIL_ACCESS_INGEST_PLATFORMS = ["gmail", "outlook"];

const GMAIL_DOMAINS = new Set(["gmail.com", "googlemail.com"]);
const OUTLOOK_DOMAINS = new Set(["outlook.com", "hotmail.com", "live.com", "msn.com"]);

export const MAIL_ACCESS_FORBIDDEN_ACTIONS = [
  "browse broader inbox",
  "send message",
  "delete message",
  "reply to message",
  "archive message",
  "mark message read",
];

const VERIFICATION_TERMS = [
  "verification code",
  "one-time code",
  "security code",
  "login code",
  "sign-in code",
  "confirmation code",
];

const BLOCKERS = [
  {
    kind: "captcha",
    label: "captcha",
    patterns: ["captcha", "are you a robot", "verify you are human"],
  },
  {
    kind: "two_factor",
    label: "mail 2FA prompt",
    patterns: [
      "two-factor",
      "two factor",
      "two-step",
      "two step",
      "authenticator",
      "security key",
      "check your phone",
      "verify it's you",
      "verification method",
    ],
  },
  {
    kind: "login_wall",
    label: "mail login wall",
    patterns: [
      "sign in to",
      "sign into",
      "log in to",
      "login to",
      "enter your password",
      "choose an account",
    ],
  },
];

function normalizePlatform(platform) {
  const normalized = String(platform || "")
    .trim()
    .toLowerCase();
  if (!MAIL_ACCESS_PLATFORMS.includes(normalized)) {
    throw new Error(
      `unsupported mail platform "${platform}". Supported: ${MAIL_ACCESS_PLATFORMS.join(", ")}`
    );
  }
  return normalized;
}

export function canUseMailAccess({ platform, data, root } = {}) {
  return mayRun({
    capability: MAIL_ACCESS_CAPABILITY,
    platform: normalizePlatform(platform),
    data,
    root,
  });
}

export function buildVerificationCodeMailPlan({
  platform,
  providerName = "",
  recipientEmail = "",
  issuer = "",
  maxAgeMinutes = 15,
} = {}) {
  const normalizedPlatform = normalizePlatform(platform);
  const boundedAge =
    Number.isFinite(maxAgeMinutes) && maxAgeMinutes > 0 ? Math.floor(maxAgeMinutes) : 15;
  const searchTerms = issuer ? [...VERIFICATION_TERMS, issuer] : [...VERIFICATION_TERMS];

  return {
    capability: MAIL_ACCESS_CAPABILITY,
    platform: normalizedPlatform,
    providerName,
    mode: "verification-code-only",
    recipientEmail,
    issuer,
    maxAgeMinutes: boundedAge,
    searchTerms,
    allowedActions: [
      "search recent mail for verification-code terms",
      "open one matching recent message",
      "read the code from that message",
      "return to the original application or sign-in page",
    ],
    forbiddenActions: MAIL_ACCESS_FORBIDDEN_ACTIONS,
    haltOn: ["login wall", "2FA prompt", "captcha", "unexpected interstitial"],
    privacyRule:
      "Never browse the broader inbox. Read only the specific recent verification-code message needed for the current flow.",
  };
}

export function inferMailAccessPlatformFromEmail(email = "") {
  const match = String(email)
    .trim()
    .toLowerCase()
    .match(/^[^@\s]+@([^@\s]+)$/);
  if (!match) return null;
  const domain = match[1];
  if (GMAIL_DOMAINS.has(domain)) return "gmail";
  if (OUTLOOK_DOMAINS.has(domain)) return "outlook";
  if (domain.includes(".")) return "webmail";
  return null;
}

export function supportsWebmailIngest(platform) {
  const normalized = normalizePlatform(platform);
  return MAIL_ACCESS_INGEST_PLATFORMS.includes(normalized);
}

export function classifyMailAccessBlocker(pageText = "") {
  const lower = String(pageText).toLowerCase();
  for (const blocker of BLOCKERS) {
    const signal = blocker.patterns.find((pattern) => lower.includes(pattern));
    if (signal) {
      return {
        kind: blocker.kind,
        label: blocker.label,
        signal,
        action: "halt",
      };
    }
  }
  return null;
}

export function extractVerificationCodes(text = "") {
  const lines = String(text).split(/\r?\n/);
  const candidates = [];
  const seen = new Set();

  for (let i = 0; i < lines.length; i++) {
    const windowText = [lines[i - 1], lines[i], lines[i + 1]].filter(Boolean).join(" ");
    if (!hasVerificationContext(windowText)) continue;

    for (const code of codesFromLine(windowText)) {
      if (seen.has(code)) continue;
      seen.add(code);
      candidates.push(code);
    }
  }

  return candidates;
}

function hasVerificationContext(text) {
  const lower = text.toLowerCase();
  return [
    "verification",
    "one-time",
    "one time",
    "security code",
    "login code",
    "sign-in code",
    "passcode",
    "confirmation code",
  ].some((term) => lower.includes(term));
}

function codesFromLine(line) {
  const results = [];
  const mixedRanges = [];

  for (const match of line.matchAll(/\b[A-Z]{2,4}[- ]?\d{3,6}\b/g)) {
    mixedRanges.push([match.index, match.index + match[0].length]);
    results.push(match[0].replace(/[-\s]/g, "").toUpperCase());
  }

  for (const match of line.matchAll(/\b\d{4,8}\b/g)) {
    const start = match.index;
    const end = start + match[0].length;
    if (mixedRanges.some(([mixedStart, mixedEnd]) => start >= mixedStart && end <= mixedEnd)) {
      continue;
    }
    results.push(match[0]);
  }

  return results;
}
