import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { createConfiguredApplyExecutor } from "../src/core/apply/apply-executor-factory.mjs";
import {
  createOrcaApplyExecutor,
  renderedFieldsFromSnapshot,
  uploadTargetsFromSnapshot,
} from "../src/core/apply/orca-executor.mjs";
import { createOrcaOps } from "../src/core/apply/orca-ops.mjs";
import { buildMinimalPdf } from "./fixtures/pdf.mjs";

const allowApply = () => ({ allowed: true, reasons: [] });

const FORM_SNAPSHOT = {
  origin: "https://careers.example.test/jobs/staff-ai/apply",
  refs: {
    e1: { name: "First Name", role: "textbox" },
    e2: { name: "Why Example?", role: "textbox" },
    e3: { name: "Work authorization", role: "combobox" },
    e4: { name: "Gender", role: "combobox" },
    e5: { name: "Submit application", role: "button" },
    e6: { name: "Choose one", role: "option" },
    e7: { name: "Yes, authorized to work", role: "option" },
    e8: { name: "No, I need sponsorship", role: "option" },
  },
  snapshot: [
    '- textbox "First Name" [required, ref=e1]',
    '- textbox "Why Example?" [required, ref=e2]',
    '- combobox "Work authorization" [expanded=false, required, ref=e3]',
    '  - option "Choose one" [selected, ref=e6]',
    '  - option "Yes, authorized to work" [ref=e7]',
    '  - option "No, I need sponsorship" [ref=e8]',
    '- combobox "Gender" [expanded=false, ref=e4]',
    '- button "Submit application" [ref=e5]',
  ].join("\n"),
  browserPageId: "page-123",
};

test("Orca focusTab switches to the retained supervised page", async () => {
  const commands = [];
  const ops = createOrcaOps({
    runOrcaImpl: async (args) => {
      commands.push(args);
      return {};
    },
  });

  await ops.focusTab({ pageId: "page-123" });

  assert.deepEqual(commands, [["tab", "switch", "--page", "page-123", "--json"]]);
});

test("Orca ops forward cancellation to child work and reject after an in-flight abort", async () => {
  const controller = new AbortController();
  const cancellation = new Error("application preparation cancelled");
  const calls = [];
  const ops = createOrcaOps({
    runOrcaImpl: async (args, options) => {
      calls.push({ args, signal: options?.signal });
      controller.abort(cancellation);
      return {};
    },
  });

  await assert.rejects(
    () => ops.clickButton({ pageId: "page-123", ref: "e1", signal: controller.signal }),
    (error) => error === cancellation
  );
  assert.deepEqual(calls, [
    {
      args: ["click", "--page", "page-123", "--element", "@e1", "--json"],
      signal: controller.signal,
    },
  ]);
});

test("Orca selectDeclineOption chooses only one narrowly recognized option", async () => {
  const commands = [];
  let snapshotIndex = 0;
  const snapshots = [
    {
      origin: "https://example.test/apply",
      refs: { e1: { name: "Gender", role: "combobox" } },
      snapshot: '- combobox "Gender" [expanded=false, ref=e1]',
    },
    {
      origin: "https://example.test/apply",
      refs: {
        e1: { name: "Gender", role: "combobox" },
        e2: { name: "Woman", role: "option" },
        e3: { name: "Prefer not to answer", role: "option" },
      },
      snapshot: [
        '- combobox "Gender" [expanded=true, ref=e1]',
        '  - option "Woman" [ref=e2]',
        '  - option "Prefer not to answer" [ref=e3]',
      ].join("\n"),
    },
    {
      origin: "https://example.test/apply",
      refs: { e1: { name: "Gender", role: "combobox" } },
      snapshot: '- combobox "Gender" [expanded=false, ref=e1]: Prefer not to answer',
    },
  ];
  const ops = createOrcaOps({
    runOrcaImpl: async (args) => {
      commands.push(args);
      if (args[0] === "snapshot") {
        return snapshots[Math.min(snapshotIndex++, snapshots.length - 1)];
      }
      if (args[0] === "eval") return { result: "[]" };
      return {};
    },
  });

  const result = await ops.selectDeclineOption({
    pageId: "page-123",
    ref: "e1",
    label: "Gender",
  });

  assert.equal(result.selectedValue, "Prefer not to answer");
  assert.equal(
    commands.some((args) => args[0] === "click" && args.includes("@e3")),
    true
  );
});

test("Orca selectDeclineOption waits for an asynchronously rendered Greenhouse decline option", async () => {
  const commands = [];
  const label = "Disability Status";
  let menuOpen = false;
  let waited = false;
  let selected = false;
  const ops = createOrcaOps({
    runOrcaImpl: async (args) => {
      commands.push(args);
      if (args[0] === "click") {
        if (args.includes("@e1")) menuOpen = true;
        if (args.includes("@e3")) selected = true;
        return {};
      }
      if (args[0] === "wait") {
        waited = true;
        return {};
      }
      if (args[0] === "snapshot") {
        if (selected) {
          return {
            origin: "https://job-boards.greenhouse.io/example/jobs/123",
            refs: { e4: { name: label, role: "combobox" } },
            snapshot: `- combobox "${label}" [expanded=false, ref=e4]: I do not want to answer`,
          };
        }
        return {
          origin: "https://job-boards.greenhouse.io/example/jobs/123",
          refs: {
            e1: { name: label, role: "combobox" },
            ...(menuOpen && waited
              ? { e3: { name: "I do not want to answer", role: "option" } }
              : {}),
          },
          snapshot: [
            `- combobox "${label}" [expanded=${menuOpen}, ref=e1]`,
            ...(menuOpen && waited ? ['  - option "I do not want to answer" [ref=e3]'] : []),
          ].join("\n"),
        };
      }
      if (args[0] === "eval") return { result: "false" };
      return {};
    },
  });

  const result = await ops.selectDeclineOption({
    pageId: "page-greenhouse",
    ref: "e1",
    label,
  });

  assert.deepEqual(result, { selectedValue: "I do not want to answer" });
  assert.equal(
    commands.some((args) => args[0] === "wait"),
    true
  );
});

test("Orca selectDeclineOption reacquires a committed Greenhouse field after refs shift", async () => {
  const label = "Race";
  let selected = false;
  const ops = createOrcaOps({
    runOrcaImpl: async (args) => {
      if (args[0] === "click") {
        if (args.includes("@e3")) selected = true;
        return {};
      }
      if (args[0] === "snapshot") {
        if (selected) {
          return {
            origin: "https://job-boards.greenhouse.io/example/jobs/123",
            refs: {
              e1: { name: "Remove I don't wish to answer", role: "button" },
              e4: { name: label, role: "combobox" },
            },
            snapshot: [
              '- button "Remove I don\'t wish to answer" [ref=e1]',
              `- combobox "${label}" [expanded=false, required, ref=e4]: I don't wish to answer`,
            ].join("\n"),
          };
        }
        return {
          origin: "https://job-boards.greenhouse.io/example/jobs/123",
          refs: {
            e1: { name: label, role: "combobox" },
            e3: { name: "I don't wish to answer", role: "option" },
          },
          snapshot: [
            `- combobox "${label}" [expanded=true, required, ref=e1]`,
            '  - option "I don\'t wish to answer" [ref=e3]',
          ].join("\n"),
        };
      }
      if (args[0] === "eval") return { result: "false" };
      return {};
    },
  });

  const result = await ops.selectDeclineOption({
    pageId: "page-greenhouse",
    ref: "e1",
    label,
  });

  assert.deepEqual(result, { selectedValue: "I don't wish to answer" });
});

test("Orca selectDeclineOption uses pointer events when a Greenhouse multi-select ignores CLI click", async () => {
  const commands = [];
  const label = "What gender identity do you most closely identify with?";
  let selected = false;
  const ops = createOrcaOps({
    runOrcaImpl: async (args) => {
      commands.push(args);
      if (args[0] === "snapshot") {
        if (selected) {
          return {
            origin: "https://job-boards.greenhouse.io/example/jobs/123",
            refs: { e4: { name: label, role: "combobox" } },
            snapshot: `- combobox "${label}" [expanded=false, required, ref=e4]: I don't wish to answer`,
          };
        }
        return {
          origin: "https://job-boards.greenhouse.io/example/jobs/123",
          refs: {
            e1: { name: label, role: "combobox" },
            e3: { name: "I don't wish to answer", role: "option" },
          },
          snapshot: [
            `- combobox "${label}" [expanded=true, required, ref=e1]`,
            '  - option "I don\'t wish to answer" [ref=e3]',
          ].join("\n"),
        };
      }
      if (args[0] === "eval") {
        const expression = args[args.indexOf("--expression") + 1];
        if (expression.includes("[role='option']")) {
          selected = true;
          return { result: "true" };
        }
        return { result: "false" };
      }
      return {};
    },
  });

  const result = await ops.selectDeclineOption({
    pageId: "page-greenhouse",
    ref: "e1",
    label,
  });

  assert.deepEqual(result, { selectedValue: "I don't wish to answer" });
  assert.equal(
    commands.some((args) => args[0] === "click" && args.includes("@e3")),
    false,
    "the Greenhouse option commits through the pointer-event fallback"
  );
});

