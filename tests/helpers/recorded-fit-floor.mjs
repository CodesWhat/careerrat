// Writes the fit floor through the canonical recorded-config writer, so a test
// gets the same `knowledge_write` thread message a CLI settings change leaves.
import { patchRecordedCandidateConfig } from "../../src/core/agent/recorded-config-write.mjs";
import { workspaceThreadRead } from "../../src/core/agent/workspace-thread.mjs";

export function recordFitFloor(ctx, value) {
  patchRecordedCandidateConfig({
    ...ctx,
    name: "targeting",
    patch: { fit_bands: { fit_floor: value } },
    writes: [{ path: "fit_bands.fit_floor", label: "fit floor" }],
    writer: "test.fit-floor",
  });
  return workspaceThreadRead(ctx).messages.at(-1);
}
