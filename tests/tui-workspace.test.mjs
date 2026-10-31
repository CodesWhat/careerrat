import assert from "node:assert/strict";
import { test } from "node:test";
import headless from "@xterm/headless";

const api = await import("../src/core/tui/workspace.mjs").catch((error) => {
  if (error.code !== "ERR_MODULE_NOT_FOUND") throw error;
  return {};
});
const invoke = (name, ...args) => {
  assert.equal(typeof api[name], "function", `missing workspace behavior: ${name}`);
  return api[name](...args);
};
const data = {
  jobs: [
    {
      id: "northstar",
      kind: "application",
      stage: { id: "interview", order: 3 },
      record: {
        id: "northstar",
        company: "Northstar",
        role: "Staff Engineer",
        status: "interview",
        statusNote: "Interview booked",
        nextAction: "Prepare system design",
        evaluation: {
          gate: "keep",
          fitScore: 90,
          compensation: {
            currency: "USD",
            basis: "base",
            source: "job-description",
            minBase: 176000,
            maxBase: 204000,
          },
        },
        artifacts: { jd: "workspace/jobs/northstar.md" },
      },
    },
    {
      id: "atlas",
      kind: "sourced",
      stage: { id: "sourced", order: 0 },
      record: { id: "atlas", company: "Atlas", role: "Engineer", status: "sourced" },
    },
  ],
};

test("jobs remain visible beside native terminal output at wide and narrow sizes", async () => {
  for (const [cols, rows] of [
    [120, 36],
    [80, 30],
  ]) {
    const state = invoke("createWorkspaceState", data);
    const frame = invoke(
      "renderWorkspace",
      data,
      state,
      { cols, rows },
      { lines: ["NATIVE AGENT READY"], cursor: { x: 0, y: 1, visible: true } }
    );
    const terminal = new headless.Terminal({ cols, rows, allowProposedApi: true });
    try {
      await new Promise((resolve) => terminal.write(frame.output, resolve));
      const content = Array.from({ length: rows }, (_, index) =>
        terminal.buffer.active.getLine(index)?.translateToString(true)
      ).join("\n");
      assert.match(content, /Northstar/);
      assert.match(content, /NATIVE AGENT READY/);
      assert.match(content, /Staff Engineer/);
      assert.ok(frame.layout.agent.cols >= 35);
      assert.ok(frame.layout.agent.rows >= 5);
      assert.equal(terminal.buffer.active.baseY, 0, "drawing must not scroll away the jobs");
    } finally {
      terminal.dispose();
    }
  }
});

test("job focus owns navigation/filter/order while agent focus forwards typing", () => {
  let state = invoke("createWorkspaceState", data);
  state = invoke("workspaceKey", data, state, { name: "down" }).state;
  assert.equal(state.selectedId, "atlas");
  state = invoke("workspaceKey", data, state, { name: "f" }).state;
  assert.equal(state.stage, "sourced");
  state = invoke("workspaceKey", data, state, { name: "s" }).state;
  assert.equal(state.order, "asc");
  state = invoke("workspaceKey", data, state, { name: "f6" }).state;
  assert.equal(state.focus, "agent");
  const forwarded = invoke("workspaceKey", data, state, { name: "q", sequence: "q" });
  assert.deepEqual(forwarded.effect, { type: "agent-input", data: "q" });
  assert.equal(invoke("workspaceKey", data, state, { name: "q", ctrl: true }).effect.type, "quit");
});

test("refresh retains visible selection by ID and command requests pin the chosen job", () => {
  const state = { ...invoke("createWorkspaceState", data), selectedId: "atlas" };
  const refreshed = invoke("refreshWorkspace", { jobs: [...data.jobs].reverse() }, state);
  assert.equal(refreshed.selectedId, "atlas");
  const action = invoke("workspaceKey", data, refreshed, { name: "3", sequence: "3" });
  assert.equal(action.effect.type, "agent-request");
  assert.match(action.effect.text, /atlas/);
  assert.match(action.effect.text, /apply-job/);
  assert.doesNotMatch(action.effect.text, /northstar/);
});

