import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import {
  AUTH_FLOW_USER_AGENT,
  buildAuthUaFilterPatterns,
  choosePreferredPort,
  DEFAULT_PACKAGED_PORT,
  decideExternalOpen,
  isAllowedExternalUrl,
  resolveDesktopRuntimePaths,
} from "../apps/desktop/desktop-runtime.mjs";
import { loadLocalAiEnv, writeLocalAiKey } from "../src/core/ai/ai-env.mjs";
import { closeAll, dbFilePath, openDb } from "../src/core/db/connection.mjs";
import { ALL_MIGRATIONS } from "../src/core/db/migrations.mjs";

function tempRoot(prefix) {
  return mkdtempSync(join(tmpdir(), prefix));
}

function cleanup(path) {
  rmSync(path, { recursive: true, force: true });
}

afterEach(() => {
  closeAll();
});

describe("desktop runtime path resolution", () => {
  it("resolves packaged ROLESTER_HOME under Electron userData and repoRoot under resources", () => {
    const root = tempRoot("rolester-desktop-runtime-");
    try {
      const userDataPath = join(root, "user-data");
      const resourcesPath = join(root, "Rolester.app", "Contents", "Resources");

      const runtime = resolveDesktopRuntimePaths({
        isPackaged: true,
        userDataPath,
        resourcesPath,
        appDir: join(root, "checkout", "apps", "desktop"),
      });

      assert.equal(runtime.rolesterHome, join(userDataPath, "data"));
      assert.equal(runtime.repoRoot, join(resourcesPath, "rolester"));
      assert.equal(runtime.rolesterHome.startsWith(resourcesPath), false);
    } finally {
      cleanup(root);
    }
  });

  it("keeps dev mode on the checkout without assigning ROLESTER_HOME", () => {
    const appDir = join("checkout", "apps", "desktop");
    const runtime = resolveDesktopRuntimePaths({
      isPackaged: false,
      appDir,
      userDataPath: "ignored-user-data",
      resourcesPath: "ignored-resources",
    });

    assert.equal(runtime.rolesterHome, null);
    assert.equal(runtime.repoRoot, join(appDir, "../.."));
  });

  it("keeps branded node_modules Electron launches in dev mode when appDir is the checkout", () => {
    const root = tempRoot("rolester-desktop-branded-dev-");
    try {
      const appDir = join(root, "checkout", "apps", "desktop");
      const resourcesPath = join(
        root,
        "checkout",
        "node_modules",
        "electron",
        "dist",
        "Electron.app",
        "Contents",
        "Resources"
      );

      const runtime = resolveDesktopRuntimePaths({
        isPackaged: true,
        appDir,
        userDataPath: join(root, "Application Support", "Rolester"),
        resourcesPath,
      });

      assert.equal(runtime.isPackaged, false);
      assert.equal(runtime.rolesterHome, null);
      assert.equal(runtime.repoRoot, join(appDir, "../.."));
    } finally {
      cleanup(root);
    }
  });
});

