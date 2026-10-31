import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import headless from "@xterm/headless";
import pty from "node-pty";
import { killProcessTreeByPid } from "../src/core/ai/runtime-process.mjs";
import { closeAll } from "../src/core/db/connection.mjs";
import { importFromTracker } from "../src/core/db/import-from-tracker.mjs";
import { sourcingRunLatest } from "../src/core/db/verbs/sourcing-runs.mjs";
import { preparePtyHelpers } from "../src/core/tui/prepare.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));

async function stopTestTerminal(child, isExited, terminal, pids = []) {
  if (!isExited()) {
    await new Promise((resolve) => {
      const timer = setTimeout(() => {
        for (const pid of pids) if (pid) killProcessTreeByPid(pid);
        child.kill("SIGKILL");
        resolve();
      }, 3000);
      child.onExit(() => {
        clearTimeout(timer);
        resolve();
      });
      child.kill("SIGTERM");
    });
  }
  terminal.dispose();
}
function fixture(t) {
  const home = mkdtempSync(join(tmpdir(), "careerrat-tui-cli-"));
  mkdirSync(join(home, "workspace"));
  writeFileSync(
    join(home, "workspace/tracker.json"),
    JSON.stringify({
      applications: [
        { id: "northstar", company: "Northstar", role: "Staff Engineer", status: "interview" },
        { id: "atlas", company: "Atlas", role: "Platform Engineer", status: "applied" },
      ],
    })
  );
  t.after(() => rmSync(home, { recursive: true, force: true }));
  return { CAREERRAT_HOME: home, HOME: home, PATH: process.env.PATH };
}

test("tui JSON reads saved jobs without a terminal, agent or browser server", (t) => {
  const env = fixture(t);
  const result = JSON.parse(
    execFileSync(process.execPath, [join(root, "bin/careerrat.mjs"), "tui", "--json"], {
      env,
      encoding: "utf8",
    })
  );
  assert.equal(result.jobs.length, 2);
  assert.equal(result.mode, "legacy");
});

test("real terminal can browse, filter and quit without launching an agent", {
  timeout: 12000,
}, async (t) => {
  const env = fixture(t);
  preparePtyHelpers();
  const terminal = new headless.Terminal({ cols: 120, rows: 36, allowProposedApi: true });
  let child;
  let exited = false;
  let stage = 0;
  let raw = "";
  let snapshot = "";
  let rejectRun;
  const done = new Promise((resolve, reject) => {
    rejectRun = reject;
    child = pty.spawn(process.execPath, [join(root, "src/cli/tui.mjs"), "--no-agent"], {
      env,
      cwd: root,
      cols: 120,
      rows: 36,
      name: "xterm-256color",
    });
    child.onData((data) => {
      raw += data;
      terminal.write(data, () => {
        snapshot = Array.from({ length: terminal.rows }, (_, index) =>
          terminal.buffer.active
            .getLine(terminal.buffer.active.baseY + index)
            ?.translateToString(true)
        ).join("\n");
        if (
          stage === 0 &&
          snapshot.includes("Northstar") &&
          snapshot.includes("Saved jobs work without an agent")
        ) {
          stage = 1;
          child.write("f");
        }
        if (stage === 1 && snapshot.includes("Status: applied")) {
          stage = 2;
          child.resize(80, 30);
          terminal.resize(80, 30);
          child.write("\x11");
        }
      });
    });
    child.onExit(({ exitCode }) => {
      exited = true;
      if (stage === 2 && exitCode === 0) resolve();
      else
        reject(
          new Error(
            `TUI exited early: ${exitCode}, stage ${stage}\n${snapshot}\n${raw.slice(-1000)}`
          )
        );
    });
  });
  const timer = setTimeout(
    () => rejectRun(new Error(`TUI proof timed out at ${stage}\n${snapshot}`)),
    9000
  );
  t.after(async () => {
    clearTimeout(timer);
    await stopTestTerminal(child, () => exited, terminal);
  });
  await done;
  assert.ok(raw.includes("\x1b[?1049l"));
  assert.ok(raw.includes("\x1b[?25h"));
});