test("Orca typeahead selectOption uses pointer events when a Greenhouse multi-select ignores CLI click", async () => {
  const commands = [];
  const label = "Race";
  const value = "Two or more races";
  let selected = false;
  const ops = createOrcaOps({
    runOrcaImpl: async (args) => {
      commands.push(args);
      if (args[0] === "snapshot") {
        if (selected) {
          return {
            origin: "https://job-boards.greenhouse.io/example/jobs/123",
            refs: { e4: { name: label, role: "combobox" } },
            snapshot: `- combobox "${label}" [expanded=false, required, ref=e4]: ${value}`,
          };
        }
        return {
          origin: "https://job-boards.greenhouse.io/example/jobs/123",
          refs: {
            e1: { name: label, role: "combobox" },
            e3: { name: value, role: "option" },
          },
          snapshot: [
            `- combobox "${label}" [expanded=true, required, ref=e1]`,
            `  - option "${value}" [ref=e3]`,
          ].join("\n"),
        };
      }
      if (args[0] === "eval") {
        const expression = args[args.indexOf("--expression") + 1];
        if (expression.includes("[role='option']")) {
          selected = true;
          return { result: "true" };
        }
        return { result: "false" };
      }
      return {};
    },
  });

  const result = await ops.selectOption({
    pageId: "page-greenhouse",
    ref: "e1",
    label,
    value,
    typeahead: true,
  });

  assert.deepEqual(result, { selectedValue: value });
  assert.equal(
    commands.some((args) => args[0] === "click" && args.includes("@e3")),
    false,
    "the confirmed exact option commits through the pointer-event fallback"
  );
});

test("Orca snapshot marks one Next control safe only from structured form progress", async () => {
  const commands = [];
  const ops = createOrcaOps({
    runOrcaImpl: async (args) => {
      commands.push(args);
      if (args[0] === "snapshot") {
        return {
          origin: "https://example.test/apply",
          refs: { e1: { name: "Next", role: "button" } },
          snapshot: '- button "Next" [ref=e1]',
        };
      }
      if (args[0] === "eval") return { result: JSON.stringify(["Next"]) };
      return {};
    },
  });

  const snapshot = await ops.snapshot({ pageId: "page-123" });

  assert.equal(snapshot.refs.e1.advanceSafe, true);
  assert.equal(
    commands.some((args) => args[0] === "eval"),
    true
  );
});

test("Orca snapshot does not assign label-based progress proof to duplicate Next controls", async () => {
  const ops = createOrcaOps({
    runOrcaImpl: async (args) => {
      if (args[0] === "snapshot") {
        return {
          origin: "https://example.test/apply",
          refs: {
            e1: { name: "Next", role: "button" },
            e2: { name: "Next", role: "button" },
          },
          snapshot: ['- button "Next" [ref=e1]', '- button "Next" [ref=e2]'].join("\n"),
        };
      }
      if (args[0] === "eval") return { result: JSON.stringify(["Next", "Next"]) };
      return {};
    },
  });

  const snapshot = await ops.snapshot({ pageId: "page-123" });

  assert.equal(snapshot.refs.e1.advanceSafe, undefined);
  assert.equal(snapshot.refs.e2.advanceSafe, undefined);
});

test("Orca snapshot binds progress proof only to an exact advance label", async () => {
  const ops = createOrcaOps({
    runOrcaImpl: async (args) => {
      if (args[0] === "snapshot") {
        return {
          origin: "https://example.test/apply",
          refs: {
            e1: { name: "Continue browsing jobs", role: "button" },
            e2: { name: "Next", role: "button" },
          },
          snapshot: ['- button "Continue browsing jobs" [ref=e1]', '- button "Next" [ref=e2]'].join(
            "\n"
          ),
        };
      }
      if (args[0] === "eval") {
        return { result: JSON.stringify(["Continue browsing jobs", "Next"]) };
      }
      return {};
    },
  });

  const snapshot = await ops.snapshot({ pageId: "page-123" });

  assert.equal(snapshot.refs.e1.advanceSafe, undefined);
  assert.equal(snapshot.refs.e2.advanceSafe, true);
});

test("Orca snapshot probes a named Greenhouse react-select instead of treating its blank state as unknowable", async () => {
  const commands = [];
  const label = "Are you currently eligible to work in your country of residence?";
  const ops = createOrcaOps({
    runOrcaImpl: async (args) => {
      commands.push(args);
      if (args[0] === "snapshot") {
        return {
          origin: "https://job-boards.greenhouse.io/example/jobs/123",
          refs: { e39: { name: label, role: "combobox" } },
          snapshot: [
            "- LabelText",
            `  - StaticText "${label}"`,
            "- generic",
            '  - StaticText "Select..."',
            `  - combobox "${label}" [expanded=false, required, ref=e39]`,
          ].join("\n"),
        };
      }
      if (args[0] === "eval") {
        return {
          result: JSON.stringify([{ label, stateKnown: true, value: "", typeahead: true }]),
        };
      }
      return {};
    },
  });

  const snapshot = await ops.snapshot({ pageId: "page-greenhouse" });

  assert.deepEqual(snapshot.refs.e39, {
    role: "combobox",
    name: label,
    required: true,
    stateKnown: true,
    value: "",
    typeahead: true,
  });
  assert.equal(
    commands.some((args) => args[0] === "eval"),
    true,
    "the DOM probe must run even when the combobox accessible name is the real field label"
  );
});

test("Orca snapshot does not treat typed react-select search text as a committed selection", async () => {
  const label = "Are you currently eligible to work in your country of residence?";
  const displayScope = { querySelectorAll: () => [] };
  const input = {
    tagName: "INPUT",
    value: "Yes",
    required: true,
    parentElement: displayScope,
    closest: () => displayScope,
    getAttribute: (name) => ({ role: "combobox", "aria-required": "true" })[name] ?? null,
  };
  const root = { querySelectorAll: () => [input] };
  const labelNode = {
    innerText: label,
    className: "required-field-label",
    parentElement: root,
    closest: () => root,
  };
  const document = { querySelectorAll: () => [labelNode] };
  const ops = createOrcaOps({
    runOrcaImpl: async (args) => {
      if (args[0] === "snapshot") {
        return {
          origin: "https://job-boards.greenhouse.io/example/jobs/123",
          refs: { e39: { name: label, role: "combobox" } },
          snapshot: [
            "- LabelText",
            `  - StaticText "${label}"`,
            "- generic",
            '  - StaticText "Yes"',
            `  - combobox "${label}" [expanded=true, required, ref=e39]: Yes`,
          ].join("\n"),
        };
      }
      if (args[0] === "eval") {
        const expression = args[args.indexOf("--expression") + 1];
        return { result: Function("document", `return ${expression}`)(document) };
      }
      return {};
    },
  });

  const snapshot = await ops.snapshot({ pageId: "page-greenhouse" });

  assert.equal(snapshot.refs.e39.typeahead, true);
  assert.equal(snapshot.refs.e39.stateKnown, undefined);
  assert.equal(snapshot.refs.e39.value, undefined);
});

test("Orca select verification reads the acted-on ref when labels are duplicated", async () => {
  const commands = [];
  const ops = createOrcaOps({
    runOrcaImpl: async (args) => {
      commands.push(args);
      if (args[0] === "snapshot") {
        return {
          origin: "https://example.test/apply",
          refs: {
            e1: { name: "State", role: "combobox" },
            e2: { name: "State", role: "combobox" },
          },
          snapshot: [
            '- combobox "State" [ref=e1]: California',
            '- combobox "State" [ref=e2]: New York',
          ].join("\n"),
        };
      }
      return {};
    },
  });

  await ops.selectOption({
    pageId: "page-123",
    ref: "e2",
    label: "State",
    value: "New York",
  });

  assert.deepEqual(commands[0], [
    "select",
    "--page",
    "page-123",
    "--element",
    "@e2",
    "--value",
    "New York",
    "--json",
  ]);
});

