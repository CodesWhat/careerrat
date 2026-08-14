export function formatTokenCount(value) {
  const n = Number(value) || 0;
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(Math.round(n));
}

export function formatUsd(value) {
  const n = Number(value) || 0;
  if (n > 0 && n < 0.01) return `$${n.toFixed(4)}`;
  return `$${n.toFixed(2)}`;
}

export function usageFeatureLabel(feature) {
  const text = String(feature || "").trim();
  if (!text) return "Unlabeled";
  return text
    .replace(/[._:-]+/g, " ")
    .replace(/\s+/g, " ")
    .replace(/^./, (char) => char.toUpperCase());
}

export function topUsageFeatures(rows = [], limit = 4) {
  return [...(Array.isArray(rows) ? rows : [])]
    .sort(
      (a, b) =>
        (Number(b.cost_usd) || 0) - (Number(a.cost_usd) || 0) ||
        (Number(b.tokens_in) || 0) +
          (Number(b.tokens_out) || 0) -
          ((Number(a.tokens_in) || 0) + (Number(a.tokens_out) || 0))
    )
    .slice(0, limit);
}
