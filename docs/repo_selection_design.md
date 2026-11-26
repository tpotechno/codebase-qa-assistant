# Choosing a Codebase: Design

Codebase Q&A and PR Review Assistant, Phase 6

| | |
|---|---|
| Author | Todd Oppel |
| Repository | github.com/tpotechno/codebase-qa-assistant |
| Version | 0.7.0 (Phase 6) |
| Date | November 26, 2026 |
| Status | In review; 106 server tests (1 skipped on Windows) and 25 Angular tests passing |

PDF version: [repo_selection_design.pdf](repo_selection_design.pdf) · Plan: [repo_selection_plan.md](repo_selection_plan.md) · Earlier phases: [mcp_server_design.md](mcp_server_design.md), [web_ui_design.md](web_ui_design.md), [azure_design.md](azure_design.md)

## 1. Summary

Until now the assistant could only answer questions about one repository, fixed when the server started: `REPO_PATH` locally, and its own source in the demo and on Azure. Phase 6 lets the person choose. A **Codebase** field above the question accepts either of these:

- a folder path, such as `C:\source\repos\my-app`;
- a GitHub repository, as `owner/repo`, `owner/repo@branch` or a github.com URL.

The server checks the location against its policy. A GitHub repository is shallow-cloned into a size-capped cache. The chosen root then goes to the same read-only tools as before. The command line gets the same choice with `npm run ask -- --repo <location> "question"`.

The tools didn't change at all. `search_code`, `read_file` and `search_docs` keep their names, inputs and schemas, and they still can't name a root. The person picks the repository, never the model.

## 2. Why

- **Usefulness.** An assistant that only explains itself is a demo, not a tool. This was the top item on the roadmap ("clone a chosen repository on demand", "multi-repo support").
- **The hosted apps.** The private app could only answer about the source baked into its image. It can now open any repository its GitHub token can read.
- **The public demo.** Visitors can watch the real tools run on a repository of their choosing. The model stays scripted, so the demo still costs nothing and needs no key.

### Goals

- Open a local folder or a GitHub repository from the UI and the CLI.
- Leave the tool contracts and the MCP server's `/mcp` endpoint unchanged.
- Treat every cloned repository as hostile input.
- Keep disk use bounded on small Container Apps replicas.
- Add no new npm dependencies.

### Non-goals (this phase)

- **The PR reviewer.** It still looks up surrounding code in the server's own repository.
- **A shared clone cache across replicas.** The apps still run one replica.
- **Hosts other than GitHub**, such as GitLab or Azure DevOps.

## 3. What was built

### Components

| File | Responsibility |
|---|---|
| `src/repos.ts` | New. `parseLocation` decides what was typed. `repoPolicyFromEnv` sets the per-mode policy. `RepoRegistry` resolves a location to a confined root and a server-issued id. It also holds the clone cache: defensive `git` calls, size checks, de-duplicated downloads and least-recently-used eviction. |
| `src/tools.ts` | `safeResolveReal`: the containment check repeated on real paths, so a symlink or junction can't lead outside the root. `read_file` uses it. |
| `src/mcp-server.ts` | `startHttpServer` takes an optional `rootFor(id)` and serves `POST /mcp/<id>` with the tools confined to that root. Bearer auth runs first. `/mcp` is unchanged. |
| `src/github.ts` | Two read-only calls: `getRepo` (size, default branch, visibility) and `getCommitSha`. |
| `src/web-app.ts` | `POST /api/repo`. `/api/ask` accepts an optional `repoId`. `/api/config` reports `repoChoice`. |
| `src/agent.ts` | Optional `repoLabel`, added to the system prompt so answers can name the codebase. |
| `src/index.ts`, `src/ask-cli-lib.ts` | `--repo <location>` for the CLI (parsed by `parseAskArgs`), with in-process tools confined to the chosen root. |
| `scripts/demo-server.ts`, `scripts/demo-model.ts` | Demo-mode registry. `demo-model.ts` holds the stateless scripted model and the generic tour for any repository, kept apart so tests can import it. |
| `web/src/app/repo-picker/` | New component: the Codebase field, Open/Cancel, status line and errors. |
| `Dockerfile` | Installs `git` and `ca-certificates`, and sets `REPO_CACHE_DIR=/tmp/codebase-qa-repos`. |

### API

| Endpoint | JSON body | Response |
|---|---|---|
| `POST /api/repo` | `location` (at most 500 characters) | `{ id, name, label, kind, sha?, url? }`. Refusals: 400 for unreadable input, 403 when not allowed here, 404 when not found, 413 when too large, 429 when another download is running or GitHub is rate-limiting, 502 when the download fails. |
| `POST /api/ask` | `question`, optional `repoId` | As before. 404 before any streaming if the id is unknown or expired. |
| `GET /api/config` | — | Adds `repoChoice: { local, github }`. Both false hides the field. |

