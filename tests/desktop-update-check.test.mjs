import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  buildRequestHeaders,
  CHECK_INTERVAL_MS,
  compareVersions,
  DEFAULT_STATE,
  fetchLatestRelease,
  GITHUB_RELEASES_URL,
  isNewerVersion,
  mergeCheckedState,
  resolveUpdateResult,
  runUpdateCheck,
  shouldCheckNow,
  shouldNotify,
  withCheckRecorded,
  withEnabled,
  withSkippedVersion,
} from "../apps/desktop/update-check.mjs";

describe("compareVersions", () => {
  it("orders multi-digit minor versions correctly (not as strings)", () => {
    // The naive string-comparison trap: "0.10.0" < "0.9.0" lexicographically,
    // but 0.10.0 is the newer release.
    assert.equal(compareVersions("0.9.0", "0.10.0"), -1);
    assert.equal(compareVersions("0.10.0", "0.9.0"), 1);
  });

  it("orders patch versions correctly", () => {
    assert.equal(compareVersions("0.9.0", "0.9.1"), -1);
    assert.equal(compareVersions("0.9.1", "0.9.0"), 1);
  });

  it("treats equal versions as equal", () => {
    assert.equal(compareVersions("0.9.0", "0.9.0"), 0);
    assert.equal(compareVersions("v0.9.0", "0.9.0"), 0);
  });

  it("treats an unparseable version as older than a parseable one", () => {
    assert.equal(compareVersions("", "0.9.0"), -1);
    assert.equal(compareVersions("0.9.0", ""), 1);
    assert.equal(compareVersions("", ""), 0);
  });

  it("ranks a release candidate below the same version's GA release", () => {
    // The bug this guards: GitHub's /releases/latest only ever returns GA,
    // so an rc user must compare as older than GA or they never hear about
    // the version that already shipped.
    assert.equal(compareVersions("0.9.0-rc.1", "0.9.0"), -1);
    assert.equal(compareVersions("0.9.0", "0.9.0-rc.1"), 1);
  });

  it("orders release candidates of the same version numerically", () => {
    assert.equal(compareVersions("0.9.0-rc.1", "0.9.0-rc.2"), -1);
    assert.equal(compareVersions("0.9.0-rc.2", "0.9.0-rc.1"), 1);
  });

  it("orders a release candidate below the next version's GA release", () => {
    assert.equal(compareVersions("0.9.0-rc.2", "0.9.1"), -1);
    assert.equal(compareVersions("0.9.1", "0.9.0-rc.2"), 1);
  });
});

describe("isNewerVersion", () => {
  it("is true only when the candidate outranks the current version", () => {
    assert.equal(isNewerVersion("0.9.0", "0.10.0"), true);
    assert.equal(isNewerVersion("0.10.0", "0.9.0"), false);
    assert.equal(isNewerVersion("0.9.0", "0.9.0"), false);
  });

  it("is false for missing input", () => {
    assert.equal(isNewerVersion(null, "0.9.0"), false);
    assert.equal(isNewerVersion("0.9.0", null), false);
  });
});

describe("shouldCheckNow", () => {
  const now = Date.parse("2026-08-18T00:00:00Z");

  it("is false when disabled, regardless of elapsed time", () => {
    assert.equal(shouldCheckNow({ enabled: false, lastCheckedAt: null, now }), false);
  });

  it("is true when there is no prior check", () => {
    assert.equal(shouldCheckNow({ enabled: true, lastCheckedAt: null, now }), true);
  });

  it("is false before the interval elapses", () => {
    const lastCheckedAt = now - (CHECK_INTERVAL_MS - 1000);
    assert.equal(shouldCheckNow({ enabled: true, lastCheckedAt, now }), false);
  });

  it("is true once the interval has elapsed", () => {
    const lastCheckedAt = now - CHECK_INTERVAL_MS;
    assert.equal(shouldCheckNow({ enabled: true, lastCheckedAt, now }), true);
  });

  it("treats an unparseable lastCheckedAt as due", () => {
    assert.equal(shouldCheckNow({ enabled: true, lastCheckedAt: "not-a-date", now }), true);
  });
});