test("Orca native selects retry candidate-configured aliases", async () => {
  const commands = [];
  let selected = "";
  const ops = createOrcaOps({
    runOrcaImpl: async (args) => {
      commands.push(args);
      if (args[0] === "select") {
        const value = args[args.indexOf("--value") + 1];
        if (value === "Other") selected = value;
        return {};
      }
      if (args[0] === "snapshot") {
        return {
          origin: "https://example.test/apply",
          refs: { e1: { name: "How did you hear about us?", role: "combobox" } },
          snapshot: `- combobox "How did you hear about us?" [ref=e1]: ${selected}`,
        };
      }
      return {};
    },
  });

  const result = await ops.selectOption({
    pageId: "page-123",
    ref: "e1",
    label: "How did you hear about us?",
    value: "CareerRat",
    optionAliases: ["Other"],
  });

  assert.deepEqual(result, { selectedValue: "Other" });
  assert.deepEqual(
    commands
      .filter((args) => args[0] === "select")
      .map((args) => args[args.indexOf("--value") + 1]),
    ["CareerRat", "Other"]
  );
});

test("Orca select verification never reports success when the acted-on field has unknown state", async () => {
  const ops = createOrcaOps({
    runOrcaImpl: async (args) => {
      if (args[0] === "snapshot") {
        return {
          origin: "https://example.test/apply",
          refs: { e1: { name: "Work authorization", role: "combobox" } },
          snapshot: '- combobox "Work authorization" [required, ref=e1]',
        };
      }
      if (args[0] === "eval") return { result: "[]" };
      return {};
    },
  });

  await assert.rejects(
    ops.selectOption({
      pageId: "page-123",
      ref: "e1",
      label: "Work authorization",
      value: "Yes",
    }),
    /could not be confirmed/i
  );
});

test("Orca verifies a Greenhouse react-select from its visible selected value after the input clears", async () => {
  const commands = [];
  const label = "Are you currently eligible to work in your country of residence?";
  let optionsOpen = false;
  let optionSnapshotCount = 0;
  let selectedValue = "";
  const fieldSnapshot = () => ({
    origin: "https://job-boards.greenhouse.io/example/jobs/123",
    refs: { [selectedValue ? "e44" : "e39"]: { name: label, role: "combobox" } },
    snapshot: [
      "- LabelText",
      `  - StaticText "${label}"`,
      "- generic",
      `  - StaticText "${selectedValue || "Select..."}"`,
      `  - combobox "${label}" [expanded=false, required, ref=${selectedValue ? "e44" : "e39"}]`,
    ].join("\n"),
  });
  const ops = createOrcaOps({
    runOrcaImpl: async (args) => {
      commands.push(args);
      if (args[0] === "fill") {
        optionsOpen = true;
        return {};
      }
      if (args[0] === "wait" && args.includes("--selector")) {
        throw new Error("this Orca version does not support wait --selector");
      }
      if (args[0] === "snapshot") {
        if (optionsOpen) {
          optionSnapshotCount += 1;
          if (optionSnapshotCount === 1) {
            return {
              origin: fieldSnapshot().origin,
              refs: {},
              snapshot: '- combobox "Loading options" [expanded=true, ref=e39]',
            };
          }
          return {
            origin: fieldSnapshot().origin,
            refs: { e50: { name: "Yes", role: "option" } },
            snapshot: '- option "Yes" [ref=e50]',
          };
        }
        return fieldSnapshot();
      }
      if (args[0] === "click") {
        if (args.includes("@e39")) {
          optionsOpen = true;
          return {};
        }
        optionsOpen = false;
        selectedValue = "Yes";
        return {};
      }
      if (args[0] === "eval") {
        const expression = args[args.indexOf("--expression") + 1];
        return {
          result: JSON.stringify([
            {
              label,
              stateKnown: true,
              value: expression.includes("single-value") ? selectedValue : "",
              typeahead: true,
            },
          ]),
        };
      }
      return {};
    },
  });

  await ops.selectOption({
    pageId: "page-greenhouse",
    ref: "e39",
    label,
    value: "Yes",
    typeahead: true,
  });

  assert.deepEqual(
    commands
      .filter((args) => ["fill", "click"].includes(args[0]))
      .map((args) => [args[0], args[args.indexOf("--element") + 1]]),
    [
      ["click", "@e39"],
      ["fill", "@e39"],
      ["click", "@e50"],
    ]
  );
  assert.equal(optionSnapshotCount, 2, "option discovery is a bounded snapshot poll");
  assert.equal(
    commands.some((args) => args.includes("--selector")),
    false,
    "the Orca typeahead path never emits the unsupported wait --selector option"
  );
});

test("Orca typeahead reacquires a Greenhouse combobox after click renumbers every ref", async () => {
  const commands = [];
  const label = "Are you currently eligible to work in your country of residence?";
  let scrolled = false;
  let menuOpen = false;
  let selected = false;
  const ops = createOrcaOps({
    runOrcaImpl: async (args) => {
      commands.push(args);
      if (args[0] === "click") {
        if (args.includes("@e36")) menuOpen = true;
        if (args.includes("@e38")) {
          menuOpen = false;
          selected = true;
        }
        return {};
      }
      if (args[0] === "fill") {
        throw new Error("the click-only menu was already ready and must not be typed into");
      }
      if (args[0] === "snapshot") {
        if (selected) {
          return {
            origin: "https://job-boards.greenhouse.io/example/jobs/123",
            refs: { e44: { name: label, role: "combobox" } },
            snapshot: [
              "- LabelText",
              `  - StaticText "${label}"`,
              "- generic",
              '  - StaticText "Yes"',
              `  - combobox "${label}" [expanded=false, required, ref=e44]`,
            ].join("\n"),
          };
        }
        if (!menuOpen) {
          assert.equal(scrolled, true);
          return {
            origin: "https://job-boards.greenhouse.io/example/jobs/123",
            refs: { e36: { name: label, role: "combobox" } },
            snapshot: `- combobox "${label}" [expanded=false, required, ref=e36]`,
          };
        }
        return {
          origin: "https://job-boards.greenhouse.io/example/jobs/123",
          refs: {
            e36: { name: label, role: "combobox" },
            e38: { name: "Yes", role: "option" },
            e39: { name: "No", role: "option" },
          },
          snapshot: [
            "- LabelText",
            `  - StaticText "${label}"`,
            "- generic",
            `  - combobox "${label}" [expanded=true, required, ref=e36]`,
            "  - listbox",
            '    - option "Yes" [ref=e38]',
            '    - option "No" [ref=e39]',
          ].join("\n"),
        };
      }
      if (args[0] === "eval") {
        if (args[args.indexOf("--expression") + 1].includes("scrollIntoView")) {
          scrolled = true;
          return { result: "true" };
        }
        return {
          result: JSON.stringify([
            { label, stateKnown: true, value: selected ? "Yes" : "", typeahead: true },
          ]),
        };
      }
      return {};
    },
  });

  const result = await ops.selectOption({
    pageId: "page-greenhouse",
    ref: "e35",
    label,
    value: "Yes",
    typeahead: true,
  });

  assert.deepEqual(result, { selectedValue: "Yes" });
  assert.deepEqual(
    commands
      .filter((args) => ["click", "fill"].includes(args[0]))
      .map((args) => [args[0], args[args.indexOf("--element") + 1]]),
    [
      ["click", "@e36"],
      ["click", "@e38"],
    ]
  );
});

test("Orca typeahead opens the exact Greenhouse control when a CLI click does not expand it", async () => {
  const commands = [];
  const label = "Are you currently eligible to work in your country of residence?";
  let domOpened = false;
  let selected = false;
  const ops = createOrcaOps({
    runOrcaImpl: async (args) => {
      commands.push(args);
      if (args[0] === "click") {
        if (args.includes("@e43")) selected = true;
        return {};
      }
      if (args[0] === "snapshot") {
        if (selected) {
          return {
            origin: "https://job-boards.greenhouse.io/example/jobs/123",
            refs: { e50: { name: label, role: "combobox" } },
            snapshot: [
              "- LabelText",
              `  - StaticText "${label}"`,
              "- generic",
              '  - StaticText "Yes"',
              `  - combobox "${label}" [expanded=false, required, ref=e50]`,
            ].join("\n"),
          };
        }
        return {
          origin: "https://job-boards.greenhouse.io/example/jobs/123",
          refs: {
            e40: { name: label, role: "combobox" },
            ...(domOpened ? { e43: { name: "Yes", role: "option" } } : {}),
          },
          snapshot: [
            "- LabelText",
            `  - StaticText "${label}"`,
            "- generic",
            `  - combobox "${label}" [expanded=${domOpened}, required, ref=e40]`,
            ...(domOpened ? ['  - option "Yes" [ref=e43]'] : []),
          ].join("\n"),
        };
      }
      if (args[0] === "eval") {
        const expression = args[args.indexOf("--expression") + 1];
        if (expression.includes('["pointerdown","mousedown"')) domOpened = true;
        return {
          result: expression.includes("scrollIntoView")
            ? "true"
            : JSON.stringify([
                { label, stateKnown: true, value: selected ? "Yes" : "", typeahead: true },
              ]),
        };
      }
      if (args[0] === "fill" || args[0] === "wait") return {};
      return {};
    },
  });

  const result = await ops.selectOption({
    pageId: "page-greenhouse",
    ref: "e39",
    label,
    value: "Yes, I am legally authorized to work.",
    typeahead: true,
  });

  assert.deepEqual(result, { selectedValue: "Yes" });
  assert.equal(
    commands.some(
      (args) =>
        args[0] === "eval" &&
        args[args.indexOf("--expression") + 1].includes('["pointerdown","mousedown"')
    ),
    true
  );
});

