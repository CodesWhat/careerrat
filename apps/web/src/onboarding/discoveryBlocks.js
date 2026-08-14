const DISCOVERY_STEPS = new Set(["research-boards", "discover-companies"]);
const CONFIDENCE = new Set(["high", "borderline"]);

function clean(value) {
  return String(value ?? "").trim();
}

function safeHttpUrl(value) {
  const text = clean(value);
  try {
    const parsed = new URL(text);
    return ["http:", "https:"].includes(parsed.protocol) ? parsed.href : "";
  } catch {
    return "";
  }
}

function normalizeBlock(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  if (value.kind === "source_proposal") {
    const label = clean(value.label);
    const url = safeHttpUrl(value.url);
    if (!label || !url) return null;
    return {
      kind: value.kind,
      label,
      url,
      ...(clean(value.why) ? { why: clean(value.why) } : {}),
      confidence: CONFIDENCE.has(value.confidence) ? value.confidence : "borderline",
    };
  }
  if (value.kind === "company_proposal") {
    const name = clean(value.name);
    const url = safeHttpUrl(value.url);
    if (!name || !url) return null;
    return {
      kind: value.kind,
      name,
      url,
      ...(clean(value.why) ? { why: clean(value.why) } : {}),
      confidence: CONFIDENCE.has(value.confidence) ? value.confidence : "borderline",
    };
  }
  if (value.kind === "discovery_complete" && DISCOVERY_STEPS.has(value.step)) {
    return { kind: value.kind, step: value.step };
  }
  return null;
}

export function parseDiscoveryBlocks(raw) {
  const blocks = [];
  const text = String(raw ?? "").replace(
    /```careerrat:discovery\s*\n([\s\S]*?)```/gi,
    (_match, body) => {
      try {
        const block = normalizeBlock(JSON.parse(body.trim()));
        if (block) blocks.push(block);
      } catch {
        // Invalid model output stays inert and is omitted from the visible transcript.
      }
      return "";
    }
  );
  return { text: text.replace(/\n{3,}/g, "\n\n").trim(), blocks };
}