for (const ownsSearch of [false, true])
  test(ownsSearch
    ? "closing the real terminal cancels search state owned by its native agent session"
    : "native pane and saved jobs coexist, shortcuts don't submit, and quitting stops the child", {
    timeout: 15000,
  }, async (t) => {
    const env = fixture(t);
    if (ownsSearch) {
      importFromTracker({ repoRoot: root, env, sourceDir: join(env.CAREERRAT_HOME, "workspace") });
      t.after(closeAll);
    }
    const searchModule = new URL("../src/core/db/verbs/sourcing-runs.mjs", import.meta.url).href;
    const setupSearch = ownsSearch
      ? `const api=await import(${JSON.stringify(searchModule)});
    const ctx={repoRoot:${JSON.stringify(root)},env:process.env};
    const {run}=api.sourcingRunStart({...ctx,purpose:'manual-search'});
    api.sourcingRunProgress({...ctx,id:run.id,progress:{ownerSession:process.env.CAREERRAT_TUI_SESSION}});`
      : "";
    preparePtyHelpers();
    const terminal = new headless.Terminal({ cols: 120, rows: 36, allowProposedApi: true });
    const agentProgram = `
    (async()=>{${setupSearch}
    process.stdin.setRawMode(true);process.stdin.resume();
    process.stdout.write('\\x1b[?2004hAGENT_READY PID:'+process.pid+' SURFACE:'+process.env.CAREERRAT_SURFACE+'\\r\\n');
    let buffer='';
    process.stdin.on('data',data=>{
      buffer+=data.toString();
      if(buffer.includes('hello\\r')){process.stdout.write('GOT_HELLO\\r\\n');buffer='';}
      if(buffer.includes('\\x1b[201~')){
        process.stdout.write('REQUEST_INSERTED:'+buffer.includes('apply-job')+' AUTO_SUBMIT:'+buffer.includes('\\r')+'\\r\\n');
        buffer='';
      }
    });
    })();
  `;
    const runtimeUrl = new URL("../src/core/tui/runtime.mjs", import.meta.url).href;
    const driver = `import {runTerminalWorkspace} from ${JSON.stringify(runtimeUrl)};
    process.exitCode=await runTerminalWorkspace({repoRoot:${JSON.stringify(root)},env:process.env,agent:{command:process.execPath,args:['-e',${JSON.stringify(agentProgram)}]}});`;
    let child;
    let exited = false;
    let stage = 0;
    let snapshot = "";
    let agentPid;
    let rejectRun;
    const done = new Promise((resolve, reject) => {
      rejectRun = reject;
      child = pty.spawn(process.execPath, ["--input-type=module", "-e", driver], {
        cwd: root,
        env,
        cols: 120,
        rows: 36,
        name: "xterm-256color",
      });
      child.onData((data) =>
        terminal.write(data, () => {
          snapshot = Array.from({ length: terminal.rows }, (_, index) =>
            terminal.buffer.active
              .getLine(terminal.buffer.active.baseY + index)
              ?.translateToString(true)
          ).join("\n");
          agentPid ||= Number(snapshot.match(/AGENT_READY PID:(\d+)/)?.[1]);
          if (
            stage === 0 &&
            snapshot.includes("AGENT_READY") &&
            snapshot.includes("SURFACE:tui") &&
            snapshot.includes("Northstar")
          ) {
            agentPid = Number(snapshot.match(/AGENT_READY PID:(\d+)/)?.[1]);
            stage = 1;
            child.write("\x1b[17~hello\r");
          }
          if (stage === 1 && snapshot.includes("GOT_HELLO")) {
            assert.match(snapshot, /Northstar/);
            stage = 2;
            child.write("\x1b[17~3");
          }
          if (stage === 2 && snapshot.includes("REQUEST_INSERTED:true AUTO_SUBMIT:false")) {
            stage = 3;
            child.write("\x11");
          }
        })
      );
      child.onExit(({ exitCode }) => {
        exited = true;
        if (stage === 3 && exitCode === 0) resolve();
        else reject(new Error(`Native workspace exited early: ${exitCode}, ${stage}\n${snapshot}`));
      });
    });
    const timer = setTimeout(
      () => rejectRun(new Error(`Native workspace proof timed out at ${stage}\n${snapshot}`)),
      10000
    );
    t.after(async () => {
      clearTimeout(timer);
      await stopTestTerminal(child, () => exited, terminal, [agentPid]);
    });
    await done;
    assert.ok(agentPid > 0);
    assert.throws(() => process.kill(agentPid, 0), { code: "ESRCH" });
    if (ownsSearch)
      assert.equal(
        sourcingRunLatest({ repoRoot: root, env, purpose: "manual-search" }).run.error.code,
        "SEARCH_CANCELLED"
      );
  });

