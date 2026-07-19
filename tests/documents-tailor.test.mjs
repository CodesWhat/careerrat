// tests/documents-tailor.test.mjs
// node:test suite for tailor.mjs

import assert from "node:assert/strict";
import { test } from "node:test";
import { lintArtifact } from "../src/core/documents/placeholder-lint.mjs";
import {
  assertNoForbidden,
  buildCoverLetterScaffold,
  buildResumeMarkdown,
  buildShortAnswer,
  forbiddenWordingFor,
  indexEvidence,
  mapClaimsToEvidence,
  selectEvidenceForSignals,
  validateAtsSafe,
} from "../src/core/documents/tailor.mjs";

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

const EVIDENCE_BANK = {
  claims: [
    {
      id: "ai-001",
      claim: "Built production AI workflows from prototype to deployment.",
      evidence: "Led the infra team that shipped three agentic pipelines.",
      metrics: ["3 pipelines shipped"],
      links: ["https://example.com/ai-work"],
      role_signals: ["prototype-to-production", "agentic workflow"],
      allowed_wording: ["production AI workflow"],
      forbidden_wording: ["model training"],
    },
    {
      id: "lead-002",
      claim: "Managed cross-functional teams of 8–12 engineers across two time zones.",
      evidence: "Director-level role at Acme Corp, 2021–2024.",
      metrics: ["8-12 engineers"],
      links: [],
      role_signals: ["engineering management", "cross-functional leadership"],
      allowed_wording: [],
      forbidden_wording: ["hands-on coding"],
    },
    {
      id: "perf-003",
      claim: "Reduced API latency by 40% through caching and query optimization.",
      evidence: "Profiled and optimized the primary read path for the dashboard service.",
      metrics: ["40% latency reduction"],
      links: ["https://example.com/perf"],
      role_signals: ["performance engineering", "backend optimization"],
      allowed_wording: [],
      forbidden_wording: [],
    },
  ],
};

const PROFILE = {
  candidate: {
    full_name: "Alex Rivera",
    email: "alex@example.com",
    phone: "+1-555-0199",
    location: "San Francisco, CA",
    linkedin: "linkedin.com/in/alexrivera",
    github: "github.com/alexrivera",
  },
};

const HONESTY_NO_EDU = {
  education: { add_education_section: false },
  tools: { do_not_claim: ["proprietary framework X"] },
};

const HONESTY_WITH_EDU = {
  education: {
    highest_degree: "B.S. Computer Science, State University",
    add_education_section: true,
  },
  tools: { do_not_claim: [] },
};

// ---------------------------------------------------------------------------
// indexEvidence
// ---------------------------------------------------------------------------

test("indexEvidence returns byId Map and all array", () => {
  const { byId, all } = indexEvidence(EVIDENCE_BANK);
  assert.ok(byId instanceof Map);
  assert.equal(byId.size, 3);
  assert.equal(all.length, 3);
  assert.deepEqual(byId.get("ai-001").claim, EVIDENCE_BANK.claims[0].claim);
});

test("indexEvidence handles empty claims array", () => {
  const { byId, all } = indexEvidence({ claims: [] });
  assert.equal(byId.size, 0);
  assert.deepEqual(all, []);
});

// ---------------------------------------------------------------------------
// selectEvidenceForSignals
// ---------------------------------------------------------------------------

test("selectEvidenceForSignals returns only claims with matching role_signals", () => {
  const selected = selectEvidenceForSignals(EVIDENCE_BANK, ["agentic workflow"]);
  assert.equal(selected.length, 1);
  assert.equal(selected[0].id, "ai-001");
});

test("selectEvidenceForSignals matching is case-insensitive", () => {
  const selected = selectEvidenceForSignals(EVIDENCE_BANK, ["Prototype-To-Production"]);
  assert.equal(selected.length, 1);
  assert.equal(selected[0].id, "ai-001");
});

test("selectEvidenceForSignals returns multiple claims when signals match multiple", () => {
  const selected = selectEvidenceForSignals(EVIDENCE_BANK, [
    "agentic workflow",
    "engineering management",
  ]);
  assert.equal(selected.length, 2);
  const ids = selected.map((c) => c.id);
  assert.ok(ids.includes("ai-001"));
  assert.ok(ids.includes("lead-002"));
});

test("selectEvidenceForSignals returns [] for empty signals array", () => {
  const selected = selectEvidenceForSignals(EVIDENCE_BANK, []);
  assert.deepEqual(selected, []);
});

