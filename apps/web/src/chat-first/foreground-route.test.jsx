import { beforeEach, describe, expect, it, vi } from "vitest";

const hooks = vi.hoisted(() => ({ cursor: 0, slots: [], pending: [] }));
const router = vi.hoisted(() => ({ location: { pathname: "/", search: "" }, navigate: vi.fn() }));
const snapshot = vi.hoisted(() => ({
  loading: false,
  data: {
    jobs: {
      rows: [{ id: "app-1", company: "E Corp", role: "Staff Engineer", stageLabel: "Applied" }],
    },
    chatFirst: {
      jobThreads: [{ id: "job:app-1", applicationId: "app-1", company: "E Corp", messages: [] }],
    },
  },
}));

function changed(previous, next) {
  return (
    !previous ||
    !next ||
    previous.length !== next.length ||
    next.some((value, index) => !Object.is(value, previous[index]))
  );
}

// Like FirstRunController.test.jsx, drive the controller hooks without a DOM.
// Only pathname-dependent effects run here: unrelated API and stream effects
// belong to their controller tests.
vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal();
  const state = (initial) => {
    const index = hooks.cursor++;
    if (!(index in hooks.slots))
      hooks.slots[index] = typeof initial === "function" ? initial() : initial;
    return [
      hooks.slots[index],
      (next) => {
        hooks.slots[index] = typeof next === "function" ? next(hooks.slots[index]) : next;
      },
    ];
  };
  const memo = (factory, dependencies) => {
    const index = hooks.cursor++;
    if (changed(hooks.slots[index]?.dependencies, dependencies)) {
      hooks.slots[index] = { value: factory(), dependencies };
    }
    return hooks.slots[index].value;
  };
  return {
    ...actual,
    useState: state,
    useReducer(reducer, initial, initialize) {
      const [value, setValue] = state(() => (initialize ? initialize(initial) : initial));
      return [value, (action) => setValue((current) => reducer(current, action))];
    },
    useRef: (initial) => memo(() => ({ current: initial }), []),
    useMemo: memo,
    useCallback: (callback, dependencies) => memo(() => callback, dependencies),
    useEffect(effect, dependencies) {
      const index = hooks.cursor++;
      if (changed(hooks.slots[index], dependencies)) {
        hooks.slots[index] = dependencies;
        if (dependencies?.includes(router.location.pathname)) hooks.pending.push(effect);
      }
    },
  };
});
vi.mock("react-router-dom", () => ({
  useLocation: () => router.location,
  useNavigate: () => router.navigate,
}));
vi.mock("./dashboard-context.jsx", () => ({ useDashboardSnapshot: () => snapshot }));
vi.mock("../lib/sse.js", () => ({ useEventSource: () => {} }));

import { ChatFirstApp } from "./ChatFirstApp.jsx";
import { parseChatFirstForeground } from "./chat-first-model.js";

const api = {};
function render(homePath) {
  hooks.cursor = 0;
  return ChatFirstApp({ api, ...(homePath === undefined ? {} : { homePath }) }).props;
}
function flushRouteEffects() {
  for (const effect of hooks.pending.splice(0)) effect();
}
function lastDestination() {
  return router.navigate.mock.calls.at(-1)?.[0];
}

beforeEach(() => {
  hooks.cursor = 0;
  hooks.slots = [];
  hooks.pending = [];
  router.location = { pathname: "/", search: "" };
  router.navigate.mockReset();
});

describe.each(["/conversation", undefined])("foreground route %s", (homePath) => {
  const pathname = homePath || "/";
  it("keeps Pipeline and job selection on the mounted workspace route", async () => {
    router.location = { pathname, search: "" };
    let view = render(homePath);
    view.actions.openBrowser("pipeline");
    expect(lastDestination()).toMatchObject({ pathname });
    expect(parseChatFirstForeground(lastDestination().search).browse).toBe("pipeline");

    router.location = lastDestination();
    view = render(homePath);
    await view.actions.openJob("app-1");
    expect(lastDestination()).toMatchObject({ pathname });
    expect(parseChatFirstForeground(lastDestination().search)).toMatchObject({
      activeThread: "job:app-1",
      browse: false,
    });
  });

  it("hydrates query and foreground changes from browser history", () => {
    router.location = { pathname, search: "?browse=pipeline&q=engineer" };
    render(homePath);
    flushRouteEffects();
    expect(render(homePath)).toMatchObject({ query: "engineer", ui: { browse: "pipeline" } });

    router.location = { pathname, search: "?thread=job%3Aapp-1&q=staff" };
    render(homePath);
    flushRouteEffects();
    expect(render(homePath)).toMatchObject({
      query: "staff",
      ui: { activeThread: "job:app-1", browse: false },
    });
  });

  it("writes foreground UI changes back to the mounted route", () => {
    router.location = { pathname, search: "?browse=pipeline" };
    render(homePath);
    flushRouteEffects();
    const view = render(homePath);
    flushRouteEffects();
    router.navigate.mockClear();

    view.actions.changePipelineView("list");
    render(homePath);
    flushRouteEffects();
    expect(lastDestination()).toMatchObject({ pathname });
    expect(parseChatFirstForeground(lastDestination().search).pipeView).toBe("list");
  });

  it("reconciles a missing job and canonicalizes its query on the mounted route", () => {
    router.location = { pathname, search: "?thread=job%3Amissing&q=staff" };
    render(homePath);
    flushRouteEffects();
    expect(render(homePath).ui.activeThread).toBe("today");
    expect(lastDestination()).toMatchObject({ pathname });
    expect(parseChatFirstForeground(lastDestination().search)).toMatchObject({
      activeThread: "today",
      query: "staff",
    });
  });

  it("canonicalizes an unavailable saved review on the mounted route", () => {
    router.location = { pathname, search: "?review=company:missing" };
    render(homePath);
    flushRouteEffects();
    expect(
      router.navigate.mock.calls.some(
        ([destination, options]) =>
          destination.pathname === pathname &&
          parseChatFirstForeground(destination.search).reviewKind === null &&
          options.replace === true
      )
    ).toBe(true);
  });
});
