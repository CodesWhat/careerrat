// Shared path-containment primitive for CareerRat's two independent runtime
// file-access boundaries: runtime-tool-policy.mjs's general Read/Glob/Grep
// allowlist (the chat/skill runtimes' broad tool profile) and
// installed-runtimes.mjs's narrower exact-read staged-upload boundary (the
// installed CLI runtimes' intake-extract/resume-extract skills). Both files
// canonicalize (realpath) their own paths before calling this — it only
// decides whether an already-canonical `candidate` resolves inside an
// already-canonical `root`.
//
// Single-sourced here because the two files previously carried independent
// copies of this check that had quietly drifted: one compared the raw
// `relative()` string against the two-character literal "..", which also
// matches a real file or directory whose name simply begins with two dots
// (e.g. "..bar") and wrongly treats it as outside root. This version
// requires the separator immediately after ".." (or an exact ".." segment)
// before treating it as a parent-traversal escape, so a literal dot-prefixed
// name inside root is correctly still "within".
import { isAbsolute, relative, sep } from "node:path";

export function isWithinRuntimePath(root, candidate) {
  const remainder = relative(root, candidate);
  return (
    remainder === "" ||
    (!remainder.startsWith(`..${sep}`) && remainder !== ".." && !isAbsolute(remainder))
  );
}
