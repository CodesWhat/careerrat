import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../lib/api.js";

const hooks = vi.hoisted(() => ({
  cursor: 0,
  effectDeps: [],
  pendingEffects: [],
  rendering: false,
  stateUpdatesDuringRender: 0,
  states: [],
  resetRender() {
    this.cursor = 0;
    this.pendingEffects = [];
  },
  clear() {
    this.cursor = 0;
    this.effectDeps = [];
    this.pendingEffects = [];
    this.rendering = false;
    this.stateUpdatesDuringRender = 0;
    this.states = [];
  },
}));

const navigate = vi.hoisted(() => vi.fn());
const router = vi.hoisted(() => ({
  location: { pathname: "/settings", search: "", state: null },
}));

function dependenciesChanged(previous, next) {
  return (
    !previous ||
    !next ||
    previous.length !== next.length ||
    next.some((value, index) => !Object.is(value, previous[index]))
  );
}

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    useEffect(effect, dependencies) {
      const index = hooks.cursor++;
      if (dependenciesChanged(hooks.effectDeps[index], dependencies)) {
        hooks.effectDeps[index] = dependencies;
        hooks.pendingEffects.push(effect);
      }
    },
    useState(initialValue) {
      const index = hooks.cursor++;
      if (!(index in hooks.states)) {
        hooks.states[index] = typeof initialValue === "function" ? initialValue() : initialValue;
      }
      const setValue = (nextValue) => {
        if (hooks.rendering) hooks.stateUpdatesDuringRender += 1;
        hooks.states[index] =
          typeof nextValue === "function" ? nextValue(hooks.states[index]) : nextValue;
      };
      return [hooks.states[index], setValue];
    },
    useRef(initialValue) {
      const index = hooks.cursor++;
      if (!(index in hooks.states)) hooks.states[index] = { current: initialValue };
      return hooks.states[index];
    },
    useSyncExternalStore(_subscribe, getSnapshot) {
      return getSnapshot();
    },
  };
});

vi.mock("react-router-dom", () => ({
  useBlocker: (predicate) => {
    router.shouldBlock = predicate;
    return router.blocker;
  },
  useLocation: () => router.location,
  useNavigate: () => navigate,
}));

vi.mock("./ProfileSettings.jsx", () => ({ ProfileSettings: () => null }));

function createApi() {
  let enabled = true;
  return {
    addBoardSource: vi.fn().mockResolvedValue({ ok: true }),
    runWorkspaceIntent: vi.fn().mockResolvedValue({ status: "completed" }),
    getAiPreferences: vi.fn().mockResolvedValue({
      quality: "automatic",
      reasoning: "automatic",
      source: "default",
      updatedAt: null,
    }),
    getAutomationSettings: vi.fn().mockResolvedValue({ capabilities: [] }),
    getInstalledAiRuntimes: vi.fn().mockResolvedValue({ runtimes: [] }),
    getOnboardState: vi.fn(async () => ({
      data: {},
      publicSyncPreference: { enabled, source: enabled ? "default" : "user", updatedAt: null },
    })),
    getSourceMaintenance: vi.fn().mockResolvedValue({ searches: [], companies: [] }),
    saveCandidateFile: vi.fn().mockResolvedValue({ ok: true }),
    upsertDeepIngestConfirmedItem: vi.fn().mockResolvedValue({ ok: true }),
    saveAiPreferences: vi.fn(async ({ quality, reasoning }) => ({
      quality,
      reasoning,
      source: "saved",
      updatedAt: "2026-08-27T16:00:00.000Z",
    })),
    setAutomationSessionProvider: vi.fn().mockResolvedValue({ ok: true }),
    setPublicSyncPreference: vi.fn(async (nextEnabled) => {
      enabled = nextEnabled;
      return { ok: true };
    }),
    startInstalledAiRuntimeGuidedSetup: vi.fn().mockResolvedValue({ ok: true }),
  };
}

function onboardState({
  workspaceId = "workspace-a",
  candidateId = "candidate-a",
  version = 1,
  lastUpdatedAt = "2026-08-28T12:00:00.000Z",
  revision,
  title = "Staff Engineer",
} = {}) {
  return {
    draftContext: {
      owner: { workspaceId, candidateId },
      base: revision ? { revision } : { version, lastUpdatedAt },
    },
    data: {
      targeting: {
        role_buckets: [{ name: "Primary targets", priority: "primary", titles: [title] }],
      },
    },
    publicSyncPreference: { enabled: true, source: "default", updatedAt: null },
  };
}

async function flushEffects() {
  for (const effect of hooks.pendingEffects.splice(0)) effect();
  for (let turn = 0; turn < 8; turn += 1) await Promise.resolve();
}

function renderController(module, api) {
  hooks.resetRender();
  hooks.rendering = true;
  try {
    return module.ProfileSettingsController({ api });
  } finally {
    hooks.rendering = false;
  }
}

function settingsProps(view) {
  const children = Array.isArray(view.props.children) ? view.props.children : [view.props.children];
  return children.at(-1).props;
}

function controllerAlertText(view) {
  const children = Array.isArray(view.props.children) ? view.props.children : [view.props.children];
  return children[0]?.props?.children || null;
}

