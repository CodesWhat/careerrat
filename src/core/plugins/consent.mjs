// consent.mjs — the point-of-need consent gate for a bundled plugin.
//
// A plugin with no declared capability (manifest.capability === null) always
// runs; example-echo, the only plugin this slice ships, is that case. A
// plugin that DOES declare a capability has to clear the same automation.yml
// switches every other point-of-need permission clears — this module resolves
// through the existing mayRun() predicate in ../automation/consent.mjs rather
// than inventing a second consent model, so a plugin capability is
// indistinguishable from any other contextual permission once it's granted.
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
  // plugin is allowed the moment the candidate has granted it on any one of
  // the platforms the capability covers.
  for (const platform of platforms) {
    const verdict = mayRun({ capability, platform, data, root, env });
    if (verdict.allowed) return { allowed: true, reason: null };
  }

  return {
    allowed: false,
    reason: `capability "${capability}" is not allowed yet (enable it in automation settings)`,
  };
}
