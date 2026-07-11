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

const { EXAMPLE_FILE_ITEM, ResumeDocumentViewer, ResumeStep } = ResumeStepModule;

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

describe("ResumeStep shell layout", () => {
  it("renders in the onboarding shell with the Step 2 label and shell action bar", () => {
    const html = renderResumeStep();

    expect(html).toContain('class="onboarding-shell onboarding-shell--resume"');
    expect(html).toContain('class="onboarding-step-label">Step 2');
    expect(html).toContain("onboarding-step-stack--resume");
    expect(html).toContain("onboarding-resume");
    expect(html).toContain("onboarding-resume__title-side");
    expect(html).toContain("onboarding-resume__action-side");
    expect(html.indexOf("onboarding-resume__title-side")).toBeLessThan(
      html.indexOf("onboarding-resume__action-side")
    );
    expect(html.indexOf("onboarding-resume__action-side")).toBeLessThan(
      html.indexOf("onboarding-resume__dropzone")
    );
    expect(html).toContain('class="onboarding-shell__actions"');
    expect(html).toContain('aria-label="Back"');
    expect(html).toContain('aria-label="Continue"');
    expect(html).toContain("onboarding-nav-button--back");
    expect(html).toContain("onboarding-nav-button--next");
    expect(html).not.toContain(">Back<");
    expect(html).not.toContain("Save &amp; continue");
    expect(html).not.toContain("wizard-actions");
    expect(html).not.toContain("Packet format");
    expect(html).not.toContain("DOCX board-required");
  });

  it("puts upload, files, and paste into a top-middle-bottom card layout", () => {
    const html = renderResumeStep({ aiEnabled: true });

    expect(html).toContain("onboarding-resume__upload-panel");
    expect(html).toContain("onboarding-resume__dropzone");
    expect(html).toContain("Click to select");
    expect(html).toContain("Drop files here");
    expect(html).toContain("onboarding-resume__formats");
    expect(html).toContain("DOCX");
    expect(html).toContain("TXT");
    expect(html).toContain("MD");
    expect(html).toContain("PDF");
    expect(html).toContain("PNG/JPG");
    expect(html).toContain("onboarding-resume__files-panel");
    expect(html).toContain("Files");
    expect(html).toContain("hopes-and-dreams.pdf");
    expect(html).toContain("PDF");
    expect(html).toContain("Example file");
    expect(html).toContain('aria-label="Open document preview for hopes-and-dreams.pdf"');
    expect(html).toContain('aria-label="Remove hopes-and-dreams.pdf"');
    expect(html).toContain("onboarding-resume__file-preview");
    expect(html).toContain("onboarding-resume__file-remove");
    expect(html).not.toContain("onboarding-resume__preview-panel");
    expect(html).not.toContain("Files will show here after upload.");
    expect(html).toContain("onboarding-resume__paste-section");
    expect(html).toContain("Add resume text");
    expect(html).not.toContain("Analyze text");
    expect(html).not.toContain("Hide paste box");
    expect(html).not.toContain("AI reads it and autofills the rest");
    expect(html.indexOf("onboarding-resume__upload-panel")).toBeLessThan(
      html.indexOf("onboarding-resume__files-panel")
    );
    expect(html.indexOf("onboarding-resume__files-panel")).toBeLessThan(
      html.indexOf("onboarding-resume__paste-section")
    );
  });

  it("opens files in a real document viewer surface instead of an inline file-row dropdown", () => {
    const html = renderToStaticMarkup(
      <ResumeDocumentViewer item={EXAMPLE_FILE_ITEM} onClose={() => {}} />
    );

    expect(html).toContain("onboarding-resume__document-viewer");
    expect(html).toContain("Resume document viewer");
    expect(html).toContain("PDF preview");
    expect(html).toContain("hopes-and-dreams.pdf");
    expect(html).toContain("onboarding-resume__document-object");
    expect(html).toContain("application/pdf");
    expect(html).toContain("data:application/pdf;base64");
    expect(html).not.toContain("onboarding-resume__preview-panel");
  });

  it("renders pasted text as an alternate top entry mode instead of expanding over files", () => {
    const html = renderResumeStep({ initialTextMode: true });

    expect(html).toContain("onboarding-resume__text-entry");
    expect(html).toContain("Paste resume text");
    expect(html).toContain("Use file upload");
    expect(html).toContain("Add text as file");
    expect(html).not.toContain("onboarding-resume__dropzone");
    expect(html).not.toContain("Analyze text");
    expect(html).not.toContain("Hide paste box");
    expect(html.indexOf("onboarding-resume__upload-panel")).toBeLessThan(
      html.indexOf("onboarding-resume__files-panel")
    );
    expect(html.indexOf("onboarding-resume__files-panel")).toBeLessThan(
      html.indexOf("onboarding-resume__paste-section")
    );
  });
});

describe("ResumeStep DOCX intake", () => {
  it("accepts DOCX regardless of AI availability and explains local-vs-AI parsing", () => {
    const noAiHtml = renderResumeStep({ aiEnabled: false });
    const aiHtml = renderResumeStep({ aiEnabled: true });

    expect(noAiHtml).toContain(".docx");
    expect(aiHtml).toContain(".docx");
    expect(noAiHtml).toContain("AI reads it in the black box and autofills the rest");
    expect(aiHtml).toContain("AI reads it in the black box and autofills the rest");
    expect(noAiHtml).toContain("onboarding-resume__footnote-marker");
    expect(noAiHtml).toContain("maybe");
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

  it("describes unavailable managed AI without asking for a user API key", async () => {
    const parseResumeFileForReview = ResumeStepModule.parseResumeFileForReview;
    const describeResumeUploadError = ResumeStepModule.describeResumeUploadError;

    await expect(
      parseResumeFileForReview({ name: "resume.pdf" }, { aiEnabled: false })
    ).rejects.toThrow("Managed AI required");

    expect(describeResumeUploadError(new Error("missing"), { mode: "ai-unavailable" })).toEqual({
      message:
        "Managed AI is needed to extract PDF/image resumes. Paste your resume text below for now.",
      showPaste: true,
    });
    expect(describeResumeUploadError({ status: 501 })).toEqual({
      message: "Managed AI is unavailable right now — paste your resume text below instead.",
      showPaste: true,
    });
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
        .message
    ).toContain(".docx");
  });
});
