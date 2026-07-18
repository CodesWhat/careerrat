import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  connectManagedAi: vi.fn(),
}));

vi.mock("../../lib/api.js", async (importOriginal) => ({
  ...(await importOriginal()),
  connectManagedAi: api.connectManagedAi,
}));

const clerkState = vi.hoisted(() => ({
  signedIn: false,
  user: {
    primaryEmailAddress: { emailAddress: "test@rolester.test" },
    fullName: "Test User",
  },
}));

vi.mock("@clerk/react", () => ({
  SignInButton: ({ children }) => <span data-clerk="sign-in">{children}</span>,
  SignUpButton: ({ children }) => <span data-clerk="sign-up">{children}</span>,
  UserButton: ({ appearance }) => (
    <span
      data-clerk="user-button"
      data-trigger-width={appearance?.elements?.userButtonTrigger?.width || ""}
      data-trigger-height={appearance?.elements?.userButtonTrigger?.height || ""}
      data-avatar-width={appearance?.elements?.userButtonAvatarBox?.width || ""}
      data-avatar-height={appearance?.elements?.userButtonAvatarBox?.height || ""}
    />
  ),
}));

import { RolesterAuthStateProvider } from "../../auth/clerkControls.jsx";
import { KeyStep } from "./KeyStep.jsx";

function renderKeyStep({ aiAvailable = false } = {}) {
  return renderToStaticMarkup(
    <RolesterAuthStateProvider
      value={{
        isLoaded: true,
        isSignedIn: clerkState.signedIn,
        user: clerkState.signedIn ? clerkState.user : null,
        hasClerkProvider: true,
      }}
    >
      <KeyStep
        reload={async () => {}}
        goNext={vi.fn()}
        goBack={vi.fn()}
        showToast={vi.fn()}
        runtimeCapabilities={{ aiAvailable }}
      />
    </RolesterAuthStateProvider>
  );
}

beforeEach(() => {
  clerkState.signedIn = false;
});

