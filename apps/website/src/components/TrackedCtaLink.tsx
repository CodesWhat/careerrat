"use client";

import posthog from "posthog-js";
import type { AnchorHTMLAttributes } from "react";

type TrackedCtaLinkProps = Omit<AnchorHTMLAttributes<HTMLAnchorElement>, "href"> & {
  href: string;
  placement: "header" | "hero" | "get" | "pricing" | "final";
};

export function TrackedCtaLink({ placement, onClick, href, ...props }: TrackedCtaLinkProps) {
  return (
    <a
      {...props}
      href={href}
      onClick={(event) => {
        posthog.capture("cta activated", { cta_id: "get_started", placement });
        onClick?.(event);
      }}
    />
  );
}
