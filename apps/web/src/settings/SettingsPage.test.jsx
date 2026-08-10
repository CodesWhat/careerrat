import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  addBoard: vi.fn(),
  addSearchQuery: vi.fn(),
  getAutomationSettings: vi.fn(),
  getAiSettings: vi.fn(),
  getInstalledAiRuntimes: vi.fn(),
  getOnboardState: vi.fn(),
  getSourceMaintenance: vi.fn(),
  getUsageSummary: vi.fn(),
  openInstalledAiRuntimeTerminal: vi.fn(),
  probeInstalledAiRuntime: vi.fn(),
  removeCompanyBoard: vi.fn(),
  removeSearchSource: vi.fn(),
  saveCandidateFile: vi.fn(),
  saveCompanyBoard: vi.fn(),
  selectInstalledAiRuntime: vi.fn(),
  validateAndSaveAiKey: vi.fn(),
  updateSearchSource: vi.fn(),
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

async function mountSettings() {
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
  const renderer = await mountSettings();
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
  api.getInstalledAiRuntimes.mockResolvedValue({
    selectedId: "codex",
    providerFallback: false,
    runtimes: [
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
  });
  api.getAutomationSettings.mockResolvedValue({
    mode: "basic",
    liveCount: 0,
    consent: {},
    capabilities: [],
  });
  api.getUsageSummary.mockResolvedValue({ summary: null });
  api.getSourceMaintenance.mockResolvedValue({ searches: [], companies: [] });
  api.saveCandidateFile.mockResolvedValue({ ok: true });
});

it("makes installed AI the primary Settings route and nests provider credentials under Advanced", async () => {
  const renderer = await mountLoadedSettings({});
  const text = renderedText(renderer.output);
  expect(text).toContain("Use an AI tool already on this computer");
  expect(text).toContain("Codex");
  expect(text).toContain("Selected");
  expect(text).toContain("Advanced · Use a provider API key instead");
  expect(text).toContain("How hands-on should CareerRat be?");
  expect(text).toContain("Every external capability is hard-off");
  expect(api.getInstalledAiRuntimes).toHaveBeenCalledOnce();
});

afterEach(() => {
  vi.useRealTimers();
  vi.doUnmock("react");
  vi.doUnmock("../lib/api.js");
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

  it("prefills and round-trips hybrid and on-site work modes", async () => {
    const renderer = await mountLoadedSettings({
      profile: {
        candidate: { location: "Brooklyn, NY" },
        location: {
          home: "Brooklyn, NY",
          remote: false,
          hybrid: true,
          onsite: true,
          commute_radius_miles: 25,
          relocation: [],
        },
      },
    });

    const hybrid = actionButton(renderer, "Hybrid");
    const onsite = actionButton(renderer, "On-site");
    expect(hybrid.props["aria-pressed"]).toBe(true);
    expect(onsite.props["aria-pressed"]).toBe(true);

    await actionButton(renderer, "Save profile").props.onClick();

    expect(api.saveCandidateFile).toHaveBeenCalledWith(
      "profile",
      expect.objectContaining({
        location: expect.objectContaining({
          remote: false,
          hybrid: true,
          onsite: true,
          commute_radius_miles: 25,
        }),
      })
    );
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

  it("ISSUE-022: renders, edits, adds, and saves complete post-onboarding role lanes", async () => {
    const renderer = await mountLoadedSettings({
      targeting: {
        role_buckets: [
          {
            name: "Backend & Platform",
            priority: "primary",
            titles: ["Staff Backend Engineer", "Staff Platform Engineer"],
            notes: "Hands-on systems work",
            fit_signals: ["distributed systems"],
            down_signals: ["frontend-only"],
          },
        ],
        cut_signals: ["heavy travel"],
        keep_signals: ["distributed systems"],
      },
    });

    expect(elementById(renderer, "targeting-role-0-name").props.value).toBe("Backend & Platform");
    expect(elementById(renderer, "targeting-role-0-titles").props.values).toEqual([
      "Staff Backend Engineer",
      "Staff Platform Engineer",
    ]);
    elementById(renderer, "targeting-role-0-titles").props.onChange([
      "Staff Backend Engineer",
      "Principal Backend Engineer",
    ]);
    actionButton(renderer, "Add role lane").props.onClick();
    elementById(renderer, "targeting-role-1-name").props.onChange("Infrastructure leadership");
    elementById(renderer, "targeting-role-1-titles").props.onChange([
      "Principal Platform Engineer",
    ]);

    await actionButton(renderer, "Save targeting").props.onClick();

    expect(api.saveCandidateFile).toHaveBeenCalledWith(
      "targeting",
      expect.objectContaining({
        role_buckets: [
          expect.objectContaining({
            name: "Backend & Platform",
            priority: "primary",
            titles: ["Staff Backend Engineer", "Principal Backend Engineer"],
          }),
          expect.objectContaining({
            name: "Infrastructure leadership",
            priority: "secondary",
            titles: ["Principal Platform Engineer"],
          }),
        ],
      })
    );
    expect(renderedText(renderer.output)).toContain("Role-lane changes apply to future matching");
  });

  it("omits blank optional targeting numbers instead of sending schema-invalid nulls", async () => {
    const renderer = await mountLoadedSettings({
      targeting: {
        role_buckets: [{ name: "Primary", priority: "primary", titles: ["Staff Engineer"] }],
        cut_signals: [],
        keep_signals: [],
      },
    });

    await actionButton(renderer, "Save targeting").props.onClick();

    const [, patch] = api.saveCandidateFile.mock.calls[0];
    expect(patch.fit_bands).toEqual({});
    expect(patch.reevaluation).toEqual({});
    expect(JSON.stringify(patch)).not.toContain(":null");
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
