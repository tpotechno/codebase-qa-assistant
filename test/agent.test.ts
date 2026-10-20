import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runAgent } from "../src/agent.ts";

process.env.REPO_PATH = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** A fake Messages client that replays scripted responses and records requests. */
function fakeClient(responses: any[]) {
  const requests: any[] = [];
  return {
    requests,
    messages: {
      create: async (req: any) => {
        requests.push(structuredClone(req));
        const next = responses.shift();
        if (!next) throw new Error("No more scripted responses");
        return next;
      },
    },
  };
}

const usage = { input_tokens: 10, output_tokens: 5 };

test("runs the tool loop and returns the final answer", async () => {
  const client = fakeClient([
    {
      stop_reason: "tool_use",
      usage,
      content: [{ type: "tool_use", id: "t1", name: "read_file", input: { path: "src/index.ts", start: 1, end: 2 } }],
    },
    { stop_reason: "end_turn", usage, content: [{ type: "text", text: "It is a CLI entry point." }] },
  ]);
  const calls: string[] = [];
  const result = await runAgent("What is index.ts?", {
    client: client as any,
    onToolCall: (name) => calls.push(name),
  });

  assert.equal(result.answer, "It is a CLI entry point.");
  assert.equal(result.turns, 2);
  assert.equal(result.toolCalls, 1);
  assert.deepEqual(calls, ["read_file"]);
  assert.deepEqual(result.usage, { inputTokens: 20, outputTokens: 10 });

  // Second request must carry the tool_result for t1.
  const toolResultMsg = client.requests[1].messages.at(-1);
  assert.equal(toolResultMsg.role, "user");
  assert.equal(toolResultMsg.content[0].type, "tool_result");
  assert.equal(toolResultMsg.content[0].tool_use_id, "t1");
  assert.equal(toolResultMsg.content[0].is_error, false);
});

test("marks tool errors with is_error", async () => {
  const client = fakeClient([
    {
      stop_reason: "tool_use",
      usage,
      content: [{ type: "tool_use", id: "t1", name: "read_file", input: { path: "../../etc/passwd" } }],
    },
    { stop_reason: "end_turn", usage, content: [{ type: "text", text: "Can't read that." }] },
  ]);
  await runAgent("read passwd", { client: client as any });
  assert.equal(client.requests[1].messages.at(-1).content[0].is_error, true);
});

test("stops at maxTurns", async () => {
  const loop = { stop_reason: "tool_use", usage, content: [{ type: "tool_use", id: "t", name: "search_code", input: { query: "x" } }] };
  const client = fakeClient([loop, loop]);
  const result = await runAgent("loop forever", { client: client as any, maxTurns: 2 });
  assert.equal(result.stopReason, "max_turns");
});

test("streams text by turn and reports tool results with matching ids", async () => {
  const turns: any[] = [
    { stop_reason: "tool_use", usage, content: [{ type: "text", text: "Let me look." }, { type: "tool_use", id: "t9", name: "read_file", input: { path: "src/index.ts", start: 1, end: 1 } }] },
    { stop_reason: "end_turn", usage, content: [{ type: "text", text: "Done." }] },
  ];
  const client = {
    messages: {
      create: async () => { throw new Error("should stream"); },
      stream: () => {
        const ls: Array<(d: string) => void> = [];
        return {
          on(_e: string, cb: (d: string) => void) { ls.push(cb); return this; },
          async finalMessage() {
            const m = turns.shift();
            for (const b of m.content) if (b.type === "text") ls.forEach((l) => l(b.text));
            return m;
          },
        };
      },
    },
  };
  const text: Array<[string, number]> = [];
  const calls: string[] = [];
  const results: string[] = [];
  const r = await runAgent("q", {
    client: client as any,
    onText: (d, turn) => text.push([d, turn]),
    onToolCall: (_n, _i, id) => calls.push(id),
    onToolResult: (id, res) => results.push(`${id}:${res.isError}`),
  });
  assert.deepEqual(text, [["Let me look.", 1], ["Done.", 2]]);
  assert.deepEqual(calls, ["t9"]);
  assert.deepEqual(results, ["t9:false"]);
  assert.equal(r.answer, "Done.");
});

test("an aborted signal stops the run", async () => {
  const ac = new AbortController();
  ac.abort();
  await assert.rejects(runAgent("q", { client: { messages: { create: async () => ({}) } } as any, signal: ac.signal }), /Aborted/);
});