beforeEach(() => {
  hooks.clear();
  vi.clearAllMocks();
  router.location = { pathname: "/settings", search: "", state: null };
  router.shouldBlock = null;
  router.blocker = {
    state: "unblocked",
    location: null,
    proceed: vi.fn(() => {
      if (router.blocker.location) router.location = router.blocker.location;
      router.blocker.state = "unblocked";
      router.blocker.location = null;
    }),
    reset: vi.fn(() => {
      router.blocker.state = "unblocked";
      router.blocker.location = null;
    }),
  };
  navigate.mockImplementation((to, options = {}) => {
    if (typeof to === "number") return;
    const next = typeof to === "string" ? new URL(to, "http://careerrat.local") : null;
    const nextLocation = {
      pathname: next?.pathname || to?.pathname || router.location.pathname,
      search: next?.search || to?.search || "",
      state: options.state ?? null,
    };
    if (
      router.shouldBlock?.({
        currentLocation: router.location,
        nextLocation,
        historyAction: options.replace ? "REPLACE" : "PUSH",
      })
    ) {
      router.blocker.state = "blocked";
      router.blocker.location = nextLocation;
      return;
    }
    router.location = nextLocation;
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("ProfileSettingsController foreground", () => {
  it("keeps a source draft transient until its real owner loads, then migrates it", async () => {
    const module = await import("./ProfileSettingsController.jsx");
    const api = createApi();
    const entries = new Map();
    let resolveOnboard;
    api.getOnboardState.mockReturnValue(
      new Promise((resolve) => {
        resolveOnboard = resolve;
      })
    );
    vi.stubGlobal("localStorage", {
      getItem: vi.fn((key) => entries.get(key) ?? null),
      setItem: vi.fn((key, value) => entries.set(key, value)),
      removeItem: vi.fn((key) => entries.delete(key)),
    });
    router.location = {
      pathname: "/settings",
      search: "?tab=settings&panel=source",
      state: null,
    };
    const sourceUrl = "https://jobs.example.test/search?q=platform";

    renderController(module, api);
    await flushEffects();
    let props = settingsProps(renderController(module, api));
    props.onSourceDraftChange(sourceUrl);
    props = settingsProps(renderController(module, api));

    expect.soft(props.sourceDraft).toBe(sourceUrl);
    expect.soft(globalThis.localStorage.setItem).not.toHaveBeenCalled();
    expect.soft(entries.size).toBe(0);

    resolveOnboard(onboardState());
    await flushEffects();
    props = settingsProps(renderController(module, api));
    expect.soft(props.sourceDraft).toBe(sourceUrl);
    await flushEffects();
    props = settingsProps(renderController(module, api));

    expect.soft(props.sourceDraft).toBe(sourceUrl);
    expect.soft([...entries.keys()]).toEqual(["careerrat:source-draft:workspace-a:candidate-a"]);
    expect.soft(JSON.parse([...entries.values()][0]).value).toBe(sourceUrl);
  });

  it("owns editor drafts by workspace and candidate, invalidates stale bases, and preserves the last recoverable snapshot", async () => {
    const module = await import("./ProfileSettingsController.jsx");
    const api = createApi();
    const entries = new Map();
    let persistenceFails = false;
    let canonical = onboardState();
    vi.stubGlobal("localStorage", {
      getItem: vi.fn((key) => entries.get(key) ?? null),
      setItem: vi.fn((key, value) => {
        if (persistenceFails) throw new Error("quota exceeded");
        entries.set(key, value);
      }),
      removeItem: vi.fn((key) => entries.delete(key)),
    });
    api.getOnboardState.mockImplementation(async () => canonical);
    router.location = {
      pathname: "/settings",
      search: "?panel=editor&section=targets",
      state: null,
    };

    renderController(module, api);
    await flushEffects();
    let props = settingsProps(renderController(module, api));
    props.onEditorChange("titles", "Principal Engineer");
    expect(entries.size).toBe(1);

    canonical = onboardState({ workspaceId: "workspace-b", candidateId: "candidate-b" });
    hooks.clear();
    renderController(module, api);
    await flushEffects();
    props = settingsProps(renderController(module, api));
    expect.soft(props.editorValues.titles).toBe("Staff Engineer");

    canonical = onboardState({
      version: 2,
      lastUpdatedAt: "2026-08-28T13:00:00.000Z",
      title: "Staff Platform Engineer",
    });
    hooks.clear();
    renderController(module, api);
    await flushEffects();
    props = settingsProps(renderController(module, api));
    expect.soft(props.editorValues.titles).toBe("Staff Platform Engineer");

    props.onEditorChange("titles", "Principal Engineer");
    const lastBoundedSnapshot = [...entries.values()][0];
    props = settingsProps(renderController(module, api));
    props.onEditorChange("titles", "x".repeat(20_000));
    let view = renderController(module, api);
    expect.soft(entries.size).toBe(1);
    expect.soft([...entries.values()][0]).toBe(lastBoundedSnapshot);
    expect
      .soft(controllerAlertText(view))
      .toBe("That draft is too large to save for recovery. Shorten it before leaving this page.");

    props = settingsProps(view);
    props.onEditorChange("titles", "Principal Engineer");
    expect(entries.size).toBe(1);
    const beforeStorageFailure = [...entries.values()][0];
    persistenceFails = true;
    props = settingsProps(renderController(module, api));
    props.onEditorChange("titles", "Distinguished Engineer");
    view = renderController(module, api);
    expect.soft(entries.size).toBe(1);
    expect.soft([...entries.values()][0]).toBe(beforeStorageFailure);
    expect
      .soft(controllerAlertText(view))
      .toBe(
        "CareerRat couldn't save that draft for recovery. Keep this page open, then try again."
      );
  });

  it("reconciles a pending client navigation and blocked browser POP with one Keep editing choice", async () => {
    const module = await import("./ProfileSettingsController.jsx");
    const api = createApi();
    api.getOnboardState.mockResolvedValue(onboardState());
    router.location = {
      pathname: "/settings",
      search: "?panel=editor&section=targets",
      state: null,
    };

    renderController(module, api);
    await flushEffects();
    let props = settingsProps(renderController(module, api));
    props.onEditorChange("titles", "Principal Engineer");
    props = settingsProps(renderController(module, api));
    props.onTabChange("settings");

    router.blocker.state = "blocked";
    router.blocker.location = {
      pathname: "/",
      search: "",
      state: null,
    };
    props = settingsProps(renderController(module, api));
    expect.soft(props.discardEditorOpen).toBe(true);
    props.onKeepEditing();
    props = settingsProps(renderController(module, api));

    expect.soft(router.blocker.reset).toHaveBeenCalledOnce();
    expect.soft(props.discardEditorOpen).toBe(false);
    expect.soft(props.profileEditor?.id).toBe("targets");
  });

  it("sends the captured base revision and reloads a conflicting editor for review", async () => {
    const module = await import("./ProfileSettingsController.jsx");
    const api = createApi();
    const entries = new Map();
    vi.stubGlobal("localStorage", {
      getItem: vi.fn((key) => entries.get(key) ?? null),
      setItem: vi.fn((key, value) => entries.set(key, value)),
      removeItem: vi.fn((key) => entries.delete(key)),
    });
    let canonical = onboardState({ revision: "revision-a", title: "Staff Engineer" });
    api.getOnboardState.mockImplementation(async () => canonical);
    api.saveCandidateFile.mockRejectedValueOnce(
      new ApiError(409, {
        code: "SETTINGS_BASE_CHANGED",
        error: "Settings changed since this editor opened.",
      })
    );
    router.location = {
      pathname: "/settings",
      search: "?panel=editor&section=targets",
      state: null,
    };

    renderController(module, api);
    await flushEffects();
    let view = renderController(module, api);
    let props = settingsProps(view);
    props.onEditorChange("titles", "Principal Engineer");
    canonical = onboardState({ revision: "revision-b", title: "Platform Engineer" });
    props = settingsProps(renderController(module, api));
    await props.onSaveEditor();
    view = renderController(module, api);
    props = settingsProps(view);

    expect.soft(api.saveCandidateFile).toHaveBeenNthCalledWith(1, "targeting", expect.any(Object), {
      expectedBaseRevision: "revision-a",
    });
    expect
      .soft(controllerAlertText(view))
      .toBe(
        "Your profile changed while you were editing. CareerRat reloaded the latest version and kept your draft open. Review it, then save again."
      );
    expect.soft(props.profileEditor?.id).toBe("targets");
    expect.soft(props.editorValues.titles).toBe("Principal Engineer");

    hooks.clear();
    renderController(module, api);
    await flushEffects();
    props = settingsProps(renderController(module, api));
    expect.soft(props.editorValues.titles).toBe("Principal Engineer");

    api.saveCandidateFile.mockResolvedValue({ ok: true });
    await props.onSaveEditor();
    expect.soft(api.saveCandidateFile).toHaveBeenNthCalledWith(2, "targeting", expect.any(Object), {
      expectedBaseRevision: "revision-b",
    });
  });

  it("blocks browser history while an editor is dirty and reuses the Keep or Discard decision", async () => {
    const module = await import("./ProfileSettingsController.jsx");
    const api = createApi();
    const entries = new Map();
    vi.stubGlobal("localStorage", {
      getItem: vi.fn((key) => entries.get(key) ?? null),
      setItem: vi.fn((key, value) => entries.set(key, value)),
      removeItem: vi.fn((key) => entries.delete(key)),
    });
    api.getOnboardState.mockResolvedValue(onboardState());
    const editorLocation = {
      pathname: "/settings",
      search: "?panel=editor&section=targets",
      state: null,
    };
    const destination = {
      pathname: "/settings",
      search: "?tab=settings&panel=source",
      state: null,
    };
    router.location = editorLocation;

    renderController(module, api);
    await flushEffects();
    let props = settingsProps(renderController(module, api));
    props.onEditorChange("titles", "Principal Engineer");

    router.location = {
      pathname: "/settings",
      search: "?panel=editor&section=location-policy",
      state: null,
    };
    props = settingsProps(renderController(module, api));
    expect.soft(props.discardEditorOpen).toBe(true);
    expect.soft(props.profileEditor?.id).toBe("targets");
    props.onKeepEditing();

    router.location = destination;
    props = settingsProps(renderController(module, api));
    expect.soft(props.discardEditorOpen).toBe(true);
    expect.soft(props.activeTab).toBe("profile");
    expect.soft(props.profileEditor?.id).toBe("targets");
    expect.soft(props.sourceDialogOpen).toBe(false);

    props.onKeepEditing();
    props = settingsProps(renderController(module, api));
    expect.soft(router.location.search).toBe(editorLocation.search);
    expect.soft(props.editorValues.titles).toBe("Principal Engineer");

    router.location = destination;
    props = settingsProps(renderController(module, api));
    props.onDiscardEditor();
    expect.soft(router.location.search).toBe(destination.search);
    expect.soft(entries.size).toBe(0);
  });

  it("allows a confirmed client navigation through the data-router blocker exactly once", async () => {
    const module = await import("./ProfileSettingsController.jsx");
    const api = createApi();
    api.getOnboardState.mockResolvedValue(onboardState());
    router.location = {
      pathname: "/settings",
      search: "?panel=editor&section=targets",
      state: null,
    };

    renderController(module, api);
    await flushEffects();
    let props = settingsProps(renderController(module, api));
    props.onEditorChange("titles", "Principal Engineer");
    props = settingsProps(renderController(module, api));
    props.onTabChange("settings");
    props = settingsProps(renderController(module, api));
    expect.soft(props.discardEditorOpen).toBe(true);

    props.onDiscardEditor();

    expect.soft(router.blocker.state).toBe("unblocked");
    expect.soft(router.location.search).toBe("?tab=settings");
    expect.soft(router.shouldBlock({ nextLocation: { pathname: "/", search: "" } })).toBe(true);
  });

  it("canonicalizes a changed URL without updating state during render", async () => {
    const module = await import("./ProfileSettingsController.jsx");
    const api = createApi();
    router.location = {
      pathname: "/settings",
      search: "?tab=settings&panel=source",
      state: null,
    };

    renderController(module, api);
    await flushEffects();
    renderController(module, api);
    hooks.stateUpdatesDuringRender = 0;
    router.location = {
      pathname: "/settings",
      search: "?panel=engine&tab=profile&unused=yes",
      state: null,
    };

    renderController(module, api);

    expect(hooks.stateUpdatesDuringRender).toBe(0);
  });

  it("persists bounded owner-scoped source drafts and protects dirty source navigation and reload", async () => {
    const module = await import("./ProfileSettingsController.jsx");
    const api = createApi();
    const entries = new Map();
    const addEventListener = vi.fn();
    vi.stubGlobal("addEventListener", addEventListener);
    vi.stubGlobal("removeEventListener", vi.fn());
    vi.stubGlobal("localStorage", {
      getItem: vi.fn((key) => entries.get(key) ?? null),
      setItem: vi.fn((key, value) => entries.set(key, value)),
      removeItem: vi.fn((key) => entries.delete(key)),
    });
    let canonical = onboardState();
    api.getOnboardState.mockImplementation(async () => canonical);
    router.location = {
      pathname: "/settings",
      search: "?tab=settings&panel=source",
      state: null,
    };
    const sourceUrl = "https://jobs.example.test/search?q=platform";

    renderController(module, api);
    await flushEffects();
    let props = settingsProps(renderController(module, api));
    props.onSourceDraftChange(sourceUrl);
    renderController(module, api);
    await flushEffects();
    expect.soft(addEventListener).toHaveBeenCalledWith("beforeunload", expect.any(Function));

    hooks.clear();
    renderController(module, api);
    await flushEffects();
    props = settingsProps(renderController(module, api));
    expect.soft(props.sourceDraft).toBe(sourceUrl);

    canonical = onboardState({ workspaceId: "workspace-b", candidateId: "candidate-b" });
    hooks.clear();
    renderController(module, api);
    await flushEffects();
    props = settingsProps(renderController(module, api));
    expect.soft(props.sourceDraft).toBe("");

    canonical = onboardState();
    hooks.clear();
    renderController(module, api);
    await flushEffects();
    props = settingsProps(renderController(module, api));
    expect.soft(props.sourceDraft).toBe(sourceUrl);
    props.onSourceDraftChange(`https://jobs.example.test/${"x".repeat(20_000)}`);
    expect.soft(entries.size).toBe(1);

    props = settingsProps(renderController(module, api));
    props.onSourceDraftChange(sourceUrl);
    props = settingsProps(renderController(module, api));
    props.onTabChange("profile");
    props = settingsProps(renderController(module, api));
    expect.soft(props.discardEditorOpen).toBe(true);
    expect.soft(navigate).not.toHaveBeenCalledWith("/settings", expect.anything());
  });

  it("opens a deep-linked Settings panel from the URL", async () => {
    const module = await import("./ProfileSettingsController.jsx");
    const api = createApi();
    router.location = {
      pathname: "/settings",
      search: "?tab=settings&panel=engine",
      state: null,
    };

    renderController(module, api);
    await flushEffects();
    const props = settingsProps(renderController(module, api));

    expect(props.activeTab).toBe("settings");
    expect(props.enginePickerOpen).toBe(true);
  });

  it("restores the active tab, dialog, and editor when browser history changes", async () => {
    const module = await import("./ProfileSettingsController.jsx");
    const api = createApi();
    api.getOnboardState.mockResolvedValue({
      data: {
        targeting: {
          role_buckets: [
            { name: "Primary targets", priority: "primary", titles: ["Staff Engineer"] },
          ],
        },
      },
      publicSyncPreference: { enabled: true, source: "default", updatedAt: null },
    });
    router.location = {
      pathname: "/settings",
      search: "?tab=settings&panel=source",
      state: null,
    };

    renderController(module, api);
    await flushEffects();
    let props = settingsProps(renderController(module, api));
    expect(props.activeTab).toBe("settings");
    expect(props.sourceDialogOpen).toBe(true);

    router.location = {
      pathname: "/settings",
      search: "?panel=editor&section=targets",
      state: null,
    };
    props = settingsProps(renderController(module, api));
    expect(props.activeTab).toBe("profile");
    expect(props.sourceDialogOpen).toBe(false);
    expect(props.profileEditor?.id).toBe("targets");
    expect(props.editorValues.titles).toBe("Staff Engineer");
  });

  it("keeps a dirty editor open until the candidate confirms navigation", async () => {
    const module = await import("./ProfileSettingsController.jsx");
    const api = createApi();
    api.getOnboardState.mockResolvedValue({
      data: {
        targeting: {
          role_buckets: [
            { name: "Primary targets", priority: "primary", titles: ["Staff Engineer"] },
          ],
        },
      },
      publicSyncPreference: { enabled: true, source: "default", updatedAt: null },
    });
    router.location = {
      pathname: "/settings",
      search: "?panel=editor&section=targets",
      state: null,
    };

    renderController(module, api);
    await flushEffects();
    let props = settingsProps(renderController(module, api));
    props.onEditorChange("titles", "Principal Engineer");
    props = settingsProps(renderController(module, api));
    expect(props.editorValues.titles).toBe("Principal Engineer");

    props.onTabChange("settings");
    props = settingsProps(renderController(module, api));
    expect(props.discardEditorOpen).toBe(true);
    expect(props.profileEditor?.id).toBe("targets");
    expect(props.editorValues.titles).toBe("Principal Engineer");
    expect(navigate).not.toHaveBeenCalled();

    props.onKeepEditing();
    props = settingsProps(renderController(module, api));
    expect(props.discardEditorOpen).toBe(false);
    expect(props.profileEditor?.id).toBe("targets");
    expect(props.editorValues.titles).toBe("Principal Engineer");
  });

  it("protects a dirty editor from a reload until it is saved or discarded", async () => {
    const module = await import("./ProfileSettingsController.jsx");
    const api = createApi();
    const addEventListener = vi.fn();
    const removeEventListener = vi.fn();
    vi.stubGlobal("addEventListener", addEventListener);
    vi.stubGlobal("removeEventListener", removeEventListener);
    api.getOnboardState.mockResolvedValue({
      data: {
        targeting: {
          role_buckets: [
            { name: "Primary targets", priority: "primary", titles: ["Staff Engineer"] },
          ],
        },
      },
      publicSyncPreference: { enabled: true, source: "default", updatedAt: null },
    });
    router.location = {
      pathname: "/settings",
      search: "?panel=editor&section=targets",
      state: null,
    };

    renderController(module, api);
    await flushEffects();
    const props = settingsProps(renderController(module, api));
    props.onEditorChange("titles", "Principal Engineer");
    renderController(module, api);
    await flushEffects();

    expect(addEventListener).toHaveBeenCalledWith("beforeunload", expect.any(Function));
    const protectDraft = addEventListener.mock.calls.find(([name]) => name === "beforeunload")[1];
    const event = { preventDefault: vi.fn(), returnValue: null };
    protectDraft(event);
    expect(event.preventDefault).toHaveBeenCalledOnce();
    expect(event.returnValue).toBe("");
  });

  it("keeps an editor draft scoped to its accepted section across browser history", async () => {
    const module = await import("./ProfileSettingsController.jsx");
    const api = createApi();
    api.getOnboardState.mockResolvedValue({
      data: {
        profile: { compensation: { minimum_base: 150000 } },
        targeting: {
          role_buckets: [
            { name: "Primary targets", priority: "primary", titles: ["Staff Engineer"] },
          ],
        },
      },
      publicSyncPreference: { enabled: true, source: "default", updatedAt: null },
    });
    router.location = {
      pathname: "/settings",
      search: "?panel=editor&section=targets",
      state: null,
    };

    renderController(module, api);
    await flushEffects();
    let props = settingsProps(renderController(module, api));
    props.onEditorChange("titles", "Principal Engineer");

    router.location = {
      pathname: "/settings",
      search: "?panel=editor&section=compensation",
      state: null,
    };
    props = settingsProps(renderController(module, api));
    expect(props.discardEditorOpen).toBe(true);
    expect(props.profileEditor?.id).toBe("targets");
    expect(props.editorValues).not.toHaveProperty("minimumBase");
    props.onKeepEditing();
    props = settingsProps(renderController(module, api));
    expect(router.location.search).toBe("?panel=editor&section=targets");
    expect(props.editorValues.titles).toBe("Principal Engineer");
  });

  it("restores an unsaved editor draft after the Settings route remounts", async () => {
    const module = await import("./ProfileSettingsController.jsx");
    const api = createApi();
    const storageEntries = new Map();
    vi.stubGlobal("localStorage", {
      getItem: vi.fn((key) => storageEntries.get(key) ?? null),
      setItem: vi.fn((key, value) => storageEntries.set(key, value)),
      removeItem: vi.fn((key) => storageEntries.delete(key)),
    });
    api.getOnboardState.mockResolvedValue({
      draftContext: onboardState().draftContext,
      data: {
        targeting: {
          role_buckets: [
            { name: "Primary targets", priority: "primary", titles: ["Staff Engineer"] },
          ],
        },
      },
      publicSyncPreference: { enabled: true, source: "default", updatedAt: null },
    });
    router.location = {
      pathname: "/settings",
      search: "?panel=editor&section=targets",
      state: null,
    };

    renderController(module, api);
    await flushEffects();
    let props = settingsProps(renderController(module, api));
    props.onEditorChange("titles", "Principal Engineer");

    hooks.clear();
    renderController(module, api);
    await flushEffects();
    props = settingsProps(renderController(module, api));

    expect(props.editorValues.titles).toBe("Principal Engineer");
  });

  it("hydrates a legacy annual earnings draft into the visible worksheet before interaction", async () => {
    const module = await import("./ProfileSettingsController.jsx");
    const api = createApi();
    const draftContext = onboardState().draftContext;
    const normalizedContext = {
      owner: draftContext.owner,
      base: { revision: "1:2026-08-28T12:00:00.000Z" },
    };
    const storageEntries = new Map([
      [
        "careerrat:profile-editor-draft:workspace-a:candidate-a:compensation",
        JSON.stringify({
          ...normalizedContext,
          savedAt: "2026-08-28T12:30:00.000Z",
          value: {
            minimumBase: "50000",
            minimumAnnualEarnings: "85000",
            targetBase: "90000",
          },
        }),
      ],
    ]);
    vi.stubGlobal("localStorage", {
      getItem: vi.fn((key) => storageEntries.get(key) ?? null),
      setItem: vi.fn((key, value) => storageEntries.set(key, value)),
      removeItem: vi.fn((key) => storageEntries.delete(key)),
    });
    api.getOnboardState.mockResolvedValue({
      draftContext,
      data: {
        profile: {
          compensation: {
            currency: "CAD",
            minimum_base: 50_000,
            minimum_annual_earnings: 70_000,
            target_base: 90_000,
          },
        },
      },
      publicSyncPreference: { enabled: true, source: "default", updatedAt: null },
    });
    router.location = {
      pathname: "/settings",
      search: "?panel=editor&section=compensation",
      state: null,
    };

    renderController(module, api);
    await flushEffects();
    let props = settingsProps(renderController(module, api));

    expect(props.editorValues.annualCashWorksheet).toEqual(
      expect.objectContaining({ annualOverride: "85000" })
    );

    props.onEditorChange("annualCashWorksheet", {
      ...props.editorValues.annualCashWorksheet,
      hoursPerWeek: "30",
    });
    expect(
      JSON.parse(
        storageEntries.get("careerrat:profile-editor-draft:workspace-a:candidate-a:compensation")
      ).value
    ).toEqual(
      expect.not.objectContaining({
        minimumAnnualEarnings: expect.anything(),
      })
    );
    props = settingsProps(renderController(module, api));
    await props.onSaveEditor();

    expect(api.saveCandidateFile).toHaveBeenCalledWith(
      "profile",
      {
        compensation: {
          minimum_base: 50_000,
          minimum_annual_earnings: 85_000,
          target_base: 90_000,
        },
      },
      { expectedBaseRevision: "1:2026-08-28T12:00:00.000Z" }
    );
  });

  it("surfaces a zero-derived worksheet error without writing Profile Settings", async () => {
    const module = await import("./ProfileSettingsController.jsx");
    const api = createApi();
    api.getOnboardState.mockResolvedValue({
      draftContext: onboardState().draftContext,
      data: {
        profile: {
          compensation: {
            currency: "USD",
            minimum_annual_earnings: 70_000,
          },
        },
      },
      publicSyncPreference: { enabled: true, source: "default", updatedAt: null },
    });
    router.location = {
      pathname: "/settings",
      search: "?panel=editor&section=compensation",
      state: null,
    };

    renderController(module, api);
    await flushEffects();
    const props = settingsProps(renderController(module, api));
    props.onEditorChange("annualCashWorksheet", {
      hourlyRate: "0",
      hoursPerWeek: "35",
      weeksPerYear: "52",
    });
    let view = renderController(module, api);

    await settingsProps(view).onSaveEditor();
    view = renderController(module, api);

    expect(controllerAlertText(view)).toBe(
      "Minimum annual cash earnings must be a positive amount."
    );
    expect(api.saveCandidateFile).not.toHaveBeenCalled();
  });

  it("hydrates invalid legacy annual floors losslessly and refuses to save them", async () => {
    const module = await import("./ProfileSettingsController.jsx");
    const draftContext = onboardState().draftContext;
    const normalizedContext = {
      owner: draftContext.owner,
      base: { revision: "1:2026-08-28T12:00:00.000Z" },
    };

    for (const rawFloor of ["0", "-5000", "not-an-amount"]) {
      hooks.clear();
      const api = createApi();
      const storageEntries = new Map([
        [
          "careerrat:profile-editor-draft:workspace-a:candidate-a:compensation",
          JSON.stringify({
            ...normalizedContext,
            savedAt: "2026-08-28T12:30:00.000Z",
            value: {
              minimumBase: "50000",
              minimumAnnualEarnings: rawFloor,
              targetBase: "90000",
            },
          }),
        ],
      ]);
      vi.stubGlobal("localStorage", {
        getItem: vi.fn((key) => storageEntries.get(key) ?? null),
        setItem: vi.fn((key, value) => storageEntries.set(key, value)),
        removeItem: vi.fn((key) => storageEntries.delete(key)),
      });
      api.getOnboardState.mockResolvedValue({
        draftContext,
        data: {
          profile: {
            compensation: {
              minimum_base: 50_000,
              minimum_annual_earnings: 70_000,
              target_base: 90_000,
            },
          },
        },
        publicSyncPreference: { enabled: true, source: "default", updatedAt: null },
      });
      router.location = {
        pathname: "/settings",
        search: "?panel=editor&section=compensation",
        state: null,
      };

      renderController(module, api);
      await flushEffects();
      let view = renderController(module, api);

      expect(settingsProps(view).editorValues.annualCashWorksheet.annualOverride).toBe(rawFloor);

      await settingsProps(view).onSaveEditor();
      view = renderController(module, api);

      expect(controllerAlertText(view)).toBe(
        "Minimum annual cash earnings must be a positive amount."
      );
      expect(api.saveCandidateFile).not.toHaveBeenCalled();
    }
  });

  it("clears editor dirty state when a worksheet field is edited then reverted", async () => {
    const module = await import("./ProfileSettingsController.jsx");
    const api = createApi();
    api.getOnboardState.mockResolvedValue({
      draftContext: onboardState().draftContext,
      data: {
        profile: {
          compensation: {
            currency: "USD",
            minimum_base: 50_000,
            minimum_annual_earnings: 70_000,
            target_base: 90_000,
          },
        },
      },
      publicSyncPreference: { enabled: true, source: "default", updatedAt: null },
    });
    router.location = {
      pathname: "/settings",
      search: "?panel=editor&section=compensation",
      state: null,
    };

    renderController(module, api);
    await flushEffects();
    let props = settingsProps(renderController(module, api));
    const original = props.editorValues.annualCashWorksheet;

    props.onEditorChange("annualCashWorksheet", { ...original, hoursPerWeek: "30" });
    props = settingsProps(renderController(module, api));
    props.onTabChange("settings");
    props = settingsProps(renderController(module, api));
    expect.soft(props.discardEditorOpen).toBe(true);
    props.onKeepEditing();

    props = settingsProps(renderController(module, api));
    props.onEditorChange("annualCashWorksheet", { ...original });
    props = settingsProps(renderController(module, api));
    props.onTabChange("settings");
    props = settingsProps(renderController(module, api));

    expect.soft(props.discardEditorOpen).toBe(false);
    expect.soft(props.activeTab).toBe("settings");
  });

  it("never renders a panel on the contradictory Settings tab", async () => {
    const module = await import("./ProfileSettingsController.jsx");
    const api = createApi();
    api.getOnboardState.mockResolvedValue(onboardState());

    router.location = { pathname: "/settings", search: "?panel=engine", state: null };
    renderController(module, api);
    await flushEffects();
    let props = settingsProps(renderController(module, api));
    expect.soft(props.activeTab).toBe("settings");
    expect.soft(props.enginePickerOpen).toBe(true);

    router.location = {
      pathname: "/settings",
      search: "?tab=settings&panel=editor&section=targets",
      state: null,
    };
    props = settingsProps(renderController(module, api));
    expect.soft(props.activeTab).toBe("profile");
    expect.soft(props.profileEditor?.id).toBe("targets");
    expect.soft(props.enginePickerOpen).toBe(false);
  });
});

describe("ProfileSettingsController error copy", () => {
  it("does not render raw settings-load exceptions", async () => {
    const module = await import("./ProfileSettingsController.jsx");
    const api = createApi();
    const raw = "SQLITE_ERROR: no such table at /Users/person/private/careerrat.db";
    api.getOnboardState.mockRejectedValue(new Error(raw));

    renderController(module, api);
    await flushEffects();
    const view = renderController(module, api);

    expect(controllerAlertText(view)).toBe("CareerRat couldn't load Settings. Try again.");
    expect(controllerAlertText(view)).not.toContain(raw);
  });

  it("preserves mapped typed errors when a settings action fails", async () => {
    const module = await import("./ProfileSettingsController.jsx");
    const api = createApi();
    api.setAutomationSessionProvider.mockRejectedValue(
      new ApiError(409, { code: "NO_AI_ROUTE", error: "provider route missing" })
    );

    renderController(module, api);
    await flushEffects();
    let view = renderController(module, api);
    await settingsProps(view).onBrowserProviderChange("playwright");
    view = renderController(module, api);

    expect(controllerAlertText(view)).toBe("No AI engine is connected yet. Open Settings.");
    expect(controllerAlertText(view)).not.toContain("provider route missing");
  });

  it("preserves mapped HTTP recovery instead of replacing it with a call-site fallback", async () => {
    const { profileSettingsErrorMessage } = await import("./ProfileSettingsController.jsx");

    expect(
      profileSettingsErrorMessage(new ApiError(401, { error: "raw auth failure" }), "Retry.")
    ).toBe("CareerRat couldn't complete that request safely. Reload CareerRat, then try again.");
  });

  it("shows a people-shaped recovery when saving a profile section returns 500", async () => {
    const module = await import("./ProfileSettingsController.jsx");
    const api = createApi();
    const raw = "SQLITE_BUSY: database is locked at /Users/person/private/careerrat.db";
    api.getOnboardState.mockResolvedValue({
      draftContext: onboardState().draftContext,
      data: {
        targeting: {
          role_buckets: [
            { name: "Primary targets", priority: "primary", titles: ["Staff Engineer"] },
          ],
        },
      },
      publicSyncPreference: { enabled: true, source: "default", updatedAt: null },
    });
    api.saveCandidateFile.mockRejectedValue(new ApiError(500, { error: raw }));

    renderController(module, api);
    await flushEffects();
    let view = renderController(module, api);
    settingsProps(view).onEditSection("targets");
    view = renderController(module, api);
    await settingsProps(view).onSaveEditor();
    view = renderController(module, api);

    expect(controllerAlertText(view)).toBe(
      "CareerRat hit a problem while doing that. Try again. If it keeps happening, restart CareerRat."
    );
    expect(controllerAlertText(view)).not.toContain(raw);
  });

  it("shows intentional section validation while hiding unexpected implementation details", async () => {
    const { profileSettingsErrorMessage } = await import("./ProfileSettingsController.jsx");
    const { profileSectionSavePlan } = await import("./profile-settings-controller.js");
    const fallback = "CareerRat couldn't save that profile section. Check it and try again.";
    let validationError;

    try {
      profileSectionSavePlan("targets", { titles: "" });
    } catch (cause) {
      validationError = cause;
    }

    expect(profileSettingsErrorMessage(validationError, fallback)).toBe(
      "Add at least one target role."
    );
    expect(
      profileSettingsErrorMessage(
        new Error("SQLITE_ERROR: no such table at /Users/person/private/careerrat.db"),
        fallback
      )
    ).toBe(fallback);
  });
});

describe("ProfileSettingsController public metadata preference", () => {
  it("writes the existing API and reloads the canonical preference after opt-out", async () => {
    const module = await import("./ProfileSettingsController.jsx");
    const api = createApi();

    renderController(module, api);
    await flushEffects();
    let view = renderController(module, api);
    expect(settingsProps(view).publicSyncPreference.enabled).toBe(true);

    await settingsProps(view).onPublicSyncChange(false);

    expect(api.setPublicSyncPreference).toHaveBeenCalledWith(false);
    expect(api.getOnboardState).toHaveBeenCalledTimes(2);
    view = renderController(module, api);
    expect(settingsProps(view).publicSyncPreference).toMatchObject({
      enabled: false,
      source: "user",
    });
    expect(settingsProps(view).publicSyncBusy).toBe(false);
  });
});

describe("ProfileSettingsController AI preferences", () => {
  it("loads local preferences and saves a merged provider-neutral choice", async () => {
    const module = await import("./ProfileSettingsController.jsx");
    const api = createApi();
    api.getAiPreferences.mockResolvedValue({
      quality: "balanced",
      reasoning: "medium",
      source: "saved",
      updatedAt: "2026-08-27T15:00:00.000Z",
    });

    renderController(module, api);
    await flushEffects();
    let view = renderController(module, api);
    expect(settingsProps(view).aiPreferences).toMatchObject({
      quality: "balanced",
      reasoning: "medium",
      source: "saved",
    });

    await settingsProps(view).onAiPreferenceChange("reasoning", "high");

    expect(api.saveAiPreferences).toHaveBeenCalledWith({
      quality: "balanced",
      reasoning: "high",
    });
    expect(api.saveCandidateFile).not.toHaveBeenCalled();
    view = renderController(module, api);
    expect(settingsProps(view).aiPreferences).toMatchObject({
      quality: "balanced",
      reasoning: "high",
      source: "saved",
    });
    expect(settingsProps(view).aiPreferencesBusy).toBe(false);
    expect(settingsProps(view).aiPreferencesStatus).toBe("Saved on this computer");
  });

  it("surfaces a people-shaped save error without losing the last saved choice", async () => {
    const module = await import("./ProfileSettingsController.jsx");
    const api = createApi();
    api.saveAiPreferences.mockRejectedValue(
      new ApiError(400, {
        code: "AI_PREFERENCES_INVALID",
        error: "Paul quality must be Automatic, Faster, Balanced, or Best.",
      })
    );

    renderController(module, api);
    await flushEffects();
    let view = renderController(module, api);
    await settingsProps(view).onAiPreferenceChange("quality", "broken");
    view = renderController(module, api);

    expect(controllerAlertText(view)).toBe(
      "CareerRat couldn't save that AI setting. Choose one of the options and try again."
    );
    expect(settingsProps(view).aiPreferences.quality).toBe("automatic");
  });

  it("keeps a saved preference through a post-install refresh instead of letting a later save roll it back", async () => {
    const module = await import("./ProfileSettingsController.jsx");
    const api = createApi();
    // The post-install refresh's own load() fails on an unrelated request
    // (automation settings), the same shape as the "guided update" describe
    // block below: settingsPartsRef must already carry the saved
    // aiPreferences by then, since load() never gets a chance to refresh it.
    api.getAutomationSettings
      .mockResolvedValueOnce({ capabilities: [] })
      .mockRejectedValueOnce(new Error("automation settings unavailable"));

    renderController(module, api);
    await flushEffects();

    let view = renderController(module, api);
    await settingsProps(view).onAiPreferenceChange("quality", "best");

    view = renderController(module, api);
    expect(settingsProps(view).aiPreferences).toMatchObject({
      quality: "best",
      reasoning: "automatic",
    });

    await settingsProps(view).onGuidedUpdateEngine("claude");

    view = renderController(module, api);
    await settingsProps(view).onAiPreferenceChange("reasoning", "high");

    // A stale settingsPartsRef would post the pre-guided-update "automatic"
    // quality here, silently reverting the earlier save.
    expect(api.saveAiPreferences).toHaveBeenLastCalledWith({
      quality: "best",
      reasoning: "high",
    });
  });

  it("keeps a preference saved mid-flight instead of letting a slower, earlier-started load overwrite it", async () => {
    const module = await import("./ProfileSettingsController.jsx");
    const api = createApi();
    let resolvePostInstallPreferences;
    api.getAiPreferences
      // The initial mount fetch: resolves immediately, same as every other test here.
      .mockResolvedValueOnce({
        quality: "automatic",
        reasoning: "automatic",
        source: "default",
        updatedAt: null,
      })
      // refreshRuntimesAfterInstall's own load() call: deferred, so this test
      // can land a save while it's still in flight and control exactly when
      // its (now stale) snapshot arrives.
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolvePostInstallPreferences = resolve;
          })
      );
    api.getInstalledAiRuntimes.mockResolvedValue({
      runtimes: [
        { id: "claude", name: "Claude Code", supported: true, available: true, ready: true },
      ],
      guidedSetupAvailable: true,
    });

    renderController(module, api);
    await flushEffects();

    let view = renderController(module, api);
    const guidedUpdate = settingsProps(view).onGuidedUpdateEngine("claude");
    // Let refreshRuntimesAfterInstall run far enough to call load(), which
    // calls getAiPreferences a second time and blocks on the deferred
    // promise above, before the save below races it.
    await flushEffects();

    view = renderController(module, api);
    await settingsProps(view).onAiPreferenceChange("quality", "best");

    view = renderController(module, api);
    expect(settingsProps(view).aiPreferences).toMatchObject({
      quality: "best",
      reasoning: "automatic",
    });

    // The post-install load's own (now stale) fetch finally resolves, still
    // carrying the pre-save value.
    resolvePostInstallPreferences({
      quality: "automatic",
      reasoning: "automatic",
      source: "default",
      updatedAt: null,
    });
    await guidedUpdate;
    await flushEffects();

    view = renderController(module, api);
    // A stale-load-wins bug would revert this to "automatic" here.
    expect(settingsProps(view).aiPreferences).toMatchObject({
      quality: "best",
      reasoning: "automatic",
    });

    await settingsProps(view).onAiPreferenceChange("reasoning", "high");

    // And a stale settingsPartsRef would post "automatic" here too, since
    // changeAiPreference merges the next save on top of model.aiPreferences.
    expect(api.saveAiPreferences).toHaveBeenLastCalledWith({
      quality: "best",
      reasoning: "high",
    });
  });

  it("keeps a preference saved mid-flight instead of letting the initial mount hydration overwrite it", async () => {
    const module = await import("./ProfileSettingsController.jsx");
    const api = createApi();
    let resolveMountPreferences;
    // The initial mount fetch itself: deferred, so this test can land a
    // save while it's still in flight and control exactly when its (now
    // stale) snapshot arrives.
    api.getAiPreferences.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveMountPreferences = resolve;
        })
    );

    const view = renderController(module, api);
    await flushEffects();
    // The mount Promise.all is still pending on getAiPreferences here; the
    // save below lands and bumps the revision before that snapshot commits.
    await settingsProps(view).onAiPreferenceChange("quality", "best");

    let latest = renderController(module, api);
    expect(settingsProps(latest).aiPreferences).toMatchObject({
      quality: "best",
      reasoning: "automatic",
    });

    // The mount fetch's own (now stale) snapshot finally resolves, still
    // carrying the pre-save default.
    resolveMountPreferences({
      quality: "automatic",
      reasoning: "automatic",
      source: "default",
      updatedAt: null,
    });
    await flushEffects();

    latest = renderController(module, api);
    // A stale-mount-wins bug would revert this to "automatic" here.
    expect(settingsProps(latest).aiPreferences).toMatchObject({
      quality: "best",
      reasoning: "automatic",
    });

    await settingsProps(latest).onAiPreferenceChange("reasoning", "high");

    // And a stale settingsPartsRef would post "automatic" here too.
    expect(api.saveAiPreferences).toHaveBeenLastCalledWith({
      quality: "best",
      reasoning: "high",
    });
  });

  it("disables the AI preference controls until initial hydration completes", async () => {
    const module = await import("./ProfileSettingsController.jsx");
    const api = createApi();
    let resolveMountPreferences;
    api.getAiPreferences.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveMountPreferences = resolve;
        })
    );

    const view = renderController(module, api);
    await flushEffects();

    expect(settingsProps(view).aiPreferencesBusy).toBe(true);

    resolveMountPreferences({
      quality: "automatic",
      reasoning: "automatic",
      source: "default",
      updatedAt: null,
    });
    await flushEffects();

    const settled = renderController(module, api);
    expect(settingsProps(settled).aiPreferencesBusy).toBe(false);
  });
});

