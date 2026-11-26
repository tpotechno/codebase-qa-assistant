/**
 * The demo's scripted stand-in for Claude on the Ask screen (used by demo-server.ts).
 * Kept in its own module so tests can exercise it without starting a server.
 *
 * It's stateless: like a real model, it decides its next turn from the conversation it is
 * sent, so concurrent visitors don't share a script. Tool calls it asks for run for real.
 */

/** Sample token figures; the UI labels them as such in demo mode. */
const usage = { input_tokens: 2_400, output_tokens: 310 };

const ANSWER = `The review agent is read-only by construction, not by instruction. Three settings in \`buildReviewOptions\` do the work (\`src/review.ts:129\`):

1. **No built-in tools.** \`tools: []\` removes Claude Code's shell and file-editing tools entirely.
2. **An explicit allowlist.** \`allowedTools: REVIEW_TOOLS\` lists only \`get_pr\`, \`get_pr_diff\`, \`search_code\`, \`read_file\`, and \`search_docs\` (\`src/review.ts:19\`). \`post_review\` is deliberately absent.
3. **Deny by default.** \`permissionMode: "dontAsk"\` means anything outside the allowlist is refused rather than prompted.

It is also isolated from the machine it runs on: \`settingSources: []\` ignores local Claude settings, \`strictMcpConfig: true\` admits only this project's MCP server, and \`agentEnv()\` strips inherited Claude Code session variables.

Posting happens outside the agent. The review comes back as JSON, and the command (or the **Post to GitHub** button) publishes it with \`head_sha\`, so it is refused if the PR has new commits.`;

/** Scripted turns for the demo's own repository. Tool calls run for real against it. */
function builtInTurns(): any[] {
  return [
    {
      stop_reason: "tool_use",
      usage,
      content: [
        { type: "text", text: "I'll find where the review agent's permissions are configured." },
        { type: "tool_use", id: "t1", name: "search_code", input: { query: "allowedTools", k: 5 } },
      ],
    },
    {
      stop_reason: "tool_use",
      usage,
      content: [{ type: "tool_use", id: "t2", name: "read_file", input: { path: "src/review.ts", start: 129, end: 160 } }],
    },
    {
      stop_reason: "tool_use",
      usage,
      content: [{ type: "tool_use", id: "t3", name: "search_docs", input: { query: "agent never gets the write tool" } }],
    },
    { stop_reason: "end_turn", usage, content: [{ type: "text", text: ANSWER }] },
  ];
}

/**
 * Scripted turns for any other repository: a short tour whose tool calls run for real on
 * the chosen repo. The last turn is a template filled in from those tool results, and it
 * says so, since no model wrote it.
 */
function tourTurns(label: string, results: Map<string, string>): any[] {
  return [
    {
      stop_reason: "tool_use",
      usage,
      content: [
        { type: "text", text: "I'll start with the project's own documentation." },
        { type: "tool_use", id: "tour1", name: "search_docs", input: { query: "overview introduction getting started architecture", k: 3 } },
      ],
    },
    {
      stop_reason: "tool_use",
      usage,
      content: [{ type: "tool_use", id: "tour2", name: "read_file", input: { path: "README.md", start: 1, end: 80 } }],
    },
    {
      stop_reason: "tool_use",
      usage,
      content: [{ type: "tool_use", id: "tour3", name: "search_code", input: { query: "TODO", k: 5 } }],
    },
    { stop_reason: "end_turn", usage, content: [{ type: "text", text: tourAnswer(label, results) }] },
  ];
}

/**
 * Fill in the tour's answer from what the tools actually returned, keyed by tool_use id
 * (tour1 = search_docs, tour2 = read_file README.md, tour3 = search_code TODO).
 */
