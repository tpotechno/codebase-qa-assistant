# Codebase Q&A and PR Review Assistant

An agentic assistant built on the Claude API that answers questions about a codebase and drafts pull-request review comments. It is grounded in the actual code through task-shaped tools, and in later phases it exposes those tools through a custom MCP server.

**Stack:** TypeScript / Node, Claude API (`@anthropic-ai/sdk`), Angular front end (Phase 4).

## Status

**Phase 1 — complete.** A hand-written Messages API tool loop with two tools:

| Tool | What it does |
|---|---|
| `search_code` | Case-insensitive search across text files; returns `file:line` hits with context, capped at `k` results |
| `read_file` | Reads a file with line numbers, 200 lines per call, refuses any path outside the repo root |

The loop (`src/agent.ts`): call Claude → run any `tool_use` blocks → return `tool_result` blocks (errors flagged with `is_error`) → repeat until Claude answers or a turn limit is hit. Token usage is tracked per run.

## Quick start (Windows / PowerShell)

```powershell
npm install
Copy-Item .env.example .env
# edit .env: set ANTHROPIC_API_KEY and REPO_PATH (the repo you want to ask about)
npm run ask -- "Where is the HTTP interceptor configured, and what does it add to requests?"
```

Tool calls print to stderr as they happen (`↳ search_code {...}`), followed by the answer and a token summary.

### Troubleshooting

- **`401 invalid x-api-key`** — the key was rejected. Values in `.env` take priority over Windows environment variables, so check the `.env` line is exactly `ANTHROPIC_API_KEY=sk-ant-...` (no quotes or spaces), or create a new key in the Console.
- **`npm.ps1 cannot be loaded ... not digitally signed`** — run `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned`, or use `npm.cmd` instead of `npm`.
- **npm 12 `install-scripts` warning for esbuild** — run `npm install-scripts approve esbuild`, then `npm install`.

## Tests

```powershell
npm run typecheck
npm test
```

Tests run without an API key: the tools are tested directly, and the agent loop is tested against a scripted fake Claude client (tool round-trips, error flagging, the turn limit).

## Architecture

```
┌─────────────────────────────────────────────┐
│  Angular front end (chat UI + streaming)     │  Phase 4
├─────────────────────────────────────────────┤
│  Node/TS backend — agent orchestration       │  Phase 1 (hand loop) → Phase 3 (Agent SDK)
├─────────────────────────────────────────────┤
│  MCP server (TypeScript, remote HTTP)        │  Phase 2
├─────────────────────────────────────────────┤
│  Data layer: Git repo + doc index (RAG)      │  Phase 2
└─────────────────────────────────────────────┘
```

## Roadmap

- **Phase 2 — MCP server + RAG.** Move `search_code` / `read_file` behind a remote HTTP MCP server, and add `search_docs` over READMEs and design docs. The same tools then serve both this app and Claude Code.
- **Phase 3 — PR review.** Add `get_pr_diff` and `post_review_comment` (GitHub API), and move orchestration to the Agent SDK.
- **Phase 4 — Angular UI.** Chat interface with streaming answers and a visible tool-call trace.
- **Phase 5 — Production.** Evaluation suite (answer grounding, review quality), cost limits, tracing, public demo deployment.

## License

MIT
