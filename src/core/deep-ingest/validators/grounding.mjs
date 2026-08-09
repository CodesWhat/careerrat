export function validateDeepIngestGrounding({ proposal, chunks = [] } = {}) {
  const chunkList = Array.isArray(chunks) ? chunks : [];
  const chunkId = stringValue(proposal?.chunkId || proposal?.span?.chunkId);
  const supportingQuote = stringValue(proposal?.supportingQuote);
  const chunk = chunkList.find((entry) => stringValue(entry?.id) === chunkId);
  const errors = [];

  if (!chunkId) {
    errors.push({ path: "chunkId", message: "source chunk is required" });
  } else if (!chunk) {
    errors.push({ path: "chunkId", message: "source chunk was not found" });
  }

  if (!supportingQuote) {
    errors.push({ path: "supportingQuote", message: "supporting quote is required" });
  } else if (chunk && !sourceContainsQuote(chunk.text, supportingQuote)) {
    errors.push({
      path: "supportingQuote",
      message: "supporting quote must appear in the referenced source chunk",
    });
  }

  if (proposal?.span && chunk) {
    const spanChunkId = stringValue(proposal.span.chunkId);
    if (spanChunkId && spanChunkId !== chunkId) {
      errors.push({ path: "span.chunkId", message: "span chunk must match proposal chunk" });
    }
  }

  if (errors.length) {
    return {
      ok: false,
      code: "UNGROUNDED_PROPOSAL",
      blockedFields: unique(errors.map((error) => error.path)),
      errors,
    };
  }

  return { ok: true, code: null, blockedFields: [], errors: [] };
}

function sourceContainsQuote(sourceText, supportingQuote) {
  const source = normalizeGroundingText(sourceText);
  const quote = normalizeGroundingText(supportingQuote);
  return Boolean(quote && source.includes(quote));
}

function normalizeGroundingText(value) {
  return String(value || "")
    .normalize("NFKC")
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'")
    .replace(/[‐‑‒–—]/g, "-")
    .replace(/^\s*#{1,6}\s+/gm, "")
    .replace(/^\s*[-*+]\s+/gm, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function stringValue(value) {
  return String(value ?? "").trim();
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}
