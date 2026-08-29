import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { effectiveTargetingForRole } from "../src/core/deep-ingest/role-signal-overlay.mjs";
import {
  anyMatched,
  evaluateCompensation,
  evaluateGate,
  matchedTitleBucket,
  matchSignals,
  parseSavedJob,
  renderGateBlock,
} from "../src/core/evaluate/gate.mjs";

import { validate } from "../src/core/profile/schema-validator.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const jobSchema = JSON.parse(readFileSync(join(__dirname, "../config/job.schema.json"), "utf8"));

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const JOB_MD_FIXTURE = `---
company: Acme Corp
role: Senior Solutions Engineer
reqId: req-123
source: linkedin
location: New York, NY
mode: remote
comp: $180,000 - $220,000
status: opened
fitScore:
gate:
dateOpened: 2026-06-01
---

# Job Description

We are looking for a Senior Solutions Engineer with experience in AI, LLM APIs,
and customer deployments. Strong agentic AI and technical deployment skills needed.
Base salary: $180,000 - $220,000 annually.

# Gate Notes

GATE:
FIT:
COMP:
ACTION:
`;

const TARGETING = {
  role_buckets: [
    {
      name: "Solutions Engineering",
      priority: "primary",
      titles: ["Solutions Engineer", "Customer Engineer", "Field Engineer"],
      notes: "Core target",
    },
    {
      name: "OE Opportunities",
      priority: "oe",
      titles: ["OE Director", "OE Principal"],
    },
  ],
  keep_signals: ["agentic ai", "LLM API", "customer deployment", "technical deployment"],
  cut_signals: ["no sponsorship available", "devrel", "must be on-site 5 days"],
  excluded_companies: ["BadCo", "ExcludedInc"],
  degree_policy: "preferred but not required",
};

const PROFILE = {
  candidate: { full_name: "Jane Doe", email: "jane@example.com" },
  compensation: {
    currency: "USD",
    minimum_base: 175000,
    target_base: 160000,
  },
  location: {
    home: "New York",
    remote: true,
    hybrid: true,
    onsite: false,
    relocation: ["Austin", "Seattle"],
  },
  authorization: {
    work_authorized: true,
    requires_sponsorship: false,
  },
};

// ---------------------------------------------------------------------------
// parseSavedJob
// ---------------------------------------------------------------------------

describe("parseSavedJob", () => {
  it("extracts frontmatter fields (company, role)", () => {
    const result = parseSavedJob(JOB_MD_FIXTURE);
    assert.equal(result.frontmatter.company, "Acme Corp");
    assert.equal(result.frontmatter.role, "Senior Solutions Engineer");
    assert.equal(result.frontmatter.source, "linkedin");
  });

  it("extracts body text under # Job Description", () => {
    const result = parseSavedJob(JOB_MD_FIXTURE);
    assert.ok(result.body.includes("Senior Solutions Engineer"));
    assert.ok(result.body.includes("agentic AI"));
  });

  it("extracts gateNotes under # Gate Notes", () => {
    const result = parseSavedJob(JOB_MD_FIXTURE);
    assert.ok(result.gateNotes.includes("GATE:"));
  });

  it("returns empty frontmatter and body when no frontmatter present", () => {
    const result = parseSavedJob("# Job Description\n\nSome text here.\n");
    assert.deepEqual(result.frontmatter, {});
    assert.ok(result.body.includes("Some text here"));
    assert.equal(result.gateNotes, "");
  });

  it("returns empty gateNotes when # Gate Notes section absent", () => {
    const md = "---\ncompany: Foo\nrole: Bar\n---\n\n# Job Description\n\nBody text only.\n";
    const result = parseSavedJob(md);
    assert.equal(result.gateNotes, "");
  });
});

// ---------------------------------------------------------------------------
// matchSignals / anyMatched
// ---------------------------------------------------------------------------