test("selectEvidenceForSignals deduplicates claims by id", () => {
  // Two signals that both match ai-001
  const selected = selectEvidenceForSignals(EVIDENCE_BANK, [
    "agentic workflow",
    "prototype-to-production",
  ]);
  const ids = selected.map((c) => c.id);
  assert.equal(ids.filter((id) => id === "ai-001").length, 1);
});

test("selectEvidenceForSignals returns [] when no signals match", () => {
  const selected = selectEvidenceForSignals(EVIDENCE_BANK, ["quantum computing"]);
  assert.deepEqual(selected, []);
});

// ---------------------------------------------------------------------------
// mapClaimsToEvidence
// ---------------------------------------------------------------------------

test("mapClaimsToEvidence returns id/claim/evidenceNote/links rows", () => {
  const mapped = mapClaimsToEvidence(EVIDENCE_BANK.claims);
  assert.equal(mapped.length, 3);
  assert.deepEqual(Object.keys(mapped[0]), ["id", "claim", "evidenceNote", "links"]);
  assert.equal(mapped[0].id, "ai-001");
  assert.equal(mapped[0].evidenceNote, EVIDENCE_BANK.claims[0].evidence);
  assert.deepEqual(mapped[0].links, ["https://example.com/ai-work"]);
});

test("mapClaimsToEvidence uses empty string for missing evidence", () => {
  const claims = [{ id: "x", claim: "Did a thing.", links: [] }];
  const mapped = mapClaimsToEvidence(claims);
  assert.equal(mapped[0].evidenceNote, "");
});

test("mapClaimsToEvidence uses empty array for missing links", () => {
  const claims = [{ id: "x", claim: "Did a thing.", evidence: "Real evidence." }];
  const mapped = mapClaimsToEvidence(claims);
  assert.deepEqual(mapped[0].links, []);
});

// ---------------------------------------------------------------------------
// forbiddenWordingFor
// ---------------------------------------------------------------------------

test("forbiddenWordingFor collects claim forbidden_wording", () => {
  const forbidden = forbiddenWordingFor(EVIDENCE_BANK.claims, {});
  assert.ok(forbidden.includes("model training"));
  assert.ok(forbidden.includes("hands-on coding"));
});

test("forbiddenWordingFor includes honesty.tools.do_not_claim", () => {
  const forbidden = forbiddenWordingFor([], {
    tools: { do_not_claim: ["proprietary framework X"] },
  });
  assert.ok(forbidden.includes("proprietary framework X"));
});

test("forbiddenWordingFor deduplicates entries", () => {
  const claims = [
    { forbidden_wording: ["model training"] },
    { forbidden_wording: ["model training"] },
  ];
  const forbidden = forbiddenWordingFor(claims, { tools: { do_not_claim: ["model training"] } });
  assert.equal(forbidden.filter((f) => f.toLowerCase() === "model training").length, 1);
});

test("forbiddenWordingFor handles missing forbidden_wording on claim", () => {
  const claims = [{ id: "x", claim: "Clean claim." }];
  const forbidden = forbiddenWordingFor(claims, {});
  assert.deepEqual(forbidden, []);
});

test("forbiddenWordingFor appends direct confirmed-boundary forbiddenWording as-is", () => {
  const forbidden = forbiddenWordingFor([], {}, [
    {
      boundaryType: "disclosure",
      text: "Prompt-visible context only.",
      forbiddenWording: "Exact Candidate Spelling",
    },
  ]);

  assert.deepEqual(forbidden, ["Exact Candidate Spelling"]);
});

test("forbiddenWordingFor derives the claim phrase from restrictive instruction prefixes", () => {
  const forbidden = forbiddenWordingFor([], {}, [
    { boundaryType: "do_not_claim", text: "Do not claim model training." },
  ]);

  assert.deepEqual(forbidden, ["model training"]);
});

test("forbiddenWordingFor uses the whole restrictive text when no prefix is derivable", () => {
  const forbidden = forbiddenWordingFor([], {}, [
    { boundaryType: "avoid", text: "Keep leadership scope narrowly factual." },
  ]);

  assert.deepEqual(forbidden, ["Keep leadership scope narrowly factual"]);
});

test("forbiddenWordingFor does not derive wording from non-restrictive boundary types", () => {
  const forbidden = forbiddenWordingFor([], {}, [
    { boundaryType: "education_policy", text: "Do not claim model training." },
  ]);

  assert.deepEqual(forbidden, []);
});

