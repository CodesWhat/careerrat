// A typo'd flag (`--verifiy`) used to be ignored, so the command quietly ran its
// default action and exited 0. Call this before doing any work.
export function exitOnUnknownFlags(args, known, command) {
  const allowed = new Set(known);
  const unknown = args.filter((arg) => arg.startsWith("-") && !allowed.has(arg));
  if (unknown.length === 0) return;
  console.error(
    `${command}: unknown option ${unknown.join(", ")}. Accepted: ${[...allowed].join(", ")}`
  );
  process.exit(2);
}
