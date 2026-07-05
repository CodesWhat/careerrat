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
        standard: "pdf",
        board_required: [],
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
              standard: "pdf",
              board_required: ["docx"],
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
        standard: "pdf",
        board_required: ["docx"],
      },
    });
    expect(apiMocks.extractResumeDocx).not.toHaveBeenCalled();
    expect(apiMocks.extractResumeAi).not.toHaveBeenCalled();
    expect(apiMocks.parseResumeText).not.toHaveBeenCalled();
  });
});