describe("resolveUpdateResult", () => {
  it("reports an update available with its .dmg asset", () => {
    const result = resolveUpdateResult({
      currentVersion: "0.9.0",
      release: {
        tag_name: "v0.10.0",
        html_url: "https://github.com/CodesWhat/careerrat/releases/tag/v0.10.0",
        assets: [
          {
            name: "CareerRat-0.10.0-arm64.dmg",
            browser_download_url:
              "https://github.com/CodesWhat/careerrat/releases/download/v0.10.0/CareerRat-0.10.0-arm64.dmg",
          },
        ],
      },
    });

    assert.deepEqual(result, {
      updateAvailable: true,
      version: "0.10.0",
      releaseUrl: "https://github.com/CodesWhat/careerrat/releases/tag/v0.10.0",
      dmgUrl:
        "https://github.com/CodesWhat/careerrat/releases/download/v0.10.0/CareerRat-0.10.0-arm64.dmg",
    });
  });

  it("rejects a release URL that isn't on github.com, even over https", () => {
    // Defense in depth: a compromised or MITM'd API response returning a
    // plausible https:// URL on another host must not reach the renderer.
    const result = resolveUpdateResult({
      currentVersion: "0.9.0",
      release: { tag_name: "v0.10.0", html_url: "https://evil.example.com/release", assets: [] },
    });

    assert.equal(result.releaseUrl, null);
  });

  it("rejects a release URL that isn't https, even on github.com", () => {
    const result = resolveUpdateResult({
      currentVersion: "0.9.0",
      release: {
        tag_name: "v0.10.0",
        html_url: "http://github.com/CodesWhat/careerrat/releases/tag/v0.10.0",
        assets: [],
      },
    });

    assert.equal(result.releaseUrl, null);
  });

  it("rejects a .dmg asset URL that isn't on github.com", () => {
    const result = resolveUpdateResult({
      currentVersion: "0.9.0",
      release: {
        tag_name: "v0.10.0",
        html_url: "https://github.com/CodesWhat/careerrat/releases/tag/v0.10.0",
        assets: [
          {
            name: "CareerRat-0.10.0-arm64.dmg",
            browser_download_url: "https://evil.example.com/CareerRat-0.10.0-arm64.dmg",
          },
        ],
      },
    });

    assert.equal(result.dmgUrl, null);
  });

  it("reports an update available when the running version is a release candidate and GitHub's latest is that version's GA", () => {
    // GitHub's /releases/latest excludes prereleases, so a pilot user running
    // "0.9.0-rc.1" who is due for a check always gets the GA release payload
    // back. They must be notified, not compared as already current.
    const result = resolveUpdateResult({
      currentVersion: "0.9.0-rc.1",
      release: { tag_name: "v0.9.0", html_url: "https://example.com", assets: [] },
    });

    assert.equal(result.updateAvailable, true);
    assert.equal(result.version, "0.9.0");
  });

  it("reports no update available when already current", () => {
    const result = resolveUpdateResult({
      currentVersion: "0.9.0",
      release: { tag_name: "v0.9.0", html_url: "https://example.com", assets: [] },
    });

    assert.equal(result.updateAvailable, false);
  });

  it("reports no update available when the release is older than current", () => {
    const result = resolveUpdateResult({
      currentVersion: "0.9.0",
      release: { tag_name: "v0.8.0", html_url: "https://example.com", assets: [] },
    });

    assert.equal(result.updateAvailable, false);
  });

  it("resolves a null dmgUrl when the release shipped no .dmg asset", () => {
    const result = resolveUpdateResult({
      currentVersion: "0.9.0",
      release: {
        tag_name: "v0.10.0",
        html_url: "https://example.com",
        assets: [{ name: "source.zip", browser_download_url: "https://example.com/source.zip" }],
      },
    });

    assert.equal(result.updateAvailable, true);
    assert.equal(result.dmgUrl, null);
  });

  it("degrades to a no-op result for a missing or malformed release payload", () => {
    assert.deepEqual(resolveUpdateResult({ currentVersion: "0.9.0", release: null }), {
      updateAvailable: false,
      version: null,
      releaseUrl: null,
      dmgUrl: null,
    });
    assert.deepEqual(resolveUpdateResult({ currentVersion: "0.9.0", release: {} }), {
      updateAvailable: false,
      version: null,
      releaseUrl: null,
      dmgUrl: null,
    });
    assert.deepEqual(resolveUpdateResult({ currentVersion: "0.9.0", release: { tag_name: 42 } }), {
      updateAvailable: false,
      version: null,
      releaseUrl: null,
      dmgUrl: null,
    });
  });
});

