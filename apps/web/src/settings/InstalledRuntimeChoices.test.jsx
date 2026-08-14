import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { InstalledRuntimeChoices } from "./InstalledRuntimeChoices.jsx";

// Moved verbatim from the deleted onboarding/steps/KeyStep.test.jsx — this
// test case exercises InstalledRuntimeChoices, the one export from the dead
// KeyStep wizard step that survived (settings/SettingsPage.jsx still uses
// it). Test cases exercising the dead KeyStep component were deleted along
// with the component.
describe("InstalledRuntimeChoices", () => {
  it("presents installed AI tools as the primary route and provider credentials as Advanced", () => {
    const html = renderToStaticMarkup(
      <InstalledRuntimeChoices
        state={{
          selectedId: "codex",
          providerFallback: false,
          runtimes: [
            {
              id: "claude",
              name: "Claude Code",
              commandShape: "claude -p --output-format json",
              available: true,
              ready: false,
              status: "authentication_required",
              action: "open_terminal",
              selected: false,
            },
            {
              id: "codex",
              name: "Codex",
              commandShape: "codex exec --json -",
              available: true,
              ready: true,
              status: "ready",
              selected: true,
            },
          ],
        }}
        onSelect={vi.fn()}
        onRetry={vi.fn()}
      />
    );

    expect(html).toContain("Use an AI tool already on this computer");
    expect(html).toContain("Claude Code");
    expect(html).toContain("Open Terminal to sign in");
    expect(html).toContain("Retry detection");
    expect(html).toContain("Codex");
    expect(html).toContain("Selected");
    expect(html).toContain("Use a provider API key instead");
    expect(html).toContain("Advanced");
    expect(html).not.toContain('type="password"');
  });
});
