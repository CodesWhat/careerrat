import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { verifySmokeHttpSurface } from "../apps/desktop/desktop-smoke.mjs";

describe("desktop smoke HTTP surface verification", () => {
  it("checks health, the selected SPA route, and referenced built assets", async () => {
    const requested = [];
    const report = await verifySmokeHttpSurface({
      baseUrl: "http://127.0.0.1:61234",
      route: "/app/onboarding",
      getOk: async (url) => {
        requested.push(url);
        if (url.endsWith("/api/health")) return '{"ok":true}';
        if (url.endsWith("/app/onboarding")) {
          return '<!doctype html><div id="root"></div><script type="module" src="/app/assets/index-abc.js"></script>';
        }
        if (url.endsWith("/app/assets/index-abc.js")) return "console.log('ok');";
        throw new Error(`unexpected URL ${url}`);
      },
    });

    assert.deepEqual(requested, [
      "http://127.0.0.1:61234/api/health",
      "http://127.0.0.1:61234/app/onboarding",
      "http://127.0.0.1:61234/app/assets/index-abc.js",
    ]);
    assert.deepEqual(report, {
      route: "/app/onboarding",
      assetPaths: ["/app/assets/index-abc.js"],
    });
  });

  it("rejects an error page that finished loading but is not the SPA", async () => {
    await assert.rejects(
      verifySmokeHttpSurface({
        baseUrl: "http://127.0.0.1:61234",
        route: "/app",
        getOk: async (url) => {
          if (url.endsWith("/api/health")) return '{"ok":true}';
          if (url.endsWith("/app")) return "<h1>503 Service Unavailable</h1>";
          return "";
        },
      }),
      /did not return the SPA root/
    );
  });

  it("reports the selected existing-candidate app route and all unique built assets", async () => {
    const report = await verifySmokeHttpSurface({
      baseUrl: "http://127.0.0.1:61234",
      route: "/app",
      getOk: async (url) => {
        if (url.endsWith("/api/health")) return '{"ok":true}';
        if (url.endsWith("/app")) {
          return [
            '<div id="root"></div>',
            '<link rel="stylesheet" href="/app/assets/index-def.css">',
            '<script type="module" src="/app/assets/index-def.js"></script>',
            '<script type="module" src="/app/assets/index-def.js"></script>',
          ].join("");
        }
        if (url.endsWith("/app/assets/index-def.css")) return "body{}";
        if (url.endsWith("/app/assets/index-def.js")) return "console.log('ok');";
        throw new Error(`unexpected URL ${url}`);
      },
    });

    assert.deepEqual(report, {
      route: "/app",
      assetPaths: ["/app/assets/index-def.css", "/app/assets/index-def.js"],
    });
  });
});
