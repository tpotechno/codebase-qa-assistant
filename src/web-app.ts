import path from "node:path";
import fs from "node:fs";
import { randomUUID } from "node:crypto";
import express, { type Request, type Response, type NextFunction, type Express } from "express";
import { z } from "zod";
import type Anthropic from "@anthropic-ai/sdk";
import { runAgent } from "./agent.ts";
import { StaleHeadError, formatPrRef, parsePrRef, type GitHubClient, type PrRef, type PostReviewResult } from "./github.ts";
import { formatReviewMarkdown, inlineCommentBody, runReview, type Review, type ReviewOptions } from "./review.ts";
import type { ToolProvider } from "./tool-provider.ts";

/**
 * HTTP API behind the Angular UI.
 *
 *   GET  /api/config        what the UI needs to render (repo, model, whether posting is possible)
 *   POST /api/ask           streams an answer as Server-Sent Events
 *   POST /api/review        streams a PR review as Server-Sent Events
 *   POST /api/review/post   publishes a draft this server produced, by id, at most once
 *
 * The server holds the Anthropic and GitHub credentials, so it only answers same-origin
 * requests from localhost (see guardRequests).
 */

export interface WebAppDeps {
  root: string;
  model: string;
  github: GitHubClient;
  /** True when a GitHub token is configured, so /api/review/post can work. */
  canPost: boolean;
  maxBudgetUsd: number;
  /** Tool source for /api/ask; the caller owns its lifecycle. */
  openTools: () => Promise<ToolProvider>;
  /** MCP server the review agent connects to. */
  mcp: { url: string; token?: string };
  /** Hosts (host:port) the server answers to. Requests with any other Host are rejected. */
  allowedHosts: string[];
  /** Static Angular build to serve, if present. */
  staticDir?: string;
  /** Injectable for tests. */
  anthropic?: Pick<Anthropic, "messages">;
  reviewQuery?: ReviewOptions["queryFn"];
  maxConcurrentRuns?: number;
  drafts?: DraftStore;
}

const PREVIEW_CHARS = 600;
const preview = (s: string) => (s.length > PREVIEW_CHARS ? `${s.slice(0, PREVIEW_CHARS)}…` : s);

/** Open an SSE response; returns a typed sender and an AbortController tied to disconnects. */
function openStream(req: Request, res: Response) {
  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  res.flushHeaders();
  const abort = new AbortController();
  res.on("close", () => {
    if (!res.writableFinished) abort.abort();
  });
  const send = (event: string, data: unknown) => {
    if (!res.writableEnded) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };
  const end = () => {
    if (!res.writableEnded) res.end();
  };
  return { send, end, abort };
}

/**
 * Cross-site protection for a server that spends money on the user's behalf:
 * - Host must be one of ours (blocks DNS rebinding).
 * - State-changing requests must be JSON (cross-site forms can't send it without a CORS
 *   preflight, which this server never approves) and, when the browser sends an Origin,
 *   it must be ours.
 */
function guardRequests(allowedHosts: string[]) {
  // Read on every request so a caller can add hosts after listening (e.g. on a random port).
  const isOurs = (h: string) => allowedHosts.some((a) => a.toLowerCase() === h.toLowerCase());
  return (req: Request, res: Response, next: NextFunction) => {
    if (!isOurs(req.headers.host ?? "")) {
      return res.status(403).json({ error: "Requests must be made to this server's own address." });
    }
    if (req.method !== "GET" && req.method !== "HEAD") {
      if (!req.is("application/json")) {
        return res.status(415).json({ error: "Send requests as JSON." });
      }
      const origin = req.headers.origin;
      if (origin) {
        let originHost = "";
        try {
          originHost = new URL(origin).host.toLowerCase();
        } catch {
          /* malformed origin */
        }
        if (!isOurs(originHost)) {
          return res.status(403).json({ error: "Requests from other sites are not allowed." });
        }
      }
    }
    next();
  };
}

/** Parse a TCP port from the environment: unset or blank means the fallback. */
export function parsePort(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === "") return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > 65_535) {
    throw new Error(`Port must be a whole number from 1 to 65535 (got "${raw}").`);
  }
  return n;
}

interface Draft {
  ref: PrRef;
  headSha: string;
  review: Review;
  createdAt: number;
  state: "ready" | "posting" | "posted";
  posted?: PostReviewResult;
}

/**
 * Reviews this server produced, kept briefly so they can be posted by id. Posting only
 * what the server generated means nothing else that can reach the API (a script, or an
 * injected page) can publish arbitrary text under the user's GitHub identity, and each
 * draft can be posted at most once.
 */
export class DraftStore {
  private readonly drafts = new Map<string, Draft>();

  constructor(
    private readonly ttlMs = 60 * 60_000,
    private readonly max = 20,
  ) {}

  add(ref: PrRef, headSha: string, review: Review): string {
    this.prune();
    while (this.drafts.size >= this.max) this.drafts.delete(this.drafts.keys().next().value!);
    const id = randomUUID();
    this.drafts.set(id, { ref, headSha, review, createdAt: Date.now(), state: "ready" });
    return id;
  }

  get(id: string): Draft | undefined {
    this.prune();
    return this.drafts.get(id);
  }

  private prune(): void {
    const now = Date.now();
    for (const [id, d] of this.drafts) if (now - d.createdAt >= this.ttlMs) this.drafts.delete(id);
  }
}

const askBody = z.object({ question: z.string().trim().min(1).max(4_000) });
const reviewBody = z.object({ pr: z.string().trim().min(1).max(300) });
const postBody = z.object({ draftId: z.string().uuid() });

