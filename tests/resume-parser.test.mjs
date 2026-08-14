import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  deriveEvidenceSeed,
  deriveProfileSeed,
  parseResume,
} from "../src/core/profile/resume-parser.mjs";

const TEST_ROOT = fileURLToPath(new URL("..", import.meta.url));

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

const RESUME = `
Jane Smith
jane.smith@example.com | (555) 123-4567 | https://linkedin.com/in/janesmith | https://github.com/janesmith | https://janesmith.dev

## Summary

Results-driven software engineer with 8 years of experience building scalable systems.
Passionate about clean code and developer tooling.

## Experience

### Senior Software Engineer — Acme Corp (2020–Present)

- Built a distributed job queue that reduced processing latency by 40%
- Led a team of 5 engineers to ship a real-time analytics dashboard
- Implemented automated CI/CD pipelines that cut deployment time from 2 hours to 15 minutes
- Collaborated with product to define quarterly roadmaps

### Software Engineer — Beta Inc (2016–2020)

- Designed and launched a self-service onboarding portal used by 10,000 customers
- Integrated third-party payment APIs including Stripe and PayPal
- Improved test coverage from 30% to 85% across core services
- Participated in on-call rotation

## Skills

Python, JavaScript, TypeScript, Go
Node.js, React, PostgreSQL, Redis
Docker, Kubernetes, AWS, Terraform

## Education

### B.S. Computer Science — State University (2012–2016)

Graduated with honors. GPA 3.8/4.0.

## Projects

### Open Source: job-queue-js (https://github.com/janesmith/job-queue-js)

- Created a zero-dependency job queue library with 500+ GitHub stars
- Delivered comprehensive documentation and examples for contributors
`.trim();

const BARE_LINK_RESUME = `
linkedin.com/in/alexrivera | github.com/alexrivera
Alex Rivera
alex.rivera@example.com

## Experience

- Built reliable developer tooling.
`.trim();

// ---------------------------------------------------------------------------
// parseResume — contact extraction
// ---------------------------------------------------------------------------

test("extracts email from resume", () => {
  const parsed = parseResume(RESUME);
  assert.equal(parsed.contact.email, "jane.smith@example.com");
});

test("extracts phone from resume", () => {
  const parsed = parseResume(RESUME);
  assert.equal(parsed.contact.phone, "(555) 123-4567");
});

test("extracts linkedin URL from resume", () => {
  const parsed = parseResume(RESUME);
  assert.ok(parsed.contact.linkedin.includes("linkedin.com"));
});

test("extracts github URL from resume", () => {
  const parsed = parseResume(RESUME);
  assert.ok(parsed.contact.github.includes("github.com"));
});

test("extracts full name as first name-like line", () => {
  const parsed = parseResume(RESUME);
  assert.equal(parsed.contact.full_name, "Jane Smith");
});

test("extracts portfolio URL (not linkedin or github)", () => {
  const parsed = parseResume(RESUME);
  assert.equal(parsed.contact.portfolio, "https://janesmith.dev");
});

test("extracts full name when it is a markdown H1 title", () => {
  const md = `# Alex Rivera\nalex@example.com | (415) 555-0182\n\n## Experience\n\n- Built things.`;
  const parsed = parseResume(md);
  assert.equal(parsed.contact.full_name, "Alex Rivera");
});

test("portfolio is null when no non-linkedin non-github URL exists", () => {
  const minimal = `Jane Doe\njane@example.com | https://linkedin.com/in/janedoe | https://github.com/janedoe\n\n## Experience\n\nBuilt stuff.`;
  const parsed = parseResume(minimal);
  assert.equal(parsed.contact.portfolio, null);
});

test("normalizes and extracts bare linkedin and github contact URLs", () => {
  const parsed = parseResume(BARE_LINK_RESUME);
  assert.equal(parsed.contact.linkedin, "https://linkedin.com/in/alexrivera");
  assert.equal(parsed.contact.github, "https://github.com/alexrivera");
});

test("normalizes and extracts www-prefixed bare contact URLs", () => {
  const text = `Taylor Morgan\ntaylor@example.com | www.linkedin.com/in/taylormorgan | www.github.com/taylormorgan\n\n## Experience\n\n- Shipped useful software.`;
  const parsed = parseResume(text);
  assert.equal(parsed.contact.linkedin, "https://www.linkedin.com/in/taylormorgan");
  assert.equal(parsed.contact.github, "https://www.github.com/taylormorgan");
});