## 4. How it works

### From what was typed to a root

1. **Parse.**
   - A github.com URL or `owner/repo[@ref]` means GitHub.
   - An absolute path means a folder. Windows "Copy as path" quotes are accepted.
   - Anything else is refused with an example of each form, because "relative to what?" has no good answer on a server.
   - Owner, repo and branch are checked against strict patterns. A branch may not start with `-`, so git can never read it as an option.
2. **Check policy.** Local folders are real-pathed first, so a symlink or junction can't get around `REPO_ALLOWED_ROOTS`. GitHub repositories are looked up through the API before anything is downloaded:
   - private ones are refused where they aren't allowed;
   - oversized ones are refused using GitHub's reported size;
   - the branch is resolved to a commit.
3. **Clone, or reuse.** The cache folder is named `owner__repo__<12-char sha>`, so a repeat visit is instant until the branch moves. Two requests for the same repository share one download.
4. **Register.** The root gets a random UUID, reused if the same root is opened again, with a 6-hour idle expiry. The browser sends only this id, never a path.
5. **Serve.** `/api/ask` checks the id, then opens an MCP client at `/mcp/<id>`. The MCP server looks the root up through the registry and builds its usual stateless server for that root.

### Cloning untrusted repositories

A cloned repository is code written by someone else. The clone is set up so that nothing inside it runs, and nothing in it points outside it:

| Measure | Why |
|---|---|
| `execFile("git", args)`, no shell | Nothing typed can become shell syntax. |
| URL built from validated names, always `https://github.com/...`; `--` before the URL | No `ext::` or file transports, and no option injection. |
| `-c protocol.allow=never -c protocol.https.allow=always` | Submodules or redirects can't switch transport. |
| `--depth 1 --single-branch --no-tags`, no submodules | Smallest possible download. |
| `-c core.symlinks=false` | Symlinks are checked out as plain text files. |
| `--template=`, `core.hooksPath` pointed at a missing folder, `core.fsmonitor=false` | No hook or monitor program runs. |
| `GIT_CONFIG_GLOBAL` set to an empty file, `GIT_CONFIG_NOSYSTEM=1`, `GIT_TERMINAL_PROMPT=0` | The machine's credential helpers, aliases and prompts are ignored. |
| An allowlisted environment (PATH, temp folders, proxies) | git never sees the Anthropic key, the GitHub token variable or anything else. |
| Token as `http.https://github.com/.extraheader`, set through `GIT_CONFIG_*` variables | The token is never in a URL, an argument or a log, and it goes only to github.com. |
| `.git` deleted after reading `HEAD` | Saves most of the disk. The tools skip `.git` anyway. |
| Checkout size checked again, and the clone deleted if it's over the cap | GitHub's size figure is for compressed history, not the checkout. |
| Clone into `.tmp-<uuid>`, then rename | A half-finished clone is never served. |

`read_file` now checks the real path as well as the lexical one. A symlink that escapes the root is refused even if one got past the clone settings, and so is one in a local folder the person opened. `search_code` and `search_docs` already skipped symlinks while walking.

### Policy by mode

| | Local (loopback) | Private app | Public demo |
|---|---|---|---|
| Local folders | any, or only under `REPO_ALLOWED_ROOTS` | off unless `REPO_ALLOWED_ROOTS` is set | off |
| GitHub | on | on, private repos via `GITHUB_TOKEN` | public only, no token |
| Max repository (`REPO_MAX_MB`) | 500 MB | 200 MB | 50 MB |
| Cache cap (`REPO_CACHE_MAX_MB`) | 2000 MB | 1000 MB | 500 MB |
| Downloads at once | 2 | 1 | 1 |
| Clone timeout | 120 s | 120 s | 60 s |

These sizes fit the Container Apps replicas. Microsoft Learn's storage-mounts page gives a replica 1 GiB of ephemeral storage at 0.25 vCPU (the demo) and 2 GiB at 0.5 vCPU (the private app). The worst case is a full cache plus one download that still has its history: about 600 MB on the demo and 1.4 GB on the private app. No Bicep change is needed, and the variables can override the defaults later.

### The cache

- Each clone's size is measured once, then the least recently used clones are evicted until the total fits.
- Never evicted: the clone just made, or one still downloading.
- Using an id refreshes its clone. Evicting a clone retires its id, and the UI then asks the person to open it again.
- On startup, clones already in the folder are adopted (measured and reusable). This covers a restart, or the CLI running next to the web app. Temp folders older than an hour are removed.
- Only names this code creates are ever touched.

### The demo

The scripted model is now stateless. It works out its next turn from the conversation it is sent, as a real model would, so concurrent visitors no longer share one script. It reads the codebase from the system prompt:

- **Its own repository:** the existing scripted answer plays.
- **Any other repository:** a three-step tour runs for real (`search_docs`, `read_file README.md`, `search_code TODO`). The answer is then filled in from those results, and says plainly that a template wrote it, not Claude.

