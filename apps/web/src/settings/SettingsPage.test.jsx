import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  connectManagedAi: vi.fn(),
  getAiSettings: vi.fn(),
  getOnboardState: vi.fn(),
  getUsageSummary: vi.fn(),
  saveCandidateFile: vi.fn(),
  validateAndSaveAiKey: vi.fn(),
}));

function sameDeps(left, right) {
  return (
    Array.isArray(left) &&
    Array.isArray(right) &&
    left.length === right.length &&
    left.every((value, index) => Object.is(value, right[index]))
  );
}

function createHookRenderer(Component, onRuntime) {
  const slots = [];
  let hookIndex = 0;
  let output;
  let rendering = false;
  let rerenderRequested = false;

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
          if (rendering) rerenderRequested = true;
          else render();
        },
      ];
    },
    useEffect(effect, deps) {
      const index = hookIndex++;
      const prior = slots[index];
      if (prior && sameDeps(prior.deps, deps)) return;
      slots[index] = { deps };
      effect();
    },
    useMemo(factory, deps) {
      const index = hookIndex++;
      const prior = slots[index];
      if (!prior || !sameDeps(prior.deps, deps)) slots[index] = { value: factory(), deps };
      return slots[index].value;
    },
  };
  onRuntime(runtime);

  function render() {
    rendering = true;
    do {
      rerenderRequested = false;
      hookIndex = 0;
      output = Component();
    } while (rerenderRequested);
    rendering = false;
  }

  render();
  return {
    get output() {
      return output;
    },
  };
}

function renderedText(value) {
  if (Array.isArray(value)) return value.map(renderedText).join("");
  if (typeof value === "string" || typeof value === "number") return String(value);
  if (!value || typeof value !== "object") return "";
  return renderedText(value.props?.children);
}

function findElement(root, predicate) {
  const seen = new Set();
  let match;
  function visit(value) {
    if (match || value === null || value === undefined) return;
    if (Array.isArray(value)) {
      for (const child of value) visit(child);
      return;
    }
    if (typeof value !== "object" || seen.has(value)) return;
    seen.add(value);
    if (value.props && predicate(value)) {
      match = value;
      return;
    }
    if (value.props) {
      for (const propValue of Object.values(value.props)) visit(propValue);
    }
  }
  visit(root);
  return match;
}

async function mountSettings({ getToken }) {
  vi.resetModules();
  let runtime;
  vi.doMock("react", () => ({
    // createContext is a static stub, not routed through `runtime` —
    // SettingsPage.jsx now pulls in GuardrailsStep.jsx/PrefsStep.jsx (for
    // their exported chip presets and buildQuickFactsSavePayload()), which
    // transitively import OnboardingShell.jsx. That file calls
    // createContext(null) once at module-eval time to build
    // OnboardingCompletionContext — never rendered from this page, so the
    // real Provider/Consumer/useContext behavior is never exercised here;
    // this stub only needs to exist so that top-level call doesn't throw.
    createContext: (defaultValue) => ({
      Provider: ({ children }) => children,
      Consumer: () => null,
      _currentValue: defaultValue,
    }),
    useEffect: (...args) => runtime.useEffect(...args),
    useMemo: (...args) => runtime.useMemo(...args),
    useState: (...args) => runtime.useState(...args),
  }));
  vi.doMock("../auth/clerkControls.jsx", () => ({
    useRolesterUser: () => ({ getToken }),
  }));
  vi.doMock("../lib/api.js", () => ({
    ApiError: class ApiError extends Error {},
    ...api,
  }));

  const { SettingsPage } = await import("./SettingsPage.jsx");
  return createHookRenderer(SettingsPage, (value) => {
    runtime = value;
  });
}

async function mountLoadedSettings(data) {
  api.getOnboardState.mockResolvedValue({ data });
  api.saveCandidateFile.mockResolvedValue({ ok: true });
  const renderer = await mountSettings({ getToken: vi.fn() });
  await vi.waitFor(() =>
    expect(
      findElement(
        renderer.output,
        (element) => renderedText(element) === "Save profile" && element.props.onClick
      )
    ).toBeTruthy()
  );
  return renderer;
}

function elementById(renderer, id) {
  const element = findElement(renderer.output, (candidate) => candidate.props.id === id);
  expect(element).toBeTruthy();
  return element;
}

function actionButton(renderer, label) {
  const button = findElement(
    renderer.output,
    (element) => renderedText(element) === label && element.props.onClick
  );
  expect(button).toBeTruthy();
  return button;
}

beforeEach(() => {
  vi.clearAllMocks();
  api.getOnboardState.mockResolvedValue({ data: {} });
  api.getAiSettings.mockResolvedValue({ route: "none", keyPresent: false });
  api.getUsageSummary.mockResolvedValue({ summary: null });
  api.saveCandidateFile.mockResolvedValue({ ok: true });
});

afterEach(() => {
  vi.useRealTimers();
  vi.doUnmock("react");
  vi.doUnmock("../auth/clerkControls.jsx");
  vi.doUnmock("../lib/api.js");
});

