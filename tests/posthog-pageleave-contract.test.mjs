import assert from "node:assert/strict";
import test from "node:test";

// Both apps/website and apps/docs carry their own copy of posthog-privacy.ts
// (no shared workspace package between the two Next.js builds — see the
// "Canonical copy" comment atop apps/docs/src/lib/posthog-privacy.ts), so the
// $pageleave/$pathname contract is exercised against both modules here rather
// than picking one.
const MODULES = [
  { label: "website", path: "../apps/website/src/lib/posthog-privacy.ts" },
  { label: "docs", path: "../apps/docs/src/lib/posthog-privacy.ts" },
];

const COOKIELESS_HASH_PROPERTIES = {
  $raw_user_agent: "Mozilla/5.0 (Test Runner)",
  $host: "careerrat.com",
};

const VALID_TOKEN = "phc_project-token";

for (const { label, path } of MODULES) {
  const { sanitizeEvent } = await import(path);

  test(`${label}: before_send rebuilds a posthog-js $pageleave envelope, keeping the cookieless hash fields`, () => {
    // posthog-js emits $pageleave itself once capture_pageleave is true, so
    // it reaches before_send carrying PostHog's own raw properties (no
    // "path" property, only $current_url) rather than ours. Before the
    // sanitizer accepted this branch, sanitizeEvent fell through to the
    // final `return null` and every $pageleave was dropped silently, which
    // is why flipping capture_pageleave alone does not fix zero-duration
    // sessions.
    const result = sanitizeEvent({
      event: "$pageleave",
      uuid: "internal-posthog-id",
      properties: {
        ...COOKIELESS_HASH_PROPERTIES,
        $current_url: "https://careerrat.com/docs/getting-started?token=secret#private",
        token: VALID_TOKEN,
        $cookieless_mode: true,
        $process_person_profile: false,
        $referrer: "https://search.example/private",
        title: "customer private title",
      },
    });

    assert.ok(result);
    assert.equal(result.event, "$pageleave");
    assert.equal(result.properties.path, "/docs/getting-started");
    assert.equal(result.properties.$pathname, "/docs/getting-started");
    assert.equal(result.properties.$raw_user_agent, COOKIELESS_HASH_PROPERTIES.$raw_user_agent);
    assert.equal(result.properties.$host, COOKIELESS_HASH_PROPERTIES.$host);
    // Regression guard for the cookieless server-hash requirement: PostHog's
    // ingestion step reads $raw_user_agent/$host straight off
    // event.properties and drops the event with a
    // cookieless_missing_user_agent / cookieless_missing_host warning if the
    // before_send rebuild ever forgets either one.
    assert.equal("$referrer" in result.properties, false);
    assert.equal("title" in result.properties, false);
  });

  test(`${label}: before_send still drops a $pageleave missing the cookieless hash fields`, () => {
    const withoutUserAgent = sanitizeEvent({
      event: "$pageleave",
      properties: {
        $host: COOKIELESS_HASH_PROPERTIES.$host,
        $current_url: "https://careerrat.com/",
        token: VALID_TOKEN,
        $cookieless_mode: true,
        $process_person_profile: false,
      },
    });
    assert.equal(withoutUserAgent, null);

    const withoutHost = sanitizeEvent({
      event: "$pageleave",
      properties: {
        $raw_user_agent: COOKIELESS_HASH_PROPERTIES.$raw_user_agent,
        $current_url: "https://careerrat.com/",
        token: VALID_TOKEN,
        $cookieless_mode: true,
        $process_person_profile: false,
      },
    });
    assert.equal(withoutHost, null);
  });

  test(`${label}: $pathname never diverges from the sanitized path, for both $pageview and $pageleave`, () => {
    const rawUrls = [
      "https://careerrat.com/",
      "https://careerrat.com/docs/getting-started",
      "https://careerrat.com/private/customer/acme?token=secret#fragment",
      "https://evil.example/docs",
    ];

    for (const event of ["$pageview", "$pageleave"]) {
      for (const rawUrl of rawUrls) {
        const result = sanitizeEvent({
          event,
          properties: {
            ...COOKIELESS_HASH_PROPERTIES,
            $current_url: rawUrl,
            token: VALID_TOKEN,
            $cookieless_mode: true,
            $process_person_profile: false,
          },
        });
        assert.ok(result, `${event} for ${rawUrl} should not be dropped`);
        assert.equal(result.properties.$pathname, result.properties.path);
      }
    }

    // Cross-origin $current_url values collapse to the same OTHER_PATH for
    // both path and $pathname, never leaking the foreign host into either.
    const crossOrigin = sanitizeEvent({
      event: "$pageview",
      properties: {
        ...COOKIELESS_HASH_PROPERTIES,
        $current_url: "https://evil.example/docs",
        token: VALID_TOKEN,
        $cookieless_mode: true,
        $process_person_profile: false,
      },
    });
    assert.ok(crossOrigin);
    assert.equal(crossOrigin.properties.path, "/_other");
    assert.equal(crossOrigin.properties.$pathname, "/_other");
  });

  test(`${label}: manually captured $pageview keeps carrying $pathname`, () => {
    // capturePageview() in instrumentation-client.ts calls
    // posthog.capture("$pageview", { path: sanitizeRoute(url) }) by hand;
    // this is the shape before_send actually receives for that call.
    const result = sanitizeEvent({
      event: "$pageview",
      properties: {
        ...COOKIELESS_HASH_PROPERTIES,
        path: "/docs/getting-started",
        token: VALID_TOKEN,
        $cookieless_mode: true,
        $process_person_profile: false,
      },
    });
    assert.ok(result);
    assert.equal(result.properties.path, "/docs/getting-started");
    assert.equal(result.properties.$pathname, "/docs/getting-started");
  });
}
