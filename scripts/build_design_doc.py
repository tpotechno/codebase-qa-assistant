import sys
from reportlab.lib.pagesizes import letter
from reportlab.lib import colors
from reportlab.lib.units import inch
from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
from reportlab.lib.enums import TA_LEFT
from reportlab.platypus import (
    SimpleDocTemplate, Paragraph, Spacer, Table, TableStyle, Preformatted,
    KeepTogether, PageBreak,
)
from reportlab.graphics.shapes import Drawing, Rect, String, Line, Polygon

OUT = sys.argv[1]

INK = colors.HexColor("#1f2933")
MUTED = colors.HexColor("#5b6670")
ACCENT = colors.HexColor("#2f5d8a")
RULE = colors.HexColor("#d5dbe1")
FILL = colors.HexColor("#f2f5f8")
CODEBG = colors.HexColor("#f6f8fa")

ss = getSampleStyleSheet()
base = ParagraphStyle("base", parent=ss["Normal"], fontName="Helvetica", fontSize=10, leading=14.5, textColor=INK, spaceAfter=6)
title = ParagraphStyle("title", parent=base, fontName="Helvetica-Bold", fontSize=22, leading=27, spaceAfter=4)
subtitle = ParagraphStyle("subtitle", parent=base, fontSize=12, leading=16, textColor=MUTED, spaceAfter=14)
h1 = ParagraphStyle("h1", parent=base, fontName="Helvetica-Bold", fontSize=14, leading=18, textColor=ACCENT, spaceBefore=14, spaceAfter=6)
h2 = ParagraphStyle("h2", parent=base, fontName="Helvetica-Bold", fontSize=11, leading=15, spaceBefore=8, spaceAfter=4)
bullet = ParagraphStyle("bullet", parent=base, leftIndent=14, bulletIndent=3, spaceAfter=3)
small = ParagraphStyle("small", parent=base, fontSize=8.5, leading=11.5, textColor=MUTED)
cell = ParagraphStyle("cell", parent=base, fontSize=9, leading=12.5, spaceAfter=0)
cellb = ParagraphStyle("cellb", parent=cell, fontName="Helvetica-Bold")
code = ParagraphStyle("code", fontName="Courier", fontSize=8.5, leading=11.5, textColor=INK, backColor=CODEBG,
                      borderPadding=(6, 6, 6, 6), leftIndent=6, rightIndent=6, spaceBefore=4, spaceAfter=10)

def P(t, s=base): return Paragraph(t, s)
def C(t): return f'<font name="Courier">{t}</font>'
def bullets(items): return [Paragraph(i, bullet, bulletText="•") for i in items]

def table(rows, widths, header=True):
    data = [[Paragraph(str(c), cellb if (header and r == 0) else cell) for c in row] for r, row in enumerate(rows)]
    t = Table(data, colWidths=widths, repeatRows=1 if header else 0)
    style = [
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("LINEBELOW", (0, 0), (-1, -1), 0.5, RULE),
        ("TOPPADDING", (0, 0), (-1, -1), 5), ("BOTTOMPADDING", (0, 0), (-1, -1), 5),
        ("LEFTPADDING", (0, 0), (-1, -1), 5), ("RIGHTPADDING", (0, 0), (-1, -1), 5),
    ]
    if header:
        style += [("BACKGROUND", (0, 0), (-1, 0), FILL), ("LINEBELOW", (0, 0), (-1, 0), 1, ACCENT)]
    t.setStyle(TableStyle(style))
    return t

