import assert from "node:assert/strict";
import test from "node:test";

import { renderLocalAgents } from "../src/core/profile/generate-agents.mjs";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const template = "# CareerRat Local Agent Instructions\n\nRouting here.\n";

const profile = {
  candidate: {
    full_name: "Josephine Candidate",
    preferred_name: "Jo",
    email: "jo@example.com",
  },
  compensation: {
    currency: "USD",
    current_base: 199000, // MUST NOT appear in output
    minimum_base: 210000,
    target_base: 240000,
    cash_over_equity: true,
  },
  location: {
    home: "Austin, TX",
    remote: true,
    hybrid: false,
    onsite: false,
  },
  authorization: {
    work_authorized: true,
  },
};

const targeting = {
  role_buckets: [
    {
      name: "Primary",
      priority: "primary",
      titles: ["Forward Deployed Engineer", "Applied AI Engineer"],
    },
    {
      name: "Secondary",
      priority: "secondary",
      titles: ["Solutions Engineer"],
    },
  ],
  keep_signals: ["customer-facing", "AI/ML product"],
  cut_signals: ["core platform SWE", "infrastructure only"],
  excluded_companies: ["MegaCorp Inc", "StealthStartup"],
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test("renderLocalAgents: output starts with the template text", () => {
  const out = renderLocalAgents({ template, profile, targeting });
  assert.ok(out.startsWith(template), "output must begin with the full template text");
});

test("renderLocalAgents: output contains ## Candidate Context header", () => {
  const out = renderLocalAgents({ template, profile, targeting });
  assert.ok(out.includes("## Candidate Context"), "missing ## Candidate Context section");
});

test("renderLocalAgents: output contains preferred_name when present", () => {
  const out = renderLocalAgents({ template, profile, targeting });
  assert.ok(out.includes("Jo"), "preferred name 'Jo' missing from output");
});

test("renderLocalAgents: falls back to full_name when preferred_name absent", () => {
  const p = {
    ...profile,
    candidate: { full_name: "Josephine Candidate", email: "jo@example.com" },
  };
  const out = renderLocalAgents({ template, profile: p, targeting });
  assert.ok(out.includes("Josephine Candidate"), "full_name fallback missing from output");
});

test("renderLocalAgents: output contains a bucket title", () => {
  const out = renderLocalAgents({ template, profile, targeting });
  assert.ok(
    out.includes("Forward Deployed Engineer"),
    "bucket title 'Forward Deployed Engineer' missing from output"
  );
});

test("renderLocalAgents: output contains all role bucket names and priorities", () => {
  const out = renderLocalAgents({ template, profile, targeting });
  assert.ok(out.includes("Primary"), "bucket name 'Primary' missing");
  assert.ok(out.includes("primary"), "priority 'primary' missing");
  assert.ok(out.includes("Secondary"), "bucket name 'Secondary' missing");
  assert.ok(out.includes("secondary"), "priority 'secondary' missing");
});

test("renderLocalAgents: output contains keep signal text", () => {
  const out = renderLocalAgents({ template, profile, targeting });
  assert.ok(out.includes("customer-facing"), "keep signal 'customer-facing' missing");
  assert.ok(out.includes("AI/ML product"), "keep signal 'AI/ML product' missing");
});

test("renderLocalAgents: output contains cut signal text", () => {
  const out = renderLocalAgents({ template, profile, targeting });
  assert.ok(out.includes("core platform SWE"), "cut signal 'core platform SWE' missing");
  assert.ok(out.includes("infrastructure only"), "cut signal 'infrastructure only' missing");
});

test("renderLocalAgents: output contains minimum_base (210000)", () => {
  const out = renderLocalAgents({ template, profile, targeting });
  assert.ok(out.includes("210000"), "minimum_base 210000 missing from output");
});

test("renderLocalAgents: output does NOT contain current_base (199000)", () => {
  const out = renderLocalAgents({ template, profile, targeting });
  assert.ok(!out.includes("199000"), "current_base 199000 must NEVER appear in output");
});

test("renderLocalAgents: output contains excluded companies when non-empty", () => {
  const out = renderLocalAgents({ template, profile, targeting });
  assert.ok(out.includes("MegaCorp Inc"), "excluded company 'MegaCorp Inc' missing");
  assert.ok(out.includes("StealthStartup"), "excluded company 'StealthStartup' missing");
});

test("renderLocalAgents: excluded_companies section absent when empty", () => {
  const t = { ...targeting, excluded_companies: [] };
  const out = renderLocalAgents({ template, profile, targeting: t });
  assert.ok(
    !out.includes("MegaCorp Inc"),
    "excluded companies should not appear when list is empty"
  );
});

test("renderLocalAgents: target_base appears in output", () => {
  const out = renderLocalAgents({ template, profile, targeting });
  assert.ok(out.includes("240000"), "target_base 240000 should appear in output");
});

test("renderLocalAgents: location remote appears in output", () => {
  const out = renderLocalAgents({ template, profile, targeting });
  assert.ok(out.includes("remote"), "location 'remote' missing from output");
});

test("renderLocalAgents: explicit worldwide remote scope is preserved in agent context", () => {
  const p = {
    ...profile,
    location: {
      ...profile.location,
      remote_scope: "worldwide",
      hybrid: true,
      onsite: true,
    },
  };
  const out = renderLocalAgents({ template, profile: p, targeting });

  assert.match(out, /remote \(worldwide\)/);
  assert.match(out, /hybrid/);
  assert.match(out, /onsite/);
  assert.match(out, /home: Austin, TX/);
});

test("renderLocalAgents: home city appears in output", () => {
  const out = renderLocalAgents({ template, profile, targeting });
  assert.ok(out.includes("Austin, TX"), "home city 'Austin, TX' missing from output");
});

test("renderLocalAgents: skips minimum_base when absent", () => {
  const p = {
    ...profile,
    compensation: { currency: "USD", current_base: 199000 },
  };
  const out = renderLocalAgents({ template, profile: p, targeting });
  assert.ok(!out.includes("Minimum base"), "Minimum base line should be absent when not set");
  assert.ok(!out.includes("199000"), "current_base must never appear");
});