describe("ProfileSettingsController guided update", () => {
  it("reports the installed result even when an unrelated Settings request fails during the post-install refresh, without re-fetching the inventory it already has", async () => {
    const module = await import("./ProfileSettingsController.jsx");
    const api = createApi();
    api.getInstalledAiRuntimes
      .mockResolvedValueOnce({ runtimes: [], guidedSetupAvailable: true })
      .mockResolvedValueOnce({
        runtimes: [
          { id: "claude", name: "Claude Code", supported: true, available: true, ready: true },
        ],
        guidedSetupAvailable: true,
      });
    // The post-install load() bundles automation settings, sources,
    // onboarding, and AI preferences in one Promise.all alongside runtimes.
    // A failure in any of those must never turn a successful installer run
    // into a reported failure.
    api.getAutomationSettings
      .mockResolvedValueOnce({ capabilities: [] })
      .mockRejectedValueOnce(new Error("automation settings unavailable"));

    renderController(module, api);
    await flushEffects();
    let props = settingsProps(renderController(module, api));

    await props.onGuidedUpdateEngine("claude");

    const view = renderController(module, api);
    props = settingsProps(view);

    expect.soft(props.guidedSetup).toEqual({ runtimeId: "claude", status: "installed" });
    expect.soft(props.enginePickerBusy).toBe(false);
    expect.soft(controllerAlertText(view)).toBe(null);
    // Only the mount's initial load and refreshRuntimesAfterInstall's own
    // targeted fetch: load()'s own inventory request is skipped since it
    // was handed that already-fetched inventory directly.
    expect.soft(api.getInstalledAiRuntimes).toHaveBeenCalledTimes(2);
    // The rendered runtime state reflects the second (post-install) fetch,
    // not the empty inventory the mount started with.
    expect.soft(props.engine.choices.find((choice) => choice.id === "claude")).toMatchObject({
      id: "claude",
      ready: true,
    });
  });

  it("reports the installed result even when the runtime-inventory refresh itself fails after a successful install", async () => {
    const module = await import("./ProfileSettingsController.jsx");
    const api = createApi();
    api.getInstalledAiRuntimes
      .mockResolvedValueOnce({ runtimes: [], guidedSetupAvailable: true })
      .mockRejectedValueOnce(new Error("runtime inventory unavailable"))
      .mockResolvedValueOnce({
        runtimes: [{ id: "claude", name: "Claude Code", available: true, ready: true }],
        guidedSetupAvailable: true,
      });

    renderController(module, api);
    await flushEffects();
    let props = settingsProps(renderController(module, api));

    await props.onGuidedUpdateEngine("claude");

    const view = renderController(module, api);
    props = settingsProps(view);

    expect.soft(props.guidedSetup).toEqual({ runtimeId: "claude", status: "installed" });
    expect.soft(props.enginePickerBusy).toBe(false);
    expect.soft(controllerAlertText(view)).toBe(null);
  });
});