def architecture_diagram():
    W, H = 468, 250
    d = Drawing(W, H)
    def box(x, y, w, h, label, sub=None, fill=FILL):
        d.add(Rect(x, y, w, h, rx=5, ry=5, fillColor=fill, strokeColor=ACCENT, strokeWidth=1))
        d.add(String(x + w / 2, y + h / 2 + (4 if sub else -3), label, fontName="Helvetica-Bold", fontSize=9.5, fillColor=INK, textAnchor="middle"))
        if sub:
            d.add(String(x + w / 2, y + h / 2 - 9, sub, fontName="Helvetica", fontSize=7.5, fillColor=MUTED, textAnchor="middle"))
    def arrow(x1, y1, x2, y2, label=None, lx=0, ly=0):
        d.add(Line(x1, y1, x2, y2, strokeColor=INK, strokeWidth=1))
        import math
        a = math.atan2(y2 - y1, x2 - x1); s = 6
        d.add(Polygon([x2, y2, x2 - s * math.cos(a - 0.4), y2 - s * math.sin(a - 0.4), x2 - s * math.cos(a + 0.4), y2 - s * math.sin(a + 0.4)], fillColor=INK, strokeColor=INK))
        if label:
            d.add(String((x1 + x2) / 2 + lx, (y1 + y2) / 2 + ly, label, fontName="Helvetica", fontSize=7.5, fillColor=MUTED, textAnchor="middle"))

    # Left column: agent process
    d.add(Rect(4, 100, 200, 140, rx=6, ry=6, fillColor=None, strokeColor=RULE, strokeDashArray=[3, 3]))
    d.add(String(12, 228, "Agent process (npm run ask)", fontName="Helvetica", fontSize=7.5, fillColor=MUTED))
    box(20, 172, 168, 44, "Agent loop", "src/agent.ts")
    box(20, 112, 168, 44, "ToolProvider", "local  |  MCP client")
    arrow(104, 172, 104, 156)

    # Right top: Claude API
    box(280, 172, 180, 44, "Claude Messages API", "tools + tool_use / tool_result", fill=colors.white)
    arrow(188, 200, 280, 200, "messages.create", 0, 5)
    arrow(280, 188, 188, 188, "tool_use", 0, -11)

    # Right bottom: MCP server process
    d.add(Rect(264, 4, 200, 160, rx=6, ry=6, fillColor=None, strokeColor=RULE, strokeDashArray=[3, 3]))
    d.add(String(272, 152, "MCP server process (npm run serve)", fontName="Helvetica", fontSize=7.5, fillColor=MUTED))
    box(280, 92, 168, 46, "MCP server", "Streamable HTTP  POST /mcp")
    box(280, 14, 76, 56, "Repo files", "code + file tools", fill=colors.white)
    box(372, 14, 76, 56, "Doc index", "BM25 ranking", fill=colors.white)
    arrow(318, 92, 318, 70); arrow(410, 92, 410, 70)

    arrow(188, 128, 280, 120, "tools/list, tools/call", -2, 8)
    d.add(String(234, 104, "Bearer token (optional)", fontName="Helvetica", fontSize=7, fillColor=MUTED, textAnchor="middle"))

    # Claude Code as second client
    box(20, 30, 168, 40, "Claude Code / other clients", "same tools, same contract", fill=colors.white)
    arrow(188, 50, 280, 104)
    return d

def on_page(c, doc):
    c.saveState()
    c.setFont("Helvetica", 8); c.setFillColor(MUTED)
    c.drawString(doc.leftMargin, 0.5 * inch, "Codebase Q&A Assistant  |  MCP Server Design")
    c.drawRightString(letter[0] - doc.rightMargin, 0.5 * inch, f"Page {doc.page}")
    c.setStrokeColor(RULE); c.line(doc.leftMargin, 0.65 * inch, letter[0] - doc.rightMargin, 0.65 * inch)
    c.restoreState()

story = []
story += [
    P("MCP Server Design", title),
    P("Codebase Q&amp;A and PR Review Assistant, Phase 2", subtitle),
    table([
        ["Author", "Todd Oppel"],
        ["Repository", "github.com/tpotechno/codebase-qa-assistant"],
        ["Version", "0.2.0 (Phase 2 complete)"],
        ["Date", "October 19, 2026"],
        ["Status", "Implemented, 17 automated tests passing"],
    ], [1.2 * inch, 5.3 * inch], header=False),
    Spacer(1, 10),
]