test("Orca typeahead uses the fresh ref while polling an asynchronous Greenhouse menu", async () => {
  const commands = [];
  const label = "Location (City)";
  let menuOpen = false;
  let typed = "";
  let waited = false;
  let selected = false;
  const ops = createOrcaOps({
    runOrcaImpl: async (args) => {
      commands.push(args);
      if (args[0] === "click") {
        if (args.includes("@e40")) menuOpen = true;
        if (args.includes("@e52")) {
          menuOpen = false;
          selected = true;
        }
        return {};
      }
      if (args[0] === "fill") {
        assert.equal(args[args.indexOf("--element") + 1], "@e40");
        typed = args[args.indexOf("--value") + 1];
        waited = false;
        return {};
      }
      if (args[0] === "wait") {
        waited = true;
        return {};
      }
      if (args[0] === "snapshot") {
        if (selected) {
          return {
            origin: "https://job-boards.greenhouse.io/example/jobs/123",
            refs: { e60: { name: label, role: "combobox" } },
            snapshot: [
              "- LabelText",
              `  - StaticText "${label}"`,
              "- generic",
              '  - StaticText "Brooklyn, New York, United States"',
              `  - combobox "${label}" [expanded=false, required, ref=e60]`,
            ].join("\n"),
          };
        }
        if (!menuOpen) {
          return {
            origin: "https://job-boards.greenhouse.io/example/jobs/123",
            refs: { e40: { name: label, role: "combobox" } },
            snapshot: `- combobox "${label}" [expanded=false, required, ref=e40]`,
          };
        }
        assert.equal(menuOpen, true);
        const optionsReady = typed === "New York, New York, United States" && waited;
        return {
          origin: "https://job-boards.greenhouse.io/example/jobs/123",
          refs: {
            e40: { name: label, role: "combobox" },
            ...(optionsReady
              ? {
                  e52: { name: "New York, New York, United States", role: "option" },
                  e53: { name: "New York Mills, New York, United States", role: "option" },
                }
              : {}),
          },
          snapshot: [
            "- LabelText",
            `  - StaticText "${label}"`,
            "- generic",
            `  - combobox "${label}" [expanded=true, required, ref=e40]`,
            ...(optionsReady
              ? [
                  '  - option "New York, New York, United States" [ref=e52]',
                  '  - option "New York Mills, New York, United States" [ref=e53]',
                ]
              : []),
          ].join("\n"),
        };
      }
      if (args[0] === "eval") {
        return {
          result: JSON.stringify([
            {
              label,
              stateKnown: true,
              value: selected ? "New York, New York, United States" : "",
              typeahead: true,
            },
          ]),
        };
      }
      return {};
    },
  });

  const result = await ops.selectOption({
    pageId: "page-greenhouse",
    ref: "e34",
    label,
    value: "Brooklyn, NY",
    typeahead: true,
    optionAliases: ["New York, New York, United States"],
  });

  assert.deepEqual(result, { selectedValue: "New York, New York, United States" });
  assert.deepEqual(
    commands.filter((args) => args[0] === "fill").map((args) => args[args.indexOf("--value") + 1]),
    ["Brooklyn, NY", "New York, New York, United States"]
  );
  assert.equal(
    commands.some(
      (args) =>
        args[0] === "wait" &&
        args[args.indexOf("--timeout") + 1] === "250" &&
        !args.includes("--selector")
    ),
    true
  );
});

test("Orca uses a configured referral-source alias without product-specific engine logic", async () => {
  const commands = [];
  const label = "How did you hear about this opportunity at Grafana?";
  let selected = false;
  const ops = createOrcaOps({
    runOrcaImpl: async (args) => {
      commands.push(args);
      if (args[0] === "snapshot") {
        if (selected) {
          return {
            origin: "https://job-boards.greenhouse.io/example/jobs/123",
            refs: { e80: { name: label, role: "combobox" } },
            snapshot: [
              "- LabelText",
              `  - StaticText "${label}"`,
              "- generic",
              '  - StaticText "Other"',
              `  - combobox "${label}" [expanded=false, required, ref=e80]`,
            ].join("\n"),
          };
        }
        return {
          origin: "https://job-boards.greenhouse.io/example/jobs/123",
          refs: {
            e41: { name: label, role: "combobox" },
            e52: { name: "LinkedIn", role: "option" },
            e53: { name: "Other", role: "option" },
          },
          snapshot: [
            "- LabelText",
            `  - StaticText "${label}"`,
            "- generic",
            `  - combobox "${label}" [expanded=true, required, ref=e41]`,
            '  - option "LinkedIn" [ref=e52]',
            '  - option "Other" [ref=e53]',
          ].join("\n"),
        };
      }
      if (args[0] === "click") {
        if (args.includes("@e53")) selected = true;
        return {};
      }
      if (args[0] === "eval") {
        return {
          result: JSON.stringify([
            { label, stateKnown: true, value: selected ? "Other" : "", typeahead: true },
          ]),
        };
      }
      return {};
    },
  });

  const result = await ops.selectOption({
    pageId: "page-greenhouse",
    ref: "e41",
    label,
    value: "Community event",
    typeahead: true,
    optionAliases: ["Other"],
  });

  assert.deepEqual(result, { selectedValue: "Other" });
  assert.equal(
    commands.some((args) => args[0] === "click" && args.includes("@e53")),
    true
  );
  assert.equal(
    commands.some((args) => args[0] === "fill"),
    false
  );
});

test("Orca typeahead waits for an asynchronous Greenhouse selection to become committed", async () => {
  const commands = [];
  const label = "Which of the following best describes you?";
  let optionClicked = false;
  let committed = false;
  let commitWaits = 0;
  const ops = createOrcaOps({
    runOrcaImpl: async (args) => {
      commands.push(args);
      if (args[0] === "click") {
        if (args.includes("@e42")) optionClicked = true;
        return {};
      }
      if (args[0] === "wait") {
        if (optionClicked) {
          commitWaits += 1;
          committed = commitWaits >= 4;
        }
        return {};
      }
      if (args[0] === "snapshot") {
        if (optionClicked) {
          return {
            origin: "https://job-boards.greenhouse.io/example/jobs/123",
            refs: { e60: { name: label, role: "combobox" } },
            snapshot: [
              "- LabelText",
              `  - StaticText "${label}"`,
              "- generic",
              `  - combobox "${label}" [expanded=false, required, ref=e60]`,
            ].join("\n"),
          };
        }
        return {
          origin: "https://job-boards.greenhouse.io/example/jobs/123",
          refs: {
            e40: { name: label, role: "combobox" },
            e42: { name: "I am a human being", role: "option" },
          },
          snapshot: [
            "- LabelText",
            `  - StaticText "${label}"`,
            "- generic",
            `  - combobox "${label}" [expanded=true, required, ref=e40]`,
            '  - option "I am a human being" [ref=e42]',
          ].join("\n"),
        };
      }
      if (args[0] === "eval") {
        return {
          result: JSON.stringify([
            {
              label,
              stateKnown: true,
              value: committed ? "I am a human being" : "",
              typeahead: true,
            },
          ]),
        };
      }
      return {};
    },
  });

  const result = await ops.selectOption({
    pageId: "page-greenhouse",
    ref: "e39",
    label,
    value: "I am a human being",
    typeahead: true,
  });

  assert.deepEqual(result, { selectedValue: "I am a human being" });
  assert.equal(
    commands.some((args) => args[0] === "wait" && args[args.indexOf("--timeout") + 1] === "250"),
    true
  );
});

