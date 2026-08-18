"use client";

import posthog from "posthog-js";
import type { AnchorHTMLAttributes } from "react";

type TrackedCtaLinkProps = AnchorHTMLAttributes<HTMLAnchorElement> & {
  placement: "header" | "hero" | "pricing" | "final";
};

export function TrackedCtaLink({ placement, onClick, ...props }: TrackedCtaLinkProps) {
  return (
    <a
      {...props}
      onClick={(event) => {
        posthog.capture("cta activated", { cta_id: "get_started", placement });
        onClick?.(event);
      }}
    />
  );
}
