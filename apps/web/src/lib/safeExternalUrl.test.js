import { describe, expect, it } from "vitest";

import { safeExternalHttpUrl } from "./safeExternalUrl.js";

describe("safeExternalHttpUrl", () => {
  it("keeps absolute HTTP and HTTPS links", () => {
    expect(safeExternalHttpUrl("https://jobs.example.com/roles/123")).toBe(
      "https://jobs.example.com/roles/123"
    );
    expect(safeExternalHttpUrl("http://localhost:3000/apply")).toBe("http://localhost:3000/apply");
  });

  it("rejects executable, relative, and malformed links", () => {
    expect(safeExternalHttpUrl("javascript:alert(1)")).toBeNull();
    expect(safeExternalHttpUrl("data:text/html,<script>alert(1)</script>")).toBeNull();
    expect(safeExternalHttpUrl("/jobs/123")).toBeNull();
    expect(safeExternalHttpUrl("not a url")).toBeNull();
  });
});
