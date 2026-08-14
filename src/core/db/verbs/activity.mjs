// verbs/activity.mjs — the standalone activity-log verb, for a caller that
// just wants to record an Activity Pulse event with no accompanying domain
// state change (mirrors today's `careerrat activity append`). Unlike the
// domain-action verbs in app.mjs/sourced.mjs/comm.mjs, this does NOT bump
// meta.version/lastUpdatedAt — logging alone isn't a tracker.json data change,
// same as activity-log.mjs's fs-backed appendActivity() never touching
// tracker.json today.
import { logActivityEvent, runVerb } from "./shared.mjs";

export function activityAppend({ repoRoot, env, event } = {}) {
  if (!event || typeof event !== "object") throw new Error("activityAppend: event is required");
  return runVerb({ repoRoot, env }, (db) => {
    const logged = logActivityEvent(db, event);
    return { event: logged };
  });
}
