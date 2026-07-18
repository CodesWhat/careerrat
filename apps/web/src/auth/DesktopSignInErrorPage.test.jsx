import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";
import { DesktopSignInErrorPage } from "./DesktopSignInErrorPage.jsx";

function renderPage(path) {
  return renderToStaticMarkup(
    <MemoryRouter initialEntries={[path]}>
      <DesktopSignInErrorPage />
    </MemoryRouter>
  );
}

describe("DesktopSignInErrorPage", () => {
  it("offers a nonce-preserving retry link", () => {
    const html = renderPage("/app/desktop-sign-in/error?nonce=abc");

    expect(html).toContain('href="/desktop-sign-in?nonce=abc"');
    expect(html).toContain("Try again");
  });

  it("sends the user back to the app instead of offering an unusable retry", () => {
    const html = renderPage("/app/desktop-sign-in/error");

    expect(html).toContain("Return to the Rolester app and click Sign in again.");
    expect(html).not.toContain("<a ");
    expect(html).not.toContain("<button");
    expect(html).not.toContain("Try again");
  });
});
