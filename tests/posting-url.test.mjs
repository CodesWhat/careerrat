// tests/posting-url.test.mjs — the shared posting-identity URL normalizer and
// the callers that must agree with it: exact tracking keys are stripped,
// identifying params (referenceId=77 vs 78) never collapse.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { closeAll, openDb } from "../src/core/db/connection.mjs";
import { importFromTracker } from "../src/core/db/import-from-tracker.mjs";
import { matchTrackerRecord } from "../src/core/intake/match.mjs";
import { normalizePostingUrl } from "../src/core/scoring/posting-url.mjs";
import { diffSnapshotOffers, offerIdentityKeys } from "../src/core/scoring/sourced-delta.mjs";
import {
  identityKeysWithAliases,
  postingIdentityKeys,
} from "../src/core/scoring/sourced-identity.mjs";

const roots = [];
after(() => {
  closeAll();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const A = "https://careers.example.com/jobs/view?referenceId=77";
const B = "https://careers.example.com/jobs/view?referenceId=78";

test("normalizePostingUrl keeps identifying params and strips exact tracking keys", () => {
  assert.notEqual(normalizePostingUrl(A), normalizePostingUrl(B));
  const base = normalizePostingUrl("https://Careers.Example.com/jobs/view?gh_jid=5&id=9");
  for (const tracked of [
    "https://careers.example.com/jobs/view/?id=9&gh_jid=5&utm_source=x#frag",
    "https://careers.example.com/jobs/view?gh_jid=5&gh_src=abc&id=9",
    "https://careers.example.com/jobs/view?trk=feed&gh_jid=5&id=9&trkInfo=z",
  ]) {
    assert.equal(normalizePostingUrl(tracked), base);
  }
  assert.equal(normalizePostingUrl("not a url "), "not a url");
  assert.equal(normalizePostingUrl(""), "");
});

test("intake match keeps referenceId=77 and 78 apart but matches tracking-only variants", () => {
  const repoRoot = mkdtempSync(join(tmpdir(), "careerrat-posting-url-"));
  roots.push(repoRoot);
  const sourceDir = join(repoRoot, "fixture-source");
  mkdirSync(sourceDir, { recursive: true });
  writeFileSync(
    join(sourceDir, "tracker.json"),
    JSON.stringify({
      meta: {},
      applications: [
        { id: "app-77", company: "Acme", role: "Engineer", status: "applied", link: A },
      ],
      sourced: [],
      sources: [],
      communications: [],
    })
  );
  importFromTracker({ repoRoot, sourceDir });
  const db = openDb({ repoRoot });
  const other = matchTrackerRecord({ db, url: B, company: "Zed", role: "Other" });
  assert.notEqual(other.confidence, "exact_url");
  const same = matchTrackerRecord({
    db,
    url: `${A}&utm_source=news&gh_src=q`,
    company: "Zed",
    role: "Other",
  });
  assert.equal(same.confidence, "exact_url");
});

test("scanner identity and snapshot delta keep referenceId=77 and 78 as distinct postings", () => {
  const keysA = new Set(postingIdentityKeys({ url: A }));
  assert.ok(!postingIdentityKeys({ url: B }).some((key) => keysA.has(key)));
  assert.ok(postingIdentityKeys({ url: `${A}&trk=1` }).some((key) => keysA.has(key)));

  const delta = diffSnapshotOffers({
    previous: [{ company: "Acme", title: "Eng", url: A }],
    current: [{ company: "Acme", title: "Eng", url: B }],
  });
  assert.equal(delta.newOffers.length, 1);
  assert.deepEqual(
    offerIdentityKeys({ url: A }).filter((key) => offerIdentityKeys({ url: B }).includes(key)),
    []
  );
});

test("persisted url aliases written under older normalizers still match", () => {
  const row = { url: A, aliasKeys: ["url:https://careers.example.com/other?id=1&utm_source=x"] };
  const keys = identityKeysWithAliases(row);
  assert.ok(keys.includes("url:https://careers.example.com/other?id=1"));
});
