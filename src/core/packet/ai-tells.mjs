// Deterministic check for the high-confidence tells of AI-written prose.
//
// Generated résumé bullets, cover letters and screening answers should read
// as written by the candidate, not by a model. This flags the tells a careful
// writer rarely produces on purpose, and names a plainer alternative for each,
// so a retry or the reviewer pass can fix them. It only reads text; it never
// rewrites, and it is field-neutral (no role, industry or tool is assumed).
//
// Source of the patterns: the humanizer skill by Siqi Chen
// (https://github.com/blader/humanizer, MIT License, Copyright (c) 2025 Siqi
// Chen), which is based on Wikipedia's "Signs of AI writing"
// (https://en.wikipedia.org/wiki/Wikipedia:Signs_of_AI_writing). The word list
// below is condensed from that skill's section 12 (overused AI words) and
// reworded; no text is copied verbatim beyond single words.
//
// MIT License notice, reproduced as the license requires:
//
//   Permission is hereby granted, free of charge, to any person obtaining a
//   copy of this software and associated documentation files (the
//   "Software"), to deal in the Software without restriction, including
//   without limitation the rights to use, copy, modify, merge, publish,
//   distribute, sublicense, and/or sell copies of the Software, and to permit
//   persons to whom the Software is furnished to do so, subject to the
//   following conditions: The above copyright notice and this permission
//   notice shall be included in all copies or substantial portions of the
//   Software. THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND.

// Single words that are tells wherever they appear, with the plain swap.
const STOCK_WORDS = [
  [/\bdelv(?:e|es|ed|ing)\b/gi, "look into, dig into"],
  [/\bleverag(?:e|es|ed|ing)\b/gi, "use"],
  [/\butili[sz](?:e|es|ed|ing)\b/gi, "use"],
  [/\brobust(?:ly)?\b/gi, "name the property: reliable, tested, fast"],
  [/\bseamless(?:ly)?\b/gi, "drop it, or say what got easier"],
  [/\btapestry\b/gi, "mix, range"],
  [/\bspearhead(?:s|ed|ing)?\b/gi, "led, ran, started"],
  [/\bpivotal\b/gi, "important, or say why"],
  [/\bcrucial\b/gi, "important, or say why"],
  [/\btestament\b/gi, "cut it and state the fact"],
  [/\bshowcas(?:e|es|ed|ing)\b/gi, "show"],
  [/\bunderscor(?:e|es|ed|ing)\b/gi, "show"],
  [/\bmeticulous(?:ly)?\b/gi, "careful, or give the check you ran"],
  [/\bintricate\b/gi, "complex, or say what made it hard"],
  [/\bvibrant\b/gi, "cut it"],
  [/\bcutting-edge\b/gi, "name the technology"],
  [/\bresults-driven\b/gi, "state the result"],
  [/\bpassionate about\b/gi, "say what you did"],
  [/\bsynerg(?:y|ies|ize|ise)\b/gi, "working together, or name the teams"],
];

// Filler and hedging that adds no fact.
const FILLER = [
  [
    /\bit(?:'s| is) (?:important|worth|crucial) to (?:note|mention|remember)(?: that)?\b/gi,
    "cut it",
  ],
  [/\bit should be noted(?: that)?\b/gi, "cut it"],
  [/\bneedless to say\b/gi, "cut it"],
  [/\bat the end of the day\b/gi, "cut it"],
  [/\bin order to\b/gi, "to"],
  [
    /\bin today(?:'s| s) (?:fast-paced|ever-changing|rapidly evolving|dynamic|competitive)\b/gi,
    "start with the point",
  ],
  [/\ba wide (?:range|variety) of\b/gi, "name them, or say how many"],
];

// Inflated openers and closers, mostly cover-letter boilerplate.
const BOILERPLATE = [
  [
    /\bI (?:am|'m) (?:writing to express|thrilled|delighted|excited|eager) (?:my |to )/gi,
    "open with the role and one concrete reason",
  ],
  [/\bproven track record\b/gi, "give the record"],
  [/\bperfect fit\b/gi, "show the match with a fact"],
  [/\bideal candidate\b/gi, "show the match with a fact"],
  [
    /\bI (?:look|am looking) forward to the opportunity to (?:discuss|contribute|bring)\b/gi,
    "end on the next step or a plain thanks",
  ],
  [/\bI am confident that (?:my|I)\b/gi, "state the evidence instead"],
];

const CONTRAST = [
  /\bnot (?:just|only|merely|simply)\b[^.!?\n]{1,100}?\bbut(?: also)?\b/gi,
  /\b(?:it|this|that)(?:'s| is| isn't| is not) not (?:just |only |merely )?[^.!?;\n]{1,60}[,;]\s*(?:it|this|that)(?:'s| is)\b/gi,
  /\b(?:isn't|aren't|wasn't|weren't) (?:just|only|merely)\b[^.!?\n]{1,100}?\bbut(?: also)?\b/gi,
];

// Three abstract single words in a row ("innovation, collaboration, and
// creativity"). Concrete lists such as tools or places don't carry these
// endings, so a skills line like "Python, Go, and Rust" is never flagged.
const ABSTRACT_WORD =
  "[A-Za-z]{3,}(?:ity|tion|sion|ness|ment|ive|ous|ful|able|ible|ency|ance|ence)s?";
const TRIAD = new RegExp(
  `\\b${ABSTRACT_WORD},\\s+${ABSTRACT_WORD},?\\s+(?:and|&)\\s+${ABSTRACT_WORD}\\b`,
  "gi"
);

function collect(text, patterns, id, findings) {
  for (const [pattern, suggestion] of patterns) {
    pattern.lastIndex = 0;
    for (const match of text.matchAll(pattern)) {
      findings.push({ id, phrase: match[0], suggestion, index: match.index });
    }
  }
}

// Returns [{ id, phrase, suggestion, index }] sorted by position. Empty array
// means the text is clean as far as these checks go.
export function findAiTells(text) {
  const source = String(text ?? "");
  const findings = [];
  if (!source.trim()) return findings;

  for (const match of source.matchAll(/—|(?<=\w) -- (?=\w)/g)) {
    findings.push({
      id: "em-dash",
      phrase: match[0].trim(),
      suggestion: "use a period, comma or colon",
      index: match.index,
    });
  }
  collect(source, STOCK_WORDS, "stock-word", findings);
  collect(source, FILLER, "filler", findings);
  collect(source, BOILERPLATE, "boilerplate", findings);
  for (const pattern of CONTRAST) {
    pattern.lastIndex = 0;
    for (const match of source.matchAll(pattern)) {
      findings.push({
        id: "not-x-but-y",
        phrase: match[0],
        suggestion: "state the point directly",
        index: match.index,
      });
    }
  }
  TRIAD.lastIndex = 0;
  for (const match of source.matchAll(TRIAD)) {
    findings.push({
      id: "forced-triad",
      phrase: match[0],
      suggestion: "keep the one or two that carry a fact, and give the fact",
      index: match.index,
    });
  }
  return findings.sort((a, b) => a.index - b.index);
}

export function findAiTellsInTexts(texts = []) {
  const out = [];
  for (const text of Array.isArray(texts) ? texts : [texts]) {
    out.push(...findAiTells(text));
  }
  return out;
}

// One line per distinct phrase: `"phrase": plainer alternative`.
export function aiTellMessages(findings = []) {
  const seen = new Set();
  const lines = [];
  for (const finding of findings) {
    const key = `${finding.id}:${finding.phrase.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    lines.push(`"${finding.phrase}" reads as AI-written: ${finding.suggestion}`);
  }
  return lines;
}
