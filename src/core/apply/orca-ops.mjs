import { execFile } from "node:child_process";

// ---------------------------------------------------------------------------
// Orca CLI plumbing
// ---------------------------------------------------------------------------

function orcaExecutable(env) {
  const configured = String(env?.ORCA_CLI_COMMAND || "").trim();
  if (configured && !/\s/.test(configured)) return configured;
  return process.platform === "linux" && !env?.ORCA_WORKTREE_ID ? "orca-ide" : "orca";
}

export function runOrcaCommand(args, { env = process.env, cwd } = {}) {
  return new Promise((resolve, reject) => {
    execFile(
      orcaExecutable(env),
      args,
      {
        cwd,
        env,
        encoding: "utf8",
        maxBuffer: 12 * 1024 * 1024,
        timeout: 30_000,
        windowsHide: true,
      },
      (error, stdout) => {
        let payload = null;
        try {
          payload = JSON.parse(String(stdout || ""));
        } catch {
          payload = null;
        }
        if (error || !payload?.ok) {
          const failure = new Error(
            payload?.error?.message || error?.message || "The Orca browser command failed."
          );
          failure.code = payload?.error?.code || error?.code || "ORCA_BROWSER_FAILED";
          reject(failure);
          return;
        }
        resolve(payload.result || {});
      }
    );
  });
}

// ---------------------------------------------------------------------------
// Snapshot normalization — pinned NormalizedSnapshot contract, shared with the
// future Playwright ops adapter: { origin, pageText, refs: { [ref]: { role, name, required } } }.
// `required` is parsed once here from the raw "[required, ref=eN]" markers so
// the driver never re-parses accessibility-tree text for it.
// ---------------------------------------------------------------------------

function requiredRefsFromText(snapshotText) {
  const required = new Set();
  for (const line of String(snapshotText || "").split(/\r?\n/)) {
    const match = line.match(/ref=([\w-]+)/);
    if (match && /\[.*\brequired\b.*\]/.test(line)) required.add(match[1]);
  }
  return required;
}

function normalizeText(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function snapshotNodes(snapshotText) {
  const nodes = [];
  for (const rawLine of String(snapshotText || "").split(/\r?\n/)) {
    const match = rawLine.match(/^(\s*)-\s+([\w-]+)(?:\s+"([^"]*)")?(.*)$/);
    if (!match) continue;
    const tail = match[4] || "";
    nodes.push({
      indent: match[1].length,
      role: match[2].toLowerCase(),
      name: String(match[3] || "").trim(),
      ref: tail.match(/\bref=([\w-]+)/)?.[1] || null,
      required: /\[.*\brequired\b.*\]/.test(tail),
      value: tail.match(/\]\s*:\s*(.*)$/)?.[1]?.trim() ?? "",
      stateKnown: /\]\s*:/.test(tail),
    });
  }
  return nodes;
}

function labelContexts(nodes) {
  const contexts = [];
  for (let index = 0; index < nodes.length; index += 1) {
    const labelNode = nodes[index];
    if (labelNode.role !== "labeltext") continue;

    let childEnd = index + 1;
    const labelParts = [];
    while (childEnd < nodes.length && nodes[childEnd].indent > labelNode.indent) {
      if (nodes[childEnd].role === "statictext" && nodes[childEnd].name) {
        labelParts.push(nodes[childEnd].name);
      }
      childEnd += 1;
    }
    const required = labelParts.some((part) => part.trim() === "*");
    const label = labelParts
      .filter((part) => part.trim() !== "*")
      .join(" ")
      .replace(/\s+/g, " ")
      .trim();
    if (!label) continue;

    let boundary = childEnd;
    while (
      boundary < nodes.length &&
      !(nodes[boundary].role === "labeltext" && nodes[boundary].indent <= labelNode.indent)
    ) {
      boundary += 1;
    }
    const controls = nodes
      .slice(childEnd, boundary)
      .filter(
        (node) =>
          node.ref && ["textbox", "combobox", "checkbox", "radio", "button"].includes(node.role)
      );
    if (!controls.length) continue;
    contexts.push({ label, required, controls });
  }
  return contexts;
}

function nestedInteractiveRefs(nodes) {
  const nested = new Set();
  for (let index = 0; index < nodes.length; index += 1) {
    const node = nodes[index];
    if (!node.ref) continue;
    for (let cursor = index + 1; cursor < nodes.length; cursor += 1) {
      if (nodes[cursor].indent <= node.indent) break;
      if (
        nodes[cursor].ref &&
        ["textbox", "combobox", "checkbox", "radio", "button"].includes(nodes[cursor].role)
      ) {
        nested.add(node.ref);
        break;
      }
    }
  }
  return nested;
}

function probeByLabel(probe = []) {
  return new Map(
    (Array.isArray(probe) ? probe : [])
      .filter((entry) => entry?.label)
      .map((entry) => [normalizeText(entry.label), entry])
  );
}