story += [P("1. Summary", h1), P(
    "Phase 2 moves the assistant's tools out of the agent process and behind a custom "
    "<b>Model Context Protocol (MCP)</b> server served over Streamable HTTP. The server exposes three "
    "read-only tools: " + C("search_code") + ", " + C("read_file") + ", and a new documentation retrieval tool, "
    + C("search_docs") + ". The agent no longer hard-codes its tools; it connects to the server as an MCP "
    "client, discovers the tools at runtime, and translates them into Claude Messages API tool definitions. "
    "Because the tools now live behind a standard protocol, the same server also works with Claude Code and "
    "any other MCP client without changes.")]

story += [P("2. Why", h1), P(
    "In Phase 1, the tools were TypeScript functions compiled into the agent. That works for one app but "
    "creates three problems as the project grows:")]
story += bullets([
    "<b>No reuse.</b> Every new client (a web UI, Claude Code, a CI job) would have to re-implement or import the tools.",
    "<b>Tight coupling.</b> Adding a tool meant changing the agent's code and redeploying it.",
    "<b>No security boundary.</b> The tools ran with the agent's full permissions, with no separate place to enforce authentication or scope.",
])
story += [P(
    "MCP addresses all three: it defines a standard contract for listing and calling tools, so the tool "
    "provider and the tool consumer can evolve and deploy independently. The goal was deliberate, not "
    "MCP for its own sake: a reusable, network-addressable tool contract is the foundation for the PR review "
    "tools in Phase 3 and the hosted demo in Phase 5.")]

story += [P("Goals", h2)] + bullets([
    "Serve the existing tools over MCP with no loss of behavior or safety.",
    "Add retrieval over the repository's documentation so the agent can answer intent and design questions, not only symbol lookups.",
    "Keep the agent loop unchanged apart from where it gets its tools.",
    "Make the server safe to run locally by default and safe to expose remotely when configured.",
    "Cover the client/server path with automated tests that need no API key.",
])
story += [P("Non-goals (this phase)", h2)] + bullets([
    "Write operations (posting PR comments) &mdash; Phase 3.",
    "Embedding-based semantic search &mdash; deferred; see Section 6.",
    "A web user interface &mdash; Phase 4.",
    "Hosted deployment and OAuth &mdash; Phase 5.",
])

story += [P("3. What was built", h1), architecture_diagram(), Spacer(1, 4),
          P("Figure 1. Runtime architecture. Dashed boxes are separate processes.", small), Spacer(1, 6)]

story += [P("Components", h2), table([
    ["File", "Responsibility"],
    [C("src/mcp-server.ts"), "Builds the MCP server and registers the three tools with zod input schemas and read-only annotations. Serves it over Streamable HTTP at POST /mcp, with optional bearer-token auth and a GET /health endpoint."],
    [C("src/serve.ts"), "Entry point for " + C("npm run serve") + ". Reads configuration from .env and refuses to bind a non-local address without an auth token."],
    [C("src/docs.ts"), "Documentation retrieval: walks the repo for Markdown and text docs, splits them into heading-scoped chunks, and ranks chunks with BM25."],
    [C("src/tool-provider.ts"), "The " + C("ToolProvider") + " interface plus two implementations: in-process tools (Phase 1 behavior) and an MCP client that discovers and calls tools on the server."],
    [C("src/tools.ts"), "Tool implementations shared by both providers: code search, file reading with the path-traversal guard, and dispatch."],
    [C("src/agent.ts"), "The hand-written Messages API loop, now taking a " + C("ToolProvider") + " instead of a fixed tool list."],
], [1.75 * inch, 4.75 * inch])]

story += [P("Tools", h2), table([
    ["Tool", "Input", "Returns"],
    [C("search_code"), "query, k (1-25), path_glob", "Up to k hits as file:line with one line of context on each side"],
    [C("read_file"), "path, start, end", "Numbered lines, at most 200 per call, with a hint to page further; refuses paths outside the repo"],
    [C("search_docs"), "query, k (1-10)", "Ranked documentation passages, each with file:line, heading path, and score"],
], [1.1 * inch, 1.7 * inch, 3.7 * inch])]

