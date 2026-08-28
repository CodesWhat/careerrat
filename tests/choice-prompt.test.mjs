import assert from "node:assert/strict";
import test from "node:test";

test("creates a server-owned binary choice with stable message context", async () => {
  let choiceApi;
  try {
    choiceApi = await import("../src/core/agent/choice-prompt.mjs");
  } catch {
    choiceApi = null;
  }

  assert.equal(typeof choiceApi?.createBinaryChoicePrompt, "function");
  const prompt = choiceApi.createBinaryChoicePrompt({
    threadId: "workspace-main",
    messageId: "assistant-1",
    question: "Should I keep this company?",
  });

  assert.match(prompt.id, /^choice-[a-f0-9]{24}$/);
  assert.equal(prompt.version, 1);
  assert.equal(prompt.threadId, "workspace-main");
  assert.equal(prompt.messageId, "assistant-1");
  assert.equal(prompt.mode, "binary");
  assert.equal(prompt.allowText, true);
  assert.equal(prompt.state, "pending");
  assert.deepEqual(
    prompt.options.map((option) => [option.id, option.label, option.actionRef.type]),
    [
      ["yes", "Yes", "chat.reply"],
      ["no", "No", "chat.reply"],
    ]
  );
});

test("normalizes bounded multi-select options and attaches only server-owned actions", async () => {
  const { createChoicePrompt } = await import("../src/core/agent/choice-prompt.mjs");
  const prompt = createChoicePrompt(
    {
      threadId: "workspace-main",
      messageId: "assistant-roles",
      question: "Which role directions sound useful?",
      mode: "multi",
      minSelections: 1,
      maxSelections: 2,
      options: [
        { id: "event", label: "Event operations", aliases: ["events"] },
        { id: "venue", label: "Venue operations", aliases: ["venues"] },
        { id: "customer", label: "Customer operations", aliases: ["customer ops"] },
      ],
    },
    {
      actionRefs: {
        event: { type: "chat.reply", input: { text: "Event operations" } },
        venue: { type: "chat.reply", input: { text: "Venue operations" } },
        customer: { type: "chat.reply", input: { text: "Customer operations" } },
      },
    }
  );

  assert.equal(prompt.mode, "multi");
  assert.equal(prompt.maxSelections, 2);
  assert.deepEqual(
    prompt.options.map((option) => option.actionRef.input.text),
    ["Event operations", "Venue operations", "Customer operations"]
  );
});

test("rejects model-supplied actions and action types outside the server allowlist", async () => {
  const { createChoicePrompt } = await import("../src/core/agent/choice-prompt.mjs");
  const draft = {
    threadId: "workspace-main",
    messageId: "assistant-roles",
    question: "Which role direction?",
    mode: "single",
    options: [{ id: "event", label: "Event operations" }],
  };

  assert.throws(
    () =>
      createChoicePrompt({
        ...draft,
        options: [
          {
            id: "event",
            label: "Event operations",
            actionRef: { type: "settings.apply", input: { unexpected: true } },
          },
        ],
      }),
    (error) => error.code === "UNTRUSTED_CHOICE_ACTION"
  );
  assert.throws(
    () =>
      createChoicePrompt(draft, {
        actionRefs: {
          event: { type: "settings.apply", input: { unexpected: true } },
        },
      }),
    (error) => error.code === "UNSUPPORTED_CHOICE_ACTION"
  );
});

test("resolves typed and clicked choices to the same normalized selection", async () => {
  const { createBinaryChoicePrompt, resolveChoicePrompt } = await import(
    "../src/core/agent/choice-prompt.mjs"
  );
  const prompt = createBinaryChoicePrompt({
    threadId: "workspace-main",
    messageId: "assistant-1",
    question: "Should I keep this company?",
  });

  const typed = resolveChoicePrompt(prompt, { text: "Yep" }, { now: "2026-08-27T16:00:00Z" });
  const clicked = resolveChoicePrompt(
    prompt,
    {
      promptId: prompt.id,
      version: 1,
      optionIds: ["yes"],
    },
    { now: "2026-08-27T16:00:00Z" }
  );

  assert.deepEqual(typed.resolution.optionIds, ["yes"]);
  assert.deepEqual(clicked.resolution.optionIds, typed.resolution.optionIds);
  assert.deepEqual(clicked.resolution.actions, typed.resolution.actions);
  assert.equal(typed.prompt.state, "resolved");
  assert.equal(typed.prompt.resolvedAt, "2026-08-27T16:00:00.000Z");
});