describe("matchSignals", () => {
  it("matches case-insensitively", () => {
    const results = matchSignals("We use LLM API extensively", ["llm api", "devrel"]);
    assert.equal(results[0].matched, true);
    assert.equal(results[1].matched, false);
  });

  it("never throws on null text", () => {
    assert.doesNotThrow(() => matchSignals(null, ["anything"]));
    assert.doesNotThrow(() => matchSignals(undefined, ["anything"]));
  });

  it("returns correct shape", () => {
    const results = matchSignals("hello world", ["hello", "missing"]);
    assert.deepEqual(results[0], { signal: "hello", matched: true });
    assert.deepEqual(results[1], { signal: "missing", matched: false });
  });
});

describe("anyMatched", () => {
  it("returns true when at least one signal matches", () => {
    assert.equal(anyMatched("agentic ai and deployment", ["agentic ai", "blockchain"]), true);
  });

  it("returns false when no signals match", () => {
    assert.equal(anyMatched("random text", ["devrel", "marketing"]), false);
  });
});

// ---------------------------------------------------------------------------
// matchedTitleBucket
// ---------------------------------------------------------------------------

describe("matchedTitleBucket", () => {
  it("returns matching bucket for title substring", () => {
    const bucket = matchedTitleBucket("Senior Solutions Engineer", TARGETING);
    assert.ok(bucket !== null);
    assert.equal(bucket.name, "Solutions Engineering");
  });

  it("returns null when no bucket matches", () => {
    const bucket = matchedTitleBucket("Marketing Manager", TARGETING);
    assert.equal(bucket, null);
  });

  it("matches case-insensitively", () => {
    const bucket = matchedTitleBucket("customer engineer II", TARGETING);
    assert.ok(bucket !== null);
  });
});

// ---------------------------------------------------------------------------
// evaluateCompensation — decision table
// ---------------------------------------------------------------------------