describe("shouldNotify", () => {
  it("is true for an available update that was not skipped", () => {
    assert.equal(
      shouldNotify({ result: { updateAvailable: true, version: "0.10.0" }, skippedVersion: null }),
      true
    );
  });

  it("is false once that exact version has been skipped", () => {
    assert.equal(
      shouldNotify({
        result: { updateAvailable: true, version: "0.10.0" },
        skippedVersion: "0.10.0",
      }),
      false
    );
  });

  it("is true again for a newer version than the one skipped", () => {
    assert.equal(
      shouldNotify({
        result: { updateAvailable: true, version: "0.11.0" },
        skippedVersion: "0.10.0",
      }),
      true
    );
  });

  it("is false when there is no update available", () => {
    assert.equal(shouldNotify({ result: { updateAvailable: false, version: null } }), false);
  });
});

describe("state helpers", () => {
  it("withCheckRecorded stamps lastCheckedAt and preserves other fields", () => {
    const next = withCheckRecorded({ ...DEFAULT_STATE, enabled: true }, { checkedAt: 12345 });
    assert.equal(next.lastCheckedAt, 12345);
    assert.equal(next.enabled, true);
  });

  it("withSkippedVersion records the skipped version", () => {
    const next = withSkippedVersion(DEFAULT_STATE, "0.10.0");
    assert.equal(next.skippedVersion, "0.10.0");
  });

  it("withEnabled coerces to a boolean and preserves other fields", () => {
    const next = withEnabled({ ...DEFAULT_STATE, skippedVersion: "0.10.0" }, false);
    assert.equal(next.enabled, false);
    assert.equal(next.skippedVersion, "0.10.0");
  });
});

describe("buildRequestHeaders", () => {
  it("carries no candidate data or identifiers, only a User-Agent and Accept", () => {
    const headers = buildRequestHeaders();
    assert.deepEqual(Object.keys(headers).sort(), ["Accept", "User-Agent"]);
    assert.equal(headers.Accept, "application/vnd.github+json");
    assert.match(headers["User-Agent"], /^CareerRat-Desktop-UpdateCheck$/);
  });
});

describe("fetchLatestRelease", () => {
  it("requests the fixed unauthenticated GitHub endpoint with no body and no query params", async () => {
    let requestedUrl = null;
    let requestedInit = null;
    await fetchLatestRelease({
      fetchImpl: async (url, init) => {
        requestedUrl = url;
        requestedInit = init;
        return { ok: true, json: async () => ({ tag_name: "v0.9.0" }) };
      },
    });

    assert.equal(requestedUrl, GITHUB_RELEASES_URL);
    assert.equal(requestedInit.body, undefined);
    assert.equal(new URL(requestedUrl).search, "");
    assert.deepEqual(Object.keys(requestedInit.headers).sort(), ["Accept", "User-Agent"]);
    assert.equal(requestedInit.headers.Authorization, undefined);
  });

  it("resolves null on a network failure without throwing", async () => {
    const release = await fetchLatestRelease({
      fetchImpl: async () => {
        throw new Error("offline");
      },
    });
    assert.equal(release, null);
  });

  it("resolves null on a non-200 response (e.g. rate limited) without throwing", async () => {
    const release = await fetchLatestRelease({
      fetchImpl: async () => ({ ok: false, status: 403, json: async () => ({}) }),
    });
    assert.equal(release, null);
  });

  it("resolves null on malformed JSON without throwing", async () => {
    const release = await fetchLatestRelease({
      fetchImpl: async () => ({
        ok: true,
        json: async () => {
          throw new SyntaxError("Unexpected token");
        },
      }),
    });
    assert.equal(release, null);
  });

  it("aborts and resolves null when the request hangs past the timeout", async () => {
    const release = await fetchLatestRelease({
      timeoutMs: 20,
      fetchImpl: (_url, { signal }) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(new Error("aborted")));
        }),
    });
    assert.equal(release, null);
  });
});

