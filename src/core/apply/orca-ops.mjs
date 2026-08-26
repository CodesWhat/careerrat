import { execFile } from "node:child_process";

import { uniqueVoluntaryDeclineOption } from "./form-fill.mjs";

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
const OPTION_SNAPSHOT_ATTEMPTS = 5;
const OPTION_SNAPSHOT_DELAY_MS = 250;

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
      expanded: /\bexpanded=true\b/.test(tail),
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
    const probedTypeahead = control.role === "combobox" && state?.typeahead === true;
    const currentField = { ...refs[control.ref] };
    if (probedTypeahead) {
      delete currentField.stateKnown;
      delete currentField.value;
    }
    refs[control.ref] = {
      ...currentField,
      ...(placeholderName ? { name: context.label } : {}),
      required: refs[control.ref].required || context.required,
      ...(control.role === "combobox" && (placeholderName || state?.typeahead === true)
        ? { typeahead: true }
        : {}),
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
  const displayScope = valueControl?.closest("[class*='control']") || valueControl?.parentElement;
  const displayedValue = Array.from(displayScope?.querySelectorAll("[class*='single-value'], [class*='multi-value']") || []).map((node) => String(node.innerText || node.textContent || "").trim()).filter(Boolean).join(", ");
  const typeahead = valueControl?.tagName === "INPUT" && valueControl.getAttribute("role") === "combobox";
  const typedButUncommitted = typeahead && Boolean(String(valueControl?.value || "").trim()) && !displayedValue;
  return {
    label: (label.innerText || "").trim(),
    required: /required/i.test(String(label.className || "")) || controls.some((control) => control.required === true || control.getAttribute("aria-required") === "true"),
    stateKnown: yesNo.length >= 2 || Boolean(valueControl && !typedButUncommitted),
    value: typeahead ? displayedValue : displayedValue || String(valueControl?.value || ""),
    typeahead,
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
  return (
    Object.values(raw.refs || {}).some(
      (entry) => String(entry?.role || "").toLowerCase() === "combobox"
    ) || /LabelText[\s\S]*button "Yes"[\s\S]*button "No"/i.test(String(raw.snapshot || ""))
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

function optionsForField(raw, ref, label) {
  const entries = Object.entries(raw.refs || {})
    .filter(([, entry]) => String(entry?.role || "").toLowerCase() === "option")
    .map(([optionRef, entry]) => ({ ref: optionRef, name: String(entry?.name || "") }));
  if (!entries.length) return [];

  const nodes = snapshotNodes(raw.snapshot);
  let controlIndex = nodes.findIndex((node) => node.ref === ref && node.role === "combobox");
  if (controlIndex < 0) {
    const wanted = normalizeText(label);
    const matches = nodes
      .map((node, index) => ({ node, index }))
      .filter(
        ({ node }) => node.role === "combobox" && normalizeText(node.name) === wanted && wanted
      );
    if (matches.length === 1) controlIndex = matches[0].index;
  }
  if (controlIndex < 0) return entries;

  let labelIndex = controlIndex - 1;
  while (labelIndex >= 0 && nodes[labelIndex].role !== "labeltext") labelIndex -= 1;
  if (labelIndex < 0) return entries;
  let boundary = controlIndex + 1;
  while (boundary < nodes.length && nodes[boundary].role !== "labeltext") {
    boundary += 1;
  }
  const ownedRefs = new Set(
    nodes
      .slice(controlIndex + 1, boundary)
      .filter((node) => node.role === "option" && node.ref)
      .map((node) => node.ref)
  );
  return entries.filter((entry) => ownedRefs.has(entry.ref));
}

function comboboxRefForField(raw, label) {
  const wanted = normalizeText(label);
  if (!wanted) return null;
  const matches = Object.entries(raw.refs || {}).filter(
    ([, entry]) =>
      String(entry?.role || "").toLowerCase() === "combobox" &&
      normalizeText(entry?.name) === wanted
  );
  return matches.length === 1 ? matches[0][0] : null;
}

function comboboxIsExpanded(raw, ref, label) {
  const nodes = snapshotNodes(raw.snapshot);
  const direct = nodes.find((node) => node.ref === ref && node.role === "combobox");
  if (direct) return direct.expanded;
  const wanted = normalizeText(label);
  const matches = nodes.filter(
    (node) => node.role === "combobox" && normalizeText(node.name) === wanted && wanted
  );
  return matches.length === 1 && matches[0].expanded;
}

function typeaheadSelectionAttempts(value, optionAliases = []) {
  return [value, ...(Array.isArray(optionAliases) ? optionAliases : [])]
    .flatMap((candidate) => {
      const requested = String(candidate || "").trim();
      const withoutSentencePunctuation = requested.replace(/[.,;!]+$/, "").trim();
      return [requested, withoutSentencePunctuation]
        .filter(Boolean)
        .map((query) => ({ query, match: requested }));
    })
    .filter(
      (entry, index, entries) =>
        entries.findIndex(
          (item) => item.query.toLocaleLowerCase() === entry.query.toLocaleLowerCase()
        ) === index
    );
}

function selectedValueMatches(actual, expected) {
  const selected = normalizeText(actual);
  const wanted = normalizeText(expected);
  if (!selected || !wanted) return false;
  if (selected === wanted || selected.includes(wanted) || wanted.includes(selected)) return true;
  const city = normalizeText(String(expected || "").split(",")[0]);
  return Boolean(city && selected.startsWith(`${city} `));
}

function selectedField(snapshot, ref, label) {
  const direct = snapshot.refs?.[ref];
  const wanted = normalizeText(label);
  if (
    direct &&
    String(direct?.role || "").toLowerCase() === "combobox" &&
    (!wanted || normalizeText(direct?.name) === wanted)
  ) {
    return direct;
  }
  if (!wanted) return null;
  const matches = Object.values(snapshot.refs || {}).filter(
    (field) =>
      String(field?.role || "").toLowerCase() === "combobox" &&
      normalizeText(field?.name) === wanted
  );
  return matches.length === 1 ? matches[0] : null;
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

  async function dismissOpenOptions(pageId) {
    try {
      await runOrcaImpl(["keypress", "--page", pageId, "--key", "Escape", "--json"]);
    } catch {
      // The original field failure remains the actionable result.
    }
  }

  async function scrollFieldIntoView(pageId, label) {
    const input = encodedDataExpression({ label: normalizeText(label) });
    await evaluate(
      pageId,
      `(() => { const input=${input}; const normalize=(value)=>String(value||"").toLowerCase().replace(/[^a-z0-9]+/g," ").replace(/\\s+/g," ").trim(); const fields=Array.from(document.querySelectorAll("[role='combobox']")); const matches=fields.filter((field)=>{const direct=field.getAttribute("aria-label")||"";const labelled=String(field.getAttribute("aria-labelledby")||"").split(/\\s+/).filter(Boolean).map((id)=>document.getElementById(id)?.innerText||"").join(" ");return normalize(direct||labelled)===input.label;}); if(matches.length!==1)return false; matches[0].scrollIntoView({block:"center",inline:"nearest"}); return true; })()`
    );
  }

  async function openTypeaheadControl(pageId, label) {
    const input = encodedDataExpression({ label: normalizeText(label) });
    await evaluate(
      pageId,
      `(() => { const input=${input}; const normalize=(value)=>String(value||"").toLowerCase().replace(/[^a-z0-9]+/g," ").replace(/\\s+/g," ").trim(); const fields=Array.from(document.querySelectorAll("[role='combobox']")); const matches=fields.filter((field)=>{const direct=field.getAttribute("aria-label")||"";const labelled=String(field.getAttribute("aria-labelledby")||"").split(/\\s+/).filter(Boolean).map((id)=>document.getElementById(id)?.innerText||"").join(" ");return normalize(direct||labelled)===input.label;}); if(matches.length!==1)return false; const field=matches[0]; const control=field.closest(".select__control")||field; field.focus({preventScroll:true}); for(const type of ["pointerdown","mousedown","pointerup","mouseup","click"]){control.dispatchEvent(new MouseEvent(type,{bubbles:true,cancelable:true,view:window,button:0,buttons:type.includes("down")?1:0}));} return true; })()`
    );
  }

  async function chooseExactOpenOption(pageId, value) {
    const input = encodedDataExpression({ value: normalizeText(value) });
    const result = await evaluate(
      pageId,
      `(() => { const input=${input}; const normalize=(value)=>String(value||"").toLowerCase().replace(/[^a-z0-9]+/g," ").replace(/\\s+/g," ").trim(); const options=Array.from(document.querySelectorAll("[role='option']")).filter((option)=>{const rect=option.getBoundingClientRect();const style=getComputedStyle(option);return rect.width>0&&rect.height>0&&style.visibility!=="hidden"&&style.display!=="none"&&normalize(option.innerText||option.textContent)===input.value;}); if(options.length!==1)return false; const option=options[0]; for(const type of ["pointerdown","mousedown","pointerup","mouseup","click"]){option.dispatchEvent(new MouseEvent(type,{bubbles:true,cancelable:true,view:window,button:0,buttons:type.includes("down")?1:0}));} return true; })()`
    );
    return result === true || String(result) === "true";
  }

  async function confirmedSelectedField(pageId, ref, label, expected) {
    let field = null;
    for (let attempt = 0; attempt < OPTION_SNAPSHOT_ATTEMPTS; attempt += 1) {
      const after = await snapshot(pageId);
      field = selectedField(after, ref, label);
      if (field?.stateKnown === true && selectedValueMatches(field.value, expected)) return field;
      if (attempt < OPTION_SNAPSHOT_ATTEMPTS - 1) {
        await runOrcaImpl([
          "wait",
          "--page",
          pageId,
          "--timeout",
          String(OPTION_SNAPSHOT_DELAY_MS),
          "--json",
        ]);
      }
    }
    return field;
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
    async selectOption({ pageId, ref, label, value, typeahead = false, optionAliases = [] }) {
      if (!typeahead) {
        const candidates = [value, ...(Array.isArray(optionAliases) ? optionAliases : [])]
          .map((candidate) => String(candidate || "").trim())
          .filter(
            (candidate, index, entries) =>
              candidate &&
              entries.findIndex((entry) => normalizeText(entry) === normalizeText(candidate)) ===
                index
          );
        let lastField = null;
        let selectedAttemptRan = false;
        let lastError = null;
        for (const candidate of candidates) {
          try {
            await runOrcaImpl([
              "select",
              "--page",
              pageId,
              "--element",
              `@${ref}`,
              "--value",
              candidate,
              "--json",
            ]);
            selectedAttemptRan = true;
            lastField = await confirmedSelectedField(pageId, ref, label, candidate);
            if (lastField?.stateKnown && selectedValueMatches(lastField.value, candidate)) {
              return { selectedValue: lastField.value };
            }
          } catch (error) {
            lastError = error;
          }
        }
        if (!selectedAttemptRan && lastError) throw lastError;
        if (lastField?.stateKnown !== true) {
          throw new Error("The field's selected value could not be confirmed.");
        }
        throw new Error(`The field still showed "${lastField.value || "blank"}" after selection.`);
      }

      let option = null;
      const attempts = typeaheadSelectionAttempts(value, optionAliases);
      await scrollFieldIntoView(pageId, label);
      let optionsSnapshot = await runOrcaImpl(["snapshot", "--page", pageId, "--json"]);
      let currentRef = comboboxRefForField(optionsSnapshot, label) || ref;
      await runOrcaImpl(["click", "--page", pageId, "--element", `@${currentRef}`, "--json"]);
      optionsSnapshot = await runOrcaImpl(["snapshot", "--page", pageId, "--json"]);
      currentRef = comboboxRefForField(optionsSnapshot, label) || currentRef;
      if (!comboboxIsExpanded(optionsSnapshot, currentRef, label)) {
        await openTypeaheadControl(pageId, label);
        optionsSnapshot = await runOrcaImpl(["snapshot", "--page", pageId, "--json"]);
        currentRef = comboboxRefForField(optionsSnapshot, label) || currentRef;
      }
      const openOptions = optionsForField(optionsSnapshot, currentRef, label);
      option = attempts
        .map((attemptValue) => optionMatch(openOptions, attemptValue.match))
        .find(Boolean);
      for (const attemptValue of attempts) {
        if (option) break;
        await runOrcaImpl([
          "fill",
          "--page",
          pageId,
          "--element",
          `@${currentRef}`,
          "--value",
          attemptValue.query,
          "--json",
        ]);
        let options = [];
        for (let attempt = 0; attempt < OPTION_SNAPSHOT_ATTEMPTS; attempt += 1) {
          optionsSnapshot = await runOrcaImpl(["snapshot", "--page", pageId, "--json"]);
          currentRef = comboboxRefForField(optionsSnapshot, label) || currentRef;
          options = optionsForField(optionsSnapshot, currentRef, label);
          option = optionMatch(options, attemptValue.match);
          if (option) break;
          if (attempt < OPTION_SNAPSHOT_ATTEMPTS - 1) {
            await runOrcaImpl([
              "wait",
              "--page",
              pageId,
              "--timeout",
              String(OPTION_SNAPSHOT_DELAY_MS),
              "--json",
            ]);
          }
        }
      }
      if (!option) {
        await dismissOpenOptions(pageId);
        throw new Error(`No unambiguous option matched "${value}".`);
      }
      const selectedThroughDom = await chooseExactOpenOption(pageId, option.name);
      if (!selectedThroughDom) {
        await runOrcaImpl(["click", "--page", pageId, "--element", `@${option.ref}`, "--json"]);
      }
      const field = await confirmedSelectedField(pageId, ref, label, option.name);
      if (!field?.stateKnown || !selectedValueMatches(field.value, option.name)) {
        await dismissOpenOptions(pageId);
        throw new Error(`The field did not keep the selected option "${option.name}".`);
      }
      return { selectedValue: option.name };
    },
    async selectDeclineOption({ pageId, ref, label }) {
      await scrollFieldIntoView(pageId, label);
      let optionsSnapshot = await runOrcaImpl(["snapshot", "--page", pageId, "--json"]);
      let currentRef = comboboxRefForField(optionsSnapshot, label) || ref;
      await runOrcaImpl(["click", "--page", pageId, "--element", `@${currentRef}`, "--json"]);
      optionsSnapshot = await runOrcaImpl(["snapshot", "--page", pageId, "--json"]);
      currentRef = comboboxRefForField(optionsSnapshot, label) || currentRef;
      if (!comboboxIsExpanded(optionsSnapshot, currentRef, label)) {
        await openTypeaheadControl(pageId, label);
        optionsSnapshot = await runOrcaImpl(["snapshot", "--page", pageId, "--json"]);
        currentRef = comboboxRefForField(optionsSnapshot, label) || currentRef;
      }
      let option = null;
      for (let attempt = 0; attempt < OPTION_SNAPSHOT_ATTEMPTS; attempt += 1) {
        option = uniqueVoluntaryDeclineOption(optionsForField(optionsSnapshot, currentRef, label));
        if (option) break;
        if (attempt < OPTION_SNAPSHOT_ATTEMPTS - 1) {
          await runOrcaImpl([
            "wait",
            "--page",
            pageId,
            "--timeout",
            String(OPTION_SNAPSHOT_DELAY_MS),
            "--json",
          ]);
          optionsSnapshot = await runOrcaImpl(["snapshot", "--page", pageId, "--json"]);
          currentRef = comboboxRefForField(optionsSnapshot, label) || currentRef;
        }
      }
      if (!option) {
        await dismissOpenOptions(pageId);
        throw new Error(`The "${label}" dropdown did not offer one unambiguous decline option.`);
      }
      const selectedThroughDom = await chooseExactOpenOption(pageId, option.name);
      if (!selectedThroughDom) {
        await runOrcaImpl(["click", "--page", pageId, "--element", `@${option.ref}`, "--json"]);
      }
      const field = await confirmedSelectedField(pageId, ref, label, option.name);
      if (!field?.stateKnown || !selectedValueMatches(field.value, option.name)) {
        await dismissOpenOptions(pageId);
        throw new Error(`The field did not keep the selected option "${option.name}".`);
      }
      return { selectedValue: option.name };
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