describe("evaluateCompensation", () => {
  it("returns 'clear' when comp band max >= minimum_base", () => {
    const result = evaluateCompensation({
      body: "Base salary: $180,000 - $220,000 annually.",
      frontmatter: { comp: "" },
      profile: PROFILE,
      bucket: TARGETING.role_buckets[0],
    });
    assert.equal(result.verdict, "clear");
    assert.ok(result.band !== null);
  });

  it("returns 'review' when a base range overlaps minimum_base", () => {
    const result = evaluateCompensation({
      body: "Base salary: $160,000 - $190,000 annually.",
      frontmatter: { comp: "" },
      profile: PROFILE,
      bucket: TARGETING.role_buckets[0],
    });
    assert.equal(result.verdict, "review");
    assert.equal(result.basis, "base");
  });

  it("evaluates explicit tipped annual earnings separately from base pay", () => {
    const result = evaluateCompensation({
      body: "Base pay: $11.35 per hour. Estimated annual earnings including tips: $95,000 - $120,000.",
      frontmatter: { comp: "" },
      profile: { compensation: { minimum_annual_earnings: 85_000 } },
      bucket: TARGETING.role_buckets[0],
    });
    assert.equal(result.verdict, "clear");
    assert.equal(result.basis, "annual-earnings");
    assert.deepEqual(result.baseBand, { min: 23_608, max: 23_608 });
    assert.deepEqual(result.annualEarningsBand, { min: 95_000, max: 120_000 });
  });

  it("keeps tipped compensation unverified when only low base pay is posted", () => {
    const result = evaluateCompensation({
      body: "Base pay: $11.35 per hour plus tips.",
      frontmatter: { comp: "" },
      profile: { compensation: { minimum_annual_earnings: 85_000 } },
      bucket: TARGETING.role_buckets[0],
    });
    assert.equal(result.verdict, "review");
    assert.equal(result.basis, "annual-earnings");
    assert.match(result.reason, /annual earnings are unverified/i);
  });

  it("estimates an unposted annual-earnings band from annual cash comparables", () => {
    const result = evaluateCompensation({
      body: "Competitive compensation offered.",
      frontmatter: { role: "Bar Manager", location: "Remote", mode: "remote" },
      profile: { compensation: { minimum_annual_earnings: 85_000 } },
      targeting: {
        role_families: [{ name: "Hospitality Management", patterns: ["bar manager"] }],
      },
      tracker: {
        applications: [
          {
            company: "One",
            role: "Bar Manager",
            loc: "Remote",
            mode: "remote",
            tc: "$70,000 - $80,000",
            compBasis: "annual-earnings",
          },
          {
            company: "Two",
            role: "Bar Manager",
            loc: "Remote",
            mode: "remote",
            tc: "$75,000 - $85,000",
            compBasis: "annual-earnings",
          },
          {
            company: "Three",
            role: "Bar Manager",
            loc: "Remote",
            mode: "remote",
            comp: { tc: "$80,000 - $90,000", basis: "annual-earnings" },
          },
        ],
      },
    });

    assert.equal(result.verdict, "estimated-below-floor");
    assert.equal(result.basis, "annual-earnings");
    assert.equal(result.floor, 85_000);
    assert.equal(result.estimate.compensationBasis, "annual-earnings");
    assert.match(result.reason, /annual earnings/i);
    assert.match(result.reason, /confirm live before deciding/i);
    assert.doesNotMatch(result.reason, /non-cash benefits/i);
  });

  it("keeps annual earnings unverified when tracker comparables contain only base pay", () => {
    const result = evaluateCompensation({
      body: "Competitive compensation offered.",
      frontmatter: { role: "Bar Manager" },
      profile: { compensation: { minimum_annual_earnings: 85_000 } },
      targeting: {
        role_families: [{ name: "Hospitality Management", patterns: ["bar manager"] }],
      },
      tracker: {
        applications: [
          { company: "One", role: "Bar Manager", base: "$70,000 - $80,000" },
          { company: "Two", role: "Bar Manager", base: "$80,000 - $90,000" },
        ],
      },
    });

    assert.equal(result.verdict, "review");
    assert.equal(result.basis, "annual-earnings");
    assert.match(result.reason, /annual earnings are unverified/i);
  });

  it("does not let base comparables satisfy a separate annual-earnings floor", () => {
    const result = evaluateCompensation({
      body: "Competitive compensation offered.",
      frontmatter: { role: "Bar Manager" },
      profile: {
        compensation: { minimum_base: 25_000, minimum_annual_earnings: 85_000 },
      },
      targeting: {
        role_families: [{ name: "Hospitality Management", patterns: ["bar manager"] }],
      },
      tracker: {
        applications: [
          { company: "One", role: "Bar Manager", base: "$70,000 - $80,000" },
          { company: "Two", role: "Bar Manager", base: "$80,000 - $90,000" },
        ],
      },
    });

    assert.equal(result.verdict, "review");
    assert.equal(result.basis, "annual-earnings");
    assert.match(result.reason, /annual earnings are unverified/i);
  });

  it("returns below-floor when explicit annual earnings top out below the floor", () => {
    const result = evaluateCompensation({
      body: "Estimated annual earnings including tips: $60,000 - $75,000.",
      frontmatter: { comp: "" },
      profile: { compensation: { minimum_annual_earnings: 85_000 } },
      bucket: TARGETING.role_buckets[0],
    });
    assert.equal(result.verdict, "below-floor");
    assert.equal(result.basis, "annual-earnings");
  });

  it("keeps a separate base floor unverified when only annual earnings are posted", () => {
    const result = evaluateCompensation({
      body: "Estimated annual earnings including tips: $95,000 - $120,000.",
      frontmatter: { comp: "" },
      profile: {
        compensation: { minimum_base: 25_000, minimum_annual_earnings: 85_000 },
      },
    });

    assert.equal(result.verdict, "review");
    assert.equal(result.basis, "base");
    assert.equal(result.baseBand, null);
    assert.deepEqual(result.annualEarningsBand, { min: 95_000, max: 120_000 });
  });

  it("reads persisted annual cash evidence from frontmatter.tc", () => {
    const result = evaluateCompensation({
      body: "Join our bar team.",
      frontmatter: { comp: "$11.35 per hour", tc: "$95,000 - $120,000" },
      profile: { compensation: { minimum_annual_earnings: 85_000 } },
    });

    assert.equal(result.verdict, "clear");
    assert.equal(result.basis, "annual-earnings");
    assert.deepEqual(result.annualEarningsBand, { min: 95_000, max: 120_000 });
  });

  it("lets a hard base miss win over unknown annual earnings", () => {
    const result = evaluateCompensation({
      body: "Base pay: $11.35 per hour including tips.",
      frontmatter: {},
      profile: {
        compensation: { minimum_base: 25_000, minimum_annual_earnings: 85_000 },
      },
    });

    assert.equal(result.verdict, "below-floor");
    assert.equal(result.basis, "base");
  });

  it("lets a hard annual-earnings miss win over an overlapping base range", () => {
    const result = evaluateCompensation({
      body: "Base salary: $80,000 - $100,000. Estimated annual earnings: $82,000 - $84,000.",
      frontmatter: {},
      profile: {
        compensation: { minimum_base: 90_000, minimum_annual_earnings: 85_000 },
      },
    });

    assert.equal(result.verdict, "below-floor");
    assert.equal(result.basis, "annual-earnings");
  });

  it("returns 'below-floor' when comp band max < minimum_base", () => {
    const result = evaluateCompensation({
      body: "Salary: $100,000 - $140,000 per year.",
      frontmatter: { comp: "" },
      profile: PROFILE,
      bucket: TARGETING.role_buckets[0],
    });
    assert.equal(result.verdict, "below-floor");
  });

  it("returns 'review' when no comp found in JD or frontmatter", () => {
    const result = evaluateCompensation({
      body: "Join our team and grow your career.",
      frontmatter: { comp: "" },
      profile: PROFILE,
      bucket: TARGETING.role_buckets[0],
    });
    assert.equal(result.verdict, "review");
    assert.equal(result.reason, "no comp in JD");
  });

  it("returns 'OE-bucket' for oe priority bucket regardless of comp", () => {
    const result = evaluateCompensation({
      body: "Salary: $100,000 - $120,000.",
      frontmatter: { comp: "" },
      profile: PROFILE,
      bucket: TARGETING.role_buckets[1], // oe
    });
    assert.equal(result.verdict, "OE-bucket");
  });

  it("uses frontmatter.comp when present", () => {
    const result = evaluateCompensation({
      body: "Join our team.",
      frontmatter: { comp: "$190,000 - $230,000" },
      profile: PROFILE,
      bucket: TARGETING.role_buckets[0],
    });
    assert.equal(result.verdict, "clear");
  });

  it("NEVER reads current_base — ignores it even when set", () => {
    const profileWithCurrentBase = {
      ...PROFILE,
      compensation: {
        ...PROFILE.compensation,
        current_base: 999999, // should never be consulted
        minimum_base: 175000,
      },
    };
    // Band max is 140k < minimum_base 175k → should be below-floor.
    // If it incorrectly used current_base (999999) as the floor, it would
    // still be below-floor, but 999999 would be in the reason string.
    const result = evaluateCompensation({
      body: "Salary: $100,000 - $140,000 per year.",
      frontmatter: { comp: "" },
      profile: profileWithCurrentBase,
      bucket: TARGETING.role_buckets[0],
    });
    assert.equal(result.verdict, "below-floor");
    // Reason must reference minimum_base (175,000), NOT current_base (999,999).
    assert.ok(!result.reason.includes("999"), "reason must not reference current_base value");
    assert.ok(result.reason.includes("175"), "reason must reference minimum_base");
  });
});