const badRequest = (res: Response, error: z.ZodError | Error) =>
  res.status(400).json({
    error: error instanceof z.ZodError ? error.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; ") : error.message,
  });

export function createWebApp(deps: WebAppDeps): Express {
  const app = express();
  app.disable("x-powered-by");
  app.use(guardRequests(deps.allowedHosts));
  app.use(express.json({ limit: "256kb" }));

  const drafts = deps.drafts ?? new DraftStore();
  let activeRuns = 0;
  const maxRuns = deps.maxConcurrentRuns ?? 2;
  const claimRun = (res: Response) => {
    if (activeRuns >= maxRuns) {
      res.status(429).json({ error: "Another request is still running. Wait for it to finish." });
      return false;
    }
    activeRuns++;
    return true;
  };

  app.get("/api/config", (_req, res) => {
    res.json({
      repoName: path.basename(deps.root),
      repoPath: deps.root,
      model: deps.model,
      canPost: deps.canPost,
      maxBudgetUsd: deps.maxBudgetUsd,
    });
  });

  app.post("/api/ask", async (req, res) => {
    const parsed = askBody.safeParse(req.body);
    if (!parsed.success) return badRequest(res, parsed.error);
    if (!claimRun(res)) return;

    const { send, end, abort } = openStream(req, res);
    let tools: ToolProvider | undefined;
    try {
      tools = await deps.openTools();
      const result = await runAgent(parsed.data.question, {
        model: deps.model,
        tools,
        client: deps.anthropic,
        signal: abort.signal,
        onText: (delta, turn) => send("text", { delta, turn }),
        onToolCall: (name, input, id) => send("tool_call", { id, name, input }),
        onToolResult: (id, r) => send("tool_result", { id, isError: r.isError, preview: preview(r.content) }),
      });
      send("done", { answer: result.answer, turns: result.turns, toolCalls: result.toolCalls, usage: result.usage });
    } catch (e) {
      if (!abort.signal.aborted) send("error", { message: (e as Error).message });
    } finally {
      activeRuns--;
      await tools?.close().catch(() => {});
      end();
    }
  });

  app.post("/api/review", async (req, res) => {
    const parsed = reviewBody.safeParse(req.body);
    if (!parsed.success) return badRequest(res, parsed.error);
    let ref;
    try {
      ref = parsePrRef(parsed.data.pr);
    } catch (e) {
      return badRequest(res, e as Error);
    }
    if (!claimRun(res)) return;

    const { send, end, abort } = openStream(req, res);
    try {
      // Read the PR first: validates it exists and pins the commit the review is based on.
      const pr = await deps.github.getPr(ref);
      if (abort.signal.aborted) return; // the browser left while the PR was loading
      send("started", { pr: formatPrRef(ref), title: pr.title, url: pr.url, headSha: pr.headSha, files: pr.changedFiles });
      const result = await runReview(ref, {
        mcpUrl: deps.mcp.url,
        mcpToken: deps.mcp.token,
        model: deps.model,
        maxBudgetUsd: deps.maxBudgetUsd,
        abortController: abort,
        queryFn: deps.reviewQuery,
        onToolCall: (name, input) => send("tool_call", { name, input }),
      });
      send("done", {
        review: result.review,
        draftId: drafts.add(ref, pr.headSha, result.review),
        costUsd: result.costUsd,
        turns: result.turns,
        durationMs: result.durationMs,
        headSha: pr.headSha,
      });
    } catch (e) {
      if (!abort.signal.aborted) send("error", { message: (e as Error).message });
    } finally {
      activeRuns--;
      end();
    }
  });

  app.post("/api/review/post", async (req, res) => {
    if (!deps.canPost) {
      return res.status(403).json({ error: "Posting needs GITHUB_TOKEN in .env (Pull requests: read and write)." });
    }
    const parsed = postBody.safeParse(req.body);
    if (!parsed.success) return badRequest(res, parsed.error);

    const draft = drafts.get(parsed.data.draftId);
    if (!draft) {
      return res.status(404).json({ error: "This review is no longer available to post. Run the review again." });
    }
    if (draft.state === "posting") return res.status(409).json({ error: "This review is already being posted." });
    if (draft.state === "posted") {
      return res.status(409).json({ error: `This review was already posted: ${draft.posted!.url}` });
    }

    draft.state = "posting"; // claimed before any await, so a second request can't slip in
    try {
      const { ref, review, headSha } = draft;
      const r = await deps.github.postReview(
        ref,
        formatReviewMarkdown(ref, review, { includeInline: false }),
        review.comments.map((c) => ({ path: c.path, line: c.line, body: inlineCommentBody(c) })),
        { expectedHeadSha: headSha },
      );
      draft.state = "posted";
      draft.posted = r;
      res.json(r);
    } catch (e) {
      draft.state = "ready";
      res.status(e instanceof StaleHeadError ? 409 : 502).json({ error: (e as Error).message });
    }
  });

  app.use("/api", (_req, res) => res.status(404).json({ error: "Not found." }));

  // Serve the Angular build, with index.html as the fallback for client-side routes.
  if (deps.staticDir && fs.existsSync(path.join(deps.staticDir, "index.html"))) {
    app.use(express.static(deps.staticDir, { index: false, maxAge: "1h" }));
    app.get(/^(?!\/api\/).*/, (_req, res) => res.sendFile(path.join(deps.staticDir!, "index.html")));
  } else {
    app.get("/", (_req, res) =>
      res.type("text").send("The web UI isn't built yet. Run: npm run web:build, then restart npm run web."),
    );
  }

  return app;
}
