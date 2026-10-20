# Codebase Q&A and PR Review Assistant

An agentic assistant built on the Claude API that answers questions about a codebase, grounded in the actual code and docs. Its tools are served by a custom **MCP server** over Streamable HTTP, so the same tools work for this app, Claude Code, and any other MCP client.

**Stack:** TypeScript / Node, Claude API (`@anthropic-ai/sdk`), Model Context Protocol (`@modelcontextprotocol/sdk`), Express. Angular front end in Phase 4.

## Status

- **Phase 1 — complete.** Hand-written Messages API tool loop.
- **Phase 2 — complete.** Custom MCP server (Streamable HTTP) with code search, file reading, and documentation retrieval; the agent discovers its tools from the server at runtime.

### Tools

| Tool | What it does |
|---|---|
| `search_code` | Case-insensitive search across text files; returns `file:line` hits with context, capped at `k` |
| `read_file` | Reads a file with line numbers, 200 lines per call; refuses any path outside the repo root |
| `search_docs` | Retrieval over READMEs, design docs, and ADRs: heading-aware chunking + BM25 ranking, returns cited passages |

All three are marked read-only (`readOnlyHint`), validate their inputs with zod schemas, and return compact output to keep context and token use down.

## Quick start (Windows / PowerShell)

```powershell
npm install
Copy-Item .env.example .env
# edit .env: set ANTHROPIC_API_KEY and REPO_PATH (the repo you want to ask about)
npm run ask -- "Where is the HTTP interceptor configured, and what does it add to requests?"
```

Without `MCP_SERVER_URL` set, tools run in-process (Phase 1 mode). Tool calls print to stderr as they happen (`↳ search_code {...}`), followed by the answer and a token summary.

### Using the MCP server

Terminal 1 — start the server:
```powershell
npm run serve
# MCP server "codebase-qa" listening at http://127.0.0.1:3333/mcp
```

Terminal 2 — set `MCP_SERVER_URL=http://127.0.0.1:3333/mcp` in `.env`, then ask as usual:
```powershell
npm run ask -- "Why does the server refuse to bind to 0.0.0.0 without a token?"
# Tools: mcp:http://127.0.0.1:3333/mcp
```

### Using the MCP server from Claude Code

With the server running:
```powershell
claude mcp add --transport http codebase-qa http://127.0.0.1:3333/mcp
```
Claude Code can then call `search_code`, `read_file`, and `search_docs` against your repo.

### Server configuration

| Variable | Default | Purpose |
|---|---|---|
| `REPO_PATH` | current folder | Repository the tools are confined to |
| `MCP_PORT` | `3333` | Port to listen on |
| `MCP_HOST` | `127.0.0.1` | Bind address; local-only by default, with DNS-rebinding protection |
| `MCP_AUTH_TOKEN` | — | If set, clients must send `Authorization: Bearer <token>`. **Required** for any non-local host |

`GET /health` returns server name and version without auth, for uptime checks.

### Troubleshooting

- **`401 invalid x-api-key`** — the key was rejected. Values in `.env` take priority over Windows environment variables, so check the `.env` line is exactly `ANTHROPIC_API_KEY=sk-ant-...` (no quotes or spaces), or create a new key in the Console.
- **`Could not connect to MCP server`** — start it with `npm run serve` in another terminal, or remove `MCP_SERVER_URL` from `.env` to use local tools.
- **`npm.ps1 cannot be loaded ... not digitally signed`** — run `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned`, or use `npm.cmd` instead of `npm`.
- **npm 12 `install-scripts` warning for esbuild** — run `npm install-scripts approve esbuild`, then `npm install`.

## Tests

```powershell
npm run typecheck
npm test
```

17 tests, no API key needed. They cover the tools directly, document chunking and ranking, and the MCP server over real HTTP: tool discovery, schema validation, path-traversal refusal, bearer-token auth, and the full agent loop running against the server with a scripted fake Claude client.

## Architecture

```
┌──────────────────────────────────────────────┐
│  Angular front end (chat UI + streaming)      │  Phase 4
├──────────────────────────────────────────────┤
│  Agent (src/agent.ts) — Messages API loop     │  Phase 1 → Agent SDK in Phase 3
│    └─ ToolProvider: local | MCP client        │  Phase 2
├──────────────────────────────────────────────┤
│  MCP server (src/mcp-server.ts)               │  Phase 2
│    Streamable HTTP · stateless · bearer auth  │
├──────────────────────────────────────────────┤
│  Data: repo files + doc index (BM25)          │  Phase 2
└──────────────────────────────────────────────┘
```

Full design write-up: [docs/mcp_server_design.md](docs/mcp_server_design.md) ([PDF](docs/mcp_server_design.pdf)) (regenerate with `python scripts/build_design_doc.py docs/mcp_server_design.pdf`, requires `pip install reportlab`).

**Design notes**

- **Client-side MCP.** The agent connects to the server with the MCP client SDK, lists its tools, and translates them into Messages API tool definitions. This works against a server on `localhost`. (The Messages API's built-in MCP connector needs a publicly reachable server, which fits the hosted deployment in Phase 5.)
- **Pluggable tool source.** The agent loop depends only on a `ToolProvider` interface, so in-process tools and MCP tools are interchangeable — and new server tools reach the agent with no agent code change.
- **Stateless server.** Each request gets a fresh server and transport, so it can scale horizontally behind a load balancer.
- **Lexical retrieval first.** `search_docs` uses BM25 with no embedding model or vector store. It exposes the same query → cited passages interface an embedding retriever would, so it can be upgraded without touching the tool contract.

## Roadmap

- **Phase 3 — PR review.** Add `get_pr_diff` and `post_review_comment` (GitHub API) to the MCP server, and move orchestration to the Agent SDK.
- **Phase 4 — Angular UI.** Chat interface with streaming answers and a visible tool-call trace.
- **Phase 5 — Production.** Evaluation suite (answer grounding, review quality), cost limits, tracing, and a public demo deployment of the MCP server.

## License

MIT
