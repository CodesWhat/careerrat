// Benefits/perks catalog + free-text extractor.
//
// Domain-neutral: this is a generic benefit taxonomy (no candidate/role bias).
// Each entry maps a canonical `key` (stored on the application as `benefits: [key]`)
// to a display emoji + label and the patterns used to detect it in free text
// (job-description body, comp notes). The browser-side dashboard keeps a parallel
// key→{emoji,label} map (dashboard-data.js BENEFIT_EMOJI) for rendering, because
// dashboard-data.js runs in the browser and can't import this server module.
//
// Keys are stable identifiers — change emoji/label freely, but don't rename a key
// without a migration (stored tracker.json rows reference keys).

const BENEFIT_CATALOG = [
  {
    key: "health",
    emoji: "🏥",
    label: "Health insurance",
    pattern:
      /health (insurance|coverage|plan|benefits?)|medical (insurance|coverage|plan|benefits?)|healthcare|comprehensive (medical|health)/i,
  },
  { key: "dental", emoji: "🦷", label: "Dental", pattern: /\bdental\b/i },
  {
    key: "vision",
    emoji: "👁️",
    label: "Vision",
    pattern: /vision (insurance|care|coverage|plan|benefits?)/i,
  },
  {
    key: "hsa",
    emoji: "🏦",
    label: "HSA / FSA",
    pattern: /\bhsa\b|\bfsa\b|health savings account|flexible spending (account|arrangement)/i,
  },
  {
    key: "retirement",
    emoji: "💰",
    label: "401(k) match",
    pattern: /401\(?k\)?|retirement (plan|match|savings|contribution)|employer match|pension/i,
  },
  {
    key: "equity",
    emoji: "📈",
    label: "Equity",
    pattern: /\bequity\b|stock options?|\brsus?\b|restricted stock|stock grant|ownership stake/i,
  },
  {
    key: "bonus",
    emoji: "💵",
    label: "Bonus",
    pattern: /\bbonus(es)?\b|variable comp(ensation)?|performance bonus/i,
  },
  {
    key: "pto",
    emoji: "🏖️",
    label: "Paid time off",
    pattern:
      /\bpto\b|paid time off|unlimited (vacation|pto|time off)|generous (vacation|pto|time off)|flexible time off|vacation days|paid vacation/i,
  },
  {
    key: "parental",
    emoji: "👶",
    label: "Parental / family leave",
    pattern:
      /parental leave|maternity|paternity|family leave|family care|caregiver leave|adoption (leave|assistance|support)|baby bonding/i,
  },
  {
    key: "fertility",
    emoji: "🍼",
    label: "Fertility / family planning",
    pattern: /fertility|family planning|\bivf\b|egg freezing/i,
  },
  {
    key: "mental_health",
    emoji: "🧠",
    label: "Mental health",
    pattern: /mental health|therapy|counseling|\beap\b|employee assistance/i,
  },
  {
    key: "wellness",
    emoji: "🏋️",
    label: "Wellness / gym",
    pattern:
      /wellness (stipend|program|benefit|reimbursement)|gym (membership|reimbursement|stipend)|fitness (stipend|reimbursement|membership)/i,
  },
  {
    key: "remote_stipend",
    emoji: "🏠",
    label: "Remote / home-office stipend",
    pattern:
      /(home.?office|remote.?work|wfh|equipment|internet|workspace) (stipend|budget|allowance|reimbursement)|work.?from.?home stipend/i,
  },
  {
    key: "learning",
    emoji: "📚",
    label: "Learning budget",
    pattern:
      /(learning|education(al)?|professional development|tuition|l&d|career growth|upskilling) (budget|stipend|reimbursement|assistance|allowance)|professional development|tuition reimbursement/i,
  },
  {
    key: "commuter",
    emoji: "🚆",
    label: "Commuter",
    pattern:
      /commuter (benefit|stipend|allowance)|transit (benefit|pass|allowance)|parking (benefit|stipend)/i,
  },
  {
    key: "meals",
    emoji: "🍴",
    label: "Meals",
    pattern:
      /free (lunch|meals|food|snacks|breakfast|dinner)|catered (meals|lunch|food)|daily meals|in-office meals|fully stocked (kitchen|pantry)/i,
  },
  { key: "sabbatical", emoji: "🌴", label: "Sabbatical", pattern: /sabbatical/i },
  {
    key: "pet",
    emoji: "🐶",
    label: "Pet-friendly",
    pattern: /pet insurance|pet-friendly|dog-friendly|bring your dog/i,
  },
];

// Browser-renderable map (key → {emoji, label}), mirrored in dashboard-data.js.
export const BENEFIT_DISPLAY = Object.fromEntries(
  BENEFIT_CATALOG.map(({ key, emoji, label }) => [key, { emoji, label }])
);

// Scan free text and return matched canonical benefit keys in catalog order
// (deduped). Returns [] for empty/no-match input.
export function extractBenefitKeys(...texts) {
  const blob = texts.filter(Boolean).join("\n");
  if (!blob.trim()) return [];
  const found = [];
  for (const { key, pattern } of BENEFIT_CATALOG) {
    if (pattern.test(blob)) found.push(key);
  }
  return found;
}
