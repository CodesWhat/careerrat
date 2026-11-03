// evaluate/recruiter-signal.mjs: fake-recruiter and interview-malware signal.
//
// Career Ops Block G Signal 18 (MIT) idea, domain-neutral. Outreach that claims a
// company but does not come from it, points at a role the company never posted, or
// asks the candidate to run someone else's code is the common shape of a hiring
// scam (including the fake "coding test" that installs malware). Like the posting
// legitimacy check this is a FLAG, never an auto-cut: it returns `suspect` so the
// human decides. Pure: no network, no fs, nothing is fetched or executed here.

export const RUN_CODE_WARNING =
  "Do not run, install or open any code, repository, archive or file this contact sends until you have confirmed them through the company's own careers page or main switchboard.";

// Mailbox providers anyone can open. A real in-house recruiter does not write from one.
const FREE_MAIL_DOMAINS = new Set([
  "gmail.com",
  "googlemail.com",
  "outlook.com",
  "hotmail.com",
  "live.com",
  "yahoo.com",
  "ymail.com",
  "icloud.com",
  "me.com",
  "aol.com",
  "proton.me",
  "protonmail.com",
  "gmx.com",
  "mail.com",
  "zoho.com",
]);

const RUN_CODE_PATTERNS = [
  /\b(?:clone|download|pull)\b[^.\n]{0,60}\b(?:repo|repository|github|gitlab|bitbucket|zip|archive)\b/i,
  /\b(?:npm|yarn|pnpm|pip3?|cargo|gem)\s+(?:install|i|add)\b/i,
  /\b(?:npm|yarn|pnpm)\s+(?:start|run)\b/i,
  /\b(?:run|execute|launch|install)\b[^.\n]{0,40}\b(?:this|the|attached|following)\b[^.\n]{0,30}\b(?:script|code|project|app|application|program|installer|executable|binary|package)\b/i,
  /\bcurl\b[^\n]{0,120}\|\s*(?:ba|z)?sh\b/i,
  /\b(?:install|download)\b[^.\n]{0,40}\b(?:meeting|interview|video)\b[^.\n]{0,30}\b(?:software|app|plugin|extension|client|driver)\b/i,
  /\b(?:fix|update)\b[^.\n]{0,30}\b(?:camera|microphone|audio|video)\b[^.\n]{0,30}\b(?:driver|issue|error)\b/i,
];

const OFF_PLATFORM_PATTERNS = [
  /\b(?:telegram|whatsapp|signal|wechat)\b/i,
  /\bmove (?:the|our) (?:conversation|chat)\b/i,
];

const PAYMENT_PATTERNS = [
  /\b(?:pay|send|wire|deposit)\b[^.\n]{0,40}\b(?:fee|deposit|equipment|laptop|training|background check|onboarding)\b/i,
  /\b(?:cashier'?s check|gift card|crypto|bitcoin)\b/i,
];

function domainOf(address) {
  const match = String(address || "")
    .trim()
    .toLowerCase()
    .match(/@([a-z0-9.-]+\.[a-z]{2,})\s*>?$/);
  return match ? match[1] : "";
}

function bareDomain(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/^www\./, "")
    .split(/[/?#]/)[0];
}

// True when `sender` is the company domain or one of its subdomains.
function sameOrganization(sender, company) {
  return sender === company || sender.endsWith(`.${company}`) || company.endsWith(`.${sender}`);
}

/**
 * @param {object} input
 * @param {string} [input.senderEmail]     From address of the outreach.
 * @param {string} [input.companyDomain]   The company's real domain, from the posting or tracker.
 * @param {boolean} [input.publicPosting]  true = posting found on the company's own careers page
 *   or a board it controls; false = searched and none found; undefined = not checked.
 * @param {string} [input.text]            Message body.
 * @returns {{ verdict: "clear"|"suspect", signals: {id: string, severity: "strong"|"mild", detail: string}[], reason: string, warning: string|null }}
 */
export function assessRecruiterSignal({ senderEmail, companyDomain, publicPosting, text } = {}) {
  const signals = [];
  const sender = domainOf(senderEmail);
  const company = bareDomain(companyDomain);
  const body = String(text || "");

  if (sender && FREE_MAIL_DOMAINS.has(sender)) {
    signals.push({
      id: "free-mail-sender",
      severity: "mild",
      detail: `writes from a free mailbox (${sender}), not a company address`,
    });
  } else if (sender && company && !sameOrganization(sender, company)) {
    signals.push({
      id: "domain-mismatch",
      severity: "strong",
      detail: `sender domain ${sender} does not match the company domain ${company}`,
    });
  }
  if (publicPosting === false) {
    signals.push({
      id: "no-public-posting",
      severity: "strong",
      detail: "no matching posting on the company's own careers page",
    });
  }
  const runsCode = RUN_CODE_PATTERNS.some((re) => re.test(body));
  if (runsCode) {
    signals.push({
      id: "run-code-request",
      severity: "strong",
      detail: "asks you to download, install or run code or software",
    });
  }
  if (OFF_PLATFORM_PATTERNS.some((re) => re.test(body))) {
    signals.push({
      id: "off-platform-chat",
      severity: "mild",
      detail: "asks to move the conversation to a messaging app",
    });
  }
  if (PAYMENT_PATTERNS.some((re) => re.test(body))) {
    signals.push({
      id: "asks-for-payment",
      severity: "strong",
      detail: "asks you to pay or front money",
    });
  }

  const strong = signals.filter((s) => s.severity === "strong").length;
  const suspect = strong >= 1 || signals.length >= 2;
  const warn = runsCode || (suspect && signals.some((s) => s.id !== "off-platform-chat"));
  return {
    verdict: suspect ? "suspect" : "clear",
    signals,
    reason: signals.map((s) => s.detail).join("; "),
    warning: suspect && warn ? RUN_CODE_WARNING : null,
  };
}
