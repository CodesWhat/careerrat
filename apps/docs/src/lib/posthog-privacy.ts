// Canonical copy: apps/website/src/lib/posthog-privacy.ts. Duplicated here
// (not imported cross-app) because apps/docs and apps/website are separate
// Next.js builds with no shared workspace package between them — apps/docs
// builds standalone and its static export is copied into
// apps/website/public/docs by scripts/build-docs-content.mjs, so it needs its
// own bundled copy of this module. Keep the two in sync by hand; the property
// contract (schema_version, site, surface, path) and the cookieless
// invariants must match exactly, since both feed the same shared PostHog
// project.

const POSTHOG_API_HOST = "https://e.codeswhat.com";
const POSTHOG_UI_HOST = "https://us.posthog.com";
const PRODUCTION_ORIGIN = "https://careerrat.com";
const SITE = "careerrat.com";

const DOCS_PATH_PREFIX = "/docs";
const OTHER_PATH = "/_other";
const PROJECT_TOKEN_PATTERN = /^phc_[A-Za-z0-9_-]+$/u;
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

// window.location.pathname on the deployed docs bundle is always the real
// browser URL (basePath: "/docs" in next.config.ts prefixes generated links,
// but doesn't change what the browser reports at runtime), so this resolves
// "docs" correctly without needing to know about basePath at all. Still
// refuses to forward anything that isn't a same-origin path.
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
  event: "$pageview" | "$pageleave" | "$web_vitals";
  properties: Record<string, boolean | number | string>;
  timestamp?: Date;
  uuid?: string;
};

function getRawPath(properties: Record<string, unknown>): unknown {
  if (typeof properties.path === "string") return properties.path;
  if (typeof properties.$pathname === "string") return properties.$pathname;
  if (typeof properties.$current_url !== "string") return undefined;
  try {
    const url = new URL(properties.$current_url);
    return url.origin === PRODUCTION_ORIGIN ? url.pathname : undefined;
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
  // cookieless_missing_host ingestion warning if either is absent. posthog-js
  // attaches both to every envelope by default, so they must survive the
  // allowlist rebuild below. $ip is deliberately NOT forwarded: posthog-js
  // never sends it, and PostHog's capture service fills it in from the
  // request's own connection IP when absent.
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

// No "cta activated" branch here: apps/docs has no marketing CTAs to track.
// If that changes, copy the allowlisted branch from
// apps/website/src/lib/posthog-privacy.ts rather than inventing a new shape.
export function sanitizeEvent(input: unknown): SanitizedEvent | null {
  if (!input || typeof input !== "object") return null;
  const eventInput = input as EventInput;
  const { event, properties } = eventInput;
  if (typeof event !== "string" || !properties || typeof properties !== "object") return null;

  const values = properties as Record<string, unknown>;
  const common = createCommonProperties(values);
  if (common === null) return null;
  // posthog-js emits $pageleave itself once capture_pageleave is true, so it
  // reaches before_send carrying PostHog's own raw properties rather than
  // ours. It gets rebuilt through the same allowlist as $pageview: without
  // this branch every $pageleave would be dropped silently by the final
  // `return null` below, which is why flipping capture_pageleave alone fixes
  // nothing. $pathname is added because PostHog's Web analytics Page /
  // Entry page / Exit page tables key off it and nothing else; it is always
  // set to the already-sanitized `path`, never the raw pathname, so it can
  // never carry more than the event was already sending.
  if (event === "$pageview" || event === "$pageleave") {
    return createSanitizedEvent(eventInput, event, {
      ...common,
      $pathname: common.path,
      $current_url: `${PRODUCTION_ORIGIN}${common.path}`,
    });
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