for (const captureFails of [false, true]) {
  test(captureFails
    ? "failed outer paste saves nothing and forwards no document or request to the agent"
    : "chunked outer paste is saved completely before the agent receives its context request", {
    timeout: 15000,
  }, async (t) => {
    const env = fixture(t);
    if (captureFails) writeFileSync(join(env.CAREERRAT_HOME, "workspace/intake"), "blocked");
    preparePtyHelpers();
    const document = "SYNTHETIC_PASTE_ORCHID_582\nSecond synthetic line.\nLast synthetic line.";
    const sentinel = "ORDINARY_SENTINEL_946";
    const terminal = new headless.Terminal({ cols: 160, rows: 36, allowProposedApi: true });
    const agentProgram = `
      const {readFileSync}=require('node:fs');
      const document=${JSON.stringify(document)};
      const sentinel=${JSON.stringify(sentinel)};
      process.stdin.setRawMode(true);process.stdin.resume();
      process.stdout.write('\\x1b[?2004hPASTE_AGENT_READY PID:'+process.pid+'\\r\\n');
      let buffer='',checked=false;
      process.stdin.on('data',data=>{
        buffer+=data.toString();
        if(!checked && buffer.includes('\\x1b[201~')){
          checked=true;
          const path=buffer.match(/saved context capture at ("[^"\\r\\n]+")/);
          let complete=false;
          try {complete=readFileSync(JSON.parse(path[1]),'utf8').endsWith(document);} catch {}
          process.stdout.write('CAPTURE_EXISTS_NOW:'+complete+'\\r\\n');
        }
        if(buffer.includes(sentinel)){
          process.stdout.write('RAW_DOCUMENT:'+buffer.includes('SYNTHETIC_PASTE_ORCHID_582')+
            ' REQUEST:'+buffer.includes('Read my saved context capture at ')+
            ' ENTER:'+(/[\\r\\n]/.test(buffer))+'\\r\\n');
          buffer='';
        }
      });
    `;
    const runtimeUrl = new URL("../src/core/tui/runtime.mjs", import.meta.url).href;
    const driver = `import {runTerminalWorkspace} from ${JSON.stringify(runtimeUrl)};
      process.exitCode=await runTerminalWorkspace({repoRoot:${JSON.stringify(root)},env:process.env,agent:{command:process.execPath,args:['-e',${JSON.stringify(agentProgram)}]}});`;
    let child;
    let exited = false;
    let stage = 0;
    let snapshot = "";
    let agentPid;
    let rejectRun;
    let pasteTimer;
    const done = new Promise((resolve, reject) => {
      rejectRun = reject;
      child = pty.spawn(process.execPath, ["--input-type=module", "-e", driver], {
        cwd: root,
        env,
        cols: 160,
        rows: 36,
        name: "xterm-256color",
      });
      child.onData((data) =>
        terminal.write(data, () => {
          snapshot = Array.from({ length: terminal.rows }, (_, index) =>
            terminal.buffer.active
              .getLine(terminal.buffer.active.baseY + index)
              ?.translateToString(true)
          ).join("\n");
          agentPid ||= Number(snapshot.match(/PASTE_AGENT_READY PID:(\d+)/)?.[1]);
          if (stage === 0 && agentPid && snapshot.includes("Northstar")) {
            stage = 1;
            const split = document.indexOf("Second") + 3;
            child.write(`\x1b[200~${document.slice(0, split)}`);
            pasteTimer = setTimeout(() => child.write(`${document.slice(split)}\x1b[201~`), 75);
          }
          const captured = snapshot.includes("CAPTURE_EXISTS_NOW:true");
          const failed =
            snapshot.includes("Context was not saved:") && snapshot.includes("ENOTDIR");
          if (stage === 1 && (captureFails ? failed : captured)) {
            stage = 2;
            child.write(`${captureFails ? "\x1b[17~" : ""}${sentinel}`);
          }
          const expected = `RAW_DOCUMENT:false REQUEST:${!captureFails} ENTER:false`;
          if (stage === 2 && snapshot.includes(expected)) {
            stage = 3;
            child.write("\x11");
          }
        })
      );
      child.onExit(({ exitCode }) => {
        exited = true;
        if (stage === 3 && exitCode === 0) resolve();
        else reject(new Error(`Paste workspace exited early: ${exitCode}, ${stage}\n${snapshot}`));
      });
    });
    const timer = setTimeout(
      () => rejectRun(new Error(`Paste proof timed out at ${stage}\n${snapshot}`)),
      10000
    );
    t.after(async () => {
      clearTimeout(timer);
      clearTimeout(pasteTimer);
      await stopTestTerminal(child, () => exited, terminal, [agentPid]);
    });
    await done;
    assert.ok(agentPid > 0);
    assert.throws(() => process.kill(agentPid, 0), { code: "ESRCH" });
  });
}