// ---------------------------------------------------------------------------
// evaluateGate — hard cut scenarios
// ---------------------------------------------------------------------------

describe("evaluateGate — hard cut: cut_signal in body", () => {
  it("gates CUT even when keep_signals also match", () => {
    const job = parseSavedJob(`---
company: Acme Corp
role: Senior Solutions Engineer
---

# Job Description

We use agentic ai and LLM API extensively. No sponsorship available.
This role requires customer deployment experience.

# Gate Notes
`);
    // "no sponsorship available" is a cut_signal AND the authorization test
    // also fires — both should produce CUT.
    const result = evaluateGate({ job, targeting: TARGETING, profile: PROFILE });
    assert.equal(result.gate, "CUT");
    assert.equal(result.action, "cut");
  });

  it("hard cut overrides keep_signal matches — cut_signal in body", () => {
    const job = {
      frontmatter: { company: "GoodCo", role: "Field Engineer" },
      body: "We love agentic AI and customer deployment. Must be on-site 5 days per week.",
    };
    const result = evaluateGate({ job, targeting: TARGETING, profile: PROFILE });
    assert.equal(result.gate, "CUT");
    assert.equal(result.action, "cut");
    assert.ok(result.reasons.some((r) => r.includes("cut signal")));
  });
});

describe("evaluateGate — hard cut: excluded_companies", () => {
  it("gates CUT when company matches excluded_companies", () => {
    const job = {
      frontmatter: { company: "BadCo", role: "Solutions Engineer" },
      body: "Salary: $200,000 - $250,000. Agentic AI deployment role.",
    };
    const result = evaluateGate({ job, targeting: TARGETING, profile: PROFILE });
    assert.equal(result.gate, "CUT");
    assert.equal(result.action, "cut");
    assert.ok(result.reasons.some((r) => r.includes("excluded")));
  });
});

