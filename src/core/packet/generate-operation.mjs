export function applicationPacketGatePasses(application) {
  const gate = String(application?.evaluation?.gate || application?.packetGate?.gate || "")
    .trim()
    .toLowerCase();
  if (gate === "keep") return true;

  const evaluatedAt = application?.evaluation?.evaluatedAt;
  return (
    gate === "review" &&
    typeof evaluatedAt === "string" &&
    Boolean(evaluatedAt.trim()) &&
    application?.reviewApproval?.evaluatedAt === evaluatedAt
  );
}