function normalizeSnapshot(raw = {}, probe = []) {
  const requiredRefs = requiredRefsFromText(raw.snapshot);
  const nodes = snapshotNodes(raw.snapshot);
  const nodeByRef = new Map(nodes.filter((node) => node.ref).map((node) => [node.ref, node]));
  const nestedRefs = nestedInteractiveRefs(nodes);
  const refs = {};
  for (const [ref, entry] of Object.entries(raw.refs || {})) {
    const node = nodeByRef.get(ref);
    refs[ref] = {
      role: entry?.role,
      name: entry?.name,
      required: requiredRefs.has(ref),
      ...(node?.stateKnown ? { stateKnown: true, value: node.value } : {}),
      ...(nestedRefs.has(ref) ? { field: false } : {}),
    };
  }

  const probed = probeByLabel(probe);
  for (const context of labelContexts(nodes)) {
    const yesNo = context.controls.filter(
      (control) => control.role === "button" && ["yes", "no"].includes(normalizeText(control.name))
    );
    if (
      yesNo.some((control) => normalizeText(control.name) === "yes") &&
      yesNo.some((control) => normalizeText(control.name) === "no")
    ) {
      const first = yesNo[0];
      const state = probed.get(normalizeText(context.label));
      refs[first.ref] = {
        role: "radio-group",
        name: context.label,
        required: context.required,
        options: yesNo.map((control) => ({ label: control.name, ref: control.ref })),
        ...(state?.stateKnown ? { stateKnown: true, value: String(state.value || "") } : {}),
      };
      continue;
    }

    const control = context.controls.find((candidate) =>
      ["textbox", "combobox", "checkbox", "radio"].includes(candidate.role)
    );
    if (!control || !refs[control.ref]) continue;
    const placeholderName = /^(?:start typing|type here|search|select|choose)(?:\.{3})?$/i.test(
      String(refs[control.ref].name || "").trim()
    );
    const state = probed.get(normalizeText(context.label));
    refs[control.ref] = {
      ...refs[control.ref],
      ...(placeholderName ? { name: context.label } : {}),
      required: refs[control.ref].required || context.required,
      ...(control.role === "combobox" && placeholderName ? { typeahead: true } : {}),
      ...(state?.stateKnown ? { stateKnown: true, value: String(state.value || "") } : {}),
    };
  }
  return { origin: raw.origin, pageText: raw.snapshot, refs };
}

const FORM_STATE_EXPRESSION = `JSON.stringify(Array.from(document.querySelectorAll("label")).map((label) => {
  const root = label.closest("[data-field-entry-id], fieldset") || label.parentElement;
  const controls = Array.from(root?.querySelectorAll("input, textarea, select, button, [role='combobox']") || []);
  const yesNo = controls.filter((control) => control.tagName === "BUTTON" && /^(yes|no)$/i.test((control.innerText || "").trim()));
  const valueControl = controls.find((control) => control.getAttribute("role") === "combobox" || ["INPUT", "TEXTAREA", "SELECT"].includes(control.tagName));
  return {
    label: (label.innerText || "").trim(),
    required: /required/i.test(String(label.className || "")) || controls.some((control) => control.required === true || control.getAttribute("aria-required") === "true"),
    stateKnown: yesNo.length >= 2 || Boolean(valueControl),
    value: String(valueControl?.value || ""),
    yesNo: yesNo.map((control) => ({
      text: (control.innerText || "").trim(),
      pressed: control.getAttribute("aria-pressed") === "true",
      className: String(control.className || "")
    }))
  };
}))`;

function needsFormStateProbe(raw = {}) {
  const text = String(raw.snapshot || "");
  return (
    /LabelText[\s\S]*combobox "(?:Start typing|Type here|Search|Select|Choose)/i.test(text) ||
    /LabelText[\s\S]*button "Yes"[\s\S]*button "No"/i.test(text)
  );
}

function parseFormState(result = {}) {
  try {
    const parsed = JSON.parse(String(result.result || "[]"));
    if (!Array.isArray(parsed)) return [];
    return parsed.map((entry) => {
      const yesNo = Array.isArray(entry?.yesNo) ? entry.yesNo : [];
      if (yesNo.length < 2) return entry;
      const selected = yesNo.find(
        (option) =>
          option?.pressed === true ||
          /(?:^|\s|_)active(?:\s|_|$)/i.test(String(option?.className || ""))
      );
      return {
        ...entry,
        stateKnown: true,
        value: String(selected?.text || ""),
      };
    });
  } catch {
    return [];
  }
}

function optionMatch(entries, requested) {
  const wanted = normalizeText(requested);
  if (!wanted) return null;
  const exact = entries.find((entry) => normalizeText(entry?.name) === wanted);
  if (exact) return exact;
  const prefixes = entries.filter((entry) => {
    const option = normalizeText(entry?.name);
    return option.startsWith(`${wanted} `) || wanted.startsWith(`${option} `);
  });
  if (prefixes.length === 1) return prefixes[0];
  const city = normalizeText(String(requested || "").split(",")[0]);
  const cityPrefixes = entries.filter((entry) => normalizeText(entry?.name).startsWith(`${city} `));
  return cityPrefixes.length === 1 ? cityPrefixes[0] : null;
}

