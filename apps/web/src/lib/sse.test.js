import { beforeEach, expect, it, vi } from "vitest";

const effects = vi.hoisted(() => []);

vi.mock("react", () => ({
  useEffect(effect) {
    effects.push(effect);
  },
  useRef(value) {
    return { current: value };
  },
}));

class FakeEventSource {
  static instances = [];

  constructor(url) {
    this.url = url;
    this.listeners = new Map();
    FakeEventSource.instances.push(this);
  }

  addEventListener(type, listener) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type).add(listener);
  }

  removeEventListener(type, listener) {
    this.listeners.get(type)?.delete(listener);
  }

  close() {}

  emit(type, data, lastEventId) {
    for (const listener of this.listeners.get(type) || []) {
      listener({ type, data, lastEventId });
    }
  }
}

beforeEach(() => {
  effects.length = 0;
  FakeEventSource.instances.length = 0;
  vi.stubGlobal("EventSource", FakeEventSource);
});

it("passes the stable SSE event id to consumers", async () => {
  const { useEventSource } = await import("./sse.js");
  const onEvent = vi.fn();

  useEventSource("/api/chat/events?id=chat-1", {
    types: ["assistant"],
    onEvent,
  });
  effects.shift()();
  FakeEventSource.instances[0].emit("assistant", '{"message":{}}', "6");

  expect(onEvent).toHaveBeenCalledWith("assistant", '{"message":{}}', {
    lastEventId: "6",
  });
});
