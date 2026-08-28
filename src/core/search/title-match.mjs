function normalizedTitleWord(word) {
  return word === "events" ? "event" : word;
}

export function normalizedTitleWords(value) {
  return new Set(
    String(value || "")
      .toLowerCase()
      .replace(/&/g, " and ")
      .replace(/[^a-z0-9]+/g, " ")
      .trim()
      .split(/\s+/)
      .filter(Boolean)
      .map(normalizedTitleWord)
  );
}

export function titleMatchesBucket(title, bucket) {
  const actual = normalizedTitleWords(title);
  return (Array.isArray(bucket?.titles) ? bucket.titles : []).some((targetTitle) => {
    const target = normalizedTitleWords(targetTitle);
    return target.size > 0 && [...target].every((word) => actual.has(word));
  });
}
