import fs from "node:fs/promises";
import path from "node:path";
import type Anthropic from "@anthropic-ai/sdk";
import { searchDocsText } from "./docs.ts";

// Directories we never walk into.
const SKIP_DIRS = new Set([
  "node_modules", ".git", "dist", "build", "out", ".angular", ".next",
  "coverage", "bin", "obj", ".vs", ".idea", ".vscode",
]);

// Only scan files that are plausibly text.
const TEXT_EXTS = new Set([
  ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".json", ".html", ".css", ".scss",
  ".md", ".txt", ".yml", ".yaml", ".cs", ".csproj", ".sln", ".xml", ".sql",
  ".py", ".java", ".go", ".rs", ".sh", ".ps1", ".config", ".env.example",
]);

const MAX_FILES_SCANNED = 5_000;
const MAX_FILE_BYTES = 512 * 1024;
const READ_WINDOW = 200;

/** Resolve the repo root at call time so tests and callers can change it. */
export function repoRoot(): string {
  return path.resolve(process.env.REPO_PATH || process.cwd());
}

/**
 * Resolve a user/model-supplied relative path and refuse anything that
 * escapes the repo root (e.g. "../../etc/passwd" or an absolute path elsewhere).
 */
export function safeResolve(root: string, relPath: string): string {
  const resolved = path.resolve(root, relPath);
  const rel = path.relative(root, resolved);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new Error(`Path "${relPath}" is outside the repository root.`);
  }
  return resolved;
}

const toPosix = (p: string) => p.split(path.sep).join("/");

async function* walk(dir: string): AsyncGenerator<string> {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) yield* walk(path.join(dir, entry.name));
    } else if (entry.isFile() && TEXT_EXTS.has(path.extname(entry.name).toLowerCase())) {
      yield path.join(dir, entry.name);
    }
  }
}

// ---------- Tool implementations ----------

export interface SearchInput { query: string; k?: number; path_glob?: string }
export interface ReadInput { path: string; start?: number; end?: number }

export async function searchCode(input: SearchInput, root = repoRoot()): Promise<string> {
  const query = input.query?.trim();
  if (!query) return "Error: query is required.";
  const k = Math.min(Math.max(input.k ?? 8, 1), 25);
  const needle = query.toLowerCase();
  const prefix = input.path_glob ? toPosix(input.path_glob).replace(/\*.*$/, "") : "";

  const hits: string[] = [];
  let scanned = 0;
  for await (const file of walk(root)) {
    if (++scanned > MAX_FILES_SCANNED) break;
    const rel = toPosix(path.relative(root, file));
    if (prefix && !rel.startsWith(prefix)) continue;

    const stat = await fs.stat(file);
    if (stat.size > MAX_FILE_BYTES) continue;
    const lines = (await fs.readFile(file, "utf8")).split(/\r?\n/);

    for (let i = 0; i < lines.length; i++) {
      if (!lines[i].toLowerCase().includes(needle)) continue;
      const from = Math.max(0, i - 1);
      const to = Math.min(lines.length - 1, i + 1);
      const snippet = lines
        .slice(from, to + 1)
        .map((l, j) => `${from + j + 1}${from + j === i ? ">" : " "} ${l.slice(0, 200)}`)
        .join("\n");
      hits.push(`${rel}:${i + 1}\n${snippet}`);
      if (hits.length >= k) break;
    }
    if (hits.length >= k) break;
  }

  if (hits.length === 0) return `No matches for "${query}".`;
  return `${hits.length} match(es) for "${query}":\n\n${hits.join("\n\n")}`;
}

export async function readFile(input: ReadInput, root = repoRoot()): Promise<string> {
  if (!input.path) return "Error: path is required.";
  let full: string;
  try {
    full = safeResolve(root, input.path);
  } catch (e) {
    return `Error: ${(e as Error).message}`;
  }

  let text: string;
  try {
    text = await fs.readFile(full, "utf8");
  } catch {
    return `Error: could not read "${input.path}".`;
  }

  const lines = text.split(/\r?\n/);
  const start = Math.max(1, input.start ?? 1);
  const requestedEnd = input.end ?? start + READ_WINDOW - 1;
  const end = Math.min(lines.length, requestedEnd, start + READ_WINDOW - 1);

  const body = lines
    .slice(start - 1, end)
    .map((l, i) => `${start + i}  ${l}`)
    .join("\n");

  const more =
    end < lines.length
      ? `\n\n[showing lines ${start}-${end} of ${lines.length}; request another range with start/end]`
      : "";
  return `${toPosix(path.relative(root, full))} (lines ${start}-${end} of ${lines.length})\n${body}${more}`;
}

// ---------- Tool definitions sent to Claude ----------

export const toolDefinitions: Anthropic.Tool[] = [
  {
    name: "search_code",
    description:
      "Case-insensitive substring search across text files in the repository. " +
      "Returns up to k hits as file:line with one line of context on each side. " +
      "Use this first to locate relevant code, then read_file to inspect it.",
    input_schema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Text to search for, e.g. a symbol or string literal." },
        k: { type: "integer", description: "Maximum hits to return (1-25, default 8)." },
        path_glob: {
          type: "string",
          description: "Optional path prefix to limit the search, e.g. 'src/app/'.",
        },
      },
      required: ["query"],
    },
  },
  {
    name: "read_file",
    description:
      "Read a file in the repository by relative path, with line numbers. " +
      `Returns at most ${READ_WINDOW} lines per call; pass start/end to page through larger files.`,
    input_schema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Path relative to the repository root." },
        start: { type: "integer", description: "First line to return (1-based)." },
        end: { type: "integer", description: "Last line to return (inclusive)." },
      },
      required: ["path"],
    },
  },
];

toolDefinitions.push({
  name: "search_docs",
  description:
    "Search the repository's documentation (READMEs, design docs, ADRs) for passages relevant " +
    "to a natural-language question. Returns ranked chunks with file:line and heading. " +
    "Use this for 'why' and 'how is this meant to work' questions; use search_code for symbols.",
  input_schema: {
    type: "object",
    properties: {
      query: { type: "string", description: "Natural-language question or keywords." },
      k: { type: "integer", description: "Number of passages to return (1-10, default 5)." },
    },
    required: ["query"],
  },
});

export interface DocsInput { query: string; k?: number }

/** Dispatch a tool_use block from Claude to its implementation. */
export async function executeTool(name: string, input: unknown, root = repoRoot()): Promise<string> {
  switch (name) {
    case "search_code":
      return searchCode(input as SearchInput, root);
    case "read_file":
      return readFile(input as ReadInput, root);
    case "search_docs": {
      const { query, k } = input as DocsInput;
      return searchDocsText(root, query, k);
    }
    default:
      return `Error: unknown tool "${name}".`;
  }
}
