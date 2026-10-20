/** An in-memory stand-in for the GitHub REST endpoints the PR tools use. */

export const HEAD_SHA = "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678"; // realistic 40-hex

export const PATCH = [
  "@@ -1,4 +1,5 @@",
  " import express from \"express\";",
  "-const port = 3000;",
  "+const port = Number(process.env.PORT);",
  "+const host = \"0.0.0.0\";",
  " const app = express();",
  " app.listen(port);",
].join("\n");

export interface FakeGitHub {
  fetch: (url: string, init?: RequestInit) => Promise<Response>;
  requests: Array<{ method: string; path: string; body?: any; auth?: string }>;
}

export function fakeGitHub(opts: { fileCount?: number } = {}): FakeGitHub {
  const requests: FakeGitHub["requests"] = [];
  const extra = Array.from({ length: Math.max(0, (opts.fileCount ?? 1) - 1) }, (_, i) => ({
    filename: `docs/file${i}.md`,
    status: "added",
    additions: 1,
    deletions: 0,
    changes: 1,
    patch: "@@ -0,0 +1 @@\n+hello",
  }));
  const files = [
    { filename: "src/server.ts", status: "modified", additions: 2, deletions: 1, changes: 3, patch: PATCH },
    ...extra,
  ];

  const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

  const fetch = async (url: string, init: RequestInit = {}) => {
    const u = new URL(url);
    const method = init.method ?? "GET";
    const headers = init.headers as Record<string, string>;
    requests.push({
      method,
      path: u.pathname + u.search,
      body: init.body ? JSON.parse(init.body as string) : undefined,
      auth: headers?.Authorization,
    });

    const m = /^\/repos\/acme\/widgets\/pulls\/(\d+)(\/files|\/reviews)?$/.exec(u.pathname);
    if (!m || m[1] !== "7") return json(404, { message: "Not Found" });

    if (!m[2] && method === "GET") {
      return json(200, {
        title: "Read port from environment",
        body: "Makes the port configurable.",
        user: { login: "dev1" },
        state: "open",
        draft: false,
        merged_at: null,
        base: { ref: "main" },
        head: { ref: "port-env", sha: HEAD_SHA },
        additions: 2 + extra.length,
        deletions: 1,
        changed_files: files.length,
        html_url: "https://github.com/acme/widgets/pull/7",
      });
    }
    if (m[2] === "/files" && method === "GET") {
      const page = Number(u.searchParams.get("page") ?? 1);
      return json(200, files.slice((page - 1) * 100, page * 100));
    }
    if (m[2] === "/reviews" && method === "POST") {
      if (!headers?.Authorization) return json(401, { message: "Requires authentication" });
      return json(200, { html_url: "https://github.com/acme/widgets/pull/7#pullrequestreview-1" });
    }
    return json(405, { message: "Method not allowed" });
  };

  return { fetch, requests };
}