describe("ProfileSettingsController browser automation provider", () => {
  it("writes the dedicated provider endpoint and reloads canonical automation state", async () => {
    const module = await import("./ProfileSettingsController.jsx");
    const api = createApi();

    renderController(module, api);
    await flushEffects();
    const view = renderController(module, api);

    await settingsProps(view).onBrowserProviderChange("playwright");

    expect(api.setAutomationSessionProvider).toHaveBeenCalledWith("playwright");
    expect(api.getAutomationSettings).toHaveBeenCalledTimes(2);
    expect(settingsProps(renderController(module, api)).browserProviderBusy).toBe(false);
  });
});

describe("ProfileSettingsController source setup", () => {
  it("saves a source in Settings without starting a login or conversation gate", async () => {
    const module = await import("./ProfileSettingsController.jsx");
    const api = createApi();

    renderController(module, api);
    await flushEffects();
    let view = renderController(module, api);
    settingsProps(view).onAddSource();
    view = renderController(module, api);
    settingsProps(view).onSourceDraftChange("https://www.linkedin.com/jobs/search/?keywords=ops");
    view = renderController(module, api);
    await settingsProps(view).onSubmitSource();

    expect(api.addBoardSource).toHaveBeenCalledWith(
      "https://www.linkedin.com/jobs/search/?keywords=ops"
    );
    expect(api.runWorkspaceIntent).not.toHaveBeenCalled();
    expect(navigate).toHaveBeenNthCalledWith(1, "/settings?tab=settings&panel=source", {
      replace: false,
    });
    expect(navigate).toHaveBeenNthCalledWith(2, "/settings?tab=settings", { replace: true });
    expect(api.getSourceMaintenance).toHaveBeenCalledTimes(2);
  });
});