describe("evaluateGate — hard cut: sponsorship mismatch", () => {
  it("gates CUT when requires_sponsorship + JD says no sponsorship", () => {
    const profileNeedsSponsor = {
      ...PROFILE,
      authorization: { work_authorized: false, requires_sponsorship: true },
    };
    const job = {
      frontmatter: { company: "GoodCo", role: "Solutions Engineer" },
      body: "Great role with agentic AI. We do not offer sponsorship for this position.",
    };
    const result = evaluateGate({ job, targeting: TARGETING, profile: profileNeedsSponsor });
    assert.equal(result.gate, "CUT");
    assert.equal(result.action, "cut");
    assert.ok(result.reasons.some((r) => r.includes("sponsorship")));
  });
});

// ---------------------------------------------------------------------------
// evaluateGate — comp review flag
// ---------------------------------------------------------------------------

describe("evaluateGate — comp below floor → REVIEW not CUT", () => {
  it("returns REVIEW with action hold when comp is below floor", () => {
    const job = {
      frontmatter: { company: "GoodCo", role: "Solutions Engineer" },
      body: "Salary: $100,000 - $130,000 annually. We value agentic AI deployment.",
    };
    const result = evaluateGate({ job, targeting: TARGETING, profile: PROFILE });
    assert.equal(result.gate, "REVIEW");
    assert.equal(result.action, "hold");
    assert.equal(result.comp.verdict, "below-floor");
  });
});

// ---------------------------------------------------------------------------
// evaluateGate — OE bucket → REVIEW
// ---------------------------------------------------------------------------

describe("evaluateGate — OE bucket", () => {
  it("comp verdict is OE-bucket and gate is REVIEW", () => {
    const job = {
      frontmatter: { company: "GoodCo", role: "OE Director" },
      body: "Great opportunity. Salary: $200,000 - $250,000. Agentic AI and LLM API focus.",
    };
    const result = evaluateGate({ job, targeting: TARGETING, profile: PROFILE });
    assert.equal(result.comp.verdict, "OE-bucket");
    assert.equal(result.gate, "REVIEW");
  });
});

// ---------------------------------------------------------------------------
// evaluateGate — no comp → REVIEW
// ---------------------------------------------------------------------------

describe("evaluateGate — no comp in JD", () => {
  it("comp verdict is review and gate is REVIEW", () => {
    const job = {
      frontmatter: { company: "GoodCo", role: "Solutions Engineer", comp: "" },
      body: "Join us and work on agentic AI. Competitive compensation offered.",
    };
    const result = evaluateGate({ job, targeting: TARGETING, profile: PROFILE });
    assert.equal(result.comp.verdict, "review");
    assert.equal(result.gate, "REVIEW");
  });
});

