"use client";

import posthog from "posthog-js";
import type { AnchorHTMLAttributes } from "react";

type TrackedCtaLinkProps = AnchorHTMLAttributes<HTMLAnchorElement> & {
  placement: "header" | "hero" | "get" | "pricing" | "final";
};

export function TrackedCtaLink({ placement, onClick, ...props }: TrackedCtaLinkProps) {
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: every call site passes an href, this is a real navigation link with a tracking onClick, not a fake button
    // biome-ignore lint/a11y/useKeyWithClickEvents: same reason, native anchor keyboard activation already applies
    <a
      {...props}
      // biome-ignore lint/a11y/useValidAnchor: href comes from AnchorHTMLAttributes props spread, not visible to the linter statically
      onClick={(event) => {
        posthog.capture("cta activated", { cta_id: "get_started", placement });
        onClick?.(event);
      }}
    />
  );
}