test("Orca typeahead waits past stale options from the previous Greenhouse query", async () => {
  const commands = [];
  const label =
    "Do you now or in the future require visa sponsorship to continue working in your country of residence?";
  let menuOpen = false;
  let waited = false;
  let selected = false;
  const ops = createOrcaOps({
    runOrcaImpl: async (args) => {
      commands.push(args);
      if (args[0] === "click") {
        if (args.includes("@e40")) menuOpen = true;
        if (args.includes("@e44")) {
          menuOpen = false;
          selected = true;
        }
        return {};
      }
      if (args[0] === "fill") {
        waited = false;
        return {};
      }
      if (args[0] === "wait") {
        waited = true;
        return {};
      }
      if (args[0] === "snapshot") {
        if (selected) {
          return {
            origin: "https://job-boards.greenhouse.io/example/jobs/123",
            refs: { e50: { name: label, role: "combobox" } },
            snapshot: [
              "- LabelText",
              `  - StaticText "${label}"`,
              "- generic",
              '  - StaticText "No"',
              `  - combobox "${label}" [expanded=false, required, ref=e50]`,
            ].join("\n"),
          };
        }
        if (!menuOpen) {
          return {
            origin: "https://job-boards.greenhouse.io/example/jobs/123",
            refs: { e40: { name: label, role: "combobox" } },
            snapshot: `- combobox "${label}" [expanded=false, required, ref=e40]`,
          };
        }
        const option = waited ? { ref: "e44", name: "No" } : { ref: "e43", name: "Yes" };
        return {
          origin: "https://job-boards.greenhouse.io/example/jobs/123",
          refs: {
            e40: { name: label, role: "combobox" },
            [option.ref]: { name: option.name, role: "option" },
          },
          snapshot: [
            "- LabelText",
            `  - StaticText "${label}"`,
            "- generic",
            `  - combobox "${label}" [expanded=true, required, ref=e40]`,
            `  - option "${option.name}" [ref=${option.ref}]`,
          ].join("\n"),
        };
      }
      if (args[0] === "eval") {
        return {
          result: JSON.stringify([
            { label, stateKnown: true, value: selected ? "No" : "", typeahead: true },
          ]),
        };
      }
      return {};
    },
  });

  const result = await ops.selectOption({
    pageId: "page-greenhouse",
    ref: "e39",
    label,
    value: "No",
    typeahead: true,
  });

  assert.deepEqual(result, { selectedValue: "No" });
  assert.equal(
    commands.some((args) => args[0] === "wait"),
    true
  );
  assert.equal(
    commands.some((args) => args[0] === "click" && args.includes("@e43")),
    false
  );
  assert.equal(
    commands.some((args) => args[0] === "click" && args.includes("@e44")),
    true
  );
});

test("Orca typeahead clicks the matching option owned by the acted-on field", async () => {
  const commands = [];
  const label = "Work authorization";
  let selected = false;
  const ops = createOrcaOps({
    runOrcaImpl: async (args) => {
      commands.push(args);
      if (args[0] === "snapshot") {
        if (selected) {
          return {
            origin: "https://example.test/apply",
            refs: { e90: { name: label, role: "combobox" } },
            snapshot: `- combobox "${label}" [required, ref=e90]: Yes`,
          };
        }
        return {
          origin: "https://example.test/apply",
          refs: {
            e70: { name: "Yes", role: "option" },
            e80: { name: "Yes", role: "option" },
          },
          snapshot: [
            "- LabelText",
            '  - StaticText "Unrelated open picker"',
            "- generic",
            '  - combobox "Unrelated open picker" [expanded=true, ref=e60]',
            "  - listbox",
            '    - option "Yes" [ref=e70]',
            "- LabelText",
            `  - StaticText "${label}"`,
            "- generic",
            `  - combobox "${label}" [expanded=true, required, ref=e39]`,
            "  - listbox",
            '    - option "Yes" [ref=e80]',
          ].join("\n"),
        };
      }
      if (args[0] === "click") {
        selected = args.includes("@e80");
        return {};
      }
      if (args[0] === "eval") {
        return {
          result: JSON.stringify([{ label, stateKnown: true, value: selected ? "Yes" : "" }]),
        };
      }
      return {};
    },
  });

  await ops.selectOption({
    pageId: "page-greenhouse",
    ref: "e39",
    label,
    value: "Yes",
    typeahead: true,
  });

  assert.equal(
    commands.some((args) => args[0] === "click" && args.includes("@e80")),
    true
  );
  assert.equal(
    commands.some((args) => args[0] === "click" && args.includes("@e70")),
    false
  );
});

test("Orca typeahead retries terminal sentence punctuation without borrowing another picker's option", async () => {
  const commands = [];
  const label = "Country";
  let typed = "";
  let selected = false;
  const ops = createOrcaOps({
    runOrcaImpl: async (args) => {
      commands.push(args);
      if (args[0] === "fill") {
        typed = args[args.indexOf("--value") + 1];
        return {};
      }
      if (args[0] === "snapshot") {
        if (selected) {
          return {
            origin: "https://example.test/apply",
            refs: { e90: { name: label, role: "combobox" } },
            snapshot: `- combobox "${label}" [required, ref=e90]: +1`,
          };
        }
        const fieldOptions = typed === "United States";
        return {
          origin: "https://example.test/apply",
          refs: {
            ...(fieldOptions ? { e80: { name: "United States +1", role: "option" } } : {}),
            e70: { name: "United States +1", role: "option" },
          },
          snapshot: [
            "- LabelText",
            `  - StaticText "${label}"`,
            "- generic",
            `  - combobox "${label}" [expanded=true, required, ref=e39]`,
            ...(fieldOptions ? ['    - option "United States +1" [ref=e80]'] : []),
            "  - LabelText",
            '    - StaticText "Phone"',
            "  - generic",
            '    - combobox "Search" [expanded=true, ref=e60]',
            '      - option "United States +1" [ref=e70]',
          ].join("\n"),
        };
      }
      if (args[0] === "click") {
        selected = args.includes("@e80");
        return {};
      }
      if (args[0] === "eval") {
        return {
          result: JSON.stringify([{ label, stateKnown: true, value: selected ? "+1" : "" }]),
        };
      }
      return {};
    },
  });

  await ops.selectOption({
    pageId: "page-greenhouse",
    ref: "e39",
    label,
    value: "United States.",
    typeahead: true,
  });

  assert.deepEqual(
    commands.filter((args) => args[0] === "fill").map((args) => args[args.indexOf("--value") + 1]),
    ["United States.", "United States"]
  );
  assert.equal(
    commands.some((args) => args[0] === "click" && args.includes("@e80")),
    true
  );
  assert.equal(
    commands.some((args) => args[0] === "click" && args.includes("@e70")),
    false
  );
});

test("Orca typeahead closes an uncommitted picker when no owned option matches", async () => {
  const commands = [];
  const label = "Work authorization";
  const ops = createOrcaOps({
    runOrcaImpl: async (args) => {
      commands.push(args);
      if (args[0] === "snapshot") {
        return {
          origin: "https://example.test/apply",
          refs: { e70: { name: "Yes", role: "option" } },
          snapshot: [
            "- LabelText",
            `  - StaticText "${label}"`,
            "- generic",
            `  - combobox "${label}" [expanded=true, required, ref=e39]`,
            "- LabelText",
            '  - StaticText "Unrelated picker"',
            "- generic",
            '  - combobox "Unrelated picker" [expanded=true, ref=e60]',
            '    - option "Yes" [ref=e70]',
          ].join("\n"),
        };
      }
      return {};
    },
  });

  await assert.rejects(
    ops.selectOption({
      pageId: "page-greenhouse",
      ref: "e39",
      label,
      value: "Yes",
      typeahead: true,
    }),
    /No unambiguous option matched/i
  );

  assert.equal(
    commands.some((args) => args[0] === "keypress" && args[args.indexOf("--key") + 1] === "Escape"),
    true
  );
});

test("Orca toggleField honors both checked and unchecked states", async () => {
  const commands = [];
  const ops = createOrcaOps({
    runOrcaImpl: async (args) => {
      commands.push(args);
      return {};
    },
  });

  await ops.toggleField({ pageId: "page-123", ref: "e1", checked: true });
  await ops.toggleField({ pageId: "page-123", ref: "e1", checked: false });

  assert.deepEqual(commands, [
    ["check", "--page", "page-123", "--element", "@e1", "--json"],
    ["uncheck", "--page", "page-123", "--element", "@e1", "--json"],
  ]);
});

test("Orca DOM probes keep selectors out of constructed JavaScript", async () => {
  const expressions = [];
  const hostileSelector = 'div");globalThis.__careerratInjected=true;//';
  const ops = createOrcaOps({
    runOrcaImpl: async (args) => {
      if (args[0] !== "eval") return {};
      expressions.push(args[args.indexOf("--expression") + 1]);
      return {
        result: args[args.indexOf("--expression") + 1].includes("querySelectorAll")
          ? JSON.stringify({ rowSelector: null, rows: [] })
          : JSON.stringify({ selector: null, text: "" }),
      };
    },
  });

  await ops.extractText({ pageId: "page-123", selectors: [hostileSelector] });
  await ops.extractRows({
    pageId: "page-123",
    rowSelectors: [hostileSelector],
    fields: { name: { selectors: [hostileSelector] } },
  });
  await ops.clickRow({ pageId: "page-123", rowSelector: hostileSelector, index: 0 });

  assert.equal(expressions.length, 3);
  assert.ok(expressions.every((expression) => !expression.includes(hostileSelector)));
  assert.ok(expressions.every((expression) => expression.includes("atob")));
});

