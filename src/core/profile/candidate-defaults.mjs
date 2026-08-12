// candidate-defaults.mjs — the single canonical "genuinely empty" shape for
// each schema-validated candidate config doc: what a brand-new candidate's
// data looks like before they have answered anything. Every value here is
// unset, false, or empty, and the whole shape validates against the doc's
// own JSON Schema.
//
// This is deliberately NOT templates/*.example.yml, which carry an
// illustrative "Jane Candidate" demo persona for CLI users who scaffold a
// workspace and hand-edit the YAML (see candidate-setup.mjs's
// ensureCandidateFiles()). That scaffolding use is legitimate. What is never
// legitimate is treating the example persona as the candidate's own answers:
// demo data must never be read back through the onboarding API as if it were
// real, and must never become the base a real write gets merged onto (doing
// so writes the persona to disk alongside whatever field the candidate
// actually saved). Both the SQLite-backed candidate verbs
// (src/core/db/verbs/candidate.mjs) and the legacy/YAML-mode onboarding
// routes (src/cli/onboard-route.mjs's readBaseDoc()) use this module as
// their one shared source of "empty," so the two modes agree on what
// "nothing answered yet" looks like.
export const CANDIDATE_DEFAULTS = Object.freeze({
  profile: {
    candidate: {
      full_name: "",
      email: "",
      preferred_name: "",
      headline: "",
      phone: "",
      location: "",
      linkedin: "",
      github: "",
      portfolio: "",
      domain: "",
      toolchain: "markdown-only",
    },
    compensation: {
      currency: "USD",
      current_comp_shareable: false,
      current_base: null,
      target_base: null,
      minimum_base: null,
      target_total_comp: null,
      cash_over_equity: true,
      expected_base: null,
      oe_min_base: null,
      oe_max_base: null,
      relo_package_needs: "",
    },
    location: {
      home: "",
      // `remote: true` (unlike hybrid/onsite below) is a deliberate
      // recall-maximizing default the scanning/scoring subsystem relies on
      // (search-prompts.mjs, the sourced scanner's location filter,
      // gate.mjs) so an untouched candidate isn't wrongly filtered out of
      // remote-friendly postings before they've stated a posture. It is
      // NOT reliable evidence that the candidate confirmed anything, so
      // UI progress tracking must not read it as an answered field — see
      // onboard-route.mjs's computeSetupProgress (`quickFacts`), which
      // deliberately excludes bare `remote` from its "answered" check for
      // exactly this reason.
      remote: true,
      hybrid: false,
      onsite: false,
      relocation: [],
      travel_tolerance: "",
    },
    authorization: {
      work_authorized: false,
      requires_sponsorship: false,
      notice_period: "",
    },
  },
  targeting: {
    role_buckets: [],
    keep_signals: [],
    cut_signals: [],
    excluded_companies: [],
    tracked_companies: [],
    degree_policy: "",
    fit_bands: { high_min: 85, med_min: 65 },
    search_preferences: {
      posting_age: { mode: "since-last-run" },
      cadence: { mode: "daily", recommended_from: "default" },
    },
  },
  evidence: { claims: [] },
  honesty: {
    education: { highest_degree: null, add_education_section: false },
    tools: { confirmed: [], adjacent: [], do_not_claim: [] },
    claims: { do_not_fabricate: ["degrees", "employers", "metrics", "tools"] },
    style: { avoid: [] },
  },
  "form-defaults": {
    source: "CareerRat",
    work_authorization: "",
    requires_sponsorship: "",
    current_employer: null,
    current_title: null,
    expected_base: null,
    linkedin: null,
    github: null,
    portfolio: null,
    eeo_default: "Prefer not to answer",
    screening_answers: {},
    document_formats: {
      default_packet_format: "pdf",
      required_export_formats: [],
    },
    confirm_current_role: false,
    auto_submit: false,
  },
  modes: {
    usage_mode: "standard",
    application_mode: "balanced",
    agent_voice: "standard",
  },
  // automation.yml's absence is itself load-bearing ("nothing automated" —
  // see templates/automation.example.yml's own header): an empty object is
  // the correct empty state, not the template's fully-populated (if all-off)
  // consent/capabilities/session structure.
  automation: {},
});

/**
 * Deep clone the canonical empty doc for a candidate config name, or `{}`
 * if the name isn't one of the known singleton docs.
 *
 * @param {string} name
 * @returns {object}
 */
export function cloneCandidateDefault(name) {
  const doc = CANDIDATE_DEFAULTS[name];
  return doc ? JSON.parse(JSON.stringify(doc)) : {};
}

/**
 * True when `doc` is deep-equal to the canonical empty default for `name` —
 * i.e. the candidate has not actually written anything to this config yet,
 * even though a DB row may already exist for it. candidateSetupInitialize()
 * pre-inserts every singleton table with exactly this default at
 * DB-creation time (see ensureSetupRows/putSingletonIfMissing in
 * src/core/db/verbs/candidate.mjs), so "the row exists" is never proof the
 * candidate answered anything — only "the row differs from the default" is.
 * Both the DB-backed doc (readSingleton's untouched-row shape) and the
 * legacy/YAML-mode fallback (readBaseDoc's cloneCandidateDefault() base)
 * produce this exact same default shape, so a plain structural comparison
 * (JSON round-trip normalizes key order/undefined the same way
 * cloneCandidateDefault's own JSON.parse(JSON.stringify(...)) does) is
 * enough — no bespoke per-field emptiness logic needed here.
 *
 * @param {string} name
 * @param {object} doc
 * @returns {boolean}
 */
export function isCandidateDefault(name, doc) {
  const defaultDoc = CANDIDATE_DEFAULTS[name];
  if (!defaultDoc) return false;
  return JSON.stringify(doc) === JSON.stringify(defaultDoc);
}
