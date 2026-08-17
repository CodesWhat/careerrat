#!/usr/bin/env node
// commit-msg hook: enforce plain Conventional Commits on the subject line.
//
// Invoked by lefthook's `commit-msg` hook (see lefthook.yml) as:
//   node scripts/validate-commit-msg.mjs <path-to-commit-msg-file>
//
// Pattern: <type>(<scope>)!?: <description>
//   - type is exactly one of the allowed Conventional Commits types
//   - scope is optional
//   - description starts lowercase and has no trailing period
// `Merge ...` and `Revert "..."` subjects (git-generated) are always allowed.

import { readFileSync } from "node:fs";

const TYPES = [
  "feat",
  "fix",
  "docs",
  "style",
  "refactor",
  "perf",
  "test",
  "build",
  "ci",
  "chore",
  "revert",
];

const SUBJECT_PATTERN = new RegExp(`^(${TYPES.join("|")})(\\([a-z0-9./-]+\\))?!?: [a-z0-9]`);

function validateSubject(subject) {
  if (subject.startsWith("Merge ") || /^Revert ".+"$/.test(subject)) {
    return { ok: true };
  }
  if (!SUBJECT_PATTERN.test(subject)) {
    return {
      ok: false,
      reason: [
        "commit subject must be plain Conventional Commits:",
        "  <type>(scope): <description>",
        `allowed types: ${TYPES.join(" ")}`,
        "description must start lowercase and not end with a period",
        `got: ${subject}`,
      ].join("\n"),
    };
  }
  if (subject.endsWith(".")) {
    return {
      ok: false,
      reason: `commit subject must not end with a period:\ngot: ${subject}`,
    };
  }
  return { ok: true };
}

function main() {
  const file = process.argv[2];
  if (!file) {
    console.error("Usage: validate-commit-msg.mjs <commit-msg-file>");
    process.exit(1);
  }
  const subject = readFileSync(file, "utf8").split("\n")[0] ?? "";
  const result = validateSubject(subject);
  if (!result.ok) {
    console.error(result.reason);
    process.exit(1);
  }
}

main();
