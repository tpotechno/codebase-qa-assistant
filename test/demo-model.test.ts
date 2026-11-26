import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { scriptedAnthropic, tourAnswer } from "../scripts/demo-model.ts";
import { runAgent } from "../src/agent.ts";
import { localToolProvider } from "../src/tool-provider.ts";
import { executeTool } from "../src/tools.ts";

/** A small repository with a README (badge, ### heading, prose), a doc, and a TODO. */
async function sampleRepo(t: { after: (fn: () => Promise<void>) => void }): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cqa-demo-model-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  await fs.writeFile(
    path.join(dir, "README.md"),
    "[![build](https://example.com/badge.svg)](https://example.com)\n\n### Well hello there!\n\nWidgets makes widgets.\nFast ones.\n\nSecond paragraph.\n",
  );
  await fs.mkdir(path.join(dir, "docs"));
  await fs.writeFile(path.join(dir, "docs", "architecture.md"), "# Architecture overview\n\nAn introduction to the architecture.\n");
  await fs.writeFile(path.join(dir, "app.ts"), "export const x = 1;\n// TODO: handle errors\n");
  return dir;
}

/** What the three tour tools return for a repo, exactly as the demo would see it. */
async function tourResults(root: string): Promise<Map<string, string>> {
  return new Map([
    ["tour1", await executeTool("search_docs", { query: "overview introduction getting started architecture", k: 3 }, root)],
    ["tour2", await executeTool("read_file", { path: "README.md", start: 1, end: 80 }, root)],
    ["tour3", await executeTool("search_code", { query: "TODO", k: 5 }, root)],
  ]);
}

test("tourAnswer is filled in from real tool output and says it's a template", async (t) => {
  const answer = tourAnswer("acme/widgets@main", await tourResults(await sampleRepo(t)));
  assert.match(answer, /\*\*Demo mode\.\*\*.*\*\*acme\/widgets@main\*\*.*not written by Claude/);
  // README: the ### heading, then the first prose paragraph (badge skipped, lines joined).
  assert.match(answer, /\*\*Well hello there!\*\*/);
  assert.match(answer, /> Widgets makes widgets\. Fast ones\./);
  assert.doesNotMatch(answer, /Second paragraph|badge\.svg/);
  // Documentation hits and TODOs, with their file:line.
  assert.match(answer, /- `docs\/architecture\.md:1` Architecture overview/);
  assert.match(answer, /- `app\.ts:2` \/\/ TODO: handle errors/);
});

test("tourAnswer copes with no README, no docs and no TODOs", async (t) => {
  const empty = await fs.mkdtemp(path.join(os.tmpdir(), "cqa-demo-empty-"));
  t.after(() => fs.rm(empty, { recursive: true, force: true }));
  const answer = tourAnswer("acme/empty@main", await tourResults(empty));
  assert.match(answer, /There's no `README\.md`/);
  assert.match(answer, /No Markdown documentation matched\./);
  assert.match(answer, /No TODO comments turned up\./);
});

test("tourAnswer shortens a long introduction", () => {
  const long = `README.md (lines 1-2 of 2)\n1  # Title\n2  ${"word ".repeat(200)}`;
  const answer = tourAnswer("x", new Map([["tour2", long]]));
  const quote = /^> (.*)$/m.exec(answer.split("### From the README")[1])![1];
  assert.ok(quote.endsWith("…"));
  assert.ok(quote.length <= 402);
});

type Params = { system?: string; messages: Array<{ role: string; content: unknown }> };
const firstToolOf = async (model: ReturnType<typeof scriptedAnthropic>, params: Params) => {
  const msg = await model.messages.stream(params).finalMessage();
  return msg.content.find((b: { type: string }) => b.type === "tool_use")?.name;
};

test("the scripted model picks its script from the system prompt and its turn from the conversation", async () => {
  const model = scriptedAnthropic("/demo/root", { thinkMs: 0, chunkMs: 0 });
  const builtIn = { system: "prompt\n\nThe codebase you are answering about: /demo/root", messages: [{ role: "user", content: "q" }] };
  const other = { system: "prompt\n\nThe codebase you are answering about: acme/widgets@main", messages: [{ role: "user", content: "q" }] };
  assert.equal(await firstToolOf(model, builtIn), "search_code"); // the hand-written script
  assert.equal(await firstToolOf(model, other), "search_docs"); // the tour
  // Stateless: one assistant turn so far means the second scripted turn, whoever asks.
  const later = { ...other, messages: [...other.messages, { role: "assistant", content: [] }, { role: "user", content: [] }] };
  assert.equal(await firstToolOf(model, later), "read_file");
  assert.equal(await firstToolOf(model, other), "search_docs");
});

test("the tour runs end to end through the real agent loop and tools", async (t) => {
  const root = await sampleRepo(t);
  const texts: string[] = [];
  const calls: string[] = [];
  const result = await runAgent("Give me a short tour of this codebase.", {
    client: scriptedAnthropic("/demo/root", { thinkMs: 0, chunkMs: 0 }) as never,
    tools: localToolProvider(root),
    repoLabel: "acme/widgets@main",
    onText: (d) => texts.push(d),
    onToolCall: (name) => calls.push(name),
  });
  assert.deepEqual(calls, ["search_docs", "read_file", "search_code"]);
  assert.match(result.answer, /Widgets makes widgets/);
  assert.match(result.answer, /app\.ts:2/);
  assert.equal(texts.join("").includes("Demo mode"), true, "the answer streams");
});