test("preserves full-scheme contact URLs and deduplicates their bare matches", () => {
  const text = `Jordan Lee\njordan@example.com | https://linkedin.com/in/jordanlee | https://github.com/jordanlee | github.com/jordanlee\n\n## Experience\n\n- Built useful software.`;
  const parsed = parseResume(text);
  assert.equal(parsed.contact.linkedin, "https://linkedin.com/in/jordanlee");
  assert.equal(parsed.contact.github, "https://github.com/jordanlee");
  assert.equal(parsed.links.filter((url) => url === "https://github.com/jordanlee").length, 1);
});

test("does not treat unrelated domains, skill tokens, or pathless hosts as links", () => {
  const text = `Casey Jones\ncasey@example.com | mygithub.com/caseyjones | github.com\n\n## Skills\n\nNode.js, socket.io`;
  const parsed = parseResume(text);
  assert.deepEqual(parsed.links, []);
  assert.equal(parsed.contact.linkedin, null);
  assert.equal(parsed.contact.github, null);
});

test("skips a bare-link-only contact line when detecting the full name", () => {
  const parsed = parseResume(BARE_LINK_RESUME);
  assert.equal(parsed.contact.full_name, "Alex Rivera");
});

// ---------------------------------------------------------------------------
// parseResume — skills tokenization
// ---------------------------------------------------------------------------

test("tokenizes comma-separated skills into individual trimmed tokens", () => {
  const parsed = parseResume(RESUME);
  const { skills } = parsed.sections;
  assert.ok(Array.isArray(skills));
  assert.ok(skills.includes("Python"));
  assert.ok(skills.includes("TypeScript"));
  assert.ok(skills.includes("Go"));
  assert.ok(skills.includes("Kubernetes"));
  assert.ok(skills.includes("Terraform"));
  // Ensure no raw comma-joined strings survived.
  assert.ok(!skills.some((s) => s.includes(",")));
});

test("deduplicates skill tokens", () => {
  const text = `## Skills\nPython, Python, JavaScript`;
  const parsed = parseResume(text);
  const pythonCount = parsed.sections.skills.filter((s) => s === "Python").length;
  assert.equal(pythonCount, 1);
});

// ---------------------------------------------------------------------------
// parseResume — experience blocks
// ---------------------------------------------------------------------------

test("captures experience as raw text blocks split on blank lines", () => {
  const parsed = parseResume(RESUME);
  const { experience } = parsed.sections;
  assert.ok(Array.isArray(experience));
  assert.ok(experience.length >= 2, `expected ≥2 experience blocks, got ${experience.length}`);
  // First block should contain job content.
  assert.ok(experience.some((b) => b.includes("Acme Corp") || b.includes("distributed job queue")));
});

test("ISSUE-004: groups Morgan's blank-spaced PDF text into exactly three employment records", () => {
  const text = readFileSync(
    join(TEST_ROOT, "tests/fixtures/resume/morgan-hale-pdftotext.txt"),
    "utf8"
  );
  const { experience } = parseResume(text).sections;

  assert.equal(experience.length, 3);
  assert.match(experience[0], /^Staff Platform Engineer \| Juniper Relay/);
  assert.match(experience[1], /^Senior Software Engineer \| Northstar Ledger/);
  assert.match(experience[2], /^Software Engineer \| HarborSignal/);
});

test("ISSUE-004: evidence excludes employment metadata and never absorbs the next job header", () => {
  const text = readFileSync(
    join(TEST_ROOT, "tests/fixtures/resume/morgan-hale-pdftotext.txt"),
    "utf8"
  );
  const claims = deriveEvidenceSeed(parseResume(text)).claims;

  assert.equal(claims.length, 10);
  assert.equal(
    claims.some(({ claim }) => /New York, NY|Jersey City, NJ/.test(claim)),
    false
  );
  assert.equal(
    claims.some(({ claim }) =>
      /Staff Platform Engineer|Senior Software Engineer|HarborSignal/.test(claim)
    ),
    false
  );
});

// ---------------------------------------------------------------------------
// parseResume — links collected and unique
// ---------------------------------------------------------------------------

test("collects all unique URLs from the resume", () => {
  const parsed = parseResume(RESUME);
  assert.ok(parsed.links.includes("https://linkedin.com/in/janesmith"));
  assert.ok(parsed.links.includes("https://github.com/janesmith"));
  assert.ok(parsed.links.includes("https://janesmith.dev"));
});

test("links array contains no duplicates", () => {
  const text = `jane@example.com\nhttps://example.com\nhttps://example.com\n\n## Experience\n\nVisit https://example.com for details.`;
  const parsed = parseResume(text);
  const count = parsed.links.filter((u) => u === "https://example.com").length;
  assert.equal(count, 1);
});

// ---------------------------------------------------------------------------
// deriveProfileSeed
// ---------------------------------------------------------------------------

