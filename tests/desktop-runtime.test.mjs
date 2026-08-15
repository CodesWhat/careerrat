import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import {
  choosePreferredPort,
  DEFAULT_PACKAGED_PORT,
  decideExternalOpen,
  isAllowedExternalUrl,
  resolveDesktopRuntimePaths,
} from "../apps/desktop/desktop-runtime.mjs";
import { verifyDesktopRelease } from "../apps/desktop/release-verification.mjs";
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
  it("resolves packaged CAREERRAT_HOME under Electron userData and repoRoot under resources", () => {
    const root = tempRoot("careerrat-desktop-runtime-");
    try {
      const userDataPath = join(root, "user-data");
      const resourcesPath = join(root, "CareerRat.app", "Contents", "Resources");

      const runtime = resolveDesktopRuntimePaths({
        isPackaged: true,
        userDataPath,
        resourcesPath,
        appDir: join(root, "checkout", "apps", "desktop"),
      });

      assert.equal(runtime.careerratHome, join(userDataPath, "data"));
      assert.equal(runtime.repoRoot, join(resourcesPath, "careerrat"));
      assert.equal(runtime.careerratHome.startsWith(resourcesPath), false);
    } finally {
      cleanup(root);
    }
  });

  it("keeps dev mode on the checkout without assigning CAREERRAT_HOME", () => {
    const appDir = join("checkout", "apps", "desktop");
    const runtime = resolveDesktopRuntimePaths({
      isPackaged: false,
      appDir,
      userDataPath: "ignored-user-data",
      resourcesPath: "ignored-resources",
    });

    assert.equal(runtime.careerratHome, null);
    assert.equal(runtime.repoRoot, join(appDir, "../.."));
  });

  it("keeps branded node_modules Electron launches in dev mode when appDir is the checkout", () => {
    const root = tempRoot("careerrat-desktop-branded-dev-");
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
        userDataPath: join(root, "Application Support", "CareerRat"),
        resourcesPath,
      });

      assert.equal(runtime.isPackaged, false);
      assert.equal(runtime.careerratHome, null);
      assert.equal(runtime.repoRoot, join(appDir, "../.."));
    } finally {
      cleanup(root);
    }
  });
});

describe("desktop packaged CAREERRAT_HOME storage", () => {
  it("initializes SQLite and all registered migrations under packaged CAREERRAT_HOME", () => {
    const root = tempRoot("careerrat-desktop-db-");
    try {
      const runtime = resolveDesktopRuntimePaths({
        isPackaged: true,
        userDataPath: join(root, "user-data"),
        resourcesPath: join(root, "Resources"),
        appDir: join(root, "checkout", "apps", "desktop"),
      });
      const env = { CAREERRAT_HOME: runtime.careerratHome };

      const db = openDb({ repoRoot: runtime.repoRoot, env });
      const expectedDbPath = join(runtime.careerratHome, "db", "careerrat.db");

      assert.equal(dbFilePath({ repoRoot: runtime.repoRoot, env }), expectedDbPath);
      assert.ok(existsSync(expectedDbPath), "database must be created under CAREERRAT_HOME");
      assert.equal(
        existsSync(join(runtime.repoRoot, ".careerrat", "db", "careerrat.db")),
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

  it("persists BYOK credentials under packaged CAREERRAT_HOME/internal without echoing secrets", () => {
    const root = tempRoot("careerrat-desktop-byok-");
    try {
      const runtime = resolveDesktopRuntimePaths({
        isPackaged: true,
        userDataPath: join(root, "user-data"),
        resourcesPath: join(root, "Resources"),
        appDir: join(root, "checkout", "apps", "desktop"),
      });
      const env = { CAREERRAT_HOME: runtime.careerratHome };
      const apiKey = "sk-ant-packaged-runtime-secret";

      const writeResult = writeLocalAiKey({ repoRoot: runtime.repoRoot, apiKey, env });
      const loadEnv = { CAREERRAT_HOME: runtime.careerratHome };
      const loadResult = loadLocalAiEnv({ repoRoot: runtime.repoRoot, env: loadEnv });

      assert.equal(writeResult.path, join(runtime.careerratHome, "internal", "ai.env"));
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
      "file:///Users/example/.ssh/id_rsa",
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

  it("keeps every same-origin path in-window, including neighboring /app routes", () => {
    for (const path of ["/app", "/app/onboarding"]) {
      assert.deepEqual(
        decideExternalOpen({
          baseUrl: "http://127.0.0.1:61234",
          target: `http://127.0.0.1:61234${path}`,
        }),
        {
          action: "ignore",
          reason: "same-origin",
          url: `http://127.0.0.1:61234${path}`,
        }
      );
    }
  });

  it("sends off-origin HTTPS targets to the OS browser", () => {
    for (const target of [
      "https://example.com/jobs",
      "https://accounts.google.com/o/oauth2/auth",
    ]) {
      assert.deepEqual(decideExternalOpen({ baseUrl: "http://127.0.0.1:61234", target }), {
        action: "open-external",
        url: target,
      });
    }
  });

  it("denies unsafe protocols even for a same-origin base", () => {
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

describe("desktop preferred port selection", () => {
  it("uses the stable default port for packaged launches", () => {
    assert.equal(choosePreferredPort({ isPackaged: true, env: {} }), DEFAULT_PACKAGED_PORT);
  });

  it("uses a valid packaged port override", () => {
    assert.equal(
      choosePreferredPort({
        isPackaged: true,
        env: { CAREERRAT_DESKTOP_PORT: "48123" },
      }),
      48123
    );
  });

  it("falls back for invalid packaged port overrides", () => {
    for (const value of ["not-a-port", "48123garbage", "0", "65536"]) {
      assert.equal(
        choosePreferredPort({
          isPackaged: true,
          env: { CAREERRAT_DESKTOP_PORT: value },
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
        env: { CAREERRAT_DESKTOP_PORT: "48123" },
      }),
      0
    );
  });
});

describe("desktop release verification", () => {
  const artifacts = {
    appPath: "/tmp/CareerRat.app",
    dmgPath: "/tmp/CareerRat.dmg",
  };

  it("passes only when signing, stapling, and Gatekeeper checks all pass", () => {
    const calls = [];
    const result = verifyDesktopRelease({
      ...artifacts,
      run(command, args) {
        calls.push([command, args]);
        return { status: 0, stdout: "accepted\n", stderr: "" };
      },
    });

    assert.equal(result.ok, true);
    assert.equal(result.checks.length, 3);
    assert.deepEqual(
      calls.map(([command]) => command),
      ["codesign", "xcrun", "spctl"]
    );
  });

  it("fails the release when the DMG has no notarization ticket", () => {
    const result = verifyDesktopRelease({
      ...artifacts,
      run(command) {
        if (command === "xcrun") {
          return {
            status: 65,
            stdout: "",
            stderr: "The staple and validate action failed! Error 65.",
          };
        }
        return { status: 0, stdout: "accepted\n", stderr: "" };
      },
    });

    assert.equal(result.ok, false);
    assert.deepEqual(
      result.failures.map((failure) => failure.id),
      ["notarization-ticket"]
    );
    assert.match(result.summary, /not signed, notarized, and Gatekeeper-ready/i);
    assert.match(result.summary, /APPLE_API_KEY|APPLE_ID|APPLE_KEYCHAIN_PROFILE/);
    assert.match(result.summary, /APPLE_API_ISSUER/);
    assert.doesNotMatch(result.summary, /APPLE_API_KEY_ISSUER/);
  });
});
