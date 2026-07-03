// boards-route.mjs — additive M8 backend route BUILDER B (wizard UI) had to
// add: the frozen M8 contract's Targeting-step "board URL preview" and
// Companies/Finish-step "add LinkedIn saved search" affordances have no
// server surface without it — src/core/providers/hiringcafe.mjs's
// buildHiringCafeUrl() and linkedin.mjs's buildLinkedInSearchUrl() are pure
// server-side ES modules, unreachable from the browser bundle, and
// search-sources.mjs's addSearchFromUrl() has no HTTP caller anywhere
// (src/cli/searches.mjs is a CLI, not a route). The M8 design doc
// (scratchpad/m8-design-deep-reasoner.md §5) named this exact route
// (`src/cli/boards-route.mjs: POST /api/boards/preview` /
// `POST /api/boards/add`) but it was not in Builder A's committed frozen
// contract/deliverables — this is the smallest additive change that makes
// the wizard's board-preview step possible at all. Split out the same way
// every other M8 route module is: `addRoute` is the mount point, `sendJson`/
// `readJsonBodyCapped` are imported from skill-run-route.mjs rather than
// duplicated.
//
// mountBoardsRoutes({addRoute, repoRoot, env}) registers:
//
//   POST /api/boards/preview   { keywords, location?, remote?, minimumBase?,
//                                windowHours? } -> 200 { hiringCafe, linkedin }
//                              Deterministic, no persistence — both builders
//                              are pure functions; either side degrades to
//                              null + an `*Error` string if its own inputs
//                              don't satisfy that builder (never a 500 for a
//                              partial preview).
//   POST /api/boards/add      { url, label? } -> 200 { ok:true, searches }
//                              Reads config/search-sources.yml (or an empty
//                              config), calls the EXISTING addSearchFromUrl
//                              (search-sources.mjs) — same platform/auth/
//                              enabled:false gating every other pasted-URL
//                              source already gets — validates against
//                              config/search-sources.schema.json, writes.
//
// ORDERING NOTE (see the design doc's §6 "Open risks #3"): POST
// /api/onboard/write-config regenerates config/search-sources.yml WHOLESALE
// from targeting — calling POST /api/boards/add before write-config would
// have its entry silently dropped. The wizard's own step ordering is the
// fix (add AFTER Finish's write-config runs), not anything enforced here.

import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { userPath } from "../core/paths/workspace.mjs";
import { atomicWriteFile } from "../core/profile/gate-writer.mjs";
import { buildHiringCafeUrl } from "../core/providers/hiringcafe.mjs";
import { buildLinkedInSearchUrl, salaryBandForMinimumBase } from "../core/providers/linkedin.mjs";
import {
  addSearchFromUrl,
  emptyConfig,
  listSearches,
  parseConfig,
  serializeConfig,
  validateConfig,
} from "../core/providers/search-sources.mjs";
import { readJsonBodyCapped, sendJson } from "./skill-run-route.mjs";

const MAX_BODY_BYTES = 1024 * 1024; // 1MB — same cap the other M8 route modules use.
const SEARCH_SOURCES_REL_PATH = "config/search-sources.yml";
const SEARCH_SOURCES_SCHEMA_PATH = "config/search-sources.schema.json";

export function mountBoardsRoutes({ addRoute, repoRoot, env = process.env }) {
  void env; // accepted for call-site symmetry with the other M8 mount*Routes() functions.
  const pathCtx = { repoRoot };

  // -------------------------------------------------------------------------
  // POST /api/boards/preview
  // -------------------------------------------------------------------------
  addRoute("POST", "/api/boards/preview", async (req, res) => {
    let body;
    try {
      body = await readJsonBodyCapped(req, MAX_BODY_BYTES);
    } catch (err) {
      sendJson(res, err.status || 400, { error: err.message });
      return;
    }

    const keywords = String(body?.keywords || "").trim();
    if (!keywords) {
      sendJson(res, 400, { error: "body.keywords is required" });
      return;
    }
    const location = body?.location ? String(body.location) : null;
    const remote = !!body?.remote;
    const windowHours =
      body?.windowHours !== undefined && body?.windowHours !== null
        ? Number(body.windowHours)
        : null;
    const minimumBase =
      body?.minimumBase !== undefined && body?.minimumBase !== null
        ? Number(body.minimumBase)
        : null;

    const result = {};

    try {
      result.hiringCafe = buildHiringCafeUrl({ query: keywords, windowHours });
    } catch (err) {
      result.hiringCafe = null;
      result.hiringCafeError = err.message;
    }

    try {
      result.linkedin = {
        url: buildLinkedInSearchUrl({
          keywords,
          location,
          remote,
          salaryBand: salaryBandForMinimumBase(minimumBase),
          postedWithin: windowHours,
        }),
      };
    } catch (err) {
      result.linkedin = null;
      result.linkedinError = err.message;
    }

    sendJson(res, 200, result);
  });

  // -------------------------------------------------------------------------
  // POST /api/boards/add
  // -------------------------------------------------------------------------
  addRoute("POST", "/api/boards/add", async (req, res) => {
    let body;
    try {
      body = await readJsonBodyCapped(req, MAX_BODY_BYTES);
    } catch (err) {
      sendJson(res, err.status || 400, { error: err.message });
      return;
    }

    const url = String(body?.url || "").trim();
    if (!url) {
      sendJson(res, 400, { error: "body.url is required" });
      return;
    }
    const label = body?.label ? String(body.label) : undefined;

    const configPath = userPath(pathCtx, SEARCH_SOURCES_REL_PATH);
    const current = existsSync(configPath)
      ? parseConfig(readFileSync(configPath, "utf8"))
      : emptyConfig();

    let next;
    try {
      next = addSearchFromUrl(current, url, { label });
    } catch (err) {
      sendJson(res, 400, { error: err.message });
      return;
    }

    const schema = JSON.parse(readFileSync(join(repoRoot, SEARCH_SOURCES_SCHEMA_PATH), "utf8"));
    const { valid, errors } = validateConfig(next, schema);
    if (!valid) {
      sendJson(res, 400, { ok: false, errors });
      return;
    }

    mkdirSync(dirname(configPath), { recursive: true });
    atomicWriteFile(configPath, `${serializeConfig(next)}\n`);
    sendJson(res, 200, { ok: true, searches: listSearches(next) });
  });
}
