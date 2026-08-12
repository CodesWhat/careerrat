import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

const HERO_BADGE_COPY = "Fresh roles. Sharp docs. Fast apply.";
const BADGE_LINE_MARKUP =
  /<span>Fresh roles\.<\/span>[\s\S]*<span>Sharp docs\.<\/span>[\s\S]*<span>Fast apply\.<\/span>/;
const AI_CHIPS = [
  ["Claude Code", "claude"],
  ["OpenAI Codex", "codex"],
  ["any CLI on PATH", "path"],
];
const UNSUPPORTED_AGENT_ADAPTERS = ["Gemini CLI", "DeepSeek", "Qwen", "Kimi", "Hermes Agent"];
const STALE_PUBLIC_CLI_PATTERN =
  /node bin\/rolester\.mjs|npm run (?:doctor|next|ingest|searches|companies|modes|automation|research|gate|learnings|stories|activity|analytics|evidence|strategy-review|status:map|export|install-skills|evaluate|tracker|tracker:dev)(?:\s|`|$)|rolester [a-z:-]+ -- --|tracker:dev/;

async function listFiles(dir, suffix) {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await listFiles(path, suffix)));
    else if (entry.isFile() && path.endsWith(suffix)) out.push(path);
  }
  return out;
}

test("website hero rat badge uses the fresh-role application copy", async () => {
  const page = await readFile("website/src/app/page.tsx", "utf8");

  assert.match(
    page,
    /className="rat-badge"[\s\S]*Fresh roles\.[\s\S]*Sharp docs\.[\s\S]*Fast apply\./
  );
  assert.match(page, BADGE_LINE_MARKUP);
  assert.doesNotMatch(page, /I read the whole posting before you chase it\./);
});

test("warm-playful mockup hero rat badge matches the website copy", async () => {
  const mockup = await readFile("mockups/03-warm-playful/index.html", "utf8");

  assert.match(
    mockup,
    /class="rat-badge"[\s\S]*Fresh roles\.[\s\S]*Sharp docs\.[\s\S]*Fast apply\./
  );
  assert.match(mockup, BADGE_LINE_MARKUP);
  assert.doesNotMatch(mockup, /I read the whole posting before you chase it\./);
});

test("hero badge copy stays compact enough for the floating card", () => {
  assert.ok(HERO_BADGE_COPY.length <= 42);
});

test("hero badge beats render as separate lines", async () => {
  const websiteCss = await readFile("website/src/app/globals.css", "utf8");
  const mockup = await readFile("mockups/03-warm-playful/index.html", "utf8");

  assert.match(websiteCss, /\.rat-badge span\s*{\s*display: block;/);
  assert.match(mockup, /\.rat-badge span\s*{\s*display: block;/);
});

test("root layout suppresses the intentional early html class hydration delta", async () => {
  const layout = await readFile("website/src/app/layout.tsx", "utf8");

  assert.match(layout, /documentElement;[\s\S]*?\.classList\.add\('js'\)/);
  assert.match(layout, /<html[\s\S]*suppressHydrationWarning/);
});

test("AI compatibility chips show launchable CLIs and leave adapter-specific agents to the roadmap", async () => {
  const page = await readFile("website/src/app/page.tsx", "utf8");
  const styles = await readFile("website/src/app/globals.css", "utf8");
  const mockup = await readFile("mockups/03-warm-playful/index.html", "utf8");
  const roadmap = await readFile("docs/ROADMAP.md", "utf8");
  const pageSquashed = page.replace(/\s+/g, " ");
  const mockupSquashed = mockup.replace(/\s+/g, " ");
  const pageAiSection = page.match(/\{\/\* ─── AI AGNOSTIC[\s\S]*?<\/section>/)?.[0] ?? "";
  const mockupAiSection = mockup.match(/<!-- ─── AI AGNOSTIC[\s\S]*?<\/section>/)?.[0] ?? "";

  const supportedCopy = /Works with your favorite AI/;
  assert.match(pageSquashed, supportedCopy);
  assert.match(mockupSquashed, supportedCopy);
  assert.match(pageSquashed, /It doesn't lock you into a model or a subscription/);
  assert.match(mockupSquashed, /It doesn't lock you into a model or a subscription/);
  assert.match(pageSquashed, /Claude Code, Codex, or anything else on your PATH/);
  assert.match(mockupSquashed, /Claude Code, Codex, or anything else on your PATH/);
  assert.match(pageSquashed, /CLI launch options/);
  assert.match(mockupSquashed, /CLI launch options/);
  assert.doesNotMatch(pageAiSection, /can actually run|not a claim/i);
  assert.doesNotMatch(mockupAiSection, /can actually run|not a claim/i);

  for (const [label, key] of AI_CHIPS) {
    assert.match(page, new RegExp(label.replaceAll(" ", "\\s+")));
    assert.match(mockup, new RegExp(label.replaceAll(" ", "\\s+")));
    assert.match(page, new RegExp(`className="ai-chip-logo ai-chip-logo-${key}"[\\s\\S]*<path`));
    assert.match(mockup, new RegExp(`class="ai-chip-logo ai-chip-logo-${key}"[\\s\\S]*<path`));
  }

  for (const label of UNSUPPORTED_AGENT_ADAPTERS) {
    assert.doesNotMatch(pageAiSection, new RegExp(label.replaceAll(" ", "\\s+")));
    assert.doesNotMatch(mockupAiSection, new RegExp(label.replaceAll(" ", "\\s+")));
    assert.match(roadmap, new RegExp(label.replaceAll(" ", "\\s+")));
  }

  assert.match(styles, /\.ai-chip-logo\s*{/);
  assert.doesNotMatch(pageAiSection, /Adapter roadmap/);
  assert.doesNotMatch(mockupAiSection, /Adapter roadmap/);
  assert.doesNotMatch(styles, /\.ai-chip-roadmap/);
  assert.doesNotMatch(page, /Gemini CLI, DeepSeek, Qwen, Kimi, or/);
  assert.doesNotMatch(mockup, /Gemini CLI, DeepSeek, Qwen, Kimi, or/);
  assert.doesNotMatch(page, /bring any AI/);
  assert.doesNotMatch(mockup, /bring any AI/);
  assert.doesNotMatch(page, /chosen AI CLI/);
  assert.doesNotMatch(mockup, /chosen AI CLI/);
  assert.doesNotMatch(page, /your AI takes it from here/);
  assert.doesNotMatch(mockup, /your AI takes it from here/);
  assert.doesNotMatch(page, /ai-chip-icon/);
  assert.doesNotMatch(mockup, /ai-chip-icon/);
  assert.doesNotMatch(page, /ai-chip-dot/);
  assert.doesNotMatch(mockup, /ai-chip-dot/);
});

test("website install copy uses the public rolester CLI convention", async () => {
  const page = await readFile("website/src/app/page.tsx", "utf8");
  const publicAgents = await readFile("website/public/AGENTS.md", "utf8");
  const combined = `${page}\n${publicAgents}`;

  assert.match(page, /npm install -g rolester/);
  assert.match(page, /careerrat start claude/);
  assert.match(page, /careerrat update/);
  assert.match(publicAgents, /careerrat start claude/);
  assert.match(publicAgents, /careerrat ingest/);
  assert.match(publicAgents, /careerrat update/);

  assert.doesNotMatch(combined, STALE_PUBLIC_CLI_PATTERN);
});

test("docs website source uses the public rolester CLI convention", async () => {
  const files = await listFiles("docs-site/content", ".mdx");
  const docs = await Promise.all(files.map(async (file) => readFile(file, "utf8")));
  const combined = docs.join("\n");

  assert.match(combined, /npm install -g rolester/);
  assert.match(combined, /careerrat start claude/);
  assert.match(combined, /careerrat tracker-dev/);
  assert.match(combined, /careerrat automation status/);
  assert.match(combined, /careerrat update/);

  assert.doesNotMatch(combined, STALE_PUBLIC_CLI_PATTERN);
});