describe("runUpdateCheck", () => {
  const currentVersion = "0.9.0";

  it("performs no network call at all when disabled", async () => {
    let called = false;
    const outcome = await runUpdateCheck({
      currentVersion,
      state: { ...DEFAULT_STATE, enabled: false },
      fetchImpl: async () => {
        called = true;
        return { ok: true, json: async () => ({ tag_name: "v0.10.0" }) };
      },
    });

    assert.equal(called, false);
    assert.equal(outcome.checked, false);
    assert.equal(outcome.result, null);
  });

  it("performs no network call when the interval has not elapsed", async () => {
    let called = false;
    const now = Date.parse("2026-08-18T00:00:00Z");
    const outcome = await runUpdateCheck({
      currentVersion,
      now,
      state: { ...DEFAULT_STATE, lastCheckedAt: now - 1000 },
      fetchImpl: async () => {
        called = true;
        return { ok: true, json: async () => ({ tag_name: "v0.10.0" }) };
      },
    });

    assert.equal(called, false);
    assert.equal(outcome.checked, false);
  });

  it("checks, resolves an available update, and records the check time", async () => {
    const now = Date.parse("2026-08-18T00:00:00Z");
    const outcome = await runUpdateCheck({
      currentVersion,
      now,
      state: DEFAULT_STATE,
      fetchImpl: async () => ({
        ok: true,
        json: async () => ({
          tag_name: "v0.10.0",
          html_url: "https://example.com/release",
          assets: [],
        }),
      }),
    });

    assert.equal(outcome.checked, true);
    assert.equal(outcome.fetchSucceeded, true);
    assert.equal(outcome.result.updateAvailable, true);
    assert.equal(outcome.result.version, "0.10.0");
    assert.equal(outcome.state.lastCheckedAt, now);
  });

  it("degrades silently on a network failure: checked but not throwing, fetchSucceeded false", async () => {
    const now = Date.parse("2026-08-18T00:00:00Z");
    const outcome = await runUpdateCheck({
      currentVersion,
      now,
      state: DEFAULT_STATE,
      fetchImpl: async () => {
        throw new Error("offline");
      },
    });

    assert.equal(outcome.checked, true);
    assert.equal(outcome.fetchSucceeded, false);
    assert.equal(outcome.result.updateAvailable, false);
    assert.equal(outcome.state.lastCheckedAt, now);
  });
});

describe("mergeCheckedState", () => {
  it("survives a toggle that lands mid-fetch: enabled/skippedVersion come from liveState, not the pre-fetch snapshot", () => {
    // Simulates main.mjs's performUpdateCheck: `nextState` is built from a
    // state snapshot taken before the (up to 10s) fetch started. `liveState`
    // stands in for module-level `updateState`, which an IPC handler can
    // have mutated and already persisted while the fetch was in flight, e.g.
    // the user turning update checks off.
    const nextState = { ...DEFAULT_STATE, enabled: true, skippedVersion: null, lastCheckedAt: 999 };
    const liveState = { ...DEFAULT_STATE, enabled: false, skippedVersion: "0.10.0" };

    const merged = mergeCheckedState({
      nextState,
      fetchSucceeded: true,
      result: { updateAvailable: true, version: "0.10.0", releaseUrl: null, dmgUrl: null },
      liveState,
    });

    assert.equal(merged.enabled, false);
    assert.equal(merged.skippedVersion, "0.10.0");
    // The check's own bookkeeping (lastCheckedAt, the cached release fields)
    // still comes from the check itself, not the live state.
    assert.equal(merged.lastCheckedAt, 999);
    assert.equal(merged.latestVersion, "0.10.0");
  });

  it("re-merges liveState on a failed fetch too", () => {
    const nextState = { ...DEFAULT_STATE, enabled: true, skippedVersion: null, lastCheckedAt: 999 };
    const liveState = { ...DEFAULT_STATE, enabled: false, skippedVersion: null };

    const merged = mergeCheckedState({
      nextState,
      fetchSucceeded: false,
      result: null,
      liveState,
    });

    assert.equal(merged.enabled, false);
    assert.equal(merged.lastCheckedAt, 999);
  });
});