describe("ProfileSettingsController permission consent", () => {
  it("does not expose a job-source login Settings write path", async () => {
    const module = await import("./ProfileSettingsController.jsx");
    const api = createApi();
    api.getAutomationSettings.mockResolvedValue({
      capabilities: [
        { capability: "source_login", enabled: true },
        { capability: "authenticated_apply_preparation", enabled: true },
        { capability: "mail_access", enabled: false },
      ],
    });

    renderController(module, api);
    await flushEffects();
    const view = renderController(module, api);
    await settingsProps(view).onPermissionChange("source_login", false);

    expect(api.saveCandidateFile).not.toHaveBeenCalled();
  });

  it("does not preserve consent for a hidden job-source permission", async () => {
    const module = await import("./ProfileSettingsController.jsx");
    const api = createApi();
    api.getAutomationSettings.mockResolvedValue({
      capabilities: [
        { capability: "source_login", enabled: true },
        { capability: "authenticated_apply_preparation", enabled: true },
      ],
    });

    renderController(module, api);
    await flushEffects();
    const view = renderController(module, api);
    await settingsProps(view).onPermissionChange("authenticated_apply_preparation", false);

    expect(api.saveCandidateFile).toHaveBeenCalledWith(
      "automation",
      expect.objectContaining({ consent: expect.objectContaining({ linkedin: false }) })
    );
  });
});

