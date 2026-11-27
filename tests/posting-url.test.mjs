// tests/posting-url.test.mjs — the shared posting-identity URL normalizer and
// the callers that must agree with it: exact tracking keys are stripped,
// identifying params (referenceId=77 vs 78) never collapse.
import assert from "node:assert/strict";
import { test } from "node:test";
import { normalizePostingUrl } from "../src/core/scoring/posting-url.mjs";
import { diffSnapshotOffers, offerIdentityKeys } from "../src/core/scoring/sourced-delta.mjs";
import {
  identityKeysWithAliases,
  postingIdentityKeys,
} from "../src/core/scoring/sourced-identity.mjs";

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

test("an unparseable URL falls back to its trimmed, lowercased form", () => {
  assert.equal(normalizePostingUrl("  /Jobs/ABC "), "/jobs/abc");
});

const PS = (seq, extra = "") =>
  `https://hr.example.edu/psc/hrprd/EMPLOYEE/HRMS/c/HRS_HRAM_FL.HRS_CG_SEARCH_FL.GBL?Page=HRS_APP_JBPST_FL&Action=U&JobOpeningId=JR00012345&PostingSeq=${seq}&SiteId=1${extra}`;

test("PeopleSoft posting identity is tenant plus JobOpeningId, whatever PostingSeq answered", () => {
  assert.equal(normalizePostingUrl(PS(1)), normalizePostingUrl(PS(2)));
  assert.equal(normalizePostingUrl(PS(1)), normalizePostingUrl(PS(2, "&trk=x")));
  const other = PS(1).replace("JR00012345", "JR00099999");
  assert.notEqual(normalizePostingUrl(PS(1)), normalizePostingUrl(other));
  const otherTenant = PS(1).replace("hr.example.edu", "jobs.other.edu");
  assert.notEqual(normalizePostingUrl(PS(1)), normalizePostingUrl(otherTenant));

  const tracked = [{ company: "Uni", title: "Analyst", url: PS(1) }];
  const scanned = [{ company: "Uni", title: "Analyst", url: PS(2) }];
  const delta = diffSnapshotOffers({ previous: tracked, current: scanned });
  assert.equal(delta.newOffers.length, 0, "the seq 2 URL is the same opening, not a new row");
  const seen = new Set(postingIdentityKeys({ url: PS(1) }));
  assert.ok(postingIdentityKeys({ url: PS(2) }).some((key) => seen.has(key)));
});
