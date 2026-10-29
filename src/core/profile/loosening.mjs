// loosening.mjs: decides whether a candidate-config change loosens a guard the
// operator set, so the write has to ask first instead of applying directly.
//
// Knowledge writes apply directly and land in the thread with an Undo. The two
// exceptions stay confirm-first: weakening an honesty boundary, and lowering the
// pay floor or target. Tightening, and a value set for the first time, are not
// loosening. Pure: callers pass the stored doc and the doc the write would leave.

// Honesty lists a removal from which weakens a boundary. `boundaries` is not in
// honesty.schema.json (the schema allows extra keys), but a doc that carries one
// is treated the same way.
const HONESTY_LISTS = [
  { path: ["tools", "do_not_claim"], label: "do-not-claim list" },
  { path: ["claims", "do_not_fabricate"], label: "do-not-fabricate list" },
  { path: ["boundaries"], label: "boundaries list" },
];

// profile.schema.json compensation fields: the floors and the targets.
const COMP_FIELDS = [
  { key: "minimum_base", label: "minimum base pay" },
  { key: "minimum_annual_earnings", label: "minimum annual cash earnings" },
  { key: "target_base", label: "target base pay" },
  { key: "target_total_comp", label: "target total pay" },
];

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function readPath(doc, path) {
  let cursor = doc;
  for (const part of path) cursor = isPlainObject(cursor) ? cursor[part] : undefined;
  return cursor;
}

function listOf(value) {
  return Array.isArray(value) ? value.map((item) => String(item ?? "").trim()) : [];
}

function norm(text) {
  return text.toLowerCase();
}

function classifyHonesty(before, after, reasons) {
  for (const { path, label } of HONESTY_LISTS) {
    const kept = new Set(listOf(readPath(after, path)).map(norm));
    for (const item of listOf(readPath(before, path))) {
      if (item && !kept.has(norm(item))) reasons.push(`Removes "${item}" from your ${label}.`);
    }
  }
  // A tool moves into confirmed from a list that held it back (adjacent or
  // do-not-claim). A tool in no earlier list is a first-time value.
  const heldBack = new Set(
    ["adjacent", "do_not_claim"].flatMap((key) =>
      listOf(readPath(before, ["tools", key])).map(norm)
    )
  );
  const wasConfirmed = new Set(listOf(readPath(before, ["tools", "confirmed"])).map(norm));
  for (const tool of listOf(readPath(after, ["tools", "confirmed"]))) {
    if (tool && heldBack.has(norm(tool)) && !wasConfirmed.has(norm(tool))) {
      reasons.push(`Marks "${tool}" as a confirmed tool.`);
    }
  }
}

function classifyProfile(before, after, reasons) {
  for (const { key, label } of COMP_FIELDS) {
    const prior = readPath(before, ["compensation", key]);
    if (typeof prior !== "number" || !Number.isFinite(prior)) continue;
    const next = readPath(after, ["compensation", key]);
    const cleared = next === null || next === undefined;
    if (cleared || (typeof next === "number" && next < prior)) {
      reasons.push(cleared ? `Clears your ${label}.` : `Lowers your ${label}.`);
    }
  }
}

// classifyConfigChange(name, before, after) -> { loosens, reasons }
// `before` is the stored doc, `after` the doc the write would leave. Reasons are
// plain sentences and never carry a pay figure.
export function classifyConfigChange(name, before, after) {
  const reasons = [];
  if (name === "honesty") classifyHonesty(before, after, reasons);
  else if (name === "profile") classifyProfile(before, after, reasons);
  return { loosens: reasons.length > 0, reasons };
}
