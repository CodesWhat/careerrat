// consent.mjs: the on/off gate for a bundled plugin.
//
// A plugin with no declared capability (manifest.capability === null) always
// runs; example-echo, the only plugin this slice ships, is that case. A
// plugin that DOES declare a capability runs unless that capability is turned
// off in automation.yml: this module resolves through the existing mayRun()
// predicate in ../automation/consent.mjs rather than inventing a second model.
// This slice does not introduce a new capability name; a future plugin
// (h1b-sponsor) is expected to be the first real user of the capability path.

import { CAPABILITIES, isCapability, loadAutomation, mayRun } from "../automation/consent.mjs";

export function pluginAllowed({ manifest, cfg, root, env } = {}) {
  const capability = manifest?.capability ?? null;
  if (capability === null) return { allowed: true, reason: null };

  if (!isCapability(capability)) {
    return { allowed: false, reason: `unknown capability "${capability}"` };
  }

  const data = cfg || loadAutomation({ root, env }).data;
  const platforms = CAPABILITIES[capability].platforms;

  // A capability can apply to several platforms (e.g. status_polling spans
  // greenhouse/workday/ashby/lever). mayRun() is platform-scoped, so a
  // plugin is allowed while the capability is on for any one of the platforms
  // it covers.
  for (const platform of platforms) {
    const verdict = mayRun({ capability, platform, data, root, env });
    if (verdict.allowed) return { allowed: true, reason: null };
  }

  return {
    allowed: false,
    reason: `capability "${capability}" is turned off (turn on: \`careerrat automation enable ${capability} --write\`)`,
  };
}
