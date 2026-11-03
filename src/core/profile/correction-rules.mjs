// profile/correction-rules.mjs: turn a correction the person made into a proposed
// writing rule. Career Ops retro.md / learn.mjs (MIT) idea.
//
// A proposal is only a proposal. It carries the person's verbatim words, at most five
// are kept per session, and nothing is written until `rules accept <id>`, which goes
// through the recorded-config writer so it shows up in the change history and has a
// real Undo. A correction that states a FACT about the candidate (an employer, a
// number of years, a degree) is refused: facts belong in evidence, where the
// evidence firewall can check them, not in a style rule that every draft obeys.

import { createHash } from "node:crypto";
import { findCompLeak } from "./comp-guard.mjs";

export const MAX_RULES_PER_SESSION = 5;
export const RULE_KINDS = ["prefer", "avoid"];
const MAX_RULE_CHARS = 200;
const MAX_QUOTE_CHARS = 500;

export const FACT_REFUSAL =
  "That reads as a fact about you, not a writing rule. Facts go in evidence (careerrat evidence add) so they get checked; a rule only changes how drafts are written.";

const FACT_PATTERNS = [
  /\b(?:i|i'm|i've|i'd|i'll|my|me|mine)\b/i,
  /\b(?:the )?candidate(?:'s)?\b/i,
  /\b\d+\+?\s*(?:years?|yrs?)\b/i,
  /\b(?:19|20)\d{2}\b/,
  /[$€£]\s?\d/,
  /\b\d+(?:\.\d+)?\s*(?:%|percent|k\b|m\b|million|billion)/i,
  /\b(?:worked|employed|graduated|certified|licensed|promoted|hired|laid off|fired)\b/i,
  /\b(?:degree|diploma|certification|clearance)\b/i,
];

function normalizeSpace(value) {
  return String(value ?? "")
    .replace(/\s+/g, " ")
    .trim();
}

export function isFactClaim(rule) {
  return FACT_PATTERNS.some((re) => re.test(rule));
}

export function ruleId({ session, kind, rule }) {
  return `rule-${createHash("sha1")
    .update(`${session}\n${kind}\n${rule.toLowerCase()}`)
    .digest("hex")
    .slice(0, 8)}`;
}

/**
 * Validate and build a proposal. Pure; returns { ok, proposal } or { ok:false, error, reason }.
 * `existing` is the stored proposal list, used for the per-session cap and duplicates.
 */
export function buildProposal({
  session,
  kind,
  rule,
  quote,
  existing = [],
  now = new Date(),
} = {}) {
  const cleanRule = normalizeSpace(rule);
  const cleanQuote = normalizeSpace(quote);
  const cleanSession = normalizeSpace(session);
  if (!cleanSession) return refuse("A session id is required.", "no-session");
  if (!RULE_KINDS.includes(kind)) {
    return refuse(`Kind must be one of: ${RULE_KINDS.join(", ")}.`, "bad-kind");
  }
  if (!cleanQuote) {
    return refuse("The person's own words are required, quoted exactly.", "no-quote");
  }
  if (cleanQuote.length > MAX_QUOTE_CHARS) {
    return refuse(
      `The quote is over ${MAX_QUOTE_CHARS} characters. Quote only the correction.`,
      "quote-too-long"
    );
  }
  if (!cleanRule) return refuse("The rule text is empty.", "no-rule");
  if (cleanRule.length > MAX_RULE_CHARS) {
    return refuse(
      `A rule is one short line, ${MAX_RULE_CHARS} characters at most.`,
      "rule-too-long"
    );
  }
  if (isFactClaim(cleanRule)) return refuse(FACT_REFUSAL, "fact");
  if (findCompLeak(cleanRule) || findCompLeak(cleanQuote)) {
    return refuse("That touches private pay details, so it can't be saved as a rule.", "private");
  }
  const id = ruleId({ session: cleanSession, kind, rule: cleanRule });
  if (existing.some((p) => p.id === id)) {
    return refuse("That rule was already proposed this session.", "duplicate");
  }
  const inSession = existing.filter((p) => p.session === cleanSession).length;
  if (inSession >= MAX_RULES_PER_SESSION) {
    return refuse(
      `Already ${MAX_RULES_PER_SESSION} proposed this session. Accept or dismiss some, then pick up the rest next session.`,
      "session-cap"
    );
  }
  return {
    ok: true,
    proposal: {
      id,
      session: cleanSession,
      kind,
      rule: cleanRule,
      quote: cleanQuote,
      status: "proposed",
      createdAt: now.toISOString(),
    },
  };
}

function refuse(error, reason) {
  return { ok: false, error, reason };
}