export function tourAnswer(label: string, results: Map<string, string>): string {
  // README: its first heading and first prose paragraph (read_file lines look like "12  text").
  const readme = results.get("tour2") ?? "";
  let readmePart = "There's no `README.md` at the root of this repository.";
  if (!readme.startsWith("Error:")) {
    const lines = readme.split("\n").slice(1).map((l) => l.replace(/^\d+ {2}/, ""));
    const heading = lines.find((l) => /^#{1,6}\s/.test(l))?.replace(/^#+\s*/, "");
    const para: string[] = [];
    for (const l of lines) {
      if (para.length && !l.trim()) break;
      // Skip headings, badges and HTML; keep the first run of plain prose.
      if (l.trim() && !/^(#|\[!\[|<|!\[|---|===)/.test(l.trim())) para.push(l.trim());
    }
    const text = para.join(" ").slice(0, 400);
    readmePart = [heading && `**${heading}**`, text && `> ${text}${para.join(" ").length > 400 ? "…" : ""}`]
      .filter(Boolean)
      .join("\n\n") || "The README has no plain-text introduction.";
  }

  // search_docs hits look like "[1] docs/setup.md:12 — Installing (score 3.10)".
  const docs = [...(results.get("tour1") ?? "").matchAll(/^\[\d+\] (\S+:\d+) — (.*) \(score/gm)]
    .map((m) => `- \`${m[1]}\` ${m[2]}`);
  // search_code hits: a "path:line" line followed by context, the matching line marked ">".
  const todos = [...(results.get("tour3") ?? "").matchAll(/^(\S+:\d+)\n(?:.*\n)*?\d+> (.*)$/gm)]
    .map((m) => `- \`${m[1]}\` ${m[2].trim().slice(0, 120)}`);

  return [
    `> **Demo mode.** The steps beside this answer really ran against **${label}**, but this text is filled in from a template, not written by Claude. Run the app with your own API key (\`npm run web\`) for real answers to any question.`,
    "### From the README",
    readmePart,
    "### Documentation that matched an overview search",
    docs.length ? docs.join("\n") : "No Markdown documentation matched.",
    "### Open TODOs",
    todos.length ? todos.join("\n") : "No TODO comments turned up.",
  ].join("\n\n");
}

const sleep = (ms: number) => (ms > 0 ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve());

/**
 * A stand-in for the Anthropic client. It's stateless: like a real model, it decides its
 * next turn from the conversation it is sent, so concurrent visitors don't share a script.
 * Which repository is being asked about comes from the system prompt (see agent.ts).
 *
 * `builtInLabel` is the label of the demo's own repository, which gets the hand-written
 * answer; any other label gets the tour. `pace` slows streaming down so it reads like a
 * model typing; tests pass 0.
 */
export function scriptedAnthropic(builtInLabel: string, pace = { thinkMs: 500, chunkMs: 12 }) {
  return {
    messages: {
      create: async () => {
        throw new Error("demo streams only");
      },
      stream: (params: { system?: string; messages: Array<{ role: string; content: unknown }> }) => {
        const label = /The codebase you are answering about: (.+)$/.exec(params.system ?? "")?.[1] ?? builtInLabel;
        // Each earlier assistant message was one scripted turn.
        const turn = params.messages.filter((m) => m.role === "assistant").length;
        // Tool results so far, by tool_use id, for the tour's final answer.
        const results = new Map<string, string>();
        for (const m of params.messages) {
          if (!Array.isArray(m.content)) continue;
          for (const b of m.content as Array<{ type: string; tool_use_id?: string; content?: unknown }>) {
            if (b.type === "tool_result" && b.tool_use_id) results.set(b.tool_use_id, String(b.content ?? ""));
          }
        }
        const script = label === builtInLabel ? builtInTurns() : tourTurns(label, results);
        const msg = script[Math.min(turn, script.length - 1)];
        const listeners: Array<(d: string) => void> = [];
        return {
          on(event: string, cb: (d: string) => void) {
            if (event === "text") listeners.push(cb);
            return this;
          },
          async finalMessage() {
            await sleep(pace.thinkMs);
            for (const block of msg.content) {
              if (block.type !== "text") continue;
              for (const piece of block.text.match(/[\s\S]{1,6}/g) ?? []) {
                listeners.forEach((l) => l(piece));
                await sleep(pace.chunkMs);
              }
            }
            return msg;
          },
        };
      },
    },
  };
}
