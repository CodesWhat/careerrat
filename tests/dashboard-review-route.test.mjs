import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { test } from "node:test";
import { mountWorkspaceAgentRoutes } from "../src/cli/workspace-agent-route.mjs";

function fixture() {
  const routes = new Map();
  const calls = [];
  mountWorkspaceAgentRoutes({
    repoRoot: "/synthetic-workspace",
    env: { CAREERRAT_PERSON: "alex" },
    addRoute: (method, path, handler) => routes.set(`${method} ${path}`, handler),
    revertKnowledgeImpl: async (input) => {
      calls.push(input);
      return { messages: [{ text: "Undid the saved change." }] };
    },
  });
  async function request(body) {
    const handler = routes.get("POST /api/workspace/knowledge/revert");
    assert.equal(typeof handler, "function", "dashboard undo has a deterministic route");
    const req = Readable.from([Buffer.from(JSON.stringify(body))]);
    req.headers = { "content-type": "application/json" };
    let status;
    let response;
    await handler(req, {
      writeHead(code) {
        status = code;
      },
      end(text) {
        response = JSON.parse(text);
      },
    });
    return { status, response };
  }
  return { calls, request };
}

test("dashboard undo needs no AI route or operation manager", async () => {
  const { calls, request } = fixture();
  const result = await request({ messageId: "saved-message", index: 2 });
  assert.equal(result.status, 200);
  assert.equal(result.response.data.messages[0].text, "Undid the saved change.");
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].intent, {
    type: "knowledge.revert",
    entity: { type: "workspace", id: "workspace-main" },
    input: { messageId: "saved-message", index: 2 },
  });
  assert.equal(calls[0].env.CAREERRAT_PERSON, "alex");
});

test("dashboard undo refuses caller-supplied write contents and invalid references", async () => {
  const { calls, request } = fixture();
  for (const body of [
    { messageId: "saved-message", index: 0, before: "invented" },
    { messageId: "saved-message", index: -1 },
    { messageId: "saved-message", index: "0" },
    { messageId: "", index: 0 },
  ]) {
    assert.equal((await request(body)).status, 400);
  }
  assert.equal(calls.length, 0);
});