story += [KeepTogether([P("4. How it works", h1), P("Request flow", h2), P(
    "A single question flows through the system as follows:")])]
story += bullets([
    "<b>Connect.</b> The CLI reads " + C("MCP_SERVER_URL") + " and opens an MCP client session to the server over Streamable HTTP (sending the bearer token if configured).",
    "<b>Discover.</b> The agent calls " + C("tools/list") + ". Each MCP tool (name, description, JSON Schema) is mapped one-to-one to a Messages API tool definition.",
    "<b>Ask.</b> The agent sends the question, system prompt, and tool definitions to the Claude Messages API.",
    "<b>Execute.</b> When Claude responds with " + C("tool_use") + " blocks, the agent forwards each to the server with " + C("tools/call") + ". The server validates arguments against the zod schema, runs the tool confined to " + C("REPO_PATH") + ", and returns text plus an " + C("isError") + " flag.",
    "<b>Return.</b> The agent sends the results back as " + C("tool_result") + " blocks (errors marked " + C("is_error") + ") and repeats until Claude produces a final answer or the turn limit is reached.",
])

story += [P("Documentation retrieval (search_docs)", h2), P(
    "Documents are split at Markdown headings (ignoring heading-like lines inside fenced code blocks) and capped "
    "at about 1,500 characters per chunk. Each chunk records its file, starting line, and full heading path, "
    "such as \"Quick start &gt; Using the MCP server\", so answers can cite exact locations. Chunks are ranked "
    "with <b>BM25</b>, the standard lexical relevance function behind most search engines, with the file name "
    "and headings weighted into each chunk's terms. The index is built on first use and cached for 30 seconds, "
    "so edits to docs show up without restarting the server.")]

story += [P("Server design", h2)] + bullets([
    "<b>Stateless Streamable HTTP.</b> Each POST creates a fresh server and transport and returns a JSON response. There are no sessions to track, so instances can run behind a load balancer. GET and DELETE on /mcp return 405.",
    "<b>Schema validation at the boundary.</b> Tool inputs are declared with zod. Invalid calls (for example an empty query) are rejected before any tool code runs.",
    "<b>Tool annotations.</b> All tools are marked " + C("readOnlyHint") + " so clients can treat them as safe to call without confirmation.",
])

story += [P("5. Security", h1), table([
    ["Risk", "Mitigation"],
    ["Reading files outside the repository", "Every path is resolved against REPO_PATH and rejected if it escapes the root (relative or absolute). Covered by tests in-process and over HTTP."],
    ["Unauthorized access to the server", "Optional bearer token checked with a constant-time comparison. Unauthenticated requests get HTTP 401."],
    ["Accidental public exposure", "Binds to 127.0.0.1 by default. The server refuses to start on any non-local address unless MCP_AUTH_TOKEN is set."],
    ["DNS-rebinding attacks from a browser", "The MCP SDK's Express app enables host-header validation automatically for local binds."],
    ["Oversized or binary content flooding the model", "File-size caps, text-extension allowlist, skipped build and dependency folders, 200-line read windows, and capped result counts."],
    ["Secrets leaking into git", ".env is git-ignored, and .env values override stale machine environment variables."],
], [2.0 * inch, 4.5 * inch])]

story += [P("6. Key decisions and alternatives", h1), table([
    ["Decision", "Alternative considered", "Why this choice"],
    ["Client-side MCP: the agent connects with the MCP client SDK", "Messages API MCP connector (mcp_servers parameter)", "The connector requires a publicly reachable server. Client-side MCP works against localhost during development; the connector becomes an option once the server is hosted in Phase 5."],
    ["Streamable HTTP transport", "stdio transport", "stdio only works for a local child process. HTTP makes the server addressable by any client and deployable as a service."],
    ["Stateless request handling", "Session-based server with stream resumption", "These tools are simple request/response calls with no server-initiated messages, so sessions add complexity with no benefit, and statelessness scales horizontally."],
    ["BM25 lexical retrieval", "Embeddings plus a vector store", "No extra API keys, model downloads, or database; deterministic and testable. The tool's contract (query in, cited passages out) is the same, so embeddings can be added later without changing clients."],
    ["Pluggable ToolProvider interface", "Replace local tools with MCP outright", "Keeps the Phase 1 path working with zero setup, makes the agent testable with either source, and new server tools reach the agent with no agent code change."],
    ["Bearer token auth", "OAuth 2.1", "Adequate for local and single-owner use. OAuth is the right fit for a multi-user hosted deployment and is planned for Phase 5."],
], [1.7 * inch, 1.6 * inch, 3.2 * inch])]

