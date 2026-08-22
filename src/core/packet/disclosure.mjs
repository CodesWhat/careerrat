// disclosure.mjs — deterministic disclosure lane for packet answers.
//
// Work-authorization, sponsorship, salary-expectation, and notice-period
// questions are structured facts the candidate already gave during
// onboarding (Quick facts persists profile.authorization.work_authorized /
// requires_sponsorship and profile.compensation.expected_base). Those facts
// have no evidence-claim id, so routing them through the AI-answer path
// (which requires a citable claim id) can only ever produce NEEDS YOU — this
// module resolves them locally instead, for free, before the AI ever sees
// them.
//
// PRIVACY (AGENTS.md): compensation.minimum_base and compensation.current_base
// are private gate inputs and must never be read in this file — an outbound
// disclosure answer states expected_base only, or degrades to the NEEDS YOU
// path (via the null return below) when expected_base isn't set.

const CATEGORY_PATTERNS = [
  ["workAuthorization", /\b(legally\s+)?authoriz|work\s+authorization|eligible\s+to\s+work/i],
  ["sponsorship", /sponsor|visa\s+status/i],
  ["salary", /salary|compensation|pay\s+(range|expectation)|base\s+pay/i],
  [
    "noticePeriod",
    /notice\s+period|when\s+can\s+you\s+start|earliest[^?]{0,50}\bstart|want\s+to\s+start\s+working|start\s+date|availability\s+to\s+start/i,
  ],
];

/**
 * Classify a question label into a disclosure category, or null when it
 * isn't one. Matching is case-insensitive substring matching against the
 * category patterns above.
 *
 * @param {string} label
 * @returns {"workAuthorization"|"sponsorship"|"salary"|"noticePeriod"|null}
 */
function classifyDisclosureQuestion(label) {
  const text = String(label || "");
  for (const [category, pattern] of CATEGORY_PATTERNS) {
    if (pattern.test(text)) return category;
  }
  return null;
}

function normalizeLabel(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function screeningAnswerEntries(formDefaults) {
  const raw = formDefaults?.screening_answers;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return [];
  return Object.entries(raw)
    .map(([key, value]) => [normalizeLabel(key), value])
    .filter(([key, value]) => key && value != null && String(value).trim() !== "");
}

// Fuzzy label match against persisted screening answers: normalized-substring
// match, mirroring resolveScreeningAnswer()'s matcher in apply/form-fill.mjs.
function findScreeningAnswer(label, formDefaults) {
  const normalized = normalizeLabel(label);
  if (!normalized) return null;
  for (const [key, value] of screeningAnswerEntries(formDefaults)) {
    if (normalized === key || normalized.includes(key)) return String(value);
  }
  return null;
}

function formatThousands(amount) {
  return Math.round(Number(amount)).toLocaleString("en-US");
}

function profileAnswer(category, profile) {
  const authorization = profile?.authorization || {};
  const compensation = profile?.compensation || {};

  if (category === "workAuthorization") {
    if (authorization.work_authorized === true) {
      return "Yes, I am legally authorized to work.";
    }
    if (authorization.work_authorized === false) return "No.";
    return null;
  }

  if (category === "sponsorship") {
    if (authorization.requires_sponsorship === false) {
      return "No, I do not require sponsorship now or in the future.";
    }
    if (authorization.requires_sponsorship === true) {
      return "Yes, I will require visa sponsorship.";
    }
    return null;
  }

  if (category === "salary") {
    // Outbound only ever states expected_base (the ask), never minimum_base
    // (the private walk-away floor) or current_base. No expected_base on
    // file means there is nothing safe to state — fall through to null so
    // the caller routes this question to the AI-answer path, which degrades
    // to the NEEDS YOU marker (see module doc comment above).
    const expected = Number(compensation.expected_base);
    if (Number.isFinite(expected) && expected > 0) {
      const currency = compensation.currency || "USD";
      return `My target base salary is $${formatThousands(expected)} ${currency} per year; I'm flexible within the posted range depending on level and total compensation.`;
    }
    return null;
  }

  if (category === "noticePeriod") {
    const notice = String(authorization.notice_period || "").trim();
    return notice ? `My notice period is ${notice}.` : null;
  }

  return null;
}

/**
 * Resolve a disclosure question deterministically, without an AI call.
 * Precedence: a persisted screening answer (verbatim) beats a derived
 * profile-fact answer; neither present returns null so the caller can fall
 * back to the AI batch.
 *
 * @param {{label?: string}} question
 * @param {{formDefaults?: object|null, profile?: object|null}} [config]
 * @returns {{answer: string, source: "screening_answers"|"profile"}|null}
 */
export function resolveDisclosureAnswer(question, { formDefaults, profile } = {}) {
  const label = question?.label || "";
  const category = classifyDisclosureQuestion(label);
  if (!category) return null;

  const screening = findScreeningAnswer(label, formDefaults);
  if (screening != null) return { answer: screening, source: "screening_answers" };

  const answer = profileAnswer(category, profile);
  if (answer != null) return { answer, source: "profile" };

  return null;
}
