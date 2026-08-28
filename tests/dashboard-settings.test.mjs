import assert from "node:assert/strict";
import test from "node:test";

import { buildSettingsSnapshot } from "../src/core/tracker/settings-snapshot.mjs";

test("Dashboard settings snapshot exposes onboarding config without private current compensation", () => {
  const snapshot = buildSettingsSnapshot({
    profile: {
      candidate: {
        full_name: "Demo Candidate",
        headline: "AI-native builder",
      },
      compensation: {
        current_base: 123456,
        minimum_base: 200000,
        target_base: 165000,
        expected_base: 165000,
      },
      location: {
        home: "Example City, ST",
        remote: true,
        remote_scope: "worldwide",
        hybrid: true,
        onsite: false,
      },
      authorization: {
        work_authorized: true,
        requires_sponsorship: false,
      },
    },
    automation: {
      session: { provider: "extension" },
      capabilities: {
        status_polling: { enabled: true },
        messaging: { enabled: false },
      },
    },
    targeting: { fit_bands: { fit_floor: 65 } },
    files: ["candidate/profile.yml", "candidate/automation.yml"],
  });

  assert.equal(snapshot.profile.candidate, "Demo Candidate");
  assert.equal(snapshot.profile.minimumBase, "$200K");
  assert.equal(snapshot.profile.targetBase, "$165K");
  assert.equal(snapshot.profile.expectedBase, "$165K");
  assert.equal(snapshot.profile.location, "Remote worldwide / hybrid - Example City, ST");
  assert.equal(snapshot.profile.remoteScope, "worldwide");
  assert.equal(snapshot.profile.workAuthorization, "Authorized; no sponsorship");
  assert.equal(snapshot.automation.sessionProvider, "Browser extension");
  assert.deepEqual(snapshot.automation.enabledCapabilities, ["Status polling"]);
  assert.equal(snapshot.targeting.fitFloor, 65);
  assert.deepEqual(snapshot.files, ["candidate/profile.yml", "candidate/automation.yml"]);
  assert.doesNotMatch(JSON.stringify(snapshot), /123456|current_base|currentBase/);
});

test("Dashboard settings snapshot uses the product fit floor when no explicit floor is saved", () => {
  assert.equal(
    buildSettingsSnapshot({ targeting: { fit_bands: { fit_floor: null } } }).targeting.fitFloor,
    70
  );
});