test("forbiddenWordingFor deduplicates boundary wording case-insensitively with first spelling", () => {
  const forbidden = forbiddenWordingFor(
    [{ forbidden_wording: ["Model Training"] }],
    { tools: { do_not_claim: ["model training"] } },
    [
      { forbiddenWording: "MODEL TRAINING" },
      { boundaryType: "do_not_claim", text: "Do not claim model training." },
    ]
  );

  assert.deepEqual(forbidden, ["Model Training"]);
});

test("forbiddenWordingFor never treats allowedWording as forbidden", () => {
  const forbidden = forbiddenWordingFor([], {}, [
    {
      boundaryType: "disclosure",
      text: "Use the confirmed disclosure.",
      allowedWording: "Allowed candidate wording",
    },
  ]);

  assert.equal(forbidden.includes("Allowed candidate wording"), false);
  assert.deepEqual(forbidden, []);
});

// ---------------------------------------------------------------------------
// assertNoForbidden
// ---------------------------------------------------------------------------

test("assertNoForbidden returns true for clean text", () => {
  const result = assertNoForbidden("Built scalable systems for enterprise clients.", [
    "model training",
  ]);
  assert.equal(result, true);
});

test("assertNoForbidden throws when forbidden phrase appears in text", () => {
  assert.throws(
    () => assertNoForbidden("Led model training for our AI platform.", ["model training"]),
    (err) => {
      assert.ok(err instanceof Error);
      assert.ok(err.message.includes("model training"), `phrase not in: ${err.message}`);
      return true;
    }
  );
});

test("assertNoForbidden check is case-insensitive", () => {
  assert.throws(() => assertNoForbidden("Led MODEL TRAINING efforts.", ["model training"]), Error);
});

test("assertNoForbidden lists all hits in error message", () => {
  assert.throws(
    () =>
      assertNoForbidden("Hands-on coding and model training daily.", [
        "model training",
        "hands-on coding",
      ]),
    (err) => {
      assert.ok(err.message.includes("model training"));
      assert.ok(err.message.includes("hands-on coding"));
      return true;
    }
  );
});

// ---------------------------------------------------------------------------
// buildResumeMarkdown
// ---------------------------------------------------------------------------

test("buildResumeMarkdown includes candidate name in header", () => {
  const md = buildResumeMarkdown({
    profile: PROFILE,
    evidence: EVIDENCE_BANK,
    job: { signals: ["agentic workflow"] },
    honesty: HONESTY_NO_EDU,
  });
  assert.ok(md.includes("Alex Rivera"), `name not found in:\n${md}`);
});

test("buildResumeMarkdown includes candidate email", () => {
  const md = buildResumeMarkdown({
    profile: PROFILE,
    evidence: EVIDENCE_BANK,
    job: { signals: ["agentic workflow"] },
    honesty: HONESTY_NO_EDU,
  });
  assert.ok(md.includes("alex@example.com"));
});

test("buildResumeMarkdown includes verbatim evidence claim bullet", () => {
  const md = buildResumeMarkdown({
    profile: PROFILE,
    evidence: EVIDENCE_BANK,
    job: { signals: ["agentic workflow"] },
    honesty: HONESTY_NO_EDU,
  });
  assert.ok(
    md.includes("Built production AI workflows from prototype to deployment."),
    `claim not found in:\n${md}`
  );
});

test("buildResumeMarkdown omits Education section when add_education_section is false", () => {
  const md = buildResumeMarkdown({
    profile: PROFILE,
    evidence: EVIDENCE_BANK,
    job: { signals: ["agentic workflow"] },
    honesty: HONESTY_NO_EDU,
  });
  assert.ok(!md.includes("## Education"), `Education section found unexpectedly in:\n${md}`);
});

test("buildResumeMarkdown includes Education section when add_education_section is true", () => {
  const md = buildResumeMarkdown({
    profile: PROFILE,
    evidence: EVIDENCE_BANK,
    job: { signals: ["agentic workflow"] },
    honesty: HONESTY_WITH_EDU,
  });
  assert.ok(md.includes("## Education"), `Education section missing from:\n${md}`);
  assert.ok(md.includes("B.S. Computer Science"));
});

test("buildResumeMarkdown falls back to all claims when no signals match", () => {
  const md = buildResumeMarkdown({
    profile: PROFILE,
    evidence: EVIDENCE_BANK,
    job: { signals: ["quantum computing"] },
    honesty: HONESTY_NO_EDU,
  });
  // Should include all three claims as fallback
  assert.ok(md.includes("Built production AI workflows"));
  assert.ok(md.includes("Managed cross-functional teams"));
  assert.ok(md.includes("Reduced API latency"));
});

