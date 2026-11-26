# Codebase Q&A Assistant: Project Context

A single briefing on this project: what it is, how it's built, where everything lives, the rules it's built around, and how it's deployed. Read it at the start of a new working session, by a person or by Claude, before changing anything.

| | |
|---|---|
| Owner | Todd Oppel (GitHub `tpotechno`) |
| Repository | github.com/tpotechno/codebase-qa-assistant (public to view; all rights reserved) |
| Version | 0.7.0 |
| Status | Phases 1–6 complete; live on Azure |
| Last updated | November 26, 2026 |

Related documents:

- **Working rules for Claude:** [`CLAUDE.md`](../CLAUDE.md) and `.claude/rules/` (backend TypeScript, Angular, infra, C#).
- **Design docs, one per phase:**
  - Phase 1, the tool loop: [tool_loop_design.md](tool_loop_design.md)
  - Phase 2, the MCP server: [mcp_server_design.md](mcp_server_design.md)
  - Phase 3, PR review: [pr_review_design.md](pr_review_design.md)
  - Phase 4, the web UI: [web_ui_design.md](web_ui_design.md)
  - Phase 5, Azure: [azure_design.md](azure_design.md)
  - Phase 6, choosing a codebase: [repo_selection_design.md](repo_selection_design.md) (plan: [repo_selection_plan.md](repo_selection_plan.md))
- **Azure setup and troubleshooting:** [azure_deployment.md](azure_deployment.md)
- **Live demo:** https://codebase-qa-demo.ambitiousdesert-11a1c74b.westus2.azurecontainerapps.io

## 1. What it is

An agentic assistant built on the Claude API with two jobs:

- **Ask.** Answer questions about a codebase (the server's own, a local folder, or a GitHub repository the person opens), grounded in the actual code and docs. The agent searches the code, reads files and searches the documentation, then answers with `file:line` citations.
- **Review.** Review a GitHub pull request. An agent reads the PR and its whole diff, looks up surrounding code when it needs context, and returns a structured review with line-anchored comments. A person can then post it to GitHub as a single **comment** review. It never approves or requests changes.

Its tools are served by a custom **MCP server** over Streamable HTTP, so the same tools work for this app, for Claude Code and for any other MCP client.

It is Todd's flagship portfolio project for remote Senior Software Engineer roles. The second project, an invoice/accounts-payable agent, reuses its patterns. It's planned in `C:\Claude Code Projects\invoice-ap-agent\`, with its own session.

## 2. Stack

| Layer | Technology |
|---|---|
| Backend | Node with TypeScript (ESM, `strict`), run directly with `tsx` (no build step); Express 5 |
| Claude | `@anthropic-ai/sdk` (Messages API: tool use, streaming), `@anthropic-ai/claude-agent-sdk` (review agent) |
| Tools | `@modelcontextprotocol/sdk` (MCP server and client), `zod` schemas |
| Web UI | Angular 21: standalone components, signals, zoneless, Vitest; IBM Plex fonts bundled; `marked` for Markdown |
| Data | Repo files on disk, a BM25 document index built in memory, GitHub REST API |
| Cloud | Azure Container Apps, Container Registry, Key Vault, Log Analytics; Bicep; GitHub Actions with OIDC |
| Dev environment | Windows 11, VS Code, PowerShell; Node 24 locally (CI: Node 22 backend, Node 24 web and image) |

The default model is `claude-sonnet-5-5`, overridable with `CLAUDE_MODEL`. Don't change model IDs without confirming the current ones first.

## 3. Phase history

| Phase | What it added | PRs |
|---|---|---|
| 1 | A hand-written Messages API tool loop with `search_code` and `read_file`, and the `npm run ask` CLI | direct commits |
| 2 | The custom MCP server (Streamable HTTP, stateless, bearer-token auth) and `search_docs`; the agent discovers its tools from the server at runtime | direct commits |
| 3 | GitHub PR tools on the server; the review agent on the Claude Agent SDK; `npm run review` with `--post` | #1 |
| 4 | Angular web UI: streaming answers, a live tool-call trace, PR reviews posted by draft id; the scripted demo mode | #2 |
| 5 | Azure Container Apps: a public demo and a private real app, Bicep, OIDC deploys, Key Vault, GitHub sign-in | #3–#8 |
| Docs | The Phase 1 design doc written after the fact; `CLAUDE.md` and `.claude/rules/` | #9 |
| 6 | Ask about any codebase: a folder path or a GitHub repo, shallow-cloned into a size-capped cache; `/mcp/<id>`; real-path checks in `read_file`; `--repo` on the CLI; the demo's tour for other repos | #11 |

Each phase was reviewed by the project's own PR reviewer, and its findings were fixed before merging.

## 4. Architecture

```
Angular UI (web/) --SSE over fetch--> Web API (src/web-app.ts)                Phase 4
  ask:    src/agent.ts   hand-written Messages API loop -> ToolProvider        Phase 1-2
  review: src/review.ts  Claude Agent SDK, read-only tools, JSON schema output  Phase 3
MCP server (src/mcp-server.ts): Streamable HTTP, stateless, bearer auth        Phase 2-3
Repos (src/repos.ts): location -> policy -> folder or shallow clone -> id     Phase 6
Data: repo files (safeResolve) | doc index (BM25) | GitHub REST (github.ts)
Azure Container Apps: demo + private app, OIDC deploys, Bicep, Key Vault       Phase 5
```

Key design points:

- **Two orchestration styles on purpose.** Ask uses a hand-written loop. Review uses the Agent SDK, which owns the loop, the MCP connection, permissions, the turn limit, the spend cap and structured output.
- **A pluggable tool source.** The Ask loop depends only on a `ToolProvider` interface. The tools can run in-process (`localToolProvider`) or over MCP (`mcpToolProvider`).
- **The model never gets the write tool.** The review agent's allowlist is read-only. Posting is a separate step a person triggers.
- **The person picks the codebase, never the model.** `/api/repo` resolves a location to a server-issued id. The MCP server serves that root at `/mcp/<id>`, and the tools' contracts are unchanged.
- **Lexical retrieval.** `search_docs` uses BM25 over heading-chunked Markdown, with no embeddings. Its interface would allow swapping in an embedding retriever later.

## 5. Repository layout

| Path | What's there |
|---|---|
| `src/tools.ts` | `search_code`, `read_file` (path guards `safeResolve` and `safeResolveReal`), tool dispatch, `repoRoot()` |
| `src/repos.ts` | `parseLocation`, `repoPolicyFromEnv`, `RepoRegistry`: local folders, defensive GitHub clones, the clone cache |
| `src/docs.ts` | Markdown chunking and BM25 ranking for `search_docs` |
| `src/agent.ts`, `src/index.ts` | The Ask agent loop (streaming, abort, tool callbacks) and its CLI |
| `src/tool-provider.ts` | `localToolProvider`, `mcpToolProvider`, `toolProviderFromEnv` |
| `src/mcp-server.ts`, `src/serve.ts` | `createMcpServer`, `startHttpServer`; the standalone server CLI |
| `src/github.ts` | GitHub REST client: PR fetch and cache, diff paging and line mapping, `postReview`, `StaleHeadError` |
| `src/review.ts`, `src/review-cli*.ts` | The review agent (Agent SDK options, sanitized env, budget) and its CLI |
| `src/web-app.ts`, `src/web-server.ts` | Express API: SSE routes, guards, sign-in gate, `DraftStore`; the server entry point |
| `test/` | `node:test` suites; `test/fixtures/fake-github.ts` is an in-memory GitHub |
| `web/` | The Angular app: `ask/`, `repo-picker/`, `review/`, `trace/`, `api.ts`, `sse.ts`, `markdown.pipe.ts`, `models.ts` |
| `scripts/demo-server.ts` | The scripted-model demo (real repo tools, fake GitHub, sample PR `acme/widgets#7`) |
| `scripts/md_to_pdf.py` | Builds the design-doc PDFs from Markdown, with drawn diagrams (needs `reportlab`) |
| `infra/` | `registry.bicep`, `main.bicep` (demo), `private.bicep` (private app) |
| `Dockerfile`, `.dockerignore` | One keyless image for both apps |
| `.github/workflows/` | `ci.yml` (tests, build, Bicep, image checks); `deploy.yml` (Azure) |
| `.mcp.json` | Gives Claude Code the `angular-cli` MCP server for Angular docs and best practices |

## 6. Tools

| Tool | Kind | What it does |
|---|---|---|
| `search_code` | read | Case-insensitive search across text files; `file:line` hits with context, capped |
| `read_file` | read | A file with line numbers, 200 lines per call; refuses paths outside the repo root |
| `search_docs` | read | BM25 retrieval over READMEs, design docs and ADRs; returns cited passages |
| `get_pr` | read | PR title, description, author, branches, head commit, changed files |
| `get_pr_diff` | read | The diff with new-file line numbers, paged at about 24k characters; lockfiles collapsed |
| `post_review` | write | Publishes one **COMMENT** review. Registered only with a token and `GITHUB_ALLOW_POST=true` |

Every input is validated with zod. Tool failures return text starting with `Error:` instead of throwing.

## 7. Non-negotiable invariants

These are the security properties the project is built around. Don't weaken them, and flag any change that touches them. CI tests the starred ones.

- Every file path from a user or the model goes through `safeResolve()`. Nothing reads outside the repo root. `read_file` also checks the real path (`safeResolveReal`), so symlinks can't escape.
- The repo root is chosen by the person through `/api/repo` (or `--repo`), never by the model. Tools never take a root.
- GitHub repos are cloned defensively: `execFile` with no shell, https only, no symlinks, no hooks, no user or system git config, a stripped environment, and the token only as a header. See `src/repos.ts`.
- Every tool except `post_review` is read-only and keeps `readOnlyHint`.
- `post_review` posts only a single COMMENT review. It's off by default and needs both `GITHUB_TOKEN` and `GITHUB_ALLOW_POST=true`.
- The review agent never gets a write tool: no built-in tools, `dontAsk` mode, no local settings, a strict MCP config, and a sanitized environment (`agentEnv()`).
- Web posting goes by **draft id** only. The server posts the review it generated itself, at most once, and refuses if the PR head moved since the review.
- ★ `serve.ts` refuses a non-local host without `MCP_AUTH_TOKEN`.
- ★ `web-server.ts` refuses to bind publicly without `ALLOWED_GITHUB_USERS`.
- The web API rejects:
  - a foreign `Host` (DNS rebinding);
  - a foreign `Origin` (cross-site requests);
  - anything but JSON on state-changing routes.
- The hosted sign-in gate matches the GitHub **login** from `X-MS-CLIENT-PRINCIPAL` claims, never the display name, which anyone can set.
- `Referrer-Policy` stays `same-origin`, never `no-referrer`. Container Apps sign-in rejects signed-in POSTs that carry no `Referer`.
- ★ The demo image has no API keys. Secrets live in `.env` locally (git-ignored) and in Key Vault on Azure. Never commit secrets or print key values.
- Model output is rendered only through `MarkdownPipe`, which escapes raw HTML; never `bypassSecurityTrustHtml`.

## 8. Configuration

Locally, settings come from `.env` (copy `.env.example`). Values in `.env` override Windows environment variables.

| Variable | Default | Purpose |
|---|---|---|
| `ANTHROPIC_API_KEY` | — | Required for Ask, Review and the web app |
| `REPO_PATH` | current folder | The repository the tools are confined to |
| `CLAUDE_MODEL` | `claude-sonnet-5-5` | Model override |
| `MCP_SERVER_URL` | — | If set, Ask uses this MCP server instead of in-process tools |
| `MCP_PORT` / `MCP_HOST` / `MCP_AUTH_TOKEN` | 3333 / 127.0.0.1 / — | Standalone MCP server; a token is required for a non-local host |
| `GITHUB_TOKEN` | — | Fine-grained token: Pull requests read/write, Contents read-only |
| `GITHUB_ALLOW_POST` | false | Registers `post_review` on a standalone server |
| `REVIEW_MAX_BUDGET_USD` | 1 | Spend cap per review |
| `WEB_PORT` | 3334 | Web API port |
| `WEB_HOST` / `PUBLIC_HOSTS` / `ALLOWED_GITHUB_USERS` | loopback / — / — | Hosting only; set by `infra/private.bicep` |
| `DEMO_HOST` / `DEMO_PORT` | loopback / 3335 | Demo server; set in the image |
| `REPO_ALLOWED_ROOTS` | — | Folders local paths must be inside. Unset locally: any folder. Hosted: local folders are off unless set. Demo: always off |
| `REPO_ALLOW_GITHUB` | true | `false` stops opening GitHub repos |
| `REPO_MAX_MB` / `REPO_CACHE_MAX_MB` | 500 / 2000 local, 200 / 1000 hosted, 50 / 500 demo | Largest repo, and the clone cache's disk cap |
| `REPO_CACHE_DIR` | temp folder | Where clones live; `/tmp/codebase-qa-repos` in the image |

## 9. Everyday commands (PowerShell, from the repo root)

| Task | Command |
|---|---|
| Install | `npm install`, then `npm run web:install` |
| Typecheck the backend | `npm run typecheck` |
| Backend tests (106; 1 skips on Windows) | `npm test`; one file: `npx tsx --test test/tools.test.ts` |
| Web tests (25) | `npm run web:test` |
| Build the UI | `npm run web:build` |
| Ask | `npm run ask -- "question"`; another codebase: `npm run ask -- --repo <folder or owner/repo> "question"` |
| Review a PR | `npm run review -- owner/repo#123`; add `--post` to publish, `--out review.md` to save |
| MCP server | `npm run serve` (port 3333); connect Claude Code with `claude mcp add --transport http codebase-qa http://127.0.0.1:3333/mcp` |
| Web app | `npm run web` (http://localhost:3334); dev UI with live reload: `npm run web:dev` |
| Scripted demo | `npm run web:demo` (port 3335, no key needed) |
| Rebuild a design PDF | `python scripts/md_to_pdf.py docs/<name>.md docs/<name>.pdf` |

Before calling any change done, run the typecheck, both test suites and the web build for whatever you touched. CI runs the same checks. Tests never hit the network or use a real API key: they use a scripted Claude client, a scripted Agent SDK stream and the fake GitHub.

## 10. Azure deployment

**Two apps run from one image**, in resource group `codebase-qa-demo-rg` (West US 2):

| App | Runs | Access |
|---|---|---|
| `codebase-qa-demo` | `scripts/demo-server.ts`: scripted model, no keys | Public (the live demo link above) |
| `codebase-qa` | `src/web-server.ts`: real Claude, real GitHub, posting | GitHub sign-in plus an allowlist of `tpotechno` |

The private app's URL is on the `azure-demo` environment in GitHub and in the deploy run summary.

**Other resources:**
- the Container Apps environment `codebase-qa-demo-env`;
- a Container Registry (Basic, `cqa…`) and Log Analytics (1 GB/day cap);
- a Key Vault (`cqakv…`);
- managed identities for image pulls and secret reads.

All of them are defined in `infra/*.bicep`.

**How a deploy works.** Every merge to `main` runs `deploy.yml`:

1. It signs in to Azure with OIDC, so no credential is stored in GitHub.
2. It builds and pushes the image, tagged with the commit SHA.
3. It deploys the registry, the demo and the private app.
4. It smoke-tests both apps. The private app must refuse unauthenticated requests.

**Where the settings live:**

| Where | Names |
|---|---|
| GitHub repository variables | `AZURE_CLIENT_ID`, `AZURE_TENANT_ID`, `AZURE_SUBSCRIPTION_ID`, `AZURE_RESOURCE_GROUP`, `PRIVATE_APP_ENABLED`, `PRIVATE_OAUTH_CLIENT_ID` (optionally `PRIVATE_ALLOWED_USERS`) |
| Key Vault secrets | `anthropic-api-key`, `github-token`, `github-oauth-secret` |
| GitHub OAuth app | "Codebase Q&A (private)", used for the private app's sign-in |

**Opening repos on Azure.** The image includes `git`. Both apps open public GitHub repos; the private app also opens private ones its `GITHUB_TOKEN` can read. Clones live on the replica's ephemeral storage, which is 1 GiB for the demo (0.25 vCPU) and 2 GiB for the private app (0.5 vCPU). The default cache caps leave room, and a restart empties the cache.

**Cost:** about $5 a month, mostly the registry. Both apps scale to zero, so the first visit after an idle period waits a few seconds.

**Lessons from the first deploy** (details in [azure_design.md](azure_design.md), section 7):

- GitHub's OIDC subject now includes numeric IDs: `repo:tpotechno@44557011/codebase-qa-assistant@1426449283:environment:azure-demo`.
- The subscription needed these providers registered:
  - `Microsoft.App`;
  - `Microsoft.OperationalInsights`;
  - `Microsoft.ContainerRegistry`;
  - `Microsoft.ManagedIdentity`;
  - `Microsoft.KeyVault`.
- A 401 on the OAuth callback meant a wrong client secret in Key Vault.
- The platform passes the GitHub display name, not the login, in `X-MS-CLIENT-PRINCIPAL-NAME`.
- An empty 403 carrying `x-ms-middleware-request-id`, without the app's own headers, means the sign-in layer refused the request before it reached the app. In our case the cause was a missing `Referer`.

**Changing a secret:** set it with `az keyvault secret set`, then restart the private app's revision. The commands are in [azure_deployment.md](azure_deployment.md).

## 11. How we work on this repo

- Todd wants to understand every change.
  - Explain what's changing and why before larger edits.
  - Comment code so each step is clear.
  - Keep the pieces small.
- Ask before:
  - adding a dependency;
  - changing a tool's contract;
  - touching `deploy.yml`, `infra/`, or the container's start command.
- Update tests with every behavior change. When a tool changes, update its zod schema, the README "Tools" table and the relevant design doc together.
- Don't hand-edit `package-lock.json` files or the generated PDFs.
- Don't guess APIs:
  - Angular: use the `angular-cli` MCP tools.
  - Anthropic, Agent SDK and MCP SDK: check the installed types in `node_modules` or the official docs.
  - Azure: check Microsoft Learn.
- Work on a branch and merge by PR. Running the project's own reviewer on a PR (`npm run review -- tpotechno/codebase-qa-assistant#N`) is part of the routine.
- On Windows, use PowerShell syntax: `Copy-Item`, `$env:NAME = "value"`, and `;` rather than `&&` on PowerShell 5. If `npm` is blocked by the execution policy, use `npm.cmd` or `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned`.

## 12. Known limitations and roadmap

- **The reviewer uses the server's own repo for context.** Ask can open any codebase, but the PR reviewer's `search_code`/`read_file` still read the built-in one. Next: open the PR's repository at its head commit.
- **The demo's GitHub rate limit.** Opening a repository makes two unauthenticated GitHub API calls, and GitHub allows 60 an hour per IP.
- **One replica.** Drafts, the run limit, repo ids and the clone cache live in memory or on the replica's disk. A shared store would allow scaling out.
- **Large PRs.** The reviewer reads the whole diff page by page. Very large PRs can hit the spend cap; raise `REVIEW_MAX_BUDGET_USD` for those.
- **Roadmap:**
  - an evaluation suite for answer grounding and review quality, run in CI;
  - a hosted MCP endpoint behind a bearer token;
  - Azure DevOps pull requests behind the same interface as GitHub;
  - tracing with OpenTelemetry.

## 13. Starting a new session

To work on this project in a fresh Claude session, open the repo (`CLAUDE.md` loads automatically) and point the session at this file:

> Read `docs/codebase_qa_context.md` and `CLAUDE.md` before doing anything. Follow the invariants in section 7 and the working rules in section 11. Today's task: ...

Keep this file current. When a phase lands or a deployment detail changes, update the matching section in the same PR.
