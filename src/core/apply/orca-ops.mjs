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

const SAFE_ADVANCE_LABELS = new Set([
  "next",
  "next step",
  "continue",
  "continue applying",
  "save and continue",
  "review",
  "review your application",
]);

function isExactAdvanceLabel(value) {
  return SAFE_ADVANCE_LABELS.has(normalizeText(value));
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

function normalizeSnapshot(raw = {}, probe = [], safeAdvanceLabels = []) {
  const requiredRefs = requiredRefsFromText(raw.snapshot);
  const nodes = snapshotNodes(raw.snapshot);
  const nodeByRef = new Map(nodes.filter((node) => node.ref).map((node) => [node.ref, node]));
  const nestedRefs = nestedInteractiveRefs(nodes);
  const refs = {};
  const buttonLabelCounts = new Map();
  for (const entry of Object.values(raw.refs || {})) {
    if (String(entry?.role || "").toLowerCase() !== "button") continue;
    const label = normalizeText(entry?.name);
    if (label) buttonLabelCounts.set(label, (buttonLabelCounts.get(label) || 0) + 1);
  }
  const safeLabels = new Set(
    safeAdvanceLabels.map((label) => normalizeText(label)).filter(Boolean)
  );
  for (const [ref, entry] of Object.entries(raw.refs || {})) {
    const node = nodeByRef.get(ref);
    const normalizedName = normalizeText(entry?.name);
    refs[ref] = {
      role: entry?.role,
      name: entry?.name,
      required: requiredRefs.has(ref),
      ...(node?.stateKnown ? { stateKnown: true, value: node.value } : {}),
      ...(nestedRefs.has(ref) ? { field: false } : {}),
      ...(String(entry?.role || "").toLowerCase() === "button" &&
      isExactAdvanceLabel(entry?.name) &&
      buttonLabelCounts.get(normalizedName) === 1 &&
      safeLabels.has(normalizedName)
        ? { advanceSafe: true }
        : {}),
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

const ADVANCE_SAFETY_EXPRESSION = `JSON.stringify((() => {
  const visible = (el) => { const rect=el.getBoundingClientRect(); const style=getComputedStyle(el); return rect.width>0 && rect.height>0 && style.visibility!=="hidden" && style.display!=="none"; };
  const label = (el) => String(el.getAttribute("aria-label") || el.innerText || el.value || el.getAttribute("name") || "").replace(/\\s+/g," ").trim();
  const normalized = (value) => String(value||"").toLowerCase().replace(/[^a-z0-9]+/g," ").replace(/\\s+/g," ").trim();
  const exactLabels = new Set(["next","next step","continue","continue applying","save and continue","review","review your application"]);
  const safeControl = (el) => { if(!exactLabels.has(normalized(label(el)))) return false; if(el.tagName==="BUTTON"||el.tagName==="INPUT"){ const fallback=el.tagName==="BUTTON"?"submit":""; return String(el.type||el.getAttribute("type")||fallback).toLowerCase()==="button"; } return String(el.getAttribute("role")||"").toLowerCase()==="button"; };
  const progressName = (el) => { const direct=String(el.getAttribute("aria-label")||"").trim(); if(direct) return direct; const labelled=String(el.getAttribute("aria-labelledby")||"").split(/\\s+/).filter(Boolean).map((id)=>document.getElementById(id)?.innerText||"").join(" ").trim(); return labelled||String(el.getAttribute("title")||el.innerText||"").trim(); };
  const stepProgress = (el) => { const name=normalized(progressName(el)); return /\\bsteps?\\b/.test(name)||(/\\b(?:application|form)\\b/.test(name)&&/\\bprogress\\b/.test(name)); };
  const scopeFor = (el) => { let node=el.parentElement; while(node){ const role=String(node.getAttribute("role")||"").toLowerCase(); if(node.tagName==="FORM" || role==="form" || role==="dialog") return node; node=node.parentElement; } return null; };
  const hasRemaining = (button) => { const scope=scopeFor(button); if(!scope) return false; for(const progress of scope.querySelectorAll("progress,[role='progressbar']")){ if(!visible(progress)||!stepProgress(progress)) continue; const current=Number(progress.value ?? progress.getAttribute("aria-valuenow")); const total=Number(progress.max ?? progress.getAttribute("aria-valuemax")); const minimum=Number(progress.getAttribute("aria-valuemin") ?? 0); if(Number.isFinite(current)&&Number.isFinite(total)&&Number.isFinite(minimum)&&total>minimum&&current>=minimum&&current<total) return true; } for(const marker of scope.querySelectorAll("[aria-current='step']")){ const siblings=Array.from(marker.parentElement?.children||[]).filter((candidate)=>{ if(!visible(candidate)) return false; const role=String(candidate.getAttribute("role")||"").toLowerCase(); return candidate.tagName==="LI" || ["listitem","step","tab"].includes(role); }); const index=siblings.indexOf(marker); if(siblings.length>1&&index>=0&&index<siblings.length-1) return true; } for(const progress of scope.querySelectorAll("[data-current-step]")){ const current=Number(progress.getAttribute("data-current-step")); const total=Number(progress.getAttribute("data-total-steps")); if(Number.isSafeInteger(current)&&Number.isSafeInteger(total)&&current>=1&&total>current) return true; } return false; };
  return Array.from(document.querySelectorAll("button,input[type='button'],input[type='submit'],[role='button']")).filter((button)=>visible(button)&&safeControl(button)&&hasRemaining(button)).map(label).filter(Boolean);
})())`;

function needsAdvanceSafetyProbe(raw = {}) {
  return Object.values(raw.refs || {}).some((entry) => {
    if (String(entry?.role || "").toLowerCase() !== "button") return false;
    return isExactAdvanceLabel(entry?.name);
  });
}

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

function encodedDataExpression(value) {
  const encoded = Buffer.from(JSON.stringify(value), "utf8").toString("base64");
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) {
    throw new Error("Browser probe data could not be encoded safely.");
  }
  return `JSON.parse(new TextDecoder().decode(Uint8Array.from(atob("${encoded}"),(character)=>character.charCodeAt(0))))`;
}

// ---------------------------------------------------------------------------
// createOrcaOps — Orca CLI implementation of the provider-neutral ops contract.
// ---------------------------------------------------------------------------

export function createOrcaOps({ runOrcaImpl } = {}) {
  async function evaluate(pageId, expression) {
    const response = await runOrcaImpl([
      "eval",
      "--page",
      pageId,
      "--expression",
      expression,
      "--json",
    ]);
    return response?.result;
  }

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
    let safeAdvanceLabels = [];
    if (needsAdvanceSafetyProbe(raw)) {
      try {
        const inspected = await runOrcaImpl([
          "eval",
          "--page",
          pageId,
          "--expression",
          ADVANCE_SAFETY_EXPRESSION,
          "--json",
        ]);
        const parsed = JSON.parse(String(inspected?.result || "[]"));
        safeAdvanceLabels = Array.isArray(parsed) ? parsed : [];
      } catch {
        safeAdvanceLabels = [];
      }
    }
    return normalizeSnapshot(raw, probe, safeAdvanceLabels);
  }

  return {
    async openTab({ url }) {
      const opened = await runOrcaImpl(["tab", "create", "--url", url, "--json"]);
      return { pageId: String(opened?.browserPageId || "").trim() };
    },
    async focusTab({ pageId }) {
      return runOrcaImpl(["tab", "switch", "--page", pageId, "--json"]);
    },
    async navigate({ pageId, url }) {
      await runOrcaImpl(["navigate", "--page", pageId, "--url", String(url), "--json"]);
      return { pageId, url: String(url) };
    },
    async back({ pageId }) {
      await runOrcaImpl(["keypress", "--page", pageId, "--key", "ALT+LEFT", "--json"]);
      return { pageId };
    },
    async pageContent({ pageId, maxText = 20_000 }) {
      const bounded = Math.min(Math.max(Number(maxText) || 20_000, 1), 100_000);
      const raw = await evaluate(
        pageId,
        `JSON.stringify({url:location.href,title:document.title,text:String(document.body?.innerText||"").slice(0,${bounded})})`
      );
      return JSON.parse(String(raw || "{}"));
    },
    async extractText({ pageId, selectors, maxText = 20_000 }) {
      const input = encodedDataExpression({
        selectors: (Array.isArray(selectors) ? selectors : [selectors])
          .map((value) => String(value || "").trim())
          .filter(Boolean)
          .slice(0, 12),
        maxText: Math.min(Math.max(Number(maxText) || 20_000, 1), 100_000),
      });
      const raw = await evaluate(
        pageId,
        `(() => { const input=${input}; for(const selector of input.selectors){const matches=Array.from(document.querySelectorAll(selector));if(!matches.length)continue;return JSON.stringify({selector,text:matches.map((node)=>String(node.innerText||node.textContent||"").trim()).filter(Boolean).join("\\n\\n").slice(0,input.maxText)});}return JSON.stringify({selector:null,text:""});})()`
      );
      return JSON.parse(String(raw || "{}"));
    },
    async extractRows({ pageId, rowSelectors, fields, maxRows = 100 }) {
      const input = encodedDataExpression({
        selectors: (Array.isArray(rowSelectors) ? rowSelectors : [rowSelectors])
          .map((value) => String(value || "").trim())
          .filter(Boolean)
          .slice(0, 12),
        fields: Object.fromEntries(
          Object.entries(fields && typeof fields === "object" ? fields : {}).slice(0, 24)
        ),
        maxRows: Math.min(Math.max(Number(maxRows) || 100, 1), 250),
      });
      const raw = await evaluate(
        pageId,
        `(() => { const input=${input}; const first=(root,values)=>{ for(const selector of (Array.isArray(values)?values:[values])) { if(!selector) continue; const found=selector===":scope"?root:root.querySelector(selector); if(found) return found; } return null; }; let rowSelector=null; let rows=[]; for(const selector of input.selectors){ const matches=Array.from(document.querySelectorAll(selector)); if(matches.length){rowSelector=selector;rows=matches.slice(0,input.maxRows);break;} } return JSON.stringify({rowSelector,rows:rows.map((row,index)=>{const output={index};for(const [name,value] of Object.entries(input.fields)){const spec=value&&typeof value==="object"?value:{};const node=first(row,spec.selectors||":scope");if(!node)output[name]="";else if(spec.kind==="href")output[name]=node.href||node.getAttribute("href")||"";else if(spec.kind==="attr")output[name]=node.getAttribute(String(spec.attribute||""))||"";else output[name]=String(node.innerText||node.textContent||"").trim();}return output;})}); })()`
      );
      return JSON.parse(String(raw || "{}"));
    },
    async clickRow({ pageId, rowSelector, index }) {
      const input = encodedDataExpression({
        selector: String(rowSelector),
        position: Math.max(Number(index) || 0, 0),
      });
      await evaluate(
        pageId,
        `(() => { const input=${input}; const row=document.querySelectorAll(input.selector)[input.position]; if(!row) throw new Error("row not found"); row.click(); return location.href; })()`
      );
      return { pageId };
    },
    async scroll({ pageId, amount = 900 }) {
      const delta = Math.min(Math.max(Number(amount) || 900, -5_000), 5_000);
      await evaluate(pageId, `window.scrollBy(0,${delta}); location.href`);
      return { pageId };
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
    async selectOption({ pageId, ref, value, typeahead = false }) {
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
        const field = after.refs?.[ref];
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
      const field = after.refs?.[ref];
      if (!field?.stateKnown || !selectedValueMatches(field.value, option.name)) {
        throw new Error(`The field did not keep the selected option "${option.name}".`);
      }
      return {};
    },
    async toggleField({ pageId, ref, checked }) {
      return runOrcaImpl([
        checked ? "check" : "uncheck",
        "--page",
        pageId,
        "--element",
        `@${ref}`,
        "--json",
      ]);
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
