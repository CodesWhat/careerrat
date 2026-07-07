import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { logoImageUrl } from "../lib/api.js";
import { CompanyAvatar } from "./CompanyAvatar.jsx";

describe("logoImageUrl", () => {
  it("builds the cached logo route with domain and name fallbacks", () => {
    expect(logoImageUrl({ domain: "acme.com", name: "Acme Inc" })).toBe(
      "/api/logos/img?domain=acme.com&name=Acme%20Inc"
    );
    expect(logoImageUrl({ name: "Sweet Green" })).toBe("/api/logos/img?name=Sweet%20Green");
  });
});

describe("CompanyAvatar", () => {
  it("uses the cached logo route even when only a company name is available", () => {
    const html = renderToStaticMarkup(<CompanyAvatar name="Sweet Green" />);

    expect(html).toContain('<img src="/api/logos/img?name=Sweet%20Green"');
    expect(html).not.toContain(">SG<");
  });
});
