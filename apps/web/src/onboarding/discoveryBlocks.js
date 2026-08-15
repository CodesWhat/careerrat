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
  // The research trio's conversational web handoff (research-company /
  // research-comp / company-health SKILL.md "Conversational web handoff"):
  // CHAT_RUNTIME_TOOLS has no Bash, so an embedded session can never shell
  // out to `careerrat research record`/`careerrat health record` — it emits
  // its finished result as one of these three typed blocks instead, and
  // ChatPanel.jsx turns each into a "Save" confirm control that fires the
  // matching research.record / company.health-record intent server-side.
  if (value.kind === "company_research_result") {
    const company = clean(value.company);
    const slug = clean(value.slug);
    const markdown = typeof value.markdown === "string" ? value.markdown : "";
    if (!company || !markdown.trim()) return null;
    return { kind: value.kind, company, slug, markdown };
  }
  if (value.kind === "comp_benchmark_result") {
    const role = clean(value.role);
    const location = clean(value.location);
    const stem = clean(value.stem);
    const markdown = typeof value.markdown === "string" ? value.markdown : "";
    if (!role || !markdown.trim()) return null;
    return {
      kind: value.kind,
      role,
      location,
      stem,
      benchmark: value.benchmark && typeof value.benchmark === "object" ? value.benchmark : null,
      markdown,
    };
  }
  if (value.kind === "company_health_result") {
    const targetType =
      value.targetType === "sourced" || value.targetType === "application" ? value.targetType : "";
    const targetId = clean(value.targetId);
    const company = clean(value.company);
    const companyHealth =
      value.companyHealth && typeof value.companyHealth === "object" ? value.companyHealth : null;
    if (!targetType || !targetId || !companyHealth) return null;
    return { kind: value.kind, targetType, targetId, company, companyHealth };
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
