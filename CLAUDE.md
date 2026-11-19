# Codebase Q&A and PR Review Assistant

Agentic assistant on the Claude API that answers questions about a codebase and reviews GitHub
pull requests. Its tools are served by a custom MCP server (Streamable HTTP). Public demo and
private app run on Azure Container Apps, deployed from GitHub Actions.

Owner: Todd (tpotechno). Develops on Windows 11 in VS Code with PowerShell.

## Repository layout

- `src/` — Node/TypeScript backend (ESM, run directly with `tsx`, no build step)
  - `tools.ts`, `docs.ts` — repo tools (`search_code`, `read_file`, `search_docs`)
  - `github.ts` — GitHub REST client and PR tools
  - `mcp-server.ts`, `serve.ts` — the MCP server
  - `agent.ts`, `index.ts` — Ask agent (Messages API tool loop) and CLI
  - `review.ts`, `review-cli*.ts` — PR review agent (Claude Agent SDK) and CLI
  - `web-app.ts`, `web-server.ts` — Express API + SSE for the web UI
- `test/` — backend tests (`node:test`); `test/fixtures/` holds fakes such as `fake-github.ts`
- `web/` — Angular 21 web UI (its own `package.json`; run Angular commands from `web/`)
- `scripts/` — `demo-server.ts` (scripted-model demo) and Python helpers that build the design-doc PDFs
- `infra/` — Bicep for Azure; `Dockerfile` builds the keyless demo image
- `docs/` — design docs (`*_design.md`, with generated PDFs) and `azure_deployment.md`

## Commands (PowerShell, from the repo root unless noted)

- Install: `npm install` and `npm run web:install`
- Typecheck backend: `npm run typecheck`
- Backend tests: `npm test`; one file: `npx tsx --test test/tools.test.ts`
- Web tests: `npm run web:test` (Vitest, single run)
- Web build: `npm run web:build`
- Run: `npm run ask -- "question"`, `npm run review -- owner/repo#123`,
  `npm run serve` (MCP server, port 3333), `npm run web` (API, port 3334),
  `npm run web:dev` (Angular dev server), `npm run web:demo` (scripted demo, port 3335)
- Use PowerShell syntax in commands (`Copy-Item`, `$env:NAME = "value"`, `;` not `&&` on Windows PowerShell 5).

## Non-negotiable invariants

These are security properties the project is built around. Do not weaken them, and flag any change that touches them.

- Every file path from a user or model goes through `safeResolve()`; nothing reads outside the repo root.
- Every tool except `post_review` stays read-only and keeps `readOnlyHint`.
- `post_review` only ever posts a single **COMMENT** review (never approve or request changes),
  is off by default, and needs both `GITHUB_TOKEN` and `GITHUB_ALLOW_POST=true`.
- `serve.ts` refuses a non-local host without `MCP_AUTH_TOKEN`; `web-server.ts` refuses to bind
  publicly without `ALLOWED_GITHUB_USERS`. CI tests these; keep them passing.
- The demo image contains no API keys. Secrets live in `.env` locally (git-ignored) and in Key Vault on Azure.
- Never commit secrets, and never print key values in logs or output.

## How to work in this repo

- Before calling a task done, run `npm run typecheck`, `npm test`, `npm run web:test` and
  `npm run web:build` for whatever you touched. CI (`.github/workflows/ci.yml`) runs the same checks.
- Add or update tests with every behavior change. Tests never hit the network or a real API key.
- When a tool's name, inputs or behavior changes, update its zod schema, the README "Tools" table
  and the relevant design doc in `docs/`.
- Ask before adding a dependency, changing a public tool contract, or editing `deploy.yml` or `infra/`.
- Don't hand-edit `package-lock.json` files or generated PDFs in `docs/`.
- Explain what you're changing and why before larger edits. Todd wants to understand every change.
- Comment code so each step is clear: what it does and why, not just restating the line.

## Looking things up

- Don't guess APIs. For Angular, use the `angular-cli` MCP tools (`get_best_practices`,
  `search_documentation`). For the Anthropic SDK, Agent SDK and MCP SDK, check the installed
  package's types in `node_modules` or the official docs, and say so if unsure.
- Don't change the default `CLAUDE_MODEL` or other model IDs without confirming current IDs first.

Detailed conventions live in `.claude/rules/` (backend TypeScript, Angular, infra) and load
automatically for matching files.