const UPLOAD_SNAPSHOT = {
  origin: "https://job-boards.greenhouse.io/example/jobs/123",
  refs: {
    e20: { name: "Resume/CV*", role: "group" },
    e21: { name: "Attach", role: "button" },
    e22: { name: "Cover Letter", role: "group" },
    e23: { name: "Attach", role: "button" },
    e24: { name: "Autofill with MyGreenhouse", role: "button" },
  },
  snapshot: [
    '- group "Resume/CV*" [required, ref=e20]',
    '  - button "Attach" [ref=e21]',
    '- group "Cover Letter" [ref=e22]',
    '  - button "Attach" [ref=e23]',
    '- button "Autofill with MyGreenhouse" [ref=e24]',
  ].join("\n"),
  browserPageId: "page-123",
};

const NATIVE_FILE_UPLOAD_SNAPSHOT = {
  origin: "https://careers.example.test/jobs/staff-ai/apply",
  refs: {
    e6: { name: "Resume/CV", role: "button" },
    e7: { name: "Submit application", role: "button" },
  },
  snapshot: [
    '- button "Resume/CV" [ref=e6]: No file chosen',
    '- button "Submit application" [ref=e7]',
  ].join("\n"),
  browserPageId: "page-123",
};

const LIVE_GREENHOUSE_UPLOAD_SNAPSHOT = {
  origin: "https://job-boards.greenhouse.io/example/jobs/123",
  refs: {
    e29: { name: "Attach", role: "button" },
    e30: { name: "Attach", role: "button" },
    e31: { name: "Dropbox", role: "button" },
  },
  snapshot: [
    '- group "Resume/CV*"',
    "  - generic",
    '    - button "Attach" [ref=e29]',
    "    - LabelText",
    '      - StaticText "Attach"',
    '    - button "Attach" [ref=e30]: No file chosen',
    '  - button "Dropbox" [ref=e31]',
  ].join("\n"),
  browserPageId: "page-greenhouse",
};

const ASHBY_CUSTOM_CONTROLS_SNAPSHOT = {
  origin: "https://jobs.ashbyhq.com/curri/18588740-4f80-4a40-b3c0-fed97517a3c4/application",
  refs: {
    e1: {
      name: "Senior Software Engineer LocationRemote - United StatesEmployment TypeFull time",
      role: "checkbox",
    },
    e14: { name: "Full Name*", role: "textbox" },
    e27: { name: "Submit Application", role: "button" },
    e32: { name: "Start typing...", role: "combobox" },
    e33: { name: "", role: "button" },
    e34: { name: "Yes", role: "button" },
    e35: { name: "No", role: "button" },
    e36: { name: "Yes", role: "button" },
    e37: { name: "No", role: "button" },
  },
  snapshot: [
    '- checkbox "Senior Software Engineer LocationRemote - United StatesEmployment TypeFull time" [checked=true, ref=e1]',
    ...[
      "- LabelText",
      '  - StaticText "Full Name"',
      '  - StaticText "*"',
      '- textbox "Full Name*" [required, ref=e14]: Riley Chen',
      "- LabelText",
      '  - StaticText "Location"',
      '  - StaticText "*"',
      "- generic",
      '  - combobox "Start typing..." [expanded=false, ref=e32]',
      "  - button [ref=e33]",
      "- LabelText",
      '  - StaticText "Will you now or in the future require sponsorship for employment visa status"',
      '  - StaticText "*"',
      "- generic",
      '  - button "Yes" [ref=e34]',
      '  - button "No" [ref=e35]',
      "- LabelText",
      '  - StaticText "Would you be willing to travel to Ventura, CA to meet with our team as part of the interview process?"',
      '  - StaticText "*"',
      "- generic",
      '  - button "Yes" [ref=e36]',
      '  - button "No" [ref=e37]',
      '- button "Submit Application" [ref=e27]',
    ].map((line) => `  ${line}`),
  ].join("\n"),
  browserPageId: "page-ashby",
};

const ASHBY_LOCATION_OPTIONS_SNAPSHOT = {
  origin: ASHBY_CUSTOM_CONTROLS_SNAPSHOT.origin,
  refs: {
    e10: { name: "Start typing...", role: "combobox" },
    e50: { name: "New York City, New York, United States", role: "option" },
    e51: { name: "West New York, New Jersey, United States", role: "option" },
  },
  snapshot: [
    '- combobox "Start typing..." [expanded=true, ref=e10]: New York, NY',
    "- listbox",
    '  - option "New York City, New York, United States" [selected, ref=e50]',
    '  - option "West New York, New Jersey, United States" [ref=e51]',
  ].join("\n"),
  browserPageId: "page-ashby",
};

test("renderedFieldsFromSnapshot keeps live form metadata and excludes non-fields", () => {
  assert.deepEqual(renderedFieldsFromSnapshot(FORM_SNAPSHOT), [
    { ref: "e1", id: "rendered-first-name", label: "First Name", type: "text", required: true },
    {
      ref: "e2",
      id: "rendered-why-example",
      label: "Why Example?",
      type: "text",
      required: true,
    },
    {
      ref: "e3",
      id: "rendered-work-authorization",
      label: "Work authorization",
      type: "select",
      required: true,
    },
    {
      ref: "e4",
      id: "rendered-gender",
      label: "Gender",
      type: "select",
      required: false,
    },
  ]);
});

test("Orca executor captures Ashby custom controls by their visible required labels", async () => {
  const captures = [];
  const execute = createOrcaApplyExecutor({
    repoRoot: "/repo",
    env: {},
    mayRunImpl: allowApply,
    runOrcaImpl: async (args) => {
      if (args[0] === "tab") return { browserPageId: "page-ashby" };
      if (args[0] === "snapshot") return ASHBY_CUSTOM_CONTROLS_SNAPSHOT;
      throw new Error(`unexpected command: ${args.join(" ")}`);
    },
    captureQuestionsImpl: async (input) => {
      captures.push(input);
      return {
        questions: input.questions,
        excluded: [],
        demographicSectionPresent: false,
      };
    },
  });

  const result = await execute({
    applicationId: "app-ashby",
    application: { id: "app-ashby" },
    postingUrl: ASHBY_CUSTOM_CONTROLS_SNAPSHOT.origin,
    questionCapture: { state: "site-required" },
  });

  assert.equal(result.state, "questions-captured");
  assert.deepEqual(
    captures[0].questions.map(({ label, type, required }) => ({ label, type, required })),
    [
      { label: "Full Name*", type: "text", required: true },
      { label: "Location", type: "select", required: true },
      {
        label: "Will you now or in the future require sponsorship for employment visa status",
        type: "radio",
        required: true,
      },
      {
        label:
          "Would you be willing to travel to Ventura, CA to meet with our team as part of the interview process?",
        type: "radio",
        required: true,
      },
    ]
  );
});