describe("Account step", () => {
  it("renders as a focused signup screen instead of an AI-key entry screen", () => {
    const html = renderKeyStep();

    expect(html).toContain("Rolester");
    expect(html).toContain("Your Rolester account.");
    expect(html).toContain("Free tier forever.");
    expect(html).toContain("No credit card required.");
    expect(html).toContain("Create account");
    expect(html).toContain("Log in");
    expect(html).toContain("Signing in keeps usage tied to you.");
    expect(html).not.toContain("Create or log in to your Rolester account.");
    expect(html).not.toContain("Free to start, no credit card required.");
    expect(html).not.toContain("Create your Rolester account.");
    expect(html).not.toContain("Get started for free. No credit card required.");
    expect(html).toContain('class="onboarding-account__intro"');
    expect(html).toContain('class="onboarding-account__fine-print"');
    expect(html).toContain(
      'class="onboarding-account__fine-print-marker" aria-hidden="true">*</span>'
    );
    expect(html).not.toContain('class="onboarding-account__hero-copy"');
    expect(html).not.toContain("Start with the free plan");
    expect(html).not.toContain("Signing in starts your free tier");
    expect(html).not.toContain("billing tied");
    expect(html).not.toContain("Free gets you started");
    expect(html).not.toContain("instead of this Mac");
    expect(html).not.toContain("Clerk handles identity");
    expect(html).not.toContain("caps and billing live");
    expect(html).toContain("onboarding-key__title-side");
    expect(html).toContain("onboarding-key__action-side");
    expect(html).toContain('class="onboarding-targeting__mark" aria-hidden="true">👤');
    expect(html).not.toContain("onboarding-key__visual");
    expect(html).not.toContain("onboarding-key__badge");
    expect(html).not.toContain("onboarding-key__provider-name");
    expect(html).not.toContain("onboarding-key__lock");
    expect(html.indexOf("onboarding-key__title-side")).toBeLessThan(
      html.indexOf("onboarding-key__action-side")
    );
    expect(html.indexOf("onboarding-key__action-side")).toBeLessThan(
      html.indexOf("Signing in keeps usage tied to you.")
    );
    expect(html.indexOf("onboarding-account__actions")).toBeLessThan(
      html.indexOf("Signing in keeps usage tied to you.")
    );
    expect(html).toContain('aria-label="Continue"');
    expect(html).toContain("onboarding-nav-button--next");
    expect(html).not.toContain(">Continue<");
    expect(html).not.toContain("Save key");
    expect(html).not.toContain('type="password"');
    expect(html).not.toContain("Connected (BYOK)");
    expect(html).not.toContain("Seven quick steps");
    expect(html).toContain('aria-label="Continue"');
    expect(html).toContain('disabled=""');
    expect(html).toContain(
      "Sign in and AI connects automatically, or paste your own Anthropic API key."
    );
  });

  it("enables Continue when managed AI is available without sign-in", () => {
    const html = renderKeyStep({ aiAvailable: true });

    expect(html).toContain('aria-label="Continue"');
    expect(html).not.toContain('disabled=""');
    expect(html).not.toContain(
      "Sign in and AI connects automatically, or paste your own Anthropic API key."
    );
  });

  it("keeps Continue disabled after sign-in until managed AI is available", () => {
    clerkState.signedIn = true;

    const html = renderKeyStep();

    expect(html).toContain("Test User");
    expect(html).toContain("test@rolester.test");
    expect(html).toContain("Account ready");
    expect(html).toContain("Signing in keeps usage tied to you.");
    expect(html).toContain(
      'class="onboarding-account__fine-print-marker" aria-hidden="true">*</span>'
    );
    expect(html).toContain('class="onboarding-account__signed-in-label"');
    expect(html).toContain("Signed in as");
    expect(html).toContain('class="onboarding-account__identity"');
    expect(html).toContain('class="onboarding-account__avatar"');
    expect(html).toContain('class="onboarding-account__identity-copy"');
    expect(html.indexOf("Signed in as")).toBeLessThan(html.indexOf("onboarding-account__identity"));
    expect(html.indexOf("onboarding-account__avatar")).toBeLessThan(html.indexOf("Test User"));
    expect(html).toContain('data-trigger-width="96px"');
    expect(html).toContain('data-trigger-height="96px"');
    expect(html).toContain('data-avatar-width="96px"');
    expect(html).toContain('data-avatar-height="96px"');
    expect(html).not.toContain('class="onboarding-account__ready-card"');
    expect(html).not.toContain('class="onboarding-account__ready-copy"');
    expect(html).not.toContain("onboarding-account__signed-in-header");
    expect(html).toContain('data-clerk="user-button"');
    expect(html).not.toContain("Create account");
    expect(html).toContain('disabled=""');
  });

  it("enables Continue for a signed-in account once managed AI is available", () => {
    clerkState.signedIn = true;

    const html = renderKeyStep({ aiAvailable: true });

    expect(html).not.toContain('disabled=""');
  });
});

function createHookRenderer(Component, props, onRuntime) {
  const slots = [];
  const cleanups = [];
  let hookIndex = 0;
  let output;
  let rendering = false;
  let rerenderRequested = false;
  let mounted = true;

  function sameDeps(left, right) {
    return (
      Array.isArray(left) &&
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((value, index) => Object.is(value, right[index]))
    );
  }

  const runtime = {
    useState(initialValue) {
      const index = hookIndex++;
      if (!(index in slots)) {
        slots[index] = typeof initialValue === "function" ? initialValue() : initialValue;
      }
      return [
        slots[index],
        (nextValue) => {
          slots[index] = typeof nextValue === "function" ? nextValue(slots[index]) : nextValue;
          if (!mounted) return;
          if (rendering) rerenderRequested = true;
          else render();
        },
      ];
    },
    useRef(initialValue) {
      const index = hookIndex++;
      if (!(index in slots)) slots[index] = { current: initialValue };
      return slots[index];
    },
    useCallback(callback, deps) {
      const index = hookIndex++;
      const prior = slots[index];
      if (!prior || !sameDeps(prior.deps, deps)) slots[index] = { value: callback, deps };
      return slots[index].value;
    },
    useEffect(effect, deps) {
      const index = hookIndex++;
      const prior = slots[index];
      if (prior && sameDeps(prior.deps, deps)) return;
      slots[index] = { deps };
      cleanups[index]?.();
      cleanups[index] = effect();
    },
  };
  onRuntime?.(runtime);

  function render() {
    rendering = true;
    do {
      rerenderRequested = false;
      hookIndex = 0;
      output = Component(props);
    } while (rerenderRequested);
    rendering = false;
  }

  render();
  return {
    get output() {
      return output;
    },
    runtime,
    unmount() {
      mounted = false;
      for (const cleanup of cleanups) cleanup?.();
    },
  };
}

