// Next.js App Router client instrumentation entry point (auto-loaded, no
// provider component needed). Wiring copied from CodesWhat/codeswhat.com's
// frontend/instrumentation-client.ts — the shared house PostHog standard.
import posthog from "posthog-js";
import { getPostHogConfig, sanitizeEvent, sanitizeRoute } from "@/lib/posthog-privacy";

const posthogConfig = getPostHogConfig({
  NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN: process.env.NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN,
  NEXT_PUBLIC_POSTHOG_HOST: process.env.NEXT_PUBLIC_POSTHOG_HOST,
  NEXT_PUBLIC_POSTHOG_UI_HOST: process.env.NEXT_PUBLIC_POSTHOG_UI_HOST,
});

function capturePageview(url: string) {
  posthog.capture("$pageview", { path: sanitizeRoute(url) });
}

if (typeof window !== "undefined" && posthogConfig) {
  posthog.init(posthogConfig.token, {
    api_host: posthogConfig.apiHost,
    ui_host: posthogConfig.uiHost,
    capture_pageview: false,
    // posthog-js only emits $pageleave when this is an explicit true, or
    // "if_capture_pageview" combined with capture_pageview enabled
    // (posthog-js posthog-core.ts, _shouldCapturePageleave). capture_pageview
    // is false above since pageviews are captured by hand, so the default
    // would silently disable $pageleave too.
    capture_pageleave: true,
    autocapture: false,
    rageclick: false,
    disable_session_recording: true,
    capture_heatmaps: false,
    capture_dead_clicks: false,
    capture_exceptions: false,
    disable_surveys: true,
    disable_surveys_automatic_display: true,
    disable_product_tours: true,
    disable_web_experiments: true,
    advanced_disable_flags: true,
    person_profiles: "never",
    cookieless_mode: "always",
    persistence: "memory",
    disable_persistence: true,
    respect_dnt: true,
    save_referrer: false,
    save_campaign_params: false,
    disable_capture_url_hashes: true,
    disable_scroll_properties: true,
    mask_all_element_attributes: true,
    mask_all_text: true,
    capture_performance: {
      network_timing: false,
      web_vitals: true,
      web_vitals_allowed_metrics: ["CLS", "FCP", "INP", "LCP"],
      web_vitals_attribution: false,
    },
    before_send: (event) => sanitizeEvent(event) as typeof event | null,
  });

  capturePageview(window.location.pathname);
}

// Next.js calls this automatically on every App Router client-side route
// transition (static export, so all navigation after the first load is
// client-side).
export function onRouterTransitionStart(url: string) {
  if (typeof window !== "undefined" && posthogConfig) capturePageview(url);
}