test("saved job labels cannot inject terminal commands into the frame", async () => {
  const hostile = structuredClone(data);
  hostile.jobs[0].record.company = "Northstar\x1b[2J\x1b]0;bad-title\x07";
  const frame = invoke(
    "renderWorkspace",
    hostile,
    invoke("createWorkspaceState", hostile),
    { cols: 120, rows: 36 },
    null
  );
  assert.doesNotMatch(frame.output, /bad-title/);
  assert.match(frame.output, /Northstar/);
  assert.equal(frame.output.includes("\x1b[2J"), false);
});

async function screen(data, state, rows) {
  const terminal = new headless.Terminal({ cols: 80, rows, allowProposedApi: true });
  try {
    const frame = invoke(
      "renderWorkspace",
      data,
      state,
      { cols: 80, rows },
      {
        lines: ["NATIVE AGENT READY"],
        cursor: { x: 0, y: 0, visible: true },
      }
    );
    await new Promise((resolve) => terminal.write(frame.output, resolve));
    assert.equal(terminal.buffer.active.baseY, 0);
    return Array.from({ length: rows }, (_, index) =>
      terminal.buffer.active.getLine(index)?.translateToString(true)
    ).join("\n");
  } finally {
    terminal.dispose();
  }
}

test("compact inspector scrolls every detail while retaining selection and native agent", async () => {
  for (const rows of [24, 30]) {
    let state = invoke("createWorkspaceState", data);
    const seen = [];
    for (let step = 0; step < 20; step++) {
      const content = await screen(data, state, rows);
      assert.match(content, /> Northstar \/ Staff Engineer/);
      assert.match(content, /NATIVE AGENT READY/);
      assert.match(content, /PgUp\/PgDn/);
      seen.push(content);
      state = invoke("workspaceKey", data, state, { name: "pagedown", sequence: "\x1b[6~" }).state;
    }
    const all = seen.join("\n");
    for (const detail of [
      "Status: interview",
      "Fit: keep / 90",
      "Pay: USD 176K–204K / base",
      "Source: job-description",
      "JD: workspace/jobs/northstar.md",
      "Interview booked",
      "Next: Prepare system design",
    ])
      assert.ok(all.includes(detail), `missing inspector detail at 80x${rows}: ${detail}`);
    const bottom = state.detailOffset;
    assert.ok(bottom > 0);
    state = invoke("workspaceKey", data, state, { name: "pagedown" }).state;
    assert.equal(state.detailOffset, bottom, "scroll clamps at the last detail");
    assert.match(await screen(data, state, rows), /Next: Prepare system design/);
    for (let step = 0; step < 20; step++) {
      state = invoke("workspaceKey", data, state, { name: "pageup" }).state;
    }
    assert.equal(state.detailOffset, 0, "scroll clamps at the first detail");
    assert.match(await screen(data, state, rows), /Status: interview/);
  }
});

test("inspector scrolling resets on changed selection and forwards in agent focus", () => {
  let state = invoke("createWorkspaceState", data);
  state = invoke("workspaceKey", data, state, { name: "pagedown" }).state;
  assert.ok(state.detailOffset > 0);
  const changed = invoke("workspaceKey", data, state, { name: "down" }).state;
  assert.equal(changed.selectedId, "atlas");
  assert.equal(changed.detailOffset, 0);
  const refreshed = invoke("refreshWorkspace", { jobs: [data.jobs[1]] }, state);
  assert.equal(refreshed.selectedId, "atlas");
  assert.equal(refreshed.detailOffset, 0);
  state = invoke("workspaceKey", data, state, { name: "f6" }).state;
  for (const [name, sequence] of [
    ["pageup", "\x1b[5~"],
    ["pagedown", "\x1b[6~"],
  ]) {
    const forwarded = invoke("workspaceKey", data, state, { name, sequence });
    assert.deepEqual(forwarded.effect, { type: "agent-input", data: sequence });
    assert.equal(forwarded.state.detailOffset, state.detailOffset);
  }
});