test("shutdown cannot reopen watchers when the workspace disappears during agent exit", {
  timeout: 10000,
}, async (t) => {
  const env = fixture(t);
  preparePtyHelpers();
  const terminal = new headless.Terminal({ cols: 120, rows: 36, allowProposedApi: true });
  const runtimeUrl = new URL("../src/core/tui/runtime.mjs", import.meta.url).href;
  const program =
    "process.stdout.write('CLOSE_PROBE:'+process.pid+'\\r\\n');process.stdin.resume()";
  const driver = `import {runTerminalWorkspace} from ${JSON.stringify(runtimeUrl)};process.exitCode=await runTerminalWorkspace({repoRoot:${JSON.stringify(root)},env:process.env,agent:{command:process.execPath,args:['-e',${JSON.stringify(program)}]}});`;
  let child;
  let exited = false;
  let removed = false;
  let agentPid;
  let rejectRun;
  const done = new Promise((resolve, reject) => {
    rejectRun = reject;
    child = pty.spawn(process.execPath, ["--input-type=module", "-e", driver], {
      cwd: root,
      env,
      cols: 120,
      rows: 36,
      name: "xterm-256color",
    });
    child.onData((data) =>
      terminal.write(data, () => {
        const snapshot = Array.from({ length: terminal.rows }, (_, i) =>
          terminal.buffer.active.getLine(i)?.translateToString(true)
        ).join("\n");
        if (!removed && snapshot.includes("CLOSE_PROBE:")) {
          agentPid = Number(snapshot.match(/CLOSE_PROBE:(\d+)/)?.[1]);
          removed = true;
          rmSync(env.CAREERRAT_HOME, { recursive: true, force: true });
          child.write("\x11");
        }
      })
    );
    child.onExit(({ exitCode }) => {
      exited = true;
      exitCode === 0 && removed ? resolve() : reject(new Error(`shutdown failed: ${exitCode}`));
    });
  });
  const timer = setTimeout(
    () => rejectRun(new Error("shutdown remained alive after workspace removal")),
    2500
  );
  t.after(async () => {
    clearTimeout(timer);
    await stopTestTerminal(child, () => exited, terminal, [agentPid]);
  });
  await done;
});

test("a file dropped into the real terminal is copied and extracted before the agent sees it", {
  timeout: 15000,
}, async (t) => {
  const env = fixture(t);
  const source = join(env.HOME, "interview notes.md");
  const body = "Interviewer: Tell me about ownership.\nCandidate: I built the shared platform.";
  writeFileSync(source, body);
  preparePtyHelpers();
  const terminal = new headless.Terminal({ cols: 160, rows: 36, allowProposedApi: true });
  const program = `const {readFileSync}=require('node:fs');
    process.stdin.setRawMode(true);process.stdin.resume();
    process.stdout.write('\\x1b[?2004hREADY_FILE_AGENT\\r\\n');
    let buffer='';process.stdin.on('data',data=>{buffer+=data;
      if(buffer.includes('\\x1b[201~')){
        const match=buffer.match(/"path":("(?:\\\\.|[^"\\\\])*")/);
        const saved=match && readFileSync(JSON.parse(match[1]),'utf8')===${JSON.stringify(body)};
        process.stdout.write('FILE_SAVED:'+!!saved+' AUTO_SUBMIT:'+buffer.includes('\\r')+'\\r\\n');
      }
    });`;
  const runtimeUrl = new URL("../src/core/tui/runtime.mjs", import.meta.url).href;
  const driver = `import {runTerminalWorkspace} from ${JSON.stringify(runtimeUrl)};
    process.exitCode=await runTerminalWorkspace({repoRoot:${JSON.stringify(root)},env:process.env,agent:{command:process.execPath,args:['-e',${JSON.stringify(program)}]}});`;
  let child;
  let exited = false;
  let stage = 0;
  let snapshot = "";
  let rejectRun;
  const done = new Promise((resolve, reject) => {
    rejectRun = reject;
    child = pty.spawn(process.execPath, ["--input-type=module", "-e", driver], {
      cwd: root,
      env,
      cols: 160,
      rows: 36,
      name: "xterm-256color",
    });
    child.onData((data) =>
      terminal.write(data, () => {
        snapshot = Array.from({ length: terminal.rows }, (_, index) =>
          terminal.buffer.active
            .getLine(terminal.buffer.active.baseY + index)
            ?.translateToString(true)
        ).join("\n");
        if (stage === 0 && snapshot.includes("READY_FILE_AGENT")) {
          stage = 1;
          child.write(`\x1b[200~'${source}'\x1b[201~`);
        }
        if (stage === 1 && snapshot.includes("FILE_SAVED:true AUTO_SUBMIT:false")) {
          assert.match(snapshot, /Atlas/);
          stage = 2;
          child.write("\x11");
        }
      })
    );
    child.onExit(({ exitCode }) => {
      exited = true;
      if (stage === 2 && exitCode === 0) resolve();
      else reject(new Error(`File drop exited at ${stage}: ${exitCode}\n${snapshot}`));
    });
  });
  const timer = setTimeout(
    () => rejectRun(new Error(`File drop timed out at ${stage}\n${snapshot}`)),
    10000
  );
  t.after(async () => {
    clearTimeout(timer);
    await stopTestTerminal(child, () => exited, terminal);
  });
  await done;
});
