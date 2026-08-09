import { requireDb } from "../db/connection.mjs";
import { generatePacket } from "./generate.mjs";

function operationError(message, code) {
  const error = new Error(message);
  error.code = code;
  return error;
}

// One owner for the KEEP gate plus packet generation. The compatibility HTTP
// route and workspace-main's job.generate-documents intent both call this.
export async function generateApplicationPacket({
  repoRoot,
  env = process.env,
  body = {},
  generatePacketImpl = generatePacket,
  coverLetterCall,
  resumeCall,
  packetAnswersCall,
} = {}) {
  const applicationId = String(body.applicationId || body.appId || "").trim();
  if (!applicationId) {
    throw operationError("generatePacket: applicationId is required", "BAD_REQUEST");
  }

  const db = requireDb({ repoRoot, env });
  const row = db.prepare("SELECT data FROM applications WHERE id = ?").get(applicationId);
  if (!row) throw operationError(`Application not found: ${applicationId}`, "NOT_FOUND");
  const application = JSON.parse(row.data);
  const gate = String(application.evaluation?.gate || application.packetGate?.gate || "")
    .trim()
    .toLowerCase();
  if (gate !== "keep") {
    throw operationError(
      "A current KEEP evaluation is required before generating application documents.",
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
  });
}
