"use client";

import { useEffect } from "react";

/**
 * All client-side interactions for the landing page:
 *  1. Soft nav-link active state by section
 *  2. Header condensing on scroll
 *
 * Reveal-on-scroll is armed here, AFTER hydration, so the inline bootstrap in
 * layout.tsx never adds `visible` to a React-rendered .reveal node before React
 * hydrates (that pre-hydration mutation caused a hydration mismatch). The inline
 * script only sets the `js` gate + a post-load failsafe for the blocked-bundle
 * case. Each block here guards on reduced-motion / missing IntersectionObserver.
 */
export default function SiteInteractions() {
  useEffect(() => {
    const reduceMotion = window.matchMedia(
      "(prefers-reduced-motion: reduce)",
    ).matches;
    const hasIO = "IntersectionObserver" in window;
    const cleanups: Array<() => void> = [];

    // ── 0. Reveal-on-scroll (armed post-hydration) ──────
    // The flag tells layout.tsx's inline failsafe the bundle loaded, so it won't
    // blanket-reveal. Adding `visible` here (after hydration) is mutation-safe.
    (
      window as unknown as { __careerratRevealArmed?: boolean }
    ).__careerratRevealArmed = true;
    const reveals = document.querySelectorAll<HTMLElement>(".reveal");
    if (!hasIO || reduceMotion) {
      reveals.forEach((el) => el.classList.add("visible"));
    } else {
      const revealObs = new IntersectionObserver(
        (entries) => {
          entries.forEach((entry) => {
            if (entry.isIntersecting) {
              entry.target.classList.add("visible");
              revealObs.unobserve(entry.target);
            }
          });
        },
        { threshold: 0.12, rootMargin: "0px 0px -40px 0px" },
      );
      reveals.forEach((el) => revealObs.observe(el));
      cleanups.push(() => revealObs.disconnect());
    }

    // ── 1. Soft nav link active state ────────────────────
    const sections = document.querySelectorAll<HTMLElement>("section[id]");
    const navLinks =
      document.querySelectorAll<HTMLAnchorElement>('.nav-links a[href^="#"]');
    if (sections.length && navLinks.length && hasIO) {
      const sectionObs = new IntersectionObserver(
        (entries) => {
          entries.forEach((entry) => {
            if (!entry.isIntersecting) return;
            const id = entry.target.id;
            navLinks.forEach((link) => {
              const isActive = link.getAttribute("href") === `#${id}`;
              link.style.fontWeight = isActive ? "700" : "";
              link.style.color = isActive ? "var(--ink)" : "";
            });
          });
        },
        { threshold: 0.4 },
      );
      sections.forEach((s) => sectionObs.observe(s));
      cleanups.push(() => sectionObs.disconnect());
    }

    // ── 2. Header condenses on scroll ────────────────────
    const nav = document.querySelector("nav");
    if (nav) {
      const THRESHOLD = 40;
      let ticking = false;
      const update = () => {
        nav.classList.toggle("scrolled", window.scrollY > THRESHOLD);
        ticking = false;
      };
      const onScroll = () => {
        if (!ticking) {
          window.requestAnimationFrame(update);
          ticking = true;
        }
      };
      window.addEventListener("scroll", onScroll, { passive: true });
      update();
      cleanups.push(() => window.removeEventListener("scroll", onScroll));
    }

    return () => cleanups.forEach((fn) => fn());
  }, []);

  return null;
}
