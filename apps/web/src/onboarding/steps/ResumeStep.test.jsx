import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const apiMocks = vi.hoisted(() => ({
  extractResumeAi: vi.fn(),
  extractResumeDocx: vi.fn(),
  parseResumeText: vi.fn(),
  saveCandidateFile: vi.fn(async () => ({ ok: true })),
  saveEvidenceSeed: vi.fn(async () => ({ ok: true })),
}));

vi.mock("../../lib/api.js", () => apiMocks);

import * as ResumeStepModule from "./ResumeStep.jsx";

const { ResumeStep } = ResumeStepModule;

const BASE_STATE = {
  data: {
    profile: { candidate: {} },
    "form-defaults": {
      document_formats: {
        default_packet_format: "pdf",
        required_export_formats: [],
      },
    },
  },
};

function renderResumeStep(props = {}) {
  return renderToStaticMarkup(
    <ResumeStep
      state={BASE_STATE}
      aiEnabled={false}
      setDraftSeeds={() => {}}
      goNext={() => {}}
      goBack={() => {}}
      showToast={() => {}}
      {...props}
    />
  );
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("ResumeStep document format preferences", () => {
  it("renders compact packet-format controls with PDF as the standard and DOCX as board-required", () => {
    const html = renderResumeStep();

    expect(html).toContain("Packet format");
    expect(html).toContain("PDF is the standard packet format.");
    expect(html).toContain("PDF standard");
    expect(html).toContain("DOCX board-required");
  });

  it("shows saved PDF/DOCX preference text from form-defaults", () => {
    const html = renderResumeStep({
      state: {
        data: {
          profile: { candidate: {} },
          "form-defaults": {
            document_formats: {
              default_packet_format: "pdf",
              required_export_formats: ["docx"],
            },
          },
        },
      },
    });

    expect(html).toContain("Saved preference");
    expect(html).toContain("PDF standard; DOCX when a board requires it.");
  });

  it("persists output-format preferences without invoking resume input parsers", async () => {
    const saveDocumentFormatPreferences = ResumeStepModule.saveDocumentFormatPreferences;
    expect(saveDocumentFormatPreferences).toBeTypeOf("function");

    await saveDocumentFormatPreferences({ docxBoardRequired: true });

    expect(apiMocks.saveCandidateFile).toHaveBeenCalledWith("form-defaults", {
      document_formats: {
        default_packet_format: "pdf",
        required_export_formats: ["docx"],
      },
    });
    expect(apiMocks.extractResumeDocx).not.toHaveBeenCalled();
    expect(apiMocks.extractResumeAi).not.toHaveBeenCalled();
    expect(apiMocks.parseResumeText).not.toHaveBeenCalled();
  });
});

describe("ResumeStep DOCX intake", () => {
  it("accepts DOCX regardless of AI availability and explains local-vs-AI parsing", () => {
    const noAiHtml = renderResumeStep({ aiEnabled: false });
    const aiHtml = renderResumeStep({ aiEnabled: true });

    expect(noAiHtml).toContain(".docx");
    expect(aiHtml).toContain(".docx");
    expect(noAiHtml).toContain(
      "DOCX, TXT, and Markdown are parsed locally. PDF and images use your connected AI key."
    );
    expect(aiHtml).toContain(
      "DOCX, TXT, and Markdown are parsed locally. PDF and images use your connected AI key."
    );
  });

  it("routes extensions to deterministic DOCX/text paths before AI-only formats", () => {
    const getResumeUploadMode = ResumeStepModule.getResumeUploadMode;
    expect(getResumeUploadMode).toBeTypeOf("function");

    expect(getResumeUploadMode("resume.docx", { aiEnabled: false })).toBe("docx");
    expect(getResumeUploadMode("resume.docx", { aiEnabled: true })).toBe("docx");
    expect(getResumeUploadMode("resume.md", { aiEnabled: false })).toBe("text");
    expect(getResumeUploadMode("resume.pdf", { aiEnabled: true })).toBe("ai");
    expect(getResumeUploadMode("resume.pdf", { aiEnabled: false })).toBe("ai-unavailable");
  });

  it("uses extractResumeDocx and normalizes successful DOCX extraction into the review panel model", async () => {
    const parseResumeFileForReview = ResumeStepModule.parseResumeFileForReview;
    expect(parseResumeFileForReview).toBeTypeOf("function");

    const file = { name: "resume.docx" };
    apiMocks.extractResumeDocx.mockResolvedValue({
      source: "docx",
      profileSeed: { candidate: { full_name: "Jane Doe" } },
      evidenceSeed: { claims: [{ claim: "Built onboarding workflows.", evidence: "Resume." }] },
      sections: { experience: 1, education: 0, skills: 3, projects: 0, other: 0 },
    });

    const result = await parseResumeFileForReview(file, {
      aiEnabled: false,
      readText: async () => {
        throw new Error("DOCX should not be read as plain text");
      },
    });

    expect(apiMocks.extractResumeDocx).toHaveBeenCalledWith(file);
    expect(apiMocks.extractResumeAi).not.toHaveBeenCalled();
    expect(apiMocks.parseResumeText).not.toHaveBeenCalled();
    expect(result.reviewTitle).toBe("Review & edit");
    expect(result.seed.source).toBe("docx");
    expect(result.seed.profileSeed.candidate.full_name).toBe("Jane Doe");
  });

  it("maps DOCX 422 failures to the exact paste fallback copy", () => {
    const describeResumeUploadError = ResumeStepModule.describeResumeUploadError;
    expect(describeResumeUploadError).toBeTypeOf("function");

    expect(
      describeResumeUploadError(
        { status: 422, body: { code: "DOCX_TEXT_UNUSABLE" } },
        { mode: "docx" }
      )
    ).toEqual({
      message:
        "We could not read usable text from that DOCX. The original file was saved; paste text or upload PDF, TXT, or Markdown.",
      showPaste: true,
    });
  });

  it("lists DOCX in unsupported-file fallback guidance", () => {
    const describeResumeUploadError = ResumeStepModule.describeResumeUploadError;
    expect(describeResumeUploadError).toBeTypeOf("function");

    expect(
      describeResumeUploadError(new Error("unsupported"), { mode: "unsupported", ext: "zip" })
    ).message.toContain(".docx");
  });
});