function selectedValueMatches(actual, expected) {
  const selected = normalizeText(actual);
  const wanted = normalizeText(expected);
  if (!selected || !wanted) return false;
  if (selected === wanted || selected.includes(wanted) || wanted.includes(selected)) return true;
  const city = normalizeText(String(expected || "").split(",")[0]);
  return Boolean(city && selected.startsWith(`${city} `));
}

// ---------------------------------------------------------------------------
// createOrcaOps — Orca CLI implementation of the provider-neutral ops contract.
// ---------------------------------------------------------------------------

export function createOrcaOps({ runOrcaImpl } = {}) {
  async function snapshot(pageId) {
    const raw = await runOrcaImpl(["snapshot", "--page", pageId, "--json"]);
    let probe = [];
    if (needsFormStateProbe(raw)) {
      try {
        const inspected = await runOrcaImpl([
          "eval",
          "--page",
          pageId,
          "--expression",
          FORM_STATE_EXPRESSION,
          "--json",
        ]);
        probe = parseFormState(inspected);
      } catch {
        probe = [];
      }
    }
    return normalizeSnapshot(raw, probe);
  }

  return {
    async openTab({ url }) {
      const opened = await runOrcaImpl(["tab", "create", "--url", url, "--json"]);
      return { pageId: String(opened?.browserPageId || "").trim() };
    },
    async focusTab({ pageId }) {
      return runOrcaImpl(["tab", "switch", "--page", pageId, "--json"]);
    },
    async snapshot({ pageId }) {
      return snapshot(pageId);
    },
    async fillField({ pageId, ref, value }) {
      return runOrcaImpl([
        "fill",
        "--page",
        pageId,
        "--element",
        `@${ref}`,
        "--value",
        String(value),
        "--json",
      ]);
    },
    async selectOption({ pageId, ref, label, value, typeahead = false }) {
      if (!typeahead) {
        await runOrcaImpl([
          "select",
          "--page",
          pageId,
          "--element",
          `@${ref}`,
          "--value",
          String(value),
          "--json",
        ]);
        const after = await snapshot(pageId);
        const field = Object.values(after.refs).find(
          (entry) => normalizeText(entry?.name) === normalizeText(label)
        );
        if (field?.stateKnown && !selectedValueMatches(field.value, value)) {
          throw new Error(`The field still showed "${field.value || "blank"}" after selection.`);
        }
        return {};
      }

      await runOrcaImpl([
        "fill",
        "--page",
        pageId,
        "--element",
        `@${ref}`,
        "--value",
        String(value),
        "--json",
      ]);
      await runOrcaImpl(["wait", "--page", pageId, "--selector", "[role='option']", "--json"]);
      const optionsSnapshot = await runOrcaImpl(["snapshot", "--page", pageId, "--json"]);
      const options = Object.entries(optionsSnapshot.refs || {})
        .filter(([, entry]) => String(entry?.role || "").toLowerCase() === "option")
        .map(([optionRef, entry]) => ({ ref: optionRef, name: String(entry?.name || "") }));
      const option = optionMatch(options, value);
      if (!option) throw new Error(`No unambiguous option matched "${value}".`);
      await runOrcaImpl(["click", "--page", pageId, "--element", `@${option.ref}`, "--json"]);
      const after = await snapshot(pageId);
      const field = Object.values(after.refs).find(
        (entry) => normalizeText(entry?.name) === normalizeText(label)
      );
      if (!field?.stateKnown || !selectedValueMatches(field.value, option.name)) {
        throw new Error(`The field did not keep the selected option "${option.name}".`);
      }
      return {};
    },
    async toggleField({ pageId, ref }) {
      return runOrcaImpl(["check", "--page", pageId, "--element", `@${ref}`, "--json"]);
    },
    async chooseButtonOption({ pageId, ref }) {
      await runOrcaImpl(["focus", "--page", pageId, "--element", `@${ref}`, "--json"]);
      return runOrcaImpl(["keypress", "--page", pageId, "--key", "Enter", "--json"]);
    },
    async clickButton({ pageId, ref }) {
      return runOrcaImpl(["click", "--page", pageId, "--element", `@${ref}`, "--json"]);
    },
    async upload({ pageId, ref, files }) {
      return runOrcaImpl([
        "upload",
        "--page",
        pageId,
        "--element",
        `@${ref}`,
        "--files",
        files,
        "--json",
      ]);
    },
    async screenshot({ pageId }) {
      const shot = await runOrcaImpl(["screenshot", "--page", pageId, "--json"]);
      return { data: shot.data, format: shot.format };
    },
  };
}