// ---------------------------------------------------------------------------
// evaluateGate — clean KEEP
// ---------------------------------------------------------------------------

describe("evaluateGate — clean high-fit primary-bucket job", () => {
  it("returns KEEP with action apply-now", () => {
    const job = {
      frontmatter: {
        company: "GoodCo",
        role: "Solutions Engineer",
        location: "Remote",
        mode: "remote",
        comp: "$190,000 - $240,000",
      },
      body: "We need a Solutions Engineer skilled in agentic AI, LLM API, and customer deployment. Base $190,000 - $240,000 annually.",
    };
    const result = evaluateGate({ job, targeting: TARGETING, profile: PROFILE });
    assert.equal(result.gate, "KEEP");
    assert.equal(result.action, "apply-now");
    assert.equal(result.comp.verdict, "clear");
    assert.ok(["high", "med"].includes(result.fit.tier));
  });
});

describe("confirmed role-signal targeting overlay", () => {
  const roleTargeting = {
    role_families: [{ name: "Applied AI", patterns: ["applied ai engineer"] }],
    keep_signals: ["Agent Workflows"],
    cut_signals: ["Model Training"],
  };

  it("applies only an exact-normalized family and keeps base spelling authoritative in dedupe", () => {
    const result = effectiveTargetingForRole({
      roleTitle: "Senior Applied AI Engineer",
      targeting: roleTargeting,
      roleSignals: [
        {
          id: "keep-duplicate",
          roleFamily: "applied-ai",
          signalType: "keep",
          text: "agent workflows",
        },
        {
          id: "keep-new",
          roleFamily: "Applied_AI",
          signalType: "keep",
          text: "Customer prototypes",
        },
        {
          id: "near-family",
          roleFamily: "applied-ai-platform",
          signalType: "cut",
          text: "Must not fuzzy match",
        },
      ],
    });

    assert.deepEqual(result.targeting.keep_signals, ["Agent Workflows", "Customer prototypes"]);
    assert.deepEqual(result.targeting.cut_signals, ["Model Training"]);
    assert.equal(result.applied.family, "Applied AI");
    assert.deepEqual(
      result.applied.keep.map((row) => row.id),
      ["keep-duplicate", "keep-new"]
    );
    assert.deepEqual(result.applied.cut, []);
  });

  it("returns targeting unchanged for an other or otherwise unresolvable family", () => {
    const result = effectiveTargetingForRole({
      roleTitle: "Unrelated Marketing Manager",
      targeting: roleTargeting,
      roleSignals: [
        {
          id: "must-not-apply",
          roleFamily: "Applied AI",
          signalType: "cut",
          text: "campaign work",
        },
      ],
    });

    assert.strictEqual(result.targeting, roleTargeting);
    assert.deepEqual(result.applied, { family: null, keep: [], cut: [] });
  });

  it("hard-cuts a matching derived cut exactly like a base cut and reports the applied row id", () => {
    const job = {
      frontmatter: { company: "ExampleCo", role: "Applied AI Engineer" },
      body: "This role owns model training and production experimentation.",
    };
    const targeting = {
      role_families: [{ name: "Applied AI", patterns: ["applied ai engineer"] }],
      keep_signals: [],
      cut_signals: [],
      excluded_companies: [],
    };
    const profile = {
      ...PROFILE,
      compensation: { currency: "USD", minimum_base: 98000, target_base: 231000 },
    };
    const baseCut = evaluateGate({
      job,
      targeting: { ...targeting, cut_signals: ["model training"] },
      profile,
    });
    const derivedCut = evaluateGate({
      job,
      targeting,
      profile,
      roleSignals: [
        {
          id: "cut-model-training",
          roleFamily: "applied-ai",
          signalType: "cut",
          text: "model training",
        },
      ],
    });

    assert.deepEqual(
      { gate: derivedCut.gate, action: derivedCut.action, reasons: derivedCut.reasons },
      { gate: baseCut.gate, action: baseCut.action, reasons: baseCut.reasons }
    );
    assert.equal(derivedCut.gate, "CUT");
    assert.deepEqual(derivedCut.appliedRoleSignalIds, ["cut-model-training"]);
  });

  it("keeps the pre-promotion evaluateGate result shape when roleSignals is not passed", () => {
    const result = evaluateGate({
      job: {
        frontmatter: {
          company: "ExampleCo",
          role: "Solutions Engineer",
          comp: "USD 98000-231000",
        },
        body: "Customer deployment work with agentic AI and LLM APIs.",
      },
      targeting: TARGETING,
      profile: { ...PROFILE, compensation: { minimum_base: 98000, target_base: 231000 } },
    });

    assert.equal(
      Object.hasOwn(result, "appliedRoleSignalIds"),
      false,
      "a no-signal call must remain byte-compatible with the pre-promotion return shape"
    );
  });
});