## 5. Security review

These are the invariants this phase touches, checked one by one:

- **`safeResolve()`:** still applied to every model-supplied path, and now backed by a real-path check. The root itself comes only from the registry, never from the model.
- **Read-only tools:** no tool was added or changed. `/mcp/<id>` builds the same server with the same `readOnlyHint` annotations.
- **The review agent's isolation:** unchanged. It still connects to `/mcp`.
- **The guards on the web API:** `POST /api/repo` sits behind the same Host, Origin and JSON checks and the sign-in gate. A test covers a cross-site request.
- **Keyless demo:** the image still holds no keys. The demo's registry uses an unauthenticated GitHub client and refuses private repositories.

### New risks, and what limits them

- **Prompt injection from a cloned repository.** A README can contain instructions aimed at the model. As with PR content, the Ask tools are read-only and confined to the root, and there's no write or network tool, so the worst case is a misleading answer.
- **Abuse of the public demo.** Anyone can make it download repositories. It accepts only public repositories up to 50 MB, one download at a time, with a 60-second timeout and a 500 MB cache. Ask's run limit and the request guards still apply.
- **GitHub's rate limit.** The demo makes two unauthenticated API calls per new repository (GitHub allows 60 an hour per IP). Repeat visits to a cached commit still make those two calls. When the limit is hit, the person sees a clear 429.
- **Local folders.** When local folders are open with no `REPO_ALLOWED_ROOTS`, which is the default on loopback, the person can point the assistant at any folder they can read, including private files outside code. That's the same trust as `REPO_PATH`. The loopback bind and the Host and Origin checks keep other websites out. Set `REPO_ALLOWED_ROOTS` to narrow it.

## 6. Testing

- **`test/repos.test.ts` (new, 21 tests):**
  - parsing, including option-like branches and Windows paths;
  - the policy for each mode;
  - local folders: missing, a file, outside the allowlist, turned off;
  - id expiry;
  - the exact git arguments and environment, including that the token never appears in arguments;
  - private, oversized and unknown repositories refused before download, and a checkout over the cap deleted;
  - de-duplicated concurrent downloads, eviction, and adopting clones from an earlier run;
  - failure paths: a failed clone (reported, and its temp folder removed), GitHub rate limits and errors, a branch that moved during the clone, no token where private repos are off, and cleaning up abandoned downloads at startup;
  - `execGit` with Node standing in for git: stdout, the last stderr line on failure, and the timeout.
  - A fake `git` runner and the in-memory GitHub keep it offline.
- **`test/tools.test.ts`:** a file symlink and a directory junction that escape the root are both refused. The file symlink test skips on Windows without Developer Mode; CI runs it on Linux.
- **`test/mcp.test.ts`:** `/mcp/<id>` serves the chosen root, refuses unknown ids, needs the token, and answers only POST.
- **`test/web-app.test.ts`:** open a folder, then ask with its id and see the tools search that folder. Also bad input, a missing folder, an unknown id, a cross-site request, the server without a registry, and an unexpected failure (a plain 500 with no details).
- **`test/demo-model.test.ts` (new):** `tourAnswer` filled in from real tool output on a temporary repo (README heading, badge skipped, docs and TODO hits), empty repos, long introductions, the stateless script choice, and the full tour through the real agent loop.
- **`test/ask-cli.test.ts` (new):** `--repo` anywhere on the line, and its mistakes.
- **`test/agent.test.ts`:** `repoLabel` in the system prompt, and `localToolProvider(root)`.
- **`test/github.test.ts`:** `getRepo` and `getCommitSha`, including branch names with slashes.
- **`repo-picker.spec.ts`:** the helpers, and the component with a fake `Api`: hidden when nothing can be opened, opening and reporting a repo, a refusal, cancelling a download, going back, prefilling without opening, and locking while a question runs.
- **`ask.spec.ts` (new):** `Ask` sends `repoId` only for a chosen codebase, names it in the label, and switches the demo's suggestion.
- Two tests were checked by breaking the code on purpose: they fail if `read_file` drops the real-path check, or if `Ask` stops sending `repoId`.
- **Manual checks:**
  - a real clone of `octocat/Hello-World` on Windows;
  - the demo server opening `octocat/Spoon-Knife` and running the tour;
  - the demo refusing a local folder;
  - the built-in demo script unchanged.

## 7. Follow-ups

- **The reviewer.** Let it open the PR's repository at its head commit through the same registry, so surrounding-code lookups match the PR.
- **More than one replica.** A shared cache (Azure Files) and a shared registry would allow scaling out.
- **Fewer GitHub calls.** Cache the metadata lookups briefly, to stretch the demo's rate limit.
- **Show the cache.** Show cached repositories in the UI for quick switching.