test("Orca executor fills Ashby required custom controls and blocks on required unknowns", async () => {
  const commands = [];
  let locationOptionsOpen = false;
  let locationValue = "";
  let hideCommittedLocationOnce = false;
  let sponsorshipValue = "";
  const execute = createOrcaApplyExecutor({
    repoRoot: "/repo",
    env: {},
    mayRunImpl: allowApply,
    runOrcaImpl: async (args) => {
      commands.push(args);
      if (args[0] === "tab") return { browserPageId: "page-ashby" };
      if (args[0] === "snapshot") {
        return locationOptionsOpen
          ? ASHBY_LOCATION_OPTIONS_SNAPSHOT
          : ASHBY_CUSTOM_CONTROLS_SNAPSHOT;
      }
      if (args[0] === "eval") {
        const visibleLocation = hideCommittedLocationOnce ? "" : locationValue;
        hideCommittedLocationOnce = false;
        return {
          result: JSON.stringify([
            { label: "Location", stateKnown: true, value: visibleLocation },
            {
              label: "Will you now or in the future require sponsorship for employment visa status",
              yesNo: [
                { text: "Yes", pressed: false, className: "ashby-option" },
                {
                  text: "No",
                  pressed: false,
                  className: sponsorshipValue === "No" ? "ashby-option _active_1svni_57" : "",
                },
              ],
            },
            {
              label:
                "Would you be willing to travel to Ventura, CA to meet with our team as part of the interview process?",
              yesNo: [
                { text: "Yes", pressed: false, className: "ashby-option" },
                { text: "No", pressed: false, className: "ashby-option" },
              ],
            },
          ]),
        };
      }
      if (args[0] === "fill" && args.includes("@e32")) {
        locationOptionsOpen = true;
        return {};
      }
      if (args[0] === "wait") return {};
      if (args[0] === "click" && args.includes("@e50")) {
        locationOptionsOpen = false;
        locationValue = "New York City, New York, United States";
        hideCommittedLocationOnce = true;
        return {};
      }
      if (args[0] === "focus") return {};
      if (args[0] === "keypress") {
        sponsorshipValue = "No";
        return {};
      }
      if (["fill", "select", "click"].includes(args[0])) return {};
      throw new Error(`unexpected command: ${args.join(" ")}`);
    },
    candidateConfigGetImpl: () => ({
      profile: {
        candidate: { full_name: "Riley Chen", location: "New York, NY" },
        location: { travel_tolerance: "" },
        authorization: { requires_sponsorship: false },
      },
      honesty: {},
      "form-defaults": { requires_sponsorship: "No" },
    }),
    loadAnswerMapImpl: () => new Map(),
  });

  const result = await execute({
    applicationId: "app-ashby",
    application: { id: "app-ashby" },
    postingUrl: ASHBY_CUSTOM_CONTROLS_SNAPSHOT.origin,
    questionCapture: { state: "captured" },
  });

  assert.equal(result.state, "blocked");
  assert.match(result.reason, /Would you be willing to travel to Ventura/);
  assert.deepEqual(result.session.unresolved, [
    {
      label:
        "Would you be willing to travel to Ventura, CA to meet with our team as part of the interview process?",
      required: true,
    },
  ]);
  assert.deepEqual(
    commands.filter(
      (args) =>
        (["@e32", "@e50", "@e35"].some((ref) => args.includes(ref)) || args[0] === "keypress") &&
        ["fill", "click", "focus", "keypress"].includes(args[0])
    ),
    [
      ["click", "--page", "page-ashby", "--element", "@e32", "--json"],
      ["fill", "--page", "page-ashby", "--element", "@e32", "--value", "New York, NY", "--json"],
      ["click", "--page", "page-ashby", "--element", "@e50", "--json"],
      ["focus", "--page", "page-ashby", "--element", "@e35", "--json"],
      ["keypress", "--page", "page-ashby", "--key", "Enter", "--json"],
    ]
  );
  assert.equal(
    commands.some((args) => args[0] === "wait" && args.includes("--text")),
    false,
    "post-selection verification stays snapshot-bounded instead of starting an open text wait"
  );
  assert.equal(
    commands.some((args) => args.includes("@e27")),
    false,
    "Submit Application is never clicked"
  );
});

test("uploadTargetsFromSnapshot maps only explicit resume and cover-letter controls", () => {
  assert.deepEqual(uploadTargetsFromSnapshot(UPLOAD_SNAPSHOT), [
    { ref: "e21", kind: "resume", label: "Resume/CV*", required: true },
    { ref: "e23", kind: "coverLetter", label: "Cover Letter", required: false },
  ]);
});

test("uploadTargetsFromSnapshot maps a native file input exposed by Orca as its label", () => {
  assert.deepEqual(uploadTargetsFromSnapshot(NATIVE_FILE_UPLOAD_SNAPSHOT), [
    { ref: "e6", kind: "resume", label: "Resume/CV", required: false },
  ]);
});

test("uploadTargetsFromSnapshot maps the native input inside a live Greenhouse group with no ref", () => {
  assert.deepEqual(uploadTargetsFromSnapshot(LIVE_GREENHOUSE_UPLOAD_SNAPSHOT), [
    { ref: "e30", kind: "resume", label: "Resume/CV*", required: true },
  ]);
});

test("Orca executor opens one supervised tab and captures rendered questions before filling", async () => {
  const commands = [];
  const captures = [];
  const runOrcaImpl = async (args) => {
    commands.push(args);
    if (args[0] === "tab") return { browserPageId: "page-123" };
    if (args[0] === "snapshot") return FORM_SNAPSHOT;
    throw new Error(`unexpected command: ${args.join(" ")}`);
  };
  const execute = createOrcaApplyExecutor({
    repoRoot: "/repo",
    env: {},
    mayRunImpl: allowApply,
    runOrcaImpl,
    captureQuestionsImpl: async (input) => {
      captures.push(input);
      return {
        source: "rendered",
        questions: input.questions.filter((question) => question.label !== "Gender"),
        excluded: [{ id: "rendered-gender", label: "Gender", reason: "gender" }],
        demographicSectionPresent: true,
      };
    },
  });

  const result = await execute({
    applicationId: "app-1",
    application: { id: "app-1", company: "Example", role: "Staff AI Engineer" },
    postingUrl: FORM_SNAPSHOT.origin,
    questionCapture: { state: "site-required" },
  });

  assert.equal(result.verified, false);
  assert.equal(result.state, "questions-captured");
  assert.equal(result.questionCaptureUpdated, true);
  assert.equal(result.session.provider, "orca");
  assert.equal(result.session.answerableCount, 3);
  assert.equal(result.session.excludedCount, 1);
  assert.deepEqual(commands.slice(0, 2), [
    ["tab", "create", "--url", FORM_SNAPSHOT.origin, "--json"],
    ["snapshot", "--page", "page-123", "--json"],
  ]);
  assert.equal(
    commands.some((args) => args[0] === "eval"),
    true,
    "combobox state is probed before the captured questions are reported"
  );
  assert.equal(captures.length, 1);
  assert.equal(captures[0].source, "rendered");
  assert.deepEqual(
    captures[0].questions.map(({ ref: _ref, ...question }) => question),
    [
      { id: "rendered-first-name", label: "First Name", type: "text", required: true },
      {
        id: "rendered-why-example",
        label: "Why Example?",
        type: "text",
        required: true,
      },
      {
        id: "rendered-work-authorization",
        label: "Work authorization",
        type: "select",
        required: true,
      },
      {
        id: "rendered-gender",
        label: "Gender",
        type: "select",
        required: false,
      },
    ]
  );
});

test("Orca executor fills confirmed values, stops before submit, and verifies only from the live page", async () => {
  const commands = [];
  let confirmationMode = false;
  let workAuthorizationValue = "";
  const currentFormSnapshot = () => ({
    ...FORM_SNAPSHOT,
    snapshot: workAuthorizationValue
      ? FORM_SNAPSHOT.snapshot.replace(
          '- combobox "Work authorization" [expanded=false, required, ref=e3]',
          `- combobox "Work authorization" [expanded=false, required, ref=e3]: ${workAuthorizationValue}`
        )
      : FORM_SNAPSHOT.snapshot,
  });
  const runOrcaImpl = async (args) => {
    commands.push(args);
    if (args[0] === "tab") return { browserPageId: "page-123" };
    if (args[0] === "snapshot") {
      return confirmationMode
        ? {
            origin: "https://careers.example.test/jobs/staff-ai/confirmation",
            refs: {},
            snapshot: 'StaticText "Thank you for applying"',
            browserPageId: "page-123",
          }
        : currentFormSnapshot();
    }
    if (args[0] === "eval") return { result: "[]" };
    if (args[0] === "screenshot") return { data: "cG5n" };
    if (args[0] === "select") {
      workAuthorizationValue = args[args.indexOf("--value") + 1];
      return {};
    }
    if (args[0] === "fill") return {};
    throw new Error(`unexpected command: ${args.join(" ")}`);
  };
  const execute = createOrcaApplyExecutor({
    repoRoot: "/repo",
    env: {},
    mayRunImpl: allowApply,
    runOrcaImpl,
    candidateConfigGetImpl: () => ({
      profile: { candidate: { full_name: "Morgan Hale" } },
      honesty: {},
      "form-defaults": {
        first_name: "Morgan",
        work_authorization: "Yes",
      },
    }),
    loadAnswerMapImpl: () => new Map([["why example", "I build reliable systems."]]),
    saveScreenshotImpl: () => "workspace/captures/app-1-confirmation.png",
  });

  const first = await execute({
    applicationId: "app-1",
    application: { id: "app-1", company: "Example", role: "Staff AI Engineer" },
    postingUrl: FORM_SNAPSHOT.origin,
    questionCapture: {
      state: "captured",
      source: "rendered",
      answerableCount: 3,
      excludedCount: 1,
      answerableIds: ["rendered-first-name", "rendered-why-example", "rendered-work-authorization"],
      excludedIds: ["rendered-gender"],
    },
  });

  assert.equal(first.verified, false);
  assert.equal(first.state, "awaiting-submit");
  assert.equal(first.session.filledCount, 3);
  assert.deepEqual(first.session.unresolved, []);
  assert.equal(
    commands.some((args) => args[0] === "click"),
    false
  );
  const actionIndexes = commands
    .map((args, index) => (["fill", "select"].includes(args[0]) ? index : -1))
    .filter((index) => index >= 0);
  assert.equal(actionIndexes.length, 3);
  for (const [actionOffset, index] of actionIndexes.entries()) {
    const previousAction = actionOffset === 0 ? -1 : actionIndexes[actionOffset - 1];
    assert.equal(
      commands.slice(previousAction + 1, index).some((args) => args[0] === "snapshot"),
      true,
      "every browser action needs a fresh snapshot"
    );
  }
  assert.deepEqual(
    commands.filter((args) => ["fill", "select"].includes(args[0])),
    [
      ["fill", "--page", "page-123", "--element", "@e1", "--value", "Morgan", "--json"],
      [
        "fill",
        "--page",
        "page-123",
        "--element",
        "@e2",
        "--value",
        "I build reliable systems.",
        "--json",
      ],
      [
        "select",
        "--page",
        "page-123",
        "--element",
        "@e3",
        "--value",
        "Yes, authorized to work",
        "--json",
      ],
    ]
  );

  confirmationMode = true;
  const verified = await execute({
    applicationId: "app-1",
    application: { id: "app-1", company: "Example", role: "Staff AI Engineer" },
    postingUrl: FORM_SNAPSHOT.origin,
    questionCapture: { state: "captured", source: "rendered", answerableCount: 3 },
  });

  assert.equal(verified.verified, true);
  assert.equal(verified.confirmation, "/confirmation");
  assert.equal(verified.currentUrl.endsWith("/confirmation"), true);
  assert.equal(verified.artifacts[0].kind, "submission_confirmation");
  assert.equal(commands.at(-1)[0], "screenshot");
});