test("buildResumeMarkdown includes optional summary only when provided", () => {
  const withSummary = buildResumeMarkdown({
    profile: PROFILE,
    evidence: EVIDENCE_BANK,
    job: { signals: [] },
    honesty: HONESTY_NO_EDU,
    summary: "Engineering leader with a track record of shipping AI products.",
  });
  assert.ok(withSummary.includes("## Summary"));
  assert.ok(withSummary.includes("Engineering leader"));

  const withoutSummary = buildResumeMarkdown({
    profile: PROFILE,
    evidence: EVIDENCE_BANK,
    job: { signals: [] },
    honesty: HONESTY_NO_EDU,
  });
  assert.ok(!withoutSummary.includes("## Summary"));
});

test("buildResumeMarkdown throws when a forbidden wording appears in selected claim text", () => {
  // Create a bank where the selected claim itself contains forbidden wording
  // (edge case: if a claim's own text matched its forbidden_wording list)
  const trickyBank = {
    claims: [
      {
        id: "t-001",
        claim: "Led model training for the research team.",
        evidence: "Real project.",
        role_signals: ["research"],
        forbidden_wording: ["model training"],
        links: [],
      },
    ],
  };
  assert.throws(
    () =>
      buildResumeMarkdown({
        profile: PROFILE,
        evidence: trickyBank,
        job: { signals: ["research"] },
        honesty: HONESTY_NO_EDU,
      }),
    (err) => {
      assert.ok(err.message.includes("model training"));
      return true;
    }
  );
});

test("buildResumeMarkdown output passes lintArtifact (no placeholders)", () => {
  const md = buildResumeMarkdown({
    profile: PROFILE,
    evidence: EVIDENCE_BANK,
    job: { signals: ["agentic workflow"] },
    honesty: HONESTY_NO_EDU,
  });
  const { clean } = lintArtifact(md);
  assert.equal(clean, true);
});

test("buildResumeMarkdown output passes validateAtsSafe", () => {
  const md = buildResumeMarkdown({
    profile: PROFILE,
    evidence: EVIDENCE_BANK,
    job: { signals: ["agentic workflow"] },
    honesty: HONESTY_NO_EDU,
  });
  const { ok } = validateAtsSafe(md);
  assert.equal(ok, true);
});

test("buildResumeMarkdown includes linkedin when present", () => {
  const md = buildResumeMarkdown({
    profile: PROFILE,
    evidence: EVIDENCE_BANK,
    job: { signals: [] },
    honesty: HONESTY_NO_EDU,
  });
  assert.ok(md.includes("linkedin.com/in/alexrivera"));
});

// ---------------------------------------------------------------------------
// buildCoverLetterScaffold
// ---------------------------------------------------------------------------

test("buildCoverLetterScaffold throws on empty blocks array", () => {
  assert.throws(
    () =>
      buildCoverLetterScaffold({
        profile: PROFILE,
        job: { frontmatter: { company: "Acme Corp", role: "Staff Engineer" } },
        evidence: EVIDENCE_BANK,
        blocks: [],
      }),
    (err) => {
      assert.ok(err instanceof Error);
      assert.ok(err.message.includes("supply"), `message was: ${err.message}`);
      return true;
    }
  );
});

test("buildCoverLetterScaffold throws on empty blocks object", () => {
  assert.throws(
    () =>
      buildCoverLetterScaffold({
        profile: PROFILE,
        job: { frontmatter: {} },
        evidence: EVIDENCE_BANK,
        blocks: {},
      }),
    Error
  );
});

test("buildCoverLetterScaffold assembles a complete letter from provided blocks", () => {
  const letter = buildCoverLetterScaffold({
    profile: PROFILE,
    job: { frontmatter: { company: "Acme Corp", role: "Staff Engineer" } },
    evidence: EVIDENCE_BANK,
    blocks: [
      "I am excited to apply for the Staff Engineer role.",
      "My experience shipping production AI systems aligns with your team's mission.",
    ],
  });
  assert.ok(letter.includes("Acme Corp"), `company not in: ${letter}`);
  assert.ok(letter.includes("Alex Rivera"), `name not in: ${letter}`);
  assert.ok(letter.includes("I am excited to apply for the Staff Engineer role."));
  assert.ok(letter.includes("My experience shipping production AI systems"));
  assert.ok(letter.includes("Sincerely,"));
});

