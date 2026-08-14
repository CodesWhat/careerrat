// Deterministic extraction for candidate-authored Markdown sections whose
// headings make intent explicit. These rows do not infer anything: every
// canonical value and supporting quote comes directly from the source text.

const EMPTY_PAYLOAD = Object.freeze({
  title: "",
  summary: "",
  claim: "",
  evidence: "",
  situation: "",
  task: "",
  action: "",
  result: "",
  reflection: "",
  boundaryType: "",
  text: "",
  allowedWording: "",
  forbiddenWording: "",
  roleFamily: "",
  signalType: "",
  rationale: "",
  reason: "",
});

export function extractExplicitMarkdownProposals(source = {}) {
  const rows = [];
  for (const chunk of Array.isArray(source.chunks) ? source.chunks : []) {
    const sections = markdownSections(chunk.text);
    const sourceId = String(source.id || source.sourceId || "source");
    const chunkId = String(chunk.id || "");
    rows.push(...honestyRows({ sourceId, chunkId, section: sections.get("honesty") }));
    rows.push(
      ...roleSignalRows({
        sourceId,
        chunkId,
        targeting: sections.get("targeting"),
        keep: sections.get("keep"),
        cut: sections.get("cut"),
      })
    );
  }
  return dedupeRows(rows);
}

function markdownSections(value) {
  const sections = new Map();
  const lines = String(value || "").split(/\r?\n/);
  let key = null;
  let heading = "";
  let body = [];

  function flush() {
    if (!key) return;
    const text = body.join("\n").trim();
    sections.set(key, { heading, text, bullets: bulletRows(body) });
  }

  for (const line of lines) {
    const match = line.match(/^#{1,3}\s+(.+?)\s*$/);
    if (match) {
      flush();
      heading = match[1].trim();
      key = sectionKey(heading);
      body = [];
      continue;
    }
    if (key) body.push(line);
  }
  flush();
  return sections;
}

function sectionKey(heading) {
  const value = String(heading || "")
    .trim()
    .toLowerCase();
  if (value === "targeting") return "targeting";
  if (value === "keep signals") return "keep";
  if (value === "cut signals") return "cut";
  if (/evidence.*honesty|honesty.*boundar/.test(value)) return "honesty";
  return null;
}

function bulletRows(lines) {
  return lines
    .map((line) => {
      const match = String(line).match(/^\s*[-*+]\s+(.+?)\s*$/);
      return match ? { raw: line.trim(), text: match[1].trim() } : null;
    })
    .filter(Boolean);
}

function honestyRows({ sourceId, chunkId, section }) {
  if (!section) return [];
  return section.bullets
    .filter(({ text }) =>
      /\b(?:did not|does not|no production|no security|no patents|belongs only|do not|shared work|co-led|phrase as)\b/i.test(
        text
      )
    )
    .map(({ text }, index) => {
      const sharedOwnership = /shared work|co-led|phrase as/i.test(text);
      const metricAttribution = /belongs only/i.test(text);
      const wording = text.match(/phrase as\s+["“]([^"”]+)["”]/i)?.[1] || "";
      return proposalRow({
        id: `${sourceId}_explicit_honesty_${index + 1}`,
        lane: "honesty",
        sourceId,
        chunkId,
        supportingQuote: text,
        payload: {
          title: sharedOwnership
            ? "Shared ownership boundary"
            : metricAttribution
              ? "Metric attribution boundary"
              : "Candidate-stated honesty boundary",
          summary: text,
          boundaryType: sharedOwnership
            ? "shared_ownership"
            : metricAttribution
              ? "metric_attribution"
              : "scope_limit",
          text,
          allowedWording: wording,
          forbiddenWording: sharedOwnership ? "sole ownership" : "",
          reason: "Explicit candidate-provided honesty boundary.",
        },
      });
    });
}

function roleSignalRows({ sourceId, chunkId, targeting, keep, cut }) {
  const rows = [];
  if (targeting) {
    const roleBullets = targeting.bullets.filter(({ text }) =>
      /^(?:primary|secondary|stretch)\s*:/i.test(text)
    );
    if (roleBullets.length) {
      rows.push(
        proposalRow({
          id: `${sourceId}_explicit_target_roles`,
          lane: "role_signal",
          sourceId,
          chunkId,
          supportingQuote: roleBullets.map(({ raw }) => raw).join("\n"),
          payload: {
            title: "Target role lanes",
            summary: roleBullets.map(({ text }) => text).join("; "),
            text: roleBullets.map(({ text }) => text).join("\n"),
            roleFamily: "candidate_targets",
            signalType: "target_roles",
            rationale: "Explicit Targeting section.",
          },
        })
      );
    }

    const compensationBullets = targeting.bullets.filter(({ text }) =>
      /^(?:target base|minimum base|target total compensation)\s*:/i.test(text)
    );
    if (compensationBullets.length) {
      rows.push(
        proposalRow({
          id: `${sourceId}_explicit_compensation`,
          lane: "role_signal",
          sourceId,
          chunkId,
          supportingQuote: compensationBullets.map(({ raw }) => raw).join("\n"),
          payload: {
            title: "Compensation targets",
            summary: compensationBullets.map(({ text }) => text).join("; "),
            text: compensationBullets.map(({ text }) => text).join("\n"),
            roleFamily: "all",
            signalType: "compensation",
            rationale: "Explicit Targeting section.",
          },
        })
      );
    }

    const locationBullet = targeting.bullets.find(({ text }) =>
      /^location posture\s*:/i.test(text)
    );
    if (locationBullet) {
      rows.push(
        proposalRow({
          id: `${sourceId}_explicit_location`,
          lane: "role_signal",
          sourceId,
          chunkId,
          supportingQuote: locationBullet.text,
          payload: {
            title: "Location posture",
            summary: locationBullet.text,
            text: locationBullet.text,
            roleFamily: "all",
            signalType: "location_posture",
            rationale: "Explicit Targeting section.",
          },
        })
      );
    }
  }

  if (keep?.bullets.length) {
    rows.push(sectionSignalRow({ sourceId, chunkId, section: keep, signalType: "keep" }));
  }
  if (cut?.bullets.length) {
    rows.push(sectionSignalRow({ sourceId, chunkId, section: cut, signalType: "cut" }));
  }
  return rows;
}

function sectionSignalRow({ sourceId, chunkId, section, signalType }) {
  const label = signalType === "keep" ? "Keep signals" : "Cut signals";
  return proposalRow({
    id: `${sourceId}_explicit_${signalType}`,
    lane: "role_signal",
    sourceId,
    chunkId,
    supportingQuote: section.text,
    payload: {
      title: label,
      summary: section.bullets.map(({ text }) => text).join("; "),
      text: section.bullets.map(({ text }) => text).join("\n"),
      roleFamily: "all",
      signalType,
      rationale: `Explicit ${label} section.`,
    },
  });
}

function proposalRow({ id, lane, sourceId, chunkId, supportingQuote, payload }) {
  return {
    id,
    lane,
    sourceId,
    chunkId,
    status: "review_needed",
    confidence: 1,
    supportingQuote,
    payload: { ...EMPTY_PAYLOAD, ...payload },
    validation: { status: "passed", blockedReasons: [] },
  };
}

function dedupeRows(rows) {
  const seen = new Set();
  return rows.filter((row) => {
    const key = `${row.lane}:${row.payload.boundaryType}:${row.payload.signalType}:${row.supportingQuote}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
