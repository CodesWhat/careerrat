import { requireDb } from "../db/connection.mjs";
import { generatePacket } from "./generate.mjs";

function operationError(message, code) {
  const error = new Error(message);
  error.code = code;
  return error;
}

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

// One owner for the persisted gate check plus packet generation. The
// compatibility HTTP route and workspace-main's job.generate-documents intent
// both call this.
export async function generateApplicationPacket({
  repoRoot,
  env = process.env,
  body = {},
  generatePacketImpl = generatePacket,
  coverLetterCall,
  resumeCall,
  packetAnswersCall,
  executionPlan,
} = {}) {
  const applicationId = String(body.applicationId || body.appId || "").trim();
  if (!applicationId) {
    throw operationError("generatePacket: applicationId is required", "BAD_REQUEST");
  }

  const db = requireDb({ repoRoot, env });
  const row = db.prepare("SELECT data FROM applications WHERE id = ?").get(applicationId);
  if (!row) throw operationError(`Application not found: ${applicationId}`, "NOT_FOUND");
  const application = JSON.parse(row.data);
  if (!applicationPacketGatePasses(application)) {
    throw operationError(
      "A current KEEP evaluation or approved REVIEW evaluation is required before generating application documents.",
      "PACKET_GATE_REQUIRED"
    );
  }

  return generatePacketImpl({
    repoRoot,
    env,
    ...body,
    applicationId,
    coverLetterCall,
    resumeCall,
    packetAnswersCall,
    executionPlan,
  });
}