test("buildCoverLetterScaffold includes greeting derived from company", () => {
  const letter = buildCoverLetterScaffold({
    profile: PROFILE,
    job: { frontmatter: { company: "Acme Corp" } },
    evidence: EVIDENCE_BANK,
    blocks: ["Paragraph about my background."],
  });
  assert.ok(letter.includes("Dear Acme Corp Hiring Team,"));
});

test("buildCoverLetterScaffold uses generic greeting when no company provided", () => {
  const letter = buildCoverLetterScaffold({
    profile: PROFILE,
    job: { frontmatter: {} },
    evidence: EVIDENCE_BANK,
    blocks: ["Paragraph about my background."],
  });
  assert.ok(letter.includes("Dear Hiring Team,"));
});

test("buildCoverLetterScaffold accepts blocks as object values", () => {
  const letter = buildCoverLetterScaffold({
    profile: PROFILE,
    job: { frontmatter: { company: "Beta Inc" } },
    evidence: EVIDENCE_BANK,
    blocks: {
      opening: "I am writing to express my interest.",
      body: "My background spans AI product and platform engineering.",
    },
  });
  assert.ok(letter.includes("I am writing to express my interest."));
  assert.ok(letter.includes("My background spans AI product"));
});

// ---------------------------------------------------------------------------
// validateAtsSafe
// ---------------------------------------------------------------------------

test("validateAtsSafe returns ok for plain ATS-safe markdown", () => {
  const md =
    "# Alex Rivera\n\n## Experience\n\n- Led platform migrations.\n- Mentored engineers.\n\n**Skills:** Python, Go";
  const { ok, issues } = validateAtsSafe(md);
  assert.equal(ok, true);
  assert.deepEqual(issues, []);
});

test("validateAtsSafe flags a markdown table", () => {
  const md = "| Column A | Column B |\n|----------|----------|\n| value 1  | value 2  |";
  const { ok, issues } = validateAtsSafe(md);
  assert.equal(ok, false);
  assert.ok(
    issues.some((i) => i.includes("table")),
    `issues: ${issues}`
  );
});

test("validateAtsSafe flags markdown images", () => {
  const { ok, issues } = validateAtsSafe("Here is my logo: ![logo](logo.png)");
  assert.equal(ok, false);
  assert.ok(issues.some((i) => i.includes("image")));
});

test("validateAtsSafe flags HTML tags", () => {
  const { ok, issues } = validateAtsSafe("Name: <b>Alex Rivera</b>");
  assert.equal(ok, false);
  assert.ok(issues.some((i) => i.includes("HTML")));
});

test("validateAtsSafe flags tab characters", () => {
  const { ok, issues } = validateAtsSafe("Item:\tvalue");
  assert.equal(ok, false);
  assert.ok(issues.some((i) => i.includes("tab")));
});

// ---------------------------------------------------------------------------
// buildShortAnswer
// ---------------------------------------------------------------------------

test("buildShortAnswer returns trimmed answer for valid input", () => {
  const result = buildShortAnswer({
    question: "Why do you want to work here?",
    answer: "  I admire the team's commitment to shipping reliable infrastructure.  ",
    honesty: HONESTY_NO_EDU,
    forbidden: [],
  });
  assert.equal(result, "I admire the team's commitment to shipping reliable infrastructure.");
});

test("buildShortAnswer throws for empty answer", () => {
  assert.throws(
    () =>
      buildShortAnswer({
        question: "Why this role?",
        answer: "   ",
        honesty: HONESTY_NO_EDU,
        forbidden: [],
      }),
    (err) => {
      assert.ok(err.message.includes("empty"));
      return true;
    }
  );
});

test("buildShortAnswer throws for answer with placeholder", () => {
  assert.throws(
    () =>
      buildShortAnswer({
        question: "Describe a challenge.",
        answer: "I overcame [insert challenge here] through teamwork.",
        honesty: HONESTY_NO_EDU,
        forbidden: [],
      }),
    (err) => {
      assert.ok(err.message.includes("placeholder"));
      return true;
    }
  );
});

test("buildShortAnswer throws for answer with forbidden wording", () => {
  assert.throws(
    () =>
      buildShortAnswer({
        question: "Describe your ML experience.",
        answer: "I have extensive model training experience.",
        honesty: HONESTY_NO_EDU,
        forbidden: ["model training"],
      }),
    (err) => {
      assert.ok(err.message.includes("model training"));
      return true;
    }
  );
});