describe("ProfileSettingsController local application defaults", () => {
  it("saves the voluntary-question policy locally while preserving private answers", async () => {
    const module = await import("./ProfileSettingsController.jsx");
    const api = createApi();
    api.getOnboardState.mockResolvedValue({
      draftContext: onboardState().draftContext,
      data: {
        "form-defaults": {
          voluntary_self_identification: {
            enabled: false,
            default_action: "leave_blank",
            confirmed_at: "2026-08-20T12:00:00.000Z",
            answers: {
              disability: {
                value: "Saved private answer",
                confirmed_at: "2026-08-19T12:00:00.000Z",
              },
            },
          },
        },
      },
      publicSyncPreference: { enabled: true, source: "default", updatedAt: null },
    });

    renderController(module, api);
    await flushEffects();
    let view = renderController(module, api);
    settingsProps(view).onEditSection("application-defaults");

    view = renderController(module, api);
    expect(settingsProps(view).profileEditor).toMatchObject({
      id: "application-defaults",
      localOnly: true,
    });
    settingsProps(view).onEditorChange("policy", "decline_when_available");

    view = renderController(module, api);
    await settingsProps(view).onSaveEditor();

    expect(api.saveCandidateFile).toHaveBeenCalledWith(
      "form-defaults",
      {
        voluntary_self_identification: {
          enabled: true,
          default_action: "decline_when_available",
          confirmed_at: expect.any(String),
          answers: {
            disability: {
              value: "Saved private answer",
              confirmed_at: "2026-08-19T12:00:00.000Z",
            },
          },
        },
      },
      { expectedBaseRevision: "1:2026-08-28T12:00:00.000Z" }
    );
    const saved = api.saveCandidateFile.mock.calls[0][1].voluntary_self_identification;
    expect(Number.isNaN(Date.parse(saved.confirmed_at))).toBe(false);
    expect(navigate).toHaveBeenLastCalledWith("/settings", { replace: true });
  });
});

