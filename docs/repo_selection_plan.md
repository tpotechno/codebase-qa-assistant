# Plan: Ask about any codebase (local folder or GitHub repo)

> **Status: implemented** on branch `feature/any-codebase`, as one PR rather than four. Design and results: [repo_selection_design.md](repo_selection_design.md). Where the build departs from this plan:
>
> - **Concurrent downloads.** A second download while one is running is refused with a clear 429, not queued. That's simpler, and safer on the public demo.
> - **The clone cache.** It adopts clones already on disk at startup instead of deleting them, so the CLI and the web app can share it. Only temp folders older than an hour are removed.
> - **The demo's scripted model.** It's now stateless: it reads the conversation, so concurrent visitors don't share a script.
> - **The system prompt.** The Ask agent's prompt names the chosen codebase (`repoLabel`).
> - **Dockerfile and storage.** The Dockerfile was changed without a separate check-in, as Todd asked. Container Apps ephemeral-storage limits were checked on Microsoft Learn: 1 GiB at 0.25 vCPU and 2 GiB at 0.5 vCPU. The defaults fit, so no Bicep change was needed.

## Context

Today every entry point fixes the repository once at startup. `repoRoot()` ([src/tools.ts:24](src/tools.ts#L24)) reads `REPO_PATH` or the cwd. `web-server.ts` and `scripts/demo-server.ts` start one MCP server bound to that root, and the UI only shows `repoName`. As a result, the app can only answer questions about itself (in the demo and on Azure) or about whatever `REPO_PATH` named at launch.

The goal is to let the user type a codebase location in the Ask screen and ask about it:
- **A local folder**, e.g. `C:\source\repos\other-app`.
- **A GitHub repo**: `owner/repo`, optionally `owner/repo@branch`, or a github.com URL. The server shallow-clones it into a cache.

This works everywhere:
- **Locally**: local folders and GitHub repos.
- **Private Azure app**: GitHub repos (public, plus private ones its `GITHUB_TOKEN` can read) and the built-in repo.
- **Public demo**: public GitHub repos within tight limits, plus the built-in repo. The model stays scripted.

This is the roadmap's "clone a chosen repository on demand" and "multi-repo support".

## Key design decisions

1. **The person chooses the repo, never the model.** The tool contracts (`search_code`, `read_file`, `search_docs`) stay exactly as they are. The model cannot name a root.
   - The server resolves a location into an opaque, server-issued `repoId`.
   - The MCP server exposes one endpoint per resolved root.
   - So the README "Tools" table and the zod schemas don't change.
2. **The MCP server serves a root per path.** `startHttpServer` gains `rootFor?: (id) => string | undefined` and a route `POST /mcp/:repoId`, using the same bearer auth and the same stateless per-request `createMcpServer(root)`. `/mcp` keeps serving the default root, so `npm run serve` and Claude Code users are unaffected.
3. **Clone with the `git` binary via `execFile`.** No shell and no new npm dependency. Untrusted repos are cloned defensively:
   - `--depth 1 --single-branch --no-tags`, and no submodules.
   - `-c core.symlinks=false`, so symlinks become plain files.
   - `-c core.hooksPath=` set empty.
   - `protocol.allow=never` with `protocol.https.allow=always`.
   - `GIT_TERMINAL_PROMPT=0`, with global and system config ignored.
   - A timeout on the clone.
4. **Size is checked before cloning.** GitHub's repo API returns `size`, the default branch and visibility. Oversized repos are refused before any download.
5. **The token never appears in a URL or a log.** For private repos on the private app, `GITHUB_TOKEN` is passed through `GIT_CONFIG_COUNT`/`KEY`/`VALUE` env as an `http.extraHeader`.
6. **Policy is set by environment, with safe defaults per mode:**

   | Setting | Local (loopback) | Private app | Public demo |
   |---|---|---|---|
   | Local paths | any folder, or only under `REPO_ALLOWED_ROOTS` if set | off unless `REPO_ALLOWED_ROOTS` | off |
   | GitHub clone | on | on (token for private repos) | on, public only, no token |
   | Max repo size (`REPO_MAX_MB`) | 500 | 200 | 50 |
   | Cache cap (`REPO_CACHE_MAX_MB`) | 2000 | 1000 | 500 |
   | Concurrent clones | 2 | 1 | 1 |

   The defaults live in code, so no Bicep change is needed. Bicep can override them later.

## Security invariants this touches (flagged)

- **`safeResolve()` gets stronger, not weaker.** Today it only compares lexical paths, so a symlink inside the repo could point outside it. Untrusted clones make that a real risk.
  - Add a realpath check: resolve the root and the target with `fs.realpath`, then re-check containment.
  - `readFile` uses it. `walk()` already skips symlinks, because it uses `Dirent.isFile`/`isDirectory`.
  - Belt and braces: `core.symlinks=false` on clone.
- **Every tool stays read-only.** Nothing new is exposed to the model.
- **Prompt injection.** An untrusted repo can carry instructions in its files. The worst case is a misleading answer: the Ask tools are read-only and confined to the root, and there's no write or exfiltration tool. I'll note this in the design doc.
- **Abuse of the public demo.** Anyone could trigger clones, which costs disk and bandwidth. Mitigations:
  - Public repos only, with the 50 MB cap and the 500 MB LRU cache.
  - One clone at a time, and a clone timeout.
  - The existing run limit and the Host/Origin/JSON guards also apply to `/api/repo`.

## Implementation steps (suggested as 4 PRs)

### PR 1: harden path confinement
- In [src/tools.ts](src/tools.ts): add `safeResolveReal(root, rel)`, which realpaths the target, re-checks it against the realpath'd root, and maps a missing file to the existing error text. Use it in `readFile`. Keep `safeResolve` for the lexical pre-check.
- Make `localToolProvider(root?)` take a root, so the CLI can use a chosen repo.
- Tests in `test/tools.test.ts`: a symlink that escapes the root is refused. Skip the test when Windows returns `EPERM` for symlink creation.

### PR 2: repo resolver, MCP route, web API, UI, CLI (local folders)
- **New `src/repos.ts`, a `RepoRegistry`:**
  - `parseLocation(input)` returns `{kind:"local", path}` or `{kind:"github", owner, repo, ref?}`. It accepts `owner/repo`, `owner/repo@ref` and `https://github.com/owner/repo[/tree/ref]`.
  - `resolve(input)` returns `{ id, root, name, kind, label, sha? }`.
    - Local: `path.resolve`, then realpath, then require a directory, then an allowlist check against `REPO_ALLOWED_ROOTS`, reusing the containment logic from `safeResolve`.
    - The `id` is a server-generated UUID mapped to the root.
  - `rootFor(id)` looks up a root, with a TTL. Plus `defaultRepo()` for the built-in root.
  - Policy comes from `repoPolicyFromEnv(mode)`.
- **[src/mcp-server.ts](src/mcp-server.ts):** add `rootFor` to `HttpServerOptions` and a `POST /mcp/:repoId` route. An unknown id gets a JSON-RPC error. Add `GET`/`DELETE` 405s like the existing `/mcp`.
- **[src/web-app.ts](src/web-app.ts):**
  - `WebAppDeps` gains `repos: RepoRegistry`, and `openTools(repoId?)`.
  - New `POST /api/repo` with body `{ location: string (≤500) }`. It returns `{ repoId, name, label, kind, sha }`, or 400/403/413 with a clear message (not allowed, not found, too large).
  - `/api/ask` body gains an optional `repoId`. An unknown or expired id returns 404: "Choose the codebase again".
  - `/api/config` adds `repoChoice: { local: boolean; github: boolean }`, keeping the default `repoName`.
- **[src/web-server.ts](src/web-server.ts) and [scripts/demo-server.ts](scripts/demo-server.ts):** build the registry with the right mode, pass `rootFor` to `startHttpServer`, and make `openTools = (id) => mcpToolProvider(id ? \`${base}/${id}\` : mcp.url, token)`.
- **[src/index.ts](src/index.ts):** add `npm run ask -- --repo <location> "question"`. It resolves through the same registry and uses local tools with that root. `REPO_PATH` stays the default.
- **Web UI:**
  - [web/src/app/models.ts](web/src/app/models.ts): add `RepoInfo` and `repoChoice`.
  - [web/src/app/api.ts](web/src/app/api.ts): add `openRepo(location)`.
  - [web/src/app/ask/ask.ts](web/src/app/ask/ask.ts) and its HTML: add a "Codebase" field above the question, with a Load button and a status line. The status reads "Loading…" while a clone runs, then "Asking about owner/repo @ abc1234", or shows an error.
    - The `repo` signal is sent as `repoId` with each ask. The label reads "Ask about {{ repo().name }}".
    - The last location is remembered in `localStorage`, wrapped in try/catch.
  - I'll check `get_best_practices` before the Angular edits.
- **Tests:**
  - `test/repos.test.ts`: parsing, allowlist, missing folder, not a directory.
  - `test/mcp.test.ts`: `/mcp/:id` serves that root, and an unknown id is refused.
  - `test/web-app.test.ts`: `/api/repo` happy path and refusals, and ask with `repoId` hits the chosen root.
  - `ask` component spec for the load flow.

### PR 3: GitHub cloning, plus `git` in the image
- **In `src/repos.ts`:**
  - `GitHubClient.getRepo(owner, repo)` returns `{ size, defaultBranch, private }`. It's a new method in [src/github.ts](src/github.ts), with a matching fake in `test/fixtures/fake-github.ts`.
  - Clone into `REPO_CACHE_DIR` (default `os.tmpdir()/codebase-qa-repos`), at `<owner>__<repo>__<sha>`. Clone to a temp folder first, then rename it into place.
  - Deduplicate in-flight clones per key, and evict least-recently-used repos past the cache cap.
  - The `git` runner is injectable, so tests use a fake runner and never touch the network.
- **Dockerfile:** `apt-get install -y --no-install-recommends git ca-certificates`, and make sure the `node` user can write to the cache dir. **I'll confirm with you before editing the Dockerfile.** I'll also check the Container Apps ephemeral-storage limits on Microsoft Learn so the cache caps fit.
- **Tests:**
  - The exact git args, including `core.symlinks=false`, no shell, and no token in the args.
  - Refusal when a repo is over the size cap.
  - Private repo refused on the demo.
  - Cache hit, plus dedupe of concurrent requests.
  - Eviction.

### PR 4: scripted demo for any repo, plus docs
- **Demo:** when the chosen repo isn't the built-in one, the scripted model runs a generic "tour" against the real tools: `search_docs("overview architecture")`, `read_file("README.md")`, and `search_code` for an entry point. It then returns a templated answer built from what the tools found, which says plainly that the demo's answer text is scripted and the steps ran for real. The built-in repo keeps its current script.
- **Docs:**
  - New design doc `docs/repo_selection_design.md` (Phase 6).
  - Update `docs/codebase_qa_context.md` sections 3, 5, 7, 8, 10 and 12.
  - README configuration and usage.
  - `.env.example` gets the new variables.
  - The PDF gets rebuilt via `scripts/md_to_pdf.py`, not edited by hand.

## Out of scope (follow-ups)
- **The review agent** still reads surrounding code from the default root. It could later reuse the registry to clone the PR's head repo.
- **Shared cache across replicas**: there's still one replica.

## Verification
- Each PR: `npm run typecheck`, `npm test`, `npm run web:test`, `npm run web:build`.
- Manual, local:
  - `npm run web`, then load `C:\source\repos\<another repo>` and ask "Give me a short tour". Check that the citations point into that repo.
  - Load `octocat/Hello-World` and ask again.
  - Try `..\..\Windows` with `REPO_ALLOWED_ROOTS` set, and confirm it's refused.
- Demo: `npm run web:demo`, load a small public repo, and confirm the tour steps run on it.
- CLI: `npm run ask -- --repo owner/repo "question"`.
- After deploy: the smoke tests still pass. On the demo, load a public repo, and check that one over 50 MB is refused.
- Run the project's reviewer on each PR: `npm run review -- tpotechno/codebase-qa-assistant#N`.
