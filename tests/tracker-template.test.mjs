import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { validate } from "../src/core/profile/schema-validator.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));

function trackerWithEvaluationRequirementsRow(row) {
  return {
    applications: [
      {
        id: "app-schema-check",
        company: "Acme",
        role: "Platform Engineer",
        status: "review",
        evaluation: {
          gate: "review",
          fitScore: 50,
          fitBucket: "med",
          fitSummary: "Needs review.",
          fitReasons: [],
          fitRisks: [],
          confidence: "medium",
          evaluatedAt: "2026-01-01T00:00:00.000Z",
          requirements: [row],
        },
      },
    ],
    sourced: [],
    sources: [],
    communications: [],
  };
}

test("tracker template includes communication state", async () => {
  const tracker = JSON.parse(await readFile(`${root}/templates/tracker.json`, "utf8"));

  assert.deepEqual(Object.keys(tracker), ["applications", "sourced", "sources", "communications"]);
  assert.ok(Array.isArray(tracker.communications));
});

test("tracker template is a demo seed: every row flagged demo:true", async () => {
  const tracker = JSON.parse(await readFile(`${root}/templates/tracker.json`, "utf8"));

  // The shipped template seeds demo data so a fresh install has a populated
  // funnel. Every row across every collection must carry demo:true so that
  // stripDemo() clears the entire seed the moment any real row is added.
  for (const key of ["applications", "sourced", "sources", "communications"]) {
    assert.ok(tracker[key].length > 0, `${key} should be seeded with demo rows`);
    for (const row of tracker[key]) {
      assert.equal(row.demo, true, `every ${key} row must be flagged demo:true`);
    }
  }
});

test("tracker schema requires communications collection", async () => {
  const schema = JSON.parse(await readFile(`${root}/config/tracker.schema.json`, "utf8"));

  assert.ok(schema.required.includes("communications"));
  assert.equal(schema.properties.communications.type, "array");
  assert.deepEqual(schema.properties.communications.items.required, ["id", "status", "summary"]);
});

test("tracker schema: an evaluation requirements row must carry all six fields", async () => {
  const schema = JSON.parse(await readFile(`${root}/config/tracker.schema.json`, "utf8"));

  const validRow = {
    requirement: "5+ years production Kubernetes",
    importance: "critical",
    evidence: "stated",
    jdSignal: "5+ years of production Kubernetes required.",
    match: "missing",
    note: "No Kubernetes experience on record.",
  };
  const { valid: validRowOk } = validate(trackerWithEvaluationRequirementsRow(validRow), schema);
  assert.equal(validRowOk, true);

  const { match: _dropped, ...missingMatch } = validRow;
  const { valid: missingMatchOk } = validate(
    trackerWithEvaluationRequirementsRow(missingMatch),
    schema
  );
  assert.equal(missingMatchOk, false, "a row missing match should fail tracker verification");
});

test("tracker schema: an evaluation requirements row rejects an extra field", async () => {
  const schema = JSON.parse(await readFile(`${root}/config/tracker.schema.json`, "utf8"));

  const rowWithExtraField = {
    requirement: "5+ years production Kubernetes",
    importance: "critical",
    evidence: "stated",
    jdSignal: "5+ years of production Kubernetes required.",
    match: "missing",
    note: "No Kubernetes experience on record.",
    confidence: "high",
  };
  const { valid } = validate(trackerWithEvaluationRequirementsRow(rowWithExtraField), schema);
  assert.equal(
    valid,
    false,
    "an extra field on a requirements row should fail tracker verification"
  );
});

test("tracker schema: the requirements key on evaluation stays optional", async () => {
  const schema = JSON.parse(await readFile(`${root}/config/tracker.schema.json`, "utf8"));

  const tracker = {
    applications: [
      {
        id: "app-legacy-eval",
        company: "Acme",
        role: "Platform Engineer",
        status: "review",
        evaluation: {
          gate: "review",
          fitScore: 50,
          fitBucket: "med",
          fitSummary: "Needs review.",
          fitReasons: [],
          fitRisks: [],
          confidence: "medium",
          evaluatedAt: "2026-01-01T00:00:00.000Z",
          // no `requirements` key at all — pre-existing verdict shape.
        },
      },
    ],
    sourced: [],
    sources: [],
    communications: [],
  };
  const { valid, errors } = validate(tracker, schema);
  assert.equal(
    valid,
    true,
    `expected an evaluation without requirements to validate, got: ${errors
      .map((e) => `${e.path}: ${e.message}`)
      .join("; ")}`
  );
});