test("Orca executor uploads generated PDFs through explicit live controls", async () => {
  const repoRoot = mkdtempSync(join(tmpdir(), "careerrat-orca-upload-"));
  try {
    mkdirSync(join(repoRoot, "workspace", "tailored"), { recursive: true });
    writeFileSync(
      join(repoRoot, "workspace", "tailored", "resume.pdf"),
      buildMinimalPdf(["Resume"]).bytes
    );
    writeFileSync(
      join(repoRoot, "workspace", "tailored", "cover.pdf"),
      buildMinimalPdf(["Cover letter"]).bytes
    );
    const commands = [];
    const runOrcaImpl = async (args) => {
      commands.push(args);
      if (args[0] === "tab") return { browserPageId: "page-123" };
      if (args[0] === "snapshot") return UPLOAD_SNAPSHOT;
      if (args[0] === "upload") return {};
      throw new Error(`unexpected command: ${args.join(" ")}`);
    };
    const execute = createOrcaApplyExecutor({
      repoRoot,
      env: {},
      mayRunImpl: allowApply,
      runOrcaImpl,
      candidateConfigGetImpl: () => ({ profile: {}, honesty: {}, "form-defaults": {} }),
      loadAnswerMapImpl: () => new Map(),
    });

    const result = await execute({
      applicationId: "app-1",
      application: {
        id: "app-1",
        artifacts: {
          resumePdf: "workspace/tailored/resume.pdf",
          coverLetterPdf: "workspace/tailored/cover.pdf",
        },
      },
      postingUrl: UPLOAD_SNAPSHOT.origin,
      questionCapture: { state: "captured", source: "rendered", answerableCount: 0 },
    });

    assert.equal(result.state, "awaiting-submit");
    assert.equal(result.session.uploadedCount, 2);
    assert.deepEqual(
      commands.filter((args) => args[0] === "upload"),
      [
        [
          "upload",
          "--page",
          "page-123",
          "--element",
          "@e21",
          "--files",
          join(repoRoot, "workspace", "tailored", "resume.pdf"),
          "--json",
        ],
        [
          "upload",
          "--page",
          "page-123",
          "--element",
          "@e23",
          "--files",
          join(repoRoot, "workspace", "tailored", "cover.pdf"),
          "--json",
        ],
      ]
    );
    for (const index of commands
      .map((args, index) => (args[0] === "upload" ? index : -1))
      .filter((index) => index >= 0)) {
      assert.equal(commands[index - 1][0], "snapshot");
    }
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test("Orca executor refuses LinkedIn Easy Apply until supervised preparation consent is live", async () => {
  const commands = [];
  const execute = createOrcaApplyExecutor({
    repoRoot: "/repo",
    env: {},
    runOrcaImpl: async (args) => {
      commands.push(args);
      return {};
    },
    mayRunImpl: () => ({
      allowed: false,
      reasons: ["authenticated_apply_preparation on LinkedIn is off"],
    }),
  });

  const result = await execute({
    applicationId: "app-linkedin",
    application: {},
    postingUrl: "https://www.linkedin.com/jobs/view/123?easyApplyModal=true",
  });

  assert.equal(result.available, true);
  assert.equal(result.verified, false);
  assert.equal(result.state, "blocked");
  assert.equal(
    result.reason,
    "Application preparation for LinkedIn is off. Turn it on in Settings before CareerRat opens the form."
  );
  assert.deepEqual(commands, []);
});

test("Orca executor stops before account creation or password entry", async () => {
  const commands = [];
  const snapshot = {
    origin: "https://careers.example.test/create-account",
    refs: { e1: { name: "Create a password", role: "textbox" } },
    snapshot: '- textbox "Create a password" [required, ref=e1]',
  };
  const execute = createOrcaApplyExecutor({
    repoRoot: "/repo",
    env: {},
    mayRunImpl: allowApply,
    runOrcaImpl: async (args) => {
      commands.push(args);
      if (args[0] === "tab") return { browserPageId: "page-123" };
      if (args[0] === "snapshot") return snapshot;
      throw new Error(`unexpected command: ${args.join(" ")}`);
    },
  });

  const result = await execute({
    applicationId: "app-account",
    application: {},
    postingUrl: snapshot.origin,
    questionCapture: { state: "site-required" },
  });

  assert.equal(result.state, "blocked");
  assert.match(result.reason, /account creation or password entry/i);
  assert.equal(
    commands.some((args) => ["fill", "select", "click"].includes(args[0])),
    false
  );
});

test("configured executor fails the extension provider immediately with an honest reason", async () => {
  const extensionExecute = createConfiguredApplyExecutor({
    repoRoot: "/repo",
    env: {},
    loadAutomationImpl: () => ({ data: { session: { provider: "extension" } } }),
  });
  assert.equal(typeof extensionExecute, "function");
  const extensionResult = await extensionExecute({
    applicationId: "app-1",
    application: {},
    postingUrl: FORM_SNAPSHOT.origin,
  });
  assert.equal(extensionResult.available, false);
  assert.equal(extensionResult.verified, false);
  assert.equal(extensionResult.state, "unavailable");
  assert.match(
    extensionResult.reason,
    /automatic apply isn't available on the .*extension.* provider yet/i
  );
  // Provider-neutral: the reason must not steer the user at one hardcoded
  // replacement provider (AGENTS.md Domain-Neutral Rule) — see session.mjs
  // automaticApplyGap().
  assert.doesNotMatch(extensionResult.reason, /playwright/i);
});

test("configured executor connects explicit Orca or automatic Orca detection", async () => {
  const execute = createConfiguredApplyExecutor({
    repoRoot: "/repo",
    env: {},
    mayRunImpl: allowApply,
    loadAutomationImpl: () => ({ data: { session: { provider: "orca" } } }),
    runOrcaImpl: async () => {
      throw new Error("Orca is not running");
    },
  });
  const result = await execute({
    applicationId: "app-1",
    application: {},
    postingUrl: FORM_SNAPSHOT.origin,
  });
  assert.equal(result.available, false);
  assert.equal(result.state, "unavailable");
  assert.match(result.reason, /Orca is not running/);

  const automatic = createConfiguredApplyExecutor({
    repoRoot: "/repo",
    env: { ORCA_WORKTREE_ID: "worktree-123" },
    mayRunImpl: allowApply,
    loadAutomationImpl: () => ({ data: { session: { provider: "auto" } } }),
    runOrcaImpl: async () => {
      throw new Error("automatic Orca attempted");
    },
  });
  assert.equal(typeof automatic, "function");
  const automaticResult = await automatic({
    applicationId: "app-1",
    application: {},
    postingUrl: FORM_SNAPSHOT.origin,
  });
  assert.match(automaticResult.reason, /automatic Orca attempted/);
});

test("configured executor never exposes browser CLI commands in user-facing failures", async () => {
  const execute = createConfiguredApplyExecutor({
    repoRoot: "/repo",
    env: {},
    mayRunImpl: allowApply,
    loadAutomationImpl: () => ({ data: { session: { provider: "orca" } } }),
    runOrcaImpl: async () => {
      throw new Error("Command failed: orca click --page browser-page-123 --element @e9 --json");
    },
  });

  const result = await execute({
    applicationId: "app-private-command",
    application: {},
    postingUrl: FORM_SNAPSHOT.origin,
  });

  assert.equal(result.state, "unavailable");
  assert.equal(
    result.reason,
    "The Orca supervised browser couldn't open the application. Check Browser automation in Settings and try again."
  );
  assert.doesNotMatch(result.reason, /orca click|--page|@e9|Command failed/i);
});
