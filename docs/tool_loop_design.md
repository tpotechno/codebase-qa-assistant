# Tool Loop Design

Codebase Q&A and PR Review Assistant, Phase 1

| | |
|---|---|
| Author | Todd Oppel |
| Repository | github.com/tpotechno/codebase-qa-assistant |
| Version | 0.1.0 (Phase 1 complete) |
| Implemented | October 19, 2026 |
| Document written | November 19, 2026, after the fact, from the Phase 1 commit and the current code |
| Status | Implemented, 7 automated tests passing at the end of Phase 1 |

PDF version: [tool_loop_design.pdf](tool_loop_design.pdf)

## 1. Summary

Phase 1 is the foundation of the assistant: a command-line agent that answers questions about a codebase by calling the Claude Messages API in a **hand-written tool loop**. Claude gets two read-only tools, `search_code` and `read_file`. The loop sends the question and the tool definitions to Claude, runs any tools Claude asks for, sends the results back, and repeats until Claude gives a final answer or a turn limit is reached. No agent framework is used. Every step of the tool-calling protocol is visible in about 100 lines of TypeScript in `src/agent.ts`.

## 2. Why

Agent frameworks such as the Claude Agent SDK hide the tool loop: they decide when to call tools, when to stop, and how to report errors. That is convenient, but it makes it hard to reason about cost, failure modes and safety when something goes wrong. Phase 1 builds the loop by hand first, so that:

- **The protocol is understood, not assumed.** `tool_use` blocks, `tool_result` blocks, `is_error`, `stop_reason` and token usage are all handled explicitly.
- **Later phases have a baseline.** Phase 3 moves PR review onto the Agent SDK on purpose. Keeping a hand-written loop for `ask` lets the repository show both approaches over the same tools.
- **Safety sits in the tools, not in the prompt.** The tools enforce their own limits (repository root, file sizes, result counts), so a confused or manipulated model cannot read outside the repository whatever it asks for.

### Goals

- Answer natural-language questions about a local repository, grounded in its actual code, with `path:line` citations.
- Keep the agent loop small, readable and fully tested.
- Make the tools safe by construction: read-only, confined to one folder, with bounded output.
- Report turns, tool calls and token usage on every run, so cost is visible from day one.
- Run the whole test suite with no API key, so it can run in CI on every push.

### Non-goals (this phase)

- An MCP server, or sharing the tools with other clients: Phase 2.
- Documentation search (`search_docs`): Phase 2.
- Pull-request review and anything that writes to GitHub: Phase 3.
- Streaming output and a web UI: Phase 4.
- Hosting: Phase 5.

## 3. What was built

### Architecture

```
  npm run ask -- "question"
 ┌─────────────────────────────┐   messages.create (system, tools, messages)   ┌───────────────────┐
 │ CLI (src/index.ts)          │ ─────────────────────────────────────────────▶ │ Claude Messages   │
 │        │                    │ ◀───────────────────────────────────────────── │ API               │
 │        ▼                    │        text and/or tool_use blocks             └───────────────────┘
 │ Agent loop (src/agent.ts)   │
 │        │  tool_use          │
 │        ▼                    │
 │ Tools (src/tools.ts)        │ ──── read-only ────▶  Repository at REPO_PATH
 │ search_code · read_file     │                       (never outside it)
 └─────────────────────────────┘
```

### Components

| File | Responsibility |
|---|---|
| `src/index.ts` | Entry point for `npm run ask`. Loads `.env`, checks that an API key is set, runs the agent, prints the answer to stdout, and prints tool calls and a usage summary to stderr. |
| `src/agent.ts` | The hand-written Messages API loop: send, run tools, return results, repeat. Takes an injectable client so tests can replace Claude with scripted responses. |
| `src/tools.ts` | Tool implementations, their JSON Schema definitions for Claude, the dispatcher (`executeTool`), and the path guard (`safeResolve`). |
| `test/agent.test.ts` | Loop tests with a fake Claude client. |
| `test/tools.test.ts` | Tool tests against the repository itself. |
| `.github/workflows/ci.yml` | Typecheck and tests on every push and pull request. |

