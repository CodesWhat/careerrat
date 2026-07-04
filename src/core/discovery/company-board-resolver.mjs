import { inferProvider } from "../scoring/sourced-scanner.mjs";

export const COMPANY_DISCOVERY_BATCH_MAX = 12;

function cleanUrlHint(value) {
  const text = String(value || "").trim();
  if (!text) return "";
  if (/^https?:\/\//i.test(text)) return text;
  if (/^[a-z0-9.-]+\.[a-z]{2,}(?:\/.*)?$/i.test(text)) return `https://${text}`;
  return "";
}

export async function resolveCompanyBoard({ seed } = {}) {
  const hint = cleanUrlHint(seed?.job_board_url || seed?.careers_url || seed?.domain_hint);
  if (!hint) {
    const err = new Error("manual seed requires a supported ATS URL hint for this slice");
    err.code = "UNSUPPORTED_COMPANY_BOARD";
    throw err;
  }

  const provider = inferProvider({ careers_url: hint });
  if (!provider) {
    const err = new Error(`unsupported ATS host for "${seed?.name || "company"}"`);
    err.code = "UNSUPPORTED_COMPANY_BOARD";
    throw err;
  }

  return {
    ok: true,
    companyName: String(seed?.name || "").trim(),
    companyDomain:
      seed?.domain_hint && !/^https?:\/\//i.test(seed.domain_hint) ? seed.domain_hint : "",
    careersUrl: hint,
    jobBoardUrl: hint,
    atsProvider: provider,
    apiUrl: "",
    confidence: "high",
    provenance: [{ source: "manual-seed-supported-ats", url: hint }],
  };
}