function visitElements(value, visitor) {
  if (Array.isArray(value)) {
    for (const child of value) visitElements(child, visitor);
    return;
  }
  if (!value || typeof value !== "object") return;
  visitor(value);
  visitElements(value.props?.children, visitor);
}

function renderedText(value) {
  if (Array.isArray(value)) return value.map(renderedText).join("");
  if (typeof value === "string" || typeof value === "number") return String(value);
  if (!value || typeof value !== "object") return "";
  return renderedText(value.props?.children);
}

async function mountManagedProvision({ getToken, reload }) {
  vi.resetModules();
  let runtime;
  vi.doMock("react", async (importOriginal) => ({
    ...(await importOriginal()),
    useCallback: (...args) => runtime.useCallback(...args),
    useEffect: (...args) => runtime.useEffect(...args),
    useRef: (...args) => runtime.useRef(...args),
    useState: (...args) => runtime.useState(...args),
  }));
  vi.doMock("../../auth/clerkControls.jsx", () => ({
    RolesterSignInButton: ({ children }) => children,
    RolesterSignUpButton: ({ children }) => children,
    RolesterUserButton: () => <span data-user-button />,
    useRolesterUser: () => ({
      isLoaded: true,
      isSignedIn: true,
      user: clerkState.user,
      desktopAuthAvailable: false,
      getToken,
    }),
  }));
  vi.doMock("../../lib/api.js", () => api);
  const { KeyStep: InteractiveKeyStep } = await import("./KeyStep.jsx");
  return createHookRenderer(
    InteractiveKeyStep,
    {
      goNext: vi.fn(),
      goBack: vi.fn(),
      runtimeCapabilities: { aiAvailable: false },
      reload,
    },
    (value) => {
      runtime = value;
    }
  );
}

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
  vi.doUnmock("react");
  vi.doUnmock("../../auth/clerkControls.jsx");
  vi.doUnmock("../../lib/api.js");
});

describe("managed AI auto-provisioning", () => {
  it("auto-connects exactly once per mount and shows the pending state", async () => {
    let resolveToken;
    const getToken = vi.fn(
      () =>
        new Promise((resolve) => {
          resolveToken = resolve;
        })
    );
    const reload = vi.fn(async () => {});
    api.connectManagedAi.mockResolvedValue({ ok: true });
    const renderer = await mountManagedProvision({ getToken, reload });

    expect(renderedText(renderer.output)).toContain("Connecting AI…");
    expect(getToken).toHaveBeenCalledOnce();

    resolveToken("obviously-fake-jwt");
    await vi.waitFor(() => expect(api.connectManagedAi).toHaveBeenCalledOnce());
    await vi.waitFor(() => expect(reload).toHaveBeenCalledOnce());
    expect(api.connectManagedAi).toHaveBeenCalledWith("obviously-fake-jwt");
    expect(getToken).toHaveBeenCalledOnce();
    renderer.unmount();
  });

  it("shows an error after two failures and Try again starts a fresh retry flow", async () => {
    vi.useFakeTimers();
    const getToken = vi.fn(async () => "obviously-fake-jwt");
    api.connectManagedAi.mockRejectedValue(new Error("simulated exchange failure"));
    const renderer = await mountManagedProvision({ getToken, reload: vi.fn() });

    await vi.advanceTimersByTimeAsync(2000);
    expect(api.connectManagedAi).toHaveBeenCalledTimes(2);
    expect(renderedText(renderer.output)).toContain("Could not connect managed AI automatically.");

    let tryAgain;
    visitElements(renderer.output, (element) => {
      if (renderedText(element) === "Try again") tryAgain = element;
    });
    expect(tryAgain).toBeTruthy();
    tryAgain.props.onClick();
    await vi.waitFor(() => expect(api.connectManagedAi).toHaveBeenCalledTimes(3));

    await vi.advanceTimersByTimeAsync(2000);
    expect(api.connectManagedAi).toHaveBeenCalledTimes(4);
    renderer.unmount();
  });
});