test("resolves mission and mock control text and clicks to the same allowlisted server action", async () => {
  const { createChoicePrompt, resolveChoicePrompt } = await import(
    "../src/core/agent/choice-prompt.mjs"
  );
  const cases = [
    {
      actionType: "mission.pause",
      entity: { type: "mission", id: "mission-1" },
      label: "Pause",
      alias: "pause mission",
    },
    {
      actionType: "mission.resume",
      entity: { type: "mission", id: "mission-1" },
      label: "Resume",
      alias: "resume mission",
    },
    {
      actionType: "mock-interview.end",
      entity: { type: "mock-interview", id: "mock-1" },
      label: "End interview",
      alias: "end mock interview",
    },
  ];

  for (const item of cases) {
    let prompt;
    assert.doesNotThrow(() => {
      prompt = createChoicePrompt(
        {
          threadId: `${item.entity.type}:${item.entity.id}`,
          messageId: `control:${item.actionType}`,
          question: `${item.label}?`,
          mode: "single",
          options: [{ id: "confirm", label: item.label, aliases: [item.alias] }],
        },
        {
          actionRefs: {
            confirm: { type: item.actionType, entity: item.entity },
          },
        }
      );
    }, `${item.actionType} must be in the server choice allowlist`);
    const clicked = resolveChoicePrompt(prompt, {
      promptId: prompt.id,
      version: prompt.version,
      optionIds: ["confirm"],
    });
    const typed = resolveChoicePrompt(prompt, { text: item.alias });

    assert.deepEqual(clicked.resolution.actions, typed.resolution.actions);
    assert.deepEqual(clicked.resolution.actions, [{ type: item.actionType, entity: item.entity }]);
  }
});

test("typed multi-select keeps and inside an option label", async () => {
  const { createChoicePrompt, resolveChoicePrompt } = await import(
    "../src/core/agent/choice-prompt.mjs"
  );
  const prompt = createChoicePrompt(
    {
      threadId: "workspace-main",
      messageId: "assistant-adjacent",
      question: "Which directions?",
      mode: "multi",
      options: [
        { id: "event", label: "Event operations" },
        { id: "training", label: "Training and enablement" },
        { id: "guest", label: "Guest operations" },
      ],
    },
    {
      actionRefs: {
        event: { type: "chat.reply", input: { text: "Event operations" } },
        training: { type: "chat.reply", input: { text: "Training and enablement" } },
        guest: { type: "chat.reply", input: { text: "Guest operations" } },
      },
    }
  );

  const resolved = resolveChoicePrompt(prompt, {
    text: "Event operations and Training and enablement",
  });
  assert.deepEqual(resolved.resolution.optionIds, ["event", "training"]);
});

test("rejects unknown options, stale versions, and replayed resolutions", async () => {
  const { createBinaryChoicePrompt, resolveChoicePrompt } = await import(
    "../src/core/agent/choice-prompt.mjs"
  );
  const prompt = createBinaryChoicePrompt({
    threadId: "workspace-main",
    messageId: "assistant-1",
    question: "Should I keep this company?",
  });

  assert.throws(
    () => resolveChoicePrompt(prompt, { promptId: prompt.id, version: 2, optionIds: ["yes"] }),
    (error) => error.code === "STALE_CHOICE_PROMPT"
  );
  assert.throws(
    () => resolveChoicePrompt(prompt, { promptId: prompt.id, version: 1, optionIds: ["maybe"] }),
    (error) => error.code === "BAD_CHOICE_OPTION"
  );
  const resolved = resolveChoicePrompt(prompt, { text: "No" }).prompt;
  assert.throws(
    () => resolveChoicePrompt(resolved, { text: "No" }),
    (error) => error.code === "CHOICE_ALREADY_RESOLVED"
  );
});

test("explicit replies cannot resolve an older prompt after a newer choice is pending", async () => {
  const { createBinaryChoicePrompt, resolvePendingMessageChoice } = await import(
    "../src/core/agent/choice-prompt.mjs"
  );
  const first = createBinaryChoicePrompt({
    threadId: "workspace-main",
    messageId: "assistant-first",
    question: "Should I keep the first option?",
  });
  const latest = createBinaryChoicePrompt({
    threadId: "workspace-main",
    messageId: "assistant-latest",
    question: "Should I keep the latest option?",
  });
  const messages = [
    { id: "assistant-first", role: "assistant", metadata: { choicePrompt: first } },
    { id: "assistant-latest", role: "assistant", metadata: { choicePrompt: latest } },
  ];

  assert.throws(
    () =>
      resolvePendingMessageChoice(messages, {
        choice: { promptId: first.id, version: first.version, optionIds: ["yes"] },
      }),
    (error) => error.code === "STALE_CHOICE_PROMPT"
  );
  assert.deepEqual(
    resolvePendingMessageChoice(messages, {
      choice: { promptId: latest.id, version: latest.version, optionIds: ["yes"] },
    }).resolution.optionIds,
    ["yes"]
  );
});

test("typed and button replies cannot resolve a pending prompt after later assistant content", async () => {
  const { createBinaryChoicePrompt, resolvePendingMessageChoice } = await import(
    "../src/core/agent/choice-prompt.mjs"
  );
  const prompt = createBinaryChoicePrompt({
    threadId: "workspace-main",
    messageId: "assistant-choice",
    question: "Do you want to log into LinkedIn so I can use it?",
  });
  const messages = [
    { id: "assistant-choice", role: "assistant", metadata: { choicePrompt: prompt } },
    { id: "assistant-later", role: "assistant", text: "The job search finished." },
  ];

  assert.equal(resolvePendingMessageChoice(messages, { text: "Yes" }), null);
  assert.throws(
    () =>
      resolvePendingMessageChoice(messages, {
        choice: { promptId: prompt.id, version: prompt.version, optionIds: ["yes"] },
      }),
    (error) => error.code === "STALE_CHOICE_PROMPT"
  );
});