describe("desktop packaged ROLESTER_HOME storage", () => {
  it("initializes SQLite and all registered migrations under packaged ROLESTER_HOME", () => {
    const root = tempRoot("rolester-desktop-db-");
    try {
      const runtime = resolveDesktopRuntimePaths({
        isPackaged: true,
        userDataPath: join(root, "user-data"),
        resourcesPath: join(root, "Resources"),
        appDir: join(root, "checkout", "apps", "desktop"),
      });
      const env = { ROLESTER_HOME: runtime.rolesterHome };

      const db = openDb({ repoRoot: runtime.repoRoot, env });
      const expectedDbPath = join(runtime.rolesterHome, "db", "rolester.db");

      assert.equal(dbFilePath({ repoRoot: runtime.repoRoot, env }), expectedDbPath);
      assert.ok(existsSync(expectedDbPath), "database must be created under ROLESTER_HOME");
      assert.equal(
        existsSync(join(runtime.repoRoot, ".rolester", "db", "rolester.db")),
        false,
        "packaged startup must not create the database under staged resources"
      );
      assert.equal(db.prepare("PRAGMA user_version").get().user_version, ALL_MIGRATIONS.at(-1).id);

      const migrationRows = db.prepare("SELECT id, name FROM _migrations ORDER BY id ASC").all();
      assert.deepEqual(
        migrationRows.map((row) => row.id),
        ALL_MIGRATIONS.map((migration) => migration.id)
      );
      assert.deepEqual(
        migrationRows.map((row) => row.name),
        ALL_MIGRATIONS.map((migration) => migration.name)
      );
    } finally {
      cleanup(root);
    }
  });

  it("persists BYOK credentials under packaged ROLESTER_HOME/internal without echoing secrets", () => {
    const root = tempRoot("rolester-desktop-byok-");
    try {
      const runtime = resolveDesktopRuntimePaths({
        isPackaged: true,
        userDataPath: join(root, "user-data"),
        resourcesPath: join(root, "Resources"),
        appDir: join(root, "checkout", "apps", "desktop"),
      });
      const env = { ROLESTER_HOME: runtime.rolesterHome };
      const apiKey = "sk-ant-packaged-runtime-secret";

      const writeResult = writeLocalAiKey({ repoRoot: runtime.repoRoot, apiKey, env });
      const loadEnv = { ROLESTER_HOME: runtime.rolesterHome };
      const loadResult = loadLocalAiEnv({ repoRoot: runtime.repoRoot, env: loadEnv });

      assert.equal(writeResult.path, join(runtime.rolesterHome, "internal", "ai.env"));
      assert.equal(loadResult.path, writeResult.path);
      assert.equal(statSync(writeResult.path).mode & 0o777, 0o600);
      assert.deepEqual(loadResult.loaded, ["ANTHROPIC_API_KEY"]);
      assert.equal(loadEnv.ANTHROPIC_API_KEY, apiKey);
      assert.equal(JSON.stringify(writeResult).includes(apiKey), false);
      assert.equal(JSON.stringify(loadResult).includes(apiKey), false);
      assert.equal(
        existsSync(join(runtime.repoRoot, ".internal", "ai.env")),
        false,
        "BYOK storage must not be written under staged signed resources"
      );
    } finally {
      cleanup(root);
    }
  });
});

describe("desktop external URL decisions", () => {
  it("allows vetted external URL protocols", () => {
    assert.equal(isAllowedExternalUrl("https://example.com/path"), true);
    assert.equal(isAllowedExternalUrl("mailto:hello@example.com"), true);
  });

  it("denies unsafe and malformed external URL targets", () => {
    for (const target of [
      "http://example.com",
      "javascript:alert(1)",
      "file:///Users/sbenson/.ssh/id_rsa",
      "data:text/html,<script>alert(1)</script>",
      "not a url",
      "",
    ]) {
      assert.equal(isAllowedExternalUrl(target), false, `${target} should be denied`);
    }
  });

  it("does not external-open same-origin app navigations", () => {
    assert.deepEqual(
      decideExternalOpen({
        baseUrl: "http://127.0.0.1:61234",
        target: "http://127.0.0.1:61234/app/onboarding",
      }),
      {
        action: "ignore",
        reason: "same-origin",
        url: "http://127.0.0.1:61234/app/onboarding",
      }
    );
  });

  it("keeps built-in HTTPS authentication origins in the Electron window", () => {
    for (const target of [
      "https://accounts.google.com/o/oauth2/auth",
      "https://accounts.youtube.com/accounts/ServiceLogin",
      "https://rolester-dev.clerk.accounts.dev/v1/client",
    ]) {
      assert.deepEqual(decideExternalOpen({ target }), {
        action: "ignore",
        reason: "auth-origin",
        url: target,
      });
    }
  });

  it("keeps configured exact and suffix authentication origins in the Electron window", () => {
    const env = {
      ROLESTER_AUTH_HOSTS: "login.example.test, .oauth.example.test",
    };

    for (const target of [
      "https://login.example.test/authorize",
      "https://tenant.oauth.example.test/callback",
    ]) {
      assert.deepEqual(decideExternalOpen({ target, env }), {
        action: "ignore",
        reason: "auth-origin",
        url: target,
      });
    }
  });

  it("ignores malformed configured auth-host entries without disrupting matching", () => {
    const env = {
      ROLESTER_AUTH_HOSTS: ", , ://bad host, ., login.example.test,",
    };

    assert.equal(
      decideExternalOpen({ target: "https://login.example.test/authorize", env }).reason,
      "auth-origin"
    );
    assert.deepEqual(decideExternalOpen({ target: "https://ordinary.example.test/jobs", env }), {
      action: "open-external",
      url: "https://ordinary.example.test/jobs",
    });
  });

  it("returns an external-open decision only for safe external targets", () => {
    assert.deepEqual(
      decideExternalOpen({
        baseUrl: "http://127.0.0.1:61234",
        target: "https://example.com/jobs",
      }),
      {
        action: "open-external",
        url: "https://example.com/jobs",
      }
    );

    assert.deepEqual(
      decideExternalOpen({
        baseUrl: "http://127.0.0.1:61234",
        target: "javascript:alert(1)",
      }),
      {
        action: "deny",
        reason: "blocked-protocol:javascript:",
        url: "javascript:alert(1)",
      }
    );
  });
});

