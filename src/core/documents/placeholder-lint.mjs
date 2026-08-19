// placeholder-lint.mjs — lint GENERATED ARTIFACT text for unresolved placeholders.
// Distinct from candidate-setup.mjs lintPlaceholders which scans candidate config files.
// Zero runtime dependencies.

// ---------------------------------------------------------------------------
// PLACEHOLDER_PATTERNS
// ---------------------------------------------------------------------------

/**
 * Array of { name, re } objects covering common template residue patterns.
 * Patterns are kept tight to avoid flagging legitimate prose.
 */
export const PLACEHOLDER_PATTERNS = [
  // Square-bracket tokens: [Company], [Role], [levels.fyi], [anything with letters,
  // digits, spaces, dots, hyphens, slashes]. The dot is included so domain-style bare
  // citation markers ([levels.fyi], [glassdoor.com]) are caught as residue — the
  // citation-hygiene contract requires a full `[source: ...]` marker, and the colon in
  // a real marker breaks this match so genuine citations stay exempt.
  // Negative lookahead (?!\() ensures we don't flag markdown links like [text](url)
  {
    name: "bracket-token",
    re: /\[[A-Za-z][\w .\-/]*\](?!\()/,
  },
  // Double curly: {{x}}
  {
    name: "double-curly-token",
    re: /\{\{[^}]+\}\}/,
  },
  // Single curly: {candidate}, {role}, etc.
  {
    name: "curly-token",
    re: /\{[A-Za-z][\w]*\}/,
  },
  // Angle-bracket inserts: <insert metric>, <...>
  {
    name: "angle-insert",
    re: /<insert[^>]*>/i,
  },
  // Generic angle ellipsis token
  {
    name: "angle-ellipsis",
    re: /<\.\.\.>/,
  },
  // Bare word: TODO
  {
    name: "TODO",
    re: /\bTODO\b/i,
  },
  // Bare word: TBD
  {
    name: "TBD",
    re: /\bTBD\b/i,
  },
  // Bare word: FIXME
  {
    name: "FIXME",
    re: /\bFIXME\b/i,
  },
  // Bare word: XXX
  {
    name: "XXX",
    re: /\bXXX\b/,
  },
  // Unanswerable form-question marker written by tailor-application STEP 6 — the
  // packet must not be upload-ready until the user resolves it. Case-sensitive on
  // purpose: ALL-CAPS is the marker form; lowercase "needs you" is legitimate prose.
  {
    name: "needs-you-marker",
    re: /\bNEEDS YOU\b/,
  },
  // Lorem ipsum
  {
    name: "lorem-ipsum",
    re: /\blorem\s+ipsum\b/i,
  },
  // Template-persona sentinels — catch template bleed-through before artifact write
  {
    name: "template-persona-name",
    re: /\bJane Candidate\b/i,
  },
  {
    name: "template-persona-email",
    re: /\bjane@example\.com\b/i,
  },
  {
    name: "template-persona-phone",
    re: /\+1-555-0100/,
  },
  {
    name: "template-persona-slug",
    re: /\bjanecandidate\b/i,
  },
];

// ---------------------------------------------------------------------------
// lintArtifact
// ---------------------------------------------------------------------------

/**
 * Scan a single artifact text string for unresolved placeholders.
 *
 * @param {string} text
 * @returns {{ clean: boolean, findings: Array<{ line: number, column: number, text: string, pattern: string }> }}
 *   line and column are 1-based.
 */
export function lintArtifact(text) {
  const findings = [];
  const lines = text.split("\n");

  for (let i = 0; i < lines.length; i++) {
    const lineText = lines[i];
    for (const { name, re } of PLACEHOLDER_PATTERNS) {
      // Use a copy with lastIndex reset-safe approach (no /g flag needed per pattern)
      const match = re.exec(lineText);
      if (match !== null) {
        findings.push({
          line: i + 1,
          column: match.index + 1,
          text: lineText.trim(),
          pattern: name,
        });
        break; // one finding per line
      }
    }
  }

  return { clean: findings.length === 0, findings };
}

// ---------------------------------------------------------------------------
// lintArtifacts
// ---------------------------------------------------------------------------

/**
 * Scan multiple artifact files for unresolved placeholders.
 *
 * @param {Array<{ name: string, text: string }>} files
 * @returns {{ clean: boolean, findings: Array<{ file: string, line: number, column: number, text: string, pattern: string }> }}
 */
export function lintArtifacts(files) {
  const findings = [];

  for (const { name, text } of files) {
    const result = lintArtifact(text);
    for (const finding of result.findings) {
      findings.push({ file: name, ...finding });
    }
  }

  return { clean: findings.length === 0, findings };
}

// ---------------------------------------------------------------------------
// assertBuildReady
// ---------------------------------------------------------------------------

/**
 * Gate function: throws if any placeholder findings exist; returns true if clean.
 * Used as the pre-upload gate before submitting artifacts.
 *
 * @param {Array<{ name: string, text: string }>} files
 * @returns {true}
 * @throws {Error} listing all findings if not clean
 */
export function assertBuildReady(files) {
  const { clean, findings } = lintArtifacts(files);
  if (clean) return true;

  const lines = findings.map((f) => `  ${f.file}:${f.line}:${f.column} [${f.pattern}]: ${f.text}`);
  throw new Error(
    `Artifact(s) contain unresolved placeholders, not build-ready:\n${lines.join("\n")}`
  );
}