### Tools

| Tool | Input | Returns |
|---|---|---|
| `search_code` | `query`, `k` (1–25, default 8), `path_glob` (optional path prefix) | Up to k case-insensitive substring hits as `file:line`, with one line of context on each side |
| `read_file` | `path`, `start`, `end` | Numbered lines, at most 200 per call, with a hint to request the next range; refuses paths outside the repository |

The system prompt tells Claude to search before reading, read only the ranges it needs, cite `path:line`, and say so when the code doesn't answer the question rather than guess.

## 4. How it works

### The loop

1. **Start.** The conversation begins with one user message: the question.
2. **Ask Claude.** Call `messages.create` with the model, the system prompt, the tool definitions and the conversation so far.
3. **Record.** Add the response's token usage to the running totals, and append Claude's full response to the conversation as an assistant message. The whole content array is kept, including `tool_use` blocks, because the API requires each `tool_result` to answer a `tool_use` in the previous assistant turn.
4. **Decide.** If `stop_reason` is not `tool_use`, or there are no `tool_use` blocks, the run is finished: join the text blocks into the answer and return.
5. **Run tools.** Otherwise, run each requested tool in order. Each result becomes a `tool_result` block carrying the matching `tool_use_id`, the tool's text output, and `is_error`.
6. **Continue.** Send all the results back in one user message, and go to step 2.

### Stopping conditions

| Condition | Result |
|---|---|
| Claude stops asking for tools (`end_turn` or another non-tool stop reason) | The final answer, with turns, tool calls, token usage and the stop reason |
| The turn limit is reached (`maxTurns`, default 10) | A clear message asking for a narrower question, with `stopReason: "max_turns"` |
| The API call fails (network error, invalid key, rate limit) | The error propagates; the CLI prints it and exits with a non-zero code |

The turn limit is the main cost control in this phase. Without it, a model that keeps asking for tools would keep running and keep spending.

### Tool errors

Tool failures are returned to Claude, not thrown. A tool that cannot do what was asked (no matches, a path outside the repository, an unreadable file, an unknown tool name) returns text starting with `Error:`, which the loop marks `is_error: true`. An unexpected exception inside a tool is caught and reported the same way. Claude can then correct itself, for example by searching first and reading a valid path, instead of the whole run failing.

### Usage reporting

Every run reports the number of turns, the number of tool calls, and total input and output tokens. The CLI prints them after the answer, for example `[3 turn(s), 4 tool call(s), 9120 in / 410 out tokens]`. Input tokens grow each turn because the full conversation, including earlier tool results, is re-sent on every call. That is why the tools cap their output.

## 5. Security

| Risk | Mitigation |
|---|---|
| Reading files outside the repository, e.g. `../../etc/passwd` or an absolute path | Every path goes through `safeResolve()`, which resolves it against the repository root and rejects anything that escapes. Covered by a test. |
| Changing the repository | Both tools are read-only. There is no write, delete or shell tool. |
| Flooding the model with output (cost and context limits) | 200-line read windows, at most 25 search hits, search snippet lines truncated to 200 characters, files over 512 KB skipped, at most 5,000 files scanned per search. |
| Scanning binaries, dependencies or build output | Text-extension allowlist; `node_modules`, `.git`, `dist`, `bin`, `obj` and similar folders are skipped. |
| Runaway loops | The `maxTurns` limit. |
| Leaking the API key | The key lives in `.env`, which is git-ignored. The CLI checks it is set but never prints it. |

## 6. Key decisions and alternatives