story += [P("7. Testing", h1), P(
    "The suite has 17 tests and runs in about two seconds with no API key, so it runs on every push in GitHub Actions. "
    "The MCP tests start a real server on a random port and connect to it with the real MCP client.")]
story += [table([
    ["Area", "What is verified"],
    ["Tools (in-process)", "Search hits and formatting, numbered line ranges, path-traversal refusal"],
    ["Documentation retrieval", "Heading-aware chunking, fenced-code handling, ranking returns the right README section, empty and unmatched queries"],
    ["MCP server over HTTP", "Tool discovery with JSON schemas, code and doc search, traversal refused with isError, schema validation rejects bad input, missing or wrong token rejected, /health"],
    ["Agent loop", "Tool round-trips, is_error flagging, turn limit, and an end-to-end run where the agent discovers tools from the MCP server and calls them via a scripted fake Claude client"],
], [1.7 * inch, 4.8 * inch])]

story += [P("8. Configuration and usage", h1), table([
    ["Variable", "Default", "Purpose"],
    [C("REPO_PATH"), "current folder", "Repository the tools are confined to"],
    [C("MCP_SERVER_URL"), "unset", "When set, the agent uses the MCP server instead of in-process tools"],
    [C("MCP_PORT"), "3333", "Server port"],
    [C("MCP_HOST"), "127.0.0.1", "Bind address; non-local requires a token"],
    [C("MCP_AUTH_TOKEN"), "unset", "If set, clients must send Authorization: Bearer &lt;token&gt;"],
], [1.6 * inch, 1.2 * inch, 3.7 * inch])]
story += [Spacer(1, 6), KeepTogether([Preformatted(
    "# Terminal 1: start the server\n"
    "npm run serve\n\n"
    "# Terminal 2: with MCP_SERVER_URL=http://127.0.0.1:3333/mcp in .env\n"
    "npm run ask -- \"Why does the server refuse to bind to 0.0.0.0 without a token?\"\n\n"
    "# Use the same server from Claude Code\n"
    "claude mcp add --transport http codebase-qa http://127.0.0.1:3333/mcp", code)])]

story += [P("9. Limitations and next steps", h1)] + bullets([
    "<b>Lexical search only.</b> BM25 misses synonyms and paraphrases. Next: optional embedding-based ranking behind the same tool.",
    "<b>Substring code search.</b> " + C("search_code") + " scans files directly. For large repos, swap in ripgrep or a prebuilt index.",
    "<b>Single repository per server.</b> REPO_PATH is fixed at startup; multi-repo support would take a repo parameter with an allowlist.",
    "<b>Phase 3:</b> add " + C("get_pr_diff") + " and " + C("post_review_comment") + " tools backed by the GitHub API, and move orchestration to the Claude Agent SDK.",
    "<b>Phase 4:</b> Angular web UI with streaming answers and a visible trace of each tool call, replacing the command line as the main way to use the assistant.",
    "<b>Phase 5:</b> evaluation suite, cost limits, tracing, OAuth, and a hosted deployment that can also use the Messages API MCP connector.",
])

doc = SimpleDocTemplate(OUT, pagesize=letter, leftMargin=inch, rightMargin=inch, topMargin=0.85 * inch, bottomMargin=0.9 * inch,
                        title="MCP Server Design", author="Todd Oppel", subject="Codebase Q&A Assistant - Phase 2 MCP server")
doc.build(story, onFirstPage=on_page, onLaterPages=on_page)
print("wrote", OUT)
