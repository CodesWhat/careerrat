import { beforeEach, describe, expect, it, vi } from "vitest";

const harness = vi.hoisted(() => ({ frames: new Map(), frame: null, cursor: 0, pending: [] }));
const snapshot = vi.hoisted(() => ({ data: null, workspace: null, refetch: vi.fn() }));
const router = vi.hoisted(() => ({ params: new URLSearchParams(), setParams: vi.fn() }));
const api = vi.hoisted(() => ({ loadArtifact: vi.fn() }));
function changed(old, next) {
  return !old || !next || next.some((value, index) => !Object.is(value, old[index]));
}
vi.mock("react", async (original) => {
  const actual = await original();
  function state(initial) {
    const frame = harness.frame;
    const index = harness.cursor++;
    if (!(index in frame.slots))
      frame.slots[index] = typeof initial === "function" ? initial() : initial;
    return [
      frame.slots[index],
      (value) => {
        frame.slots[index] = typeof value === "function" ? value(frame.slots[index]) : value;
      },
    ];
  }
  function memo(factory, deps) {
    const index = harness.cursor++;
    if (changed(harness.frame.slots[index]?.deps, deps))
      harness.frame.slots[index] = { value: factory(), deps };
    return harness.frame.slots[index].value;
  }
  return {
    ...actual,
    useState: state,
    useMemo: memo,
    useCallback: (callback, deps) => memo(() => callback, deps),
    useRef: (initial) => memo(() => ({ current: initial }), []),
    useEffect(effect, deps) {
      const frame = harness.frame;
      const index = harness.cursor++;
      if (changed(frame.slots[index]?.deps, deps)) {
        harness.pending.push(() => {
          frame.slots[index]?.cleanup?.();
          frame.slots[index] = { deps, cleanup: effect() };
        });
      }
    },
  };
});
vi.mock("react-router-dom", async (original) => ({
  ...(await original()),
  useSearchParams: () => [router.params, router.setParams],
}));
vi.mock("../chat-first/dashboard-context.jsx", () => ({ useDashboardSnapshot: () => snapshot }));
vi.mock("../chat-first/chat-first-model.js", () => ({ buildChatFirstView: (data) => data }));
vi.mock("../chat-first/chat-first-app-controller.js", () => ({
  loadChatFirstArtifact: api.loadArtifact,
}));

import { DashboardApp } from "./DashboardApp.jsx";

let childKey;
function invoke(key, component, props) {
  if (!harness.frames.has(key)) harness.frames.set(key, { slots: [] });
  harness.frame = harness.frames.get(key);
  harness.cursor = 0;
  return component(props);
}
function render() {
  const element = invoke("root", DashboardApp, {});
  if (typeof element.type !== "function" || element.type.name === "DashboardView")
    return element.props;
  const key = `workspace:${element.key}`;
  if (childKey && key !== childKey) {
    for (const slot of harness.frames.get(childKey).slots) slot?.cleanup?.();
    harness.frames.delete(childKey);
  }
  childKey = key;
  return invoke(key, element.type, element.props).props;
}
function effects() {
  for (const effect of harness.pending.splice(0)) effect();
}
function workspace(id, current = "alice") {
  return {
    id,
    current,
    startCommand: `CAREERRAT_PEOPLE_BASE='${id}' careerrat --for ${current} start codex`,
  };
}
beforeEach(() => {
  harness.frames.clear();
  harness.pending = [];
  childKey = undefined;
  api.loadArtifact.mockReset();
  router.params = new URLSearchParams("application=app-a");
  router.setParams.mockReset().mockImplementation((value) => {
    router.params = new URLSearchParams(value);
  });
  snapshot.workspace = workspace("/root-a/people/alice");
  snapshot.data = { candidateName: "A", browser: { pipeline: { jobs: [] } } };
  vi.stubGlobal("navigator", {
    clipboard: { writeText: vi.fn().mockRejectedValue(new Error("unavailable")) },
  });
});
describe("dashboard workspace replacement", () => {
  it.each([workspace("/root-b/people/bob", "bob"), workspace("/root-b/people/alice")])(
    "replaces rows, command, selection and transient state when identity becomes $id",
    async (nextWorkspace) => {
      let view = render();
      effects();
      expect(view.applicationId).toBe("app-a");
      await view.actions.copy("old workspace prompt");
      api.loadArtifact.mockResolvedValueOnce({ text: "A document" });
      await view.actions.openFile({ name: "A résumé", applicationId: "app-a" });
      view = render();
      expect(view.artifact).not.toBeNull();
      expect(view.copiedPrompt).toBe("old workspace prompt");
      snapshot.workspace = nextWorkspace;
      snapshot.data = { candidateName: "B", browser: { pipeline: { jobs: [] } } };
      view = render();
      expect(view.view.candidateName).toBe("B");
      expect(view.startCommand).toBe(nextWorkspace.startCommand);
      expect(view.person).toBe(nextWorkspace.current);
      expect(view.artifact).toBeNull();
      expect(view.copiedPrompt).toBe("");
      expect(view.notice).toBe("");
      expect(view.applicationId).toBeUndefined();
      effects();
      expect(router.params.get("application")).toBeNull();
    }
  );

  it("discards a document response from the previous workspace", async () => {
    let finish;
    api.loadArtifact.mockReturnValueOnce(
      new Promise((resolve) => {
        finish = resolve;
      })
    );
    let view = render();
    effects();
    const pending = view.actions.openFile({ name: "A résumé", applicationId: "app-a" });
    snapshot.workspace = workspace("/root-b/people/alice");
    snapshot.data = { candidateName: "B", browser: { pipeline: { jobs: [] } } };
    view = render();
    effects();
    finish({ text: "A document" });
    await pending;
    view = render();
    expect(view.artifact).toBeNull();
    expect(view.notice).toBe("");
  });
});