describe("desktop authentication request overrides", () => {
  it("builds the default auth-host URL patterns when no override is configured", () => {
    for (const env of [{}, { UNRELATED_SETTING: "ignored" }]) {
      const patterns = buildAuthUaFilterPatterns(env);

      assert.ok(patterns.includes("https://accounts.google.com/*"));
      assert.ok(patterns.includes("https://*.clerk.accounts.dev/*"));
    }
  });

  it("maps configured exact and suffix auth hosts to Electron URL patterns", () => {
    const patterns = buildAuthUaFilterPatterns({
      ROLESTER_AUTH_HOSTS: "login.example.test,.oauth.example.test",
    });

    assert.ok(patterns.includes("https://login.example.test/*"));
    assert.ok(patterns.includes("https://*.oauth.example.test/*"));
  });

  it("drops malformed configured auth hosts while retaining valid entries", () => {
    const patterns = buildAuthUaFilterPatterns({
      ROLESTER_AUTH_HOSTS: "login.example.test, bad host, ://bad host, , ., .oauth.example.test",
    });

    assert.ok(patterns.includes("https://login.example.test/*"));
    assert.ok(patterns.includes("https://*.oauth.example.test/*"));
    assert.equal(
      patterns.some((pattern) => pattern.includes("bad host")),
      false
    );
    assert.equal(
      patterns.some((pattern) => pattern.includes("://://")),
      false
    );
    assert.equal(patterns.includes("https://*./*"), false);
  });

  it("uses a Firefox user agent without Chrome or Electron branding", () => {
    assert.ok(AUTH_FLOW_USER_AGENT.includes("Firefox/"));
    assert.equal(AUTH_FLOW_USER_AGENT.includes("Chrome"), false);
    assert.equal(AUTH_FLOW_USER_AGENT.includes("Electron"), false);
  });

  it("builds default auth-host URL patterns when called without an env argument", () => {
    assert.doesNotThrow(() => buildAuthUaFilterPatterns());
    assert.ok(buildAuthUaFilterPatterns().includes("https://accounts.google.com/*"));
    assert.ok(buildAuthUaFilterPatterns().includes("https://*.clerk.accounts.dev/*"));
  });
});

describe("desktop preferred port selection", () => {
  it("uses the stable default port for packaged launches", () => {
    assert.equal(choosePreferredPort({ isPackaged: true, env: {} }), DEFAULT_PACKAGED_PORT);
  });

  it("uses a valid packaged port override", () => {
    assert.equal(
      choosePreferredPort({
        isPackaged: true,
        env: { ROLESTER_DESKTOP_PORT: "48123" },
      }),
      48123
    );
  });

  it("falls back for invalid packaged port overrides", () => {
    for (const value of ["not-a-port", "48123garbage", "0", "65536"]) {
      assert.equal(
        choosePreferredPort({
          isPackaged: true,
          env: { ROLESTER_DESKTOP_PORT: value },
        }),
        DEFAULT_PACKAGED_PORT,
        `${value} should use the packaged default`
      );
    }
  });

  it("uses an ephemeral port in development even when an override is set", () => {
    assert.equal(
      choosePreferredPort({
        isPackaged: false,
        env: { ROLESTER_DESKTOP_PORT: "48123" },
      }),
      0
    );
  });
});