describe("SettingsPage managed AI reconnect", () => {
  it("gets a Clerk token, reconnects managed AI, and surfaces success", async () => {
    vi.useFakeTimers();
    const getToken = vi.fn(async () => "obviously-fake-jwt");
    api.connectManagedAi.mockResolvedValue({ ok: true, route: "proxy" });
    api.getAiSettings
      .mockResolvedValueOnce({ route: "none", keyPresent: false })
      .mockResolvedValueOnce({ route: "proxy", keyPresent: false });
    const renderer = await mountSettings({ getToken });
    await vi.waitFor(() =>
      expect(
        findElement(renderer.output, (element) =>
          renderedText(element).includes("Reconnect managed AI")
        )
      ).toBeTruthy()
    );

    const button = findElement(
      renderer.output,
      (element) => renderedText(element) === "Reconnect managed AI" && element.props.onClick
    );
    await button.props.onClick();

    expect(getToken).toHaveBeenCalledOnce();
    expect(api.connectManagedAi).toHaveBeenCalledWith("obviously-fake-jwt");
    expect(api.getAiSettings).toHaveBeenCalledTimes(2);
    expect(
      findElement(renderer.output, (element) => element.props.message === "Managed AI connected.")
    ).toBeTruthy();
  });

  it("surfaces a reconnect failure", async () => {
    const getToken = vi.fn(async () => "obviously-fake-jwt");
    api.connectManagedAi.mockResolvedValue({ ok: false });
    const renderer = await mountSettings({ getToken });
    await vi.waitFor(() =>
      expect(
        findElement(renderer.output, (element) => renderedText(element) === "Reconnect managed AI")
      ).toBeTruthy()
    );

    const button = findElement(
      renderer.output,
      (element) => renderedText(element) === "Reconnect managed AI" && element.props.onClick
    );
    await button.props.onClick();

    expect(getToken).toHaveBeenCalledOnce();
    expect(api.connectManagedAi).toHaveBeenCalledWith("obviously-fake-jwt");
    expect(
      findElement(
        renderer.output,
        (element) => element.props.message === "Could not connect managed AI."
      )
    ).toBeTruthy();
  });
});

describe("SettingsPage edit surfaces", () => {
  it("never includes current_base or additional_links in the profile save patch", async () => {
    const renderer = await mountLoadedSettings({
      profile: {
        candidate: {
          domain: "software engineering",
          toolchain: "JavaScript",
          linkedin: "https://linkedin.example/candidate",
          additional_links: ["https://private.example/source"],
        },
        compensation: {
          current_base: 175000,
          expected_base: 231000,
          oe_min_base: 80000,
          oe_max_base: 120000,
          relo_package_needs: "Full relocation",
        },
      },
    });

    await actionButton(renderer, "Save profile").props.onClick();

    expect(api.saveCandidateFile).toHaveBeenCalledTimes(1);
    const [name, patch] = api.saveCandidateFile.mock.calls[0];
    expect(name).toBe("profile");
    expect(patch.compensation).not.toHaveProperty("current_base");
    expect(patch.candidate).not.toHaveProperty("additional_links");
    expect(JSON.stringify(patch)).not.toContain("current_base");
    expect(JSON.stringify(patch)).not.toContain("additional_links");
  });

  it("resends complete targeting guardrail and company arrays", async () => {
    const renderer = await mountLoadedSettings({
      targeting: {
        fit_bands: { high_min: 85, med_min: 70 },
        reevaluation: { rejection_total: 8, rejection_per_family: 4 },
        cut_signals: ["heavy travel"],
        keep_signals: ["customer-facing delivery"],
        excluded_companies: ["Excluded Corp"],
        tracked_companies: ["Tracked Corp"],
      },
    });

    elementById(renderer, "targeting-cut_signals").props.onChange(["heavy travel", "onsite only"]);
    await actionButton(renderer, "Save targeting").props.onClick();

    expect(api.saveCandidateFile).toHaveBeenCalledWith(
      "targeting",
      expect.objectContaining({
        cut_signals: ["heavy travel", "onsite only"],
        keep_signals: ["customer-facing delivery"],
        excluded_companies: ["Excluded Corp"],
        tracked_companies: ["Tracked Corp"],
      })
    );
  });

  it("prefills and round-trips agent_voice through the modes save", async () => {
    const renderer = await mountLoadedSettings({
      modes: {
        usage_mode: "full",
        application_mode: "selective",
        agent_voice: "technical",
      },
    });

    const select = elementById(renderer, "modes-agent_voice");
    expect(select.props.value).toBe("technical");
    select.props.onChange("verbose");
    await actionButton(renderer, "Save modes").props.onClick();

    expect(api.saveCandidateFile).toHaveBeenCalledWith("modes", {
      usage_mode: "full",
      application_mode: "selective",
      agent_voice: "verbose",
    });
  });

  it("prefills honesty data and saves it through the honesty wrapper", async () => {
    const renderer = await mountLoadedSettings({
      honesty: {
        education: {
          highest_degree: "B.S. Computer Science",
          add_education_section: true,
        },
        tools: {
          confirmed: ["PostgreSQL"],
          adjacent: ["Kubernetes"],
          do_not_claim: ["Rust"],
        },
        claims: { do_not_fabricate: ["security clearances"] },
      },
    });

    expect(elementById(renderer, "honesty-highest_degree").props.value).toBe(
      "B.S. Computer Science"
    );
    expect(elementById(renderer, "honesty-add_education_section").props.checked).toBe(true);
    expect(elementById(renderer, "honesty-tools_confirmed").props.values).toEqual(["PostgreSQL"]);
    expect(elementById(renderer, "honesty-do_not_fabricate").props.values).toEqual([
      "security clearances",
    ]);

    elementById(renderer, "honesty-highest_degree").props.onChange("M.S. Computer Science");
    await actionButton(renderer, "Save honesty boundaries").props.onClick();

    expect(api.saveCandidateFile).toHaveBeenCalledWith("honesty", {
      education: {
        highest_degree: "M.S. Computer Science",
        add_education_section: true,
      },
      tools: {
        confirmed: ["PostgreSQL"],
        adjacent: ["Kubernetes"],
        do_not_claim: ["Rust"],
      },
      claims: { do_not_fabricate: ["security clearances"] },
    });
  });
});
