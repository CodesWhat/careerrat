// tests/paste-intake-parity.test.mjs — SSOT parity guard between AGENTS.md's
// human-authored Paste Intake table (source of truth for the product
// contract) and config/paste-intake-routes.json (the machine-readable
// mirror classify.mjs's prompt and the route layer are built from). Drift is
// a red test, not a silent divergence — this parses AGENTS.md's ACTUAL
// markdown table at test time rather than hand-copying its rows, so any
// future edit to either file that isn't mirrored in the other fails loudly
// here. Never rewrites AGENTS.md's table to make this pass — if the two
// files can't map 1:1, that's a real reportable problem, not something this
// test should paper over.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));

// Extract the "| What they pasted | Route to | Captures into |" markdown
// table under AGENTS.md's "## Paste Intake" heading, up to the next line
// that isn't a table row (the "Rules for intake:" prose that follows it).
function parseAgentsMdTable() {
  const text = readFileSync(join(REPO_ROOT, "AGENTS.md"), "utf8");
  const headingIdx = text.indexOf("## Paste Intake");
  assert.ok(headingIdx !== -1, "AGENTS.md must have a '## Paste Intake' heading");
  const afterHeading = text.slice(headingIdx);

  const lines = afterHeading.split("\n");
  const startIdx = lines.findIndex((line) => line.trimStart().startsWith("|"));
  assert.ok(startIdx !== -1, "no markdown table found under '## Paste Intake'");
  // A markdown table is a CONTIGUOUS run of "|"-prefixed lines — stop at the
  // first line that isn't one (prose resumes right after the table), so a
  // later unrelated table further down the document is never swept in.
  const tableLines = [];
  for (let i = startIdx; i < lines.length; i++) {
    if (!lines[i].trimStart().startsWith("|")) break;
    tableLines.push(lines[i]);
  }
  assert.ok(tableLines.length >= 3, "expected a markdown table with a header + separator + rows");

  // tableLines[0] = header row, tableLines[1] = "| --- | --- | --- |" separator,
  // tableLines[2..] = data rows.
  const dataRows = tableLines.slice(2);
  return dataRows.map((line) => {
    const cells = line.split("|");
    // A well-formed "| a | b | c |" row splits into ["", " a ", " b ", " c ", ""] —
    // drop the leading/trailing empty strings from the outer pipes.
    const trimmed = cells.slice(1, -1).map((c) => c.trim());
    assert.equal(trimmed.length, 3, `expected exactly 3 cells in row: ${line}`);
    return { whatTheyPasted: trimmed[0], routeTo: trimmed[1], capturesInto: trimmed[2] };
  });
}

function loadRoutesJson() {
  const text = readFileSync(join(REPO_ROOT, "config/paste-intake-routes.json"), "utf8");
  return JSON.parse(text);
}

function firstSkillFromRoute(routeTo) {
  return routeTo.match(/`([^`]+)`/)?.[1] || null;
}

test("config/paste-intake-routes.json has the SAME NUMBER of rows as AGENTS.md's Paste Intake table", () => {
  const mdRows = parseAgentsMdTable();
  const routesDoc = loadRoutesJson();
  assert.equal(
    routesDoc.routes.length,
    mdRows.length,
    "a row was added/removed in one file without the other — see this file's header comment"
  );
});

test("config/paste-intake-routes.json's whatTheyPasted/routeTo/capturesInto are byte-identical to AGENTS.md's table, in the same order", () => {
  const mdRows = parseAgentsMdTable();
  const routesDoc = loadRoutesJson();

  mdRows.forEach((mdRow, i) => {
    const jsonRow = routesDoc.routes[i];
    assert.ok(jsonRow, `config/paste-intake-routes.json is missing a row at position ${i}`);
    assert.equal(
      jsonRow.whatTheyPasted,
      mdRow.whatTheyPasted,
      `row ${i} ("${jsonRow.id}"): whatTheyPasted drifted from AGENTS.md`
    );
    assert.equal(
      jsonRow.routeTo,
      mdRow.routeTo,
      `row ${i} ("${jsonRow.id}"): routeTo drifted from AGENTS.md`
    );
    assert.equal(
      jsonRow.capturesInto,
      mdRow.capturesInto,
      `row ${i} ("${jsonRow.id}"): capturesInto drifted from AGENTS.md`
    );
  });
});

test("every config/paste-intake-routes.json row has an m9 block (even if status:'deferred'/'needs_you')", () => {
  const routesDoc = loadRoutesJson();
  for (const row of routesDoc.routes) {
    assert.ok(row.m9, `row "${row.id}" is missing its m9 block`);
    assert.ok(
      ["active", "deferred", "needs_you"].includes(row.m9.status),
      `row "${row.id}" has an unrecognized m9.status "${row.m9.status}"`
    );
    assert.ok(Array.isArray(row.m9.kinds), `row "${row.id}"'s m9.kinds must be an array`);
  }
});

test("every m9.kinds entry actually appears in config/intake-classify.schema.json's kind enum", () => {
  const routesDoc = loadRoutesJson();
  const schema = JSON.parse(
    readFileSync(join(REPO_ROOT, "config/intake-classify.schema.json"), "utf8")
  );
  const enumValues = new Set(schema.properties.kind.enum);
  for (const row of routesDoc.routes) {
    for (const kind of row.m9.kinds) {
      assert.ok(
        enumValues.has(kind),
        `row "${row.id}" declares m9.kind "${kind}" which is not in the classify schema's enum`
      );
    }
  }
});

test("active Lane B/C route metadata uses the skill named by the Paste Intake route", () => {
  const routesDoc = loadRoutesJson();
  for (const row of routesDoc.routes) {
    if (!["B", "C"].includes(row.m9.lane)) continue;
    assert.equal(
      row.m9.skill,
      firstSkillFromRoute(row.routeTo),
      `row "${row.id}" has m9.skill drift from its routeTo skill`
    );
  }
});