test("deriveProfileSeed returns candidate fields populated from contact", () => {
  const parsed = parseResume(RESUME);
  const seed = deriveProfileSeed(parsed);
  assert.ok(seed.candidate);
  assert.equal(seed.candidate.email, "jane.smith@example.com");
  assert.equal(seed.candidate.full_name, "Jane Smith");
  assert.ok(seed.candidate.linkedin.includes("linkedin.com"));
});

test("deriveProfileSeed omits keys whose contact value is null", () => {
  const minimal = `Jane Doe\njane@example.com\n\n## Experience\n\nBuilt stuff.`;
  const parsed = parseResume(minimal);
  const seed = deriveProfileSeed(parsed);
  // phone, location, linkedin, github, portfolio are not present.
  assert.ok(!Object.hasOwn(seed.candidate, "phone") || seed.candidate.phone !== null);
  // All present keys must have non-null values.
  for (const [k, v] of Object.entries(seed.candidate)) {
    assert.notEqual(v, null, `key "${k}" should not be null in deriveProfileSeed output`);
  }
});

test("deriveProfileSeed carries normalized bare contact URLs end to end", () => {
  const parsed = parseResume(BARE_LINK_RESUME);
  const seed = deriveProfileSeed(parsed);
  assert.equal(seed.candidate.linkedin, "https://linkedin.com/in/alexrivera");
  assert.equal(seed.candidate.github, "https://github.com/alexrivera");
});

test("plain-text contact parsing preserves a full country or state name after the comma", () => {
  const parsed = parseResume("Morgan Hale\nmorgan@example.com | Brooklyn, New York\n");
  assert.equal(parsed.contact.location, "Brooklyn, New York");
});

// ---------------------------------------------------------------------------
// deriveEvidenceSeed
// ---------------------------------------------------------------------------

test("deriveEvidenceSeed returns claim stubs from accomplishment lines", () => {
  const parsed = parseResume(RESUME);
  const seed = deriveEvidenceSeed(parsed);
  assert.ok(Array.isArray(seed.claims));
  assert.ok(seed.claims.length > 0, "expected at least one claim stub");
});

test("claim ids are zero-padded and increment from resume-001", () => {
  const parsed = parseResume(RESUME);
  const { claims } = deriveEvidenceSeed(parsed);
  assert.equal(claims[0].id, "resume-001");
  if (claims.length > 1) {
    assert.equal(claims[1].id, "resume-002");
  }
  if (claims.length > 2) {
    assert.equal(claims[2].id, "resume-003");
  }
  // All ids match the pattern resume-NNN.
  for (const c of claims) {
    assert.match(c.id, /^resume-\d{3}$/);
  }
});

test("claim text is stripped of bullet markers", () => {
  const parsed = parseResume(RESUME);
  const { claims } = deriveEvidenceSeed(parsed);
  for (const c of claims) {
    assert.ok(!c.claim.startsWith("-"), `claim should not start with '-': ${c.claim}`);
    assert.ok(!c.claim.startsWith("*"), `claim should not start with '*': ${c.claim}`);
    assert.ok(!c.claim.startsWith("•"), `claim should not start with '•': ${c.claim}`);
  }
});

test("every claim has the fixed evidence note", () => {
  const parsed = parseResume(RESUME);
  const { claims } = deriveEvidenceSeed(parsed);
  for (const c of claims) {
    assert.equal(c.evidence, "Source: candidate resume (user-provided).");
  }
});

test("claims do NOT contain a metrics field (no fabricated metrics)", () => {
  const parsed = parseResume(RESUME);
  const { claims } = deriveEvidenceSeed(parsed);
  for (const c of claims) {
    assert.ok(!Object.hasOwn(c, "metrics"), `claim ${c.id} must not have a metrics field`);
  }
});

test("a resume with no accomplishment lines yields { claims: [] }", () => {
  const plain = `
John Doe
john@example.com

## Experience

### Engineer at Co

Attended meetings. Worked on projects. Collaborated with the team.

## Skills

Communication, Teamwork
`.trim();
  const parsed = parseResume(plain);
  const seed = deriveEvidenceSeed(parsed);
  assert.deepEqual(seed, { claims: [] });
});

test("accomplishment lines with metrics or strong verbs are captured as claims", () => {
  const parsed = parseResume(RESUME);
  const { claims } = deriveEvidenceSeed(parsed);
  const claimTexts = claims.map((c) => c.claim);

  // Line with a metric (40%) and verb (reduced) should be captured.
  assert.ok(
    claimTexts.some((t) => t.includes("40%") || t.toLowerCase().includes("latency")),
    "expected a claim about latency/40%"
  );
  // Line with verb "Led" should be captured.
  assert.ok(
    claimTexts.some((t) => t.toLowerCase().startsWith("led")),
    "expected a claim starting with 'Led'"
  );
});