| Decision | Alternative considered | Why this choice |
|---|---|---|
| Hand-written Messages API loop | Claude Agent SDK from the start | Makes every step of tool calling explicit and testable, and gives a baseline to compare against when the SDK is adopted for PR review in Phase 3. |
| Substring code search | Regular expressions, ripgrep, or an index | No dependencies and predictable behavior, and Claude can pick literal terms such as symbol names. Good enough for one repository; a faster backend can replace it behind the same tool. |
| Paged `read_file` with a 200-line window | Return whole files | Keeps each tool result small, so input tokens and cost stay bounded while Claude can still page through large files. |
| Tools return error text, marked `is_error` | Throw and end the run | Claude can recover from a bad call (wrong path, no matches) within the same run. |
| Injectable Messages client | Mock the network, or call the real API in tests | Tests are fast, free, deterministic and need no key, so they run in CI on every push. |
| Answer on stdout, progress on stderr | Everything on stdout | The answer can be piped or redirected while tool calls and usage still show in the terminal. |
| Model ID from `CLAUDE_MODEL`, with a default | Hard-coded model | The model can be changed without a code change. |

## 7. Testing

The Phase 1 suite had 7 tests that run in seconds with no API key. A fake client replays scripted Claude responses and records every request the loop sends, so the tests check the exact protocol, not just the final answer.

| Area | What is verified |
|---|---|
| Agent loop | A full round trip: a `tool_use`, the tool runs, the next request carries a `tool_result` with the matching `tool_use_id`, then the final answer, with turns, tool calls and summed token usage |
| Agent loop | A tool error (a path-traversal attempt) reaches Claude marked `is_error: true` |
| Agent loop | The run stops at `maxTurns` with `stopReason: "max_turns"` |
| Tools | `search_code` finds a known symbol with `file:line` and context, and reports no matches cleanly |
| Tools | `read_file` returns numbered lines and respects ranges, and refuses paths outside the repository |

CI (GitHub Actions) runs the typecheck and the tests on every push and pull request.

## 8. Configuration and usage

| Variable | Default | Purpose |
|---|---|---|
| `ANTHROPIC_API_KEY` | none (required) | Claude API key |
| `REPO_PATH` | current folder | Repository the tools are confined to |
| `CLAUDE_MODEL` | the project default | Model ID; check current IDs before changing it |

```powershell
# One-time setup
npm install
Copy-Item .env.example .env   # then add ANTHROPIC_API_KEY and REPO_PATH

# Ask a question
npm run ask -- "How does the agent decide when to stop?"

# Checks
npm run typecheck
npm test
```

## 9. How the loop evolved after Phase 1

The loop stayed hand-written in every later phase. It gained options, but its shape did not change.

- **Phase 2:** the agent takes a `ToolProvider` instead of a fixed tool list (`src/tool-provider.ts`). Tools come either from in-process code (the Phase 1 behavior, still the default) or from the MCP server, discovered at runtime. A third tool, `search_docs`, was added. See [mcp_server_design.md](mcp_server_design.md).
- **Phase 3:** PR review uses the Claude Agent SDK instead of this loop, on purpose, so the repository shows both orchestration styles over the same tools. See [pr_review_design.md](pr_review_design.md).
- **Phase 4:** the loop can stream text as it is generated (`onText`, with the turn number so the UI can tell interim notes from the final answer), reports each tool's result (`onToolResult`), and can be cancelled with an `AbortSignal` when the browser disconnects. See [web_ui_design.md](web_ui_design.md).

## 10. Limitations and next steps

- **Sequential tool calls.** When Claude asks for several tools in one turn, they run one after another. They could run in parallel, since all are read-only.
- **No spend cap in dollars.** The turn limit bounds cost only indirectly. The Phase 3 review agent has a per-review dollar cap; `ask` could get one too.
- **No retry logic of its own.** The loop relies on the Anthropic SDK client's built-in retries; an error that persists ends the run.
- **Lexical search only.** Substring matching misses synonyms and concepts; Phase 2 added ranked documentation search.
- **No evaluation suite.** Answer quality is checked by hand. A labeled evaluation set is on the roadmap.