describe("ProfileSettingsController engine inventory", () => {
  it("passes settings only accepted runtimes and excludes diagnostic adapters", async () => {
    const module = await import("./ProfileSettingsController.jsx");
    const api = createApi();
    api.getInstalledAiRuntimes.mockResolvedValue({
      selectedId: "hermes",
      runtimes: [
        {
          id: "claude",
          name: "Claude Code",
          supported: true,
          available: true,
          ready: true,
          selectable: false,
          capabilityTier: "detected_unverified",
          capabilities: { completion: false },
        },
        {
          id: "codex",
          name: "Codex",
          supported: true,
          available: false,
          ready: false,
          selectable: false,
          capabilityTier: "unavailable",
          capabilities: { completion: false },
        },
        {
          id: "hermes",
          name: "Hermes Agent",
          supported: false,
          available: true,
          ready: true,
          selectable: true,
          capabilityTier: "task_tools",
          capabilities: { completion: true, taskTools: true, research: true },
        },
      ],
    });

    renderController(module, api);
    await flushEffects();
    const choices = settingsProps(renderController(module, api)).engine.choices;

    expect(choices.map((choice) => choice.id)).toEqual(["claude", "codex"]);
    expect(choices.find((choice) => choice.id === "claude")).toMatchObject({
      selectable: false,
      presentationState: "unavailable",
    });
    expect(choices.find((choice) => choice.id === "hermes")).toBeUndefined();
  });
});
