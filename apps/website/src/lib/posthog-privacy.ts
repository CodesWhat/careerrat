// Wiring pattern copied from CodesWhat's shared house PostHog standard
// (CodesWhat/codeswhat.com, frontend/lib/posthog-privacy.ts): same proxy host,
// same cookieless invariants, same before_send allowlist shape. The route
// model differs on purpose — codeswhat.com is a single-route site and
// allowlists exactly "/", but careerrat.com is a real multi-page site (the
// marketing page plus the Fumadocs /docs export), so sanitizeRoute here keeps
// the actual pathname instead of collapsing everything to one allowed route.

export const POSTHOG_API_HOST = "https://e.codeswhat.com";
export const POSTHOG_UI_HOST = "https://us.posthog.com";
export const PRODUCTION_ORIGIN = "https://careerrat.com";
export const SITE = "careerrat.com";

const DOCS_PATH_PREFIX = "/docs";
const OTHER_PATH = "/_other";
const PROJECT_TOKEN_PATTERN = /^phc_[A-Za-z0-9_-]+$/u;
const ALLOWED_CTA_IDS = new Set(["get_started"]);
const ALLOWED_PLACEMENTS = new Set(["header", "hero", "pricing", "final"]);
const allowedVitalKeys = new Set([
  "$web_vitals_CLS_value",
  "$web_vitals_FCP_value",
  "$web_vitals_INP_value",
  "$web_vitals_LCP_value",
]);

export type PostHogEnvironment = {
  NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN?: string;
  NEXT_PUBLIC_POSTHOG_HOST?: string;
  NEXT_PUBLIC_POSTHOG_UI_HOST?: string;
};

export function getPostHogConfig(env: PostHogEnvironment) {
  const token = env.NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN;
  if (
    typeof token !== "string" ||
    !PROJECT_TOKEN_PATTERN.test(token) ||
    env.NEXT_PUBLIC_POSTHOG_HOST !== POSTHOG_API_HOST ||
    env.NEXT_PUBLIC_POSTHOG_UI_HOST !== POSTHOG_UI_HOST
  ) {
    return null;
  }
  return { token, apiHost: POSTHOG_API_HOST, uiHost: POSTHOG_UI_HOST } as const;
}

// Keeps the real pathname (unlike codeswhat.com's single-route allowlist) but
// still refuses to forward anything that isn't a same-origin path — absolute
// URLs, protocol strings, and protocol-relative "//host" values all fall back
// to OTHER_PATH so a crafted location value can never leak an external URL or
// a query-string secret through the path property.
export function sanitizeRoute(input: unknown): string {
  if (typeof input !== "string" || /^[a-z][a-z\d+.-]*:/i.test(input) || input.startsWith("//")) {
    return OTHER_PATH;
  }
  const pathname = input.split(/[?#]/, 1)[0] || "/";
  return pathname.startsWith("/") ? pathname : OTHER_PATH;
}

function surfaceForPath(path: string): "docs" | "marketing" {
  return path === DOCS_PATH_PREFIX || path.startsWith(`${DOCS_PATH_PREFIX}/`) ? "docs" : "marketing";
}

type EventInput = {
  event?: unknown;
  properties?: unknown;
  timestamp?: unknown;
  uuid?: unknown;
};

type SanitizedEvent = {
  event: "$pageview" | "cta activated" | "$web_vitals";
  properties: Record<string, boolean | number | string>;
  timestamp?: Date;
  uuid?: string;
};

function getRawPath(properties: Record<string, unknown>): unknown {
  if (typeof properties.path === "string") return properties.path;
  if (typeof properties.$pathname === "string") return properties.$pathname;
  if (typeof properties.$current_url !== "string") return undefined;
  try {
    return new URL(properties.$current_url).pathname;
  } catch {
    return undefined;
  }
}

function createCommonProperties(properties: Record<string, unknown>) {
  const token = properties.token;
  // PostHog's cookieless server-hash ingestion step computes the anonymous
  // distinct id from day + team + $ip + $host + $raw_user_agent. It reads
  // $raw_user_agent/$host straight off event.properties (not headers) and
  // silently drops the event with a cookieless_missing_user_agent /
  // cookieless_missing_host ingestion warning if either is absent
  // (PostHog/posthog nodejs/src/ingestion/common/cookieless/cookieless-manager.ts,
  // getProperties()/doBatchInner()). posthog-js attaches both to every
  // envelope by default, so they must survive the allowlist rebuild below.
  // $ip is deliberately NOT forwarded here: posthog-js never sends it, and
  // PostHog's capture service fills it in from the request's own connection
  // IP when absent.
  const rawUserAgent = properties.$raw_user_agent;
  const host = properties.$host;
  if (
    typeof token !== "string" ||
    !PROJECT_TOKEN_PATTERN.test(token) ||
    properties.$cookieless_mode !== true ||
    properties.$process_person_profile !== false ||
    typeof rawUserAgent !== "string" ||
    rawUserAgent === "" ||
    typeof host !== "string" ||
    host === ""
  ) {
    return null;
  }

  const path = sanitizeRoute(getRawPath(properties));
  const common: Record<string, boolean | number | string> = {
    token,
    $cookieless_mode: true,
    $process_person_profile: false,
    schema_version: 1,
    site: SITE,
    surface: surfaceForPath(path),
    path,
    $raw_user_agent: rawUserAgent,
    $host: host,
  };
  if (properties.distinct_id === "$posthog_cookieless") {
    common.distinct_id = "$posthog_cookieless";
  }
  return common;
}

function createSanitizedEvent(
  input: EventInput,
  event: SanitizedEvent["event"],
  properties: SanitizedEvent["properties"],
): SanitizedEvent {
  const result: SanitizedEvent = { event, properties };
  if (typeof input.uuid === "string") result.uuid = input.uuid;
  if (input.timestamp instanceof Date && Number.isFinite(input.timestamp.getTime())) {
    result.timestamp = input.timestamp;
  }
  return result;
}

export function sanitizeEvent(input: unknown): SanitizedEvent | null {
  if (!input || typeof input !== "object") return null;
  const eventInput = input as EventInput;
  const { event, properties } = eventInput;
  if (typeof event !== "string" || !properties || typeof properties !== "object") return null;

  const values = properties as Record<string, unknown>;
  const common = createCommonProperties(values);
  if (common === null) return null;
  if (event === "$pageview") {
    return createSanitizedEvent(eventInput, event, {
      ...common,
      $current_url: `${PRODUCTION_ORIGIN}${common.path}`,
    });
  }

  if (event === "cta activated") {
    const ctaId = typeof values.cta_id === "string" ? values.cta_id : "";
    const placement = typeof values.placement === "string" ? values.placement : "";
    return ALLOWED_CTA_IDS.has(ctaId) && ALLOWED_PLACEMENTS.has(placement)
      ? createSanitizedEvent(eventInput, event, { ...common, cta_id: ctaId, placement })
      : null;
  }

  if (event === "$web_vitals") {
    const vitalProperties: Record<string, number> = {};
    for (const key of allowedVitalKeys) {
      const value = values[key];
      if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
        vitalProperties[key] = value;
      }
    }
    return Object.keys(vitalProperties).length > 0
      ? createSanitizedEvent(eventInput, event, { ...common, ...vitalProperties })
      : null;
  }

  return null;
}