// ---------------------------------------------------------------------------
// renderGateBlock
// ---------------------------------------------------------------------------

describe("renderGateBlock", () => {
  it("returns exactly 4 lines starting GATE:/FIT:/COMP:/ACTION:", () => {
    const job = {
      frontmatter: {
        company: "GoodCo",
        role: "Solutions Engineer",
        comp: "$190,000 - $240,000",
      },
      body: "Agentic AI and LLM API deployment. Base $190,000 - $240,000 per year.",
    };
    const result = evaluateGate({ job, targeting: TARGETING, profile: PROFILE });
    const block = renderGateBlock(result);
    const lines = block.split("\n");
    // KEEP/REVIEW with a configured target_base carries the required COMP ANCHOR
    // line (AGENTS.md gate contract): GATE / FIT / COMP / COMP ANCHOR / ACTION.
    assert.equal(lines.length, 5);
    assert.ok(lines[0].startsWith("GATE:"), `line 0: ${lines[0]}`);
    assert.ok(lines[1].startsWith("FIT:"), `line 1: ${lines[1]}`);
    assert.ok(lines[2].startsWith("COMP:"), `line 2: ${lines[2]}`);
    assert.ok(lines[3].startsWith("COMP ANCHOR:"), `line 3: ${lines[3]}`);
    assert.ok(lines[3].includes("$160,000"), `anchor should state target_base: ${lines[3]}`);
    assert.ok(lines[4].startsWith("ACTION:"), `line 4: ${lines[4]}`);
  });

  it("gate block for a CUT result includes CUT and cut", () => {
    const job = {
      frontmatter: { company: "BadCo", role: "Solutions Engineer" },
      body: "Some role description.",
    };
    const result = evaluateGate({ job, targeting: TARGETING, profile: PROFILE });
    const block = renderGateBlock(result);
    assert.ok(block.includes("CUT"), `Expected CUT in: ${block}`);
    assert.ok(block.includes("ACTION: cut"), `Expected ACTION: cut in: ${block}`);
  });
});

// ---------------------------------------------------------------------------
// config/job.schema.json validation
// ---------------------------------------------------------------------------

describe("config/job.schema.json", () => {
  it("validates a well-formed saved-job object", () => {
    const data = {
      frontmatter: {
        company: "Acme Corp",
        role: "Solutions Engineer",
        reqId: "req-001",
        source: "linkedin",
        location: "Remote",
        mode: "remote",
        comp: "$180,000 - $220,000",
        status: "opened",
        fitScore: null,
        gate: null,
        dateOpened: "2026-06-01",
      },
      body: "Full JD body text here.",
    };
    const { valid, errors } = validate(data, jobSchema);
    assert.equal(valid, true, `Validation errors: ${JSON.stringify(errors)}`);
  });

  it("fails validation when required frontmatter.company is missing", () => {
    const data = {
      frontmatter: { role: "Solutions Engineer" },
      body: "Some body.",
    };
    const { valid } = validate(data, jobSchema);
    assert.equal(valid, false);
  });

  it("fails validation when body is missing", () => {
    const data = {
      frontmatter: { company: "Acme", role: "SWE" },
    };
    const { valid } = validate(data, jobSchema);
    assert.equal(valid, false);
  });
});
