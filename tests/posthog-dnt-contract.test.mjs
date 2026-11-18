import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

// Both apps carry their own copy of posthog-privacy.ts and
// instrumentation-client.ts, so the DNT/GPC contract runs against both.
const APPS = ["website", "docs"];

const VALID_PROPERTIES = {
  $raw_user_agent: "Mozilla/5.0 (Test Runner)",
  $host: "careerrat.com",
  token: "phc_project-token",
  $cookieless_mode: true,
  $process_person_profile: false,
};

for (const app of APPS) {
  const { isTrackingOptedOut, sanitizeEvent } = await import(
    `../apps/${app}/src/lib/posthog-privacy.ts`
  );
  const instrumentation = readFileSync(
    new URL(`../apps/${app}/instrumentation-client.ts`, import.meta.url),
    "utf8"
  );

  test(`${app}: isTrackingOptedOut is true for DNT "1" and GPC true`, () => {
    assert.equal(isTrackingOptedOut({ doNotTrack: "1" }), true);
    assert.equal(isTrackingOptedOut({ globalPrivacyControl: true }), true);
    assert.equal(isTrackingOptedOut({ doNotTrack: "0", globalPrivacyControl: true }), true);
  });

  test(`${app}: isTrackingOptedOut is false for anything else`, () => {
    const cases = [
      { doNotTrack: "0" },
      { doNotTrack: "unspecified" },
      { doNotTrack: null },
      { doNotTrack: "yes" },
      { globalPrivacyControl: false },
      { globalPrivacyControl: "true" },
      {},
      undefined,
      null,
    ];
    for (const nav of cases) {
      assert.equal(isTrackingOptedOut(nav), false, JSON.stringify(nav));
    }
  });

  test(`${app}: instrumentation-client guards init, before_send and route transitions`, () => {
    assert.match(instrumentation, /isTrackingOptedOut\(window\.navigator\)/u);
    // The init block is gated on the opt-out check.
    assert.match(
      instrumentation,
      /if\s*\([^)]*!isTrackingOptedOut\(window\.navigator\)[^)]*\)\s*\{\s*posthog\.init/u
    );
    // before_send consults it before sanitizing.
    const beforeSend = instrumentation.match(/before_send:[\s\S]*?sanitizeEvent/u);
    assert.ok(beforeSend, "before_send should call sanitizeEvent");
    assert.match(beforeSend[0], /isTrackingOptedOut\(window\.navigator\)/u);
    // Route transitions capture nothing when opted out.
    const transition = instrumentation.slice(
      instrumentation.indexOf("export function onRouterTransitionStart")
    );
    assert.match(transition, /!isTrackingOptedOut\(window\.navigator\)/u);
    assert.match(instrumentation, /respect_dnt:\s*true/u);
  });

  test(`${app}: sanitizeEvent carries the bare site slug`, () => {
    const result = sanitizeEvent({
      event: "$pageview",
      properties: { ...VALID_PROPERTIES, path: "/" },
    });
    assert.ok(result);
    assert.equal(result.properties.site, "careerrat");
  });
}
