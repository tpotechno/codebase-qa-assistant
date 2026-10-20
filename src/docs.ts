import fs from "node:fs/promises";
import path from "node:path";

/**
 * Lightweight retrieval over a repo's documentation (READMEs, design docs, ADRs).
 *
 * Docs are split into heading-scoped chunks and ranked with BM25, a classic lexical
 * ranking function. No embedding model or vector store is required, so this runs
 * anywhere with zero extra keys. The interface (query -> ranked chunks with source
 * locations) is the same one an embedding-based retriever would expose, so it can be
 * swapped later without touching the MCP tool or the agent.
 */

const DOC_EXTS = new Set([".md", ".mdx", ".markdown", ".txt", ".rst", ".adoc"]);
const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "build", "out", ".angular", "coverage", "bin", "obj"]);
const MAX_CHUNK_CHARS = 1_500;
const MAX_DOC_BYTES = 1024 * 1024;
const INDEX_TTL_MS = 30_000;

export interface DocChunk {
  file: string;        // repo-relative, forward slashes
  heading: string;     // nearest heading path, e.g. "Setup > Windows"
  startLine: number;   // 1-based
  text: string;
}

interface Index {
  builtAt: number;
  chunks: DocChunk[];
  termFreqs: Map<string, number>[];
  docFreq: Map<string, number>;
  lengths: number[];
  avgLength: number;
}

const STOPWORDS = new Set(
  "a an and are as at be by for from how i in is it of on or that the this to was what when where which who why with you your does do".split(" "),
);

export function tokenize(text: string): string[] {
  return (text.toLowerCase().match(/[a-z0-9_]+/g) ?? []).filter((t) => t.length > 1 && !STOPWORDS.has(t));
}

/** Split a markdown document into chunks at headings, capping chunk size. */
export function chunkMarkdown(file: string, content: string): DocChunk[] {
  const lines = content.split(/\r?\n/);
  const chunks: DocChunk[] = [];
  const headingStack: string[] = [];
  let buf: string[] = [];
  let bufStart = 1;
  let inFence = false;

  const flush = (nextStart: number) => {
    const text = buf.join("\n").trim();
    if (text) chunks.push({ file, heading: headingStack.join(" > ") || "(top)", startLine: bufStart, text });
    buf = [];
    bufStart = nextStart;
  };

  lines.forEach((line, i) => {
    if (/^\s*(```|~~~)/.test(line)) inFence = !inFence;
    const m = !inFence && /^(#{1,6})\s+(.*)$/.exec(line);
    if (m) {
      flush(i + 1);
      const level = m[1].length;
      headingStack.length = Math.min(headingStack.length, level - 1);
      headingStack[level - 1] = m[2].trim();
      headingStack.length = level;
    } else if (buf.join("\n").length + line.length > MAX_CHUNK_CHARS) {
      flush(i + 1);
    }
    buf.push(line);
  });
  flush(lines.length + 1);
  return chunks;
}

async function* walkDocs(dir: string): AsyncGenerator<string> {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (e.isDirectory()) {
      if (!SKIP_DIRS.has(e.name)) yield* walkDocs(path.join(dir, e.name));
    } else if (e.isFile() && DOC_EXTS.has(path.extname(e.name).toLowerCase())) {
      yield path.join(dir, e.name);
    }
  }
}

const cache = new Map<string, Index>();

async function buildIndex(root: string): Promise<Index> {
  const chunks: DocChunk[] = [];
  for await (const file of walkDocs(root)) {
    const stat = await fs.stat(file);
    if (stat.size > MAX_DOC_BYTES) continue;
    const rel = path.relative(root, file).split(path.sep).join("/");
    chunks.push(...chunkMarkdown(rel, await fs.readFile(file, "utf8")));
  }

  const termFreqs: Map<string, number>[] = [];
  const docFreq = new Map<string, number>();
  const lengths: number[] = [];
  for (const c of chunks) {
    // Weight the file name and heading in, since they're strong topical signals.
    const tokens = tokenize(`${c.file} ${c.heading} ${c.heading} ${c.text}`);
    const tf = new Map<string, number>();
    for (const t of tokens) tf.set(t, (tf.get(t) ?? 0) + 1);
    for (const t of tf.keys()) docFreq.set(t, (docFreq.get(t) ?? 0) + 1);
    termFreqs.push(tf);
    lengths.push(tokens.length);
  }
  const avgLength = lengths.length ? lengths.reduce((a, b) => a + b, 0) / lengths.length : 0;
  return { builtAt: Date.now(), chunks, termFreqs, docFreq, lengths, avgLength };
}

async function getIndex(root: string): Promise<Index> {
  const hit = cache.get(root);
  if (hit && Date.now() - hit.builtAt < INDEX_TTL_MS) return hit;
  const idx = await buildIndex(root);
  cache.set(root, idx);
  return idx;
}

export interface DocHit extends DocChunk { score: number }

export async function searchDocs(root: string, query: string, k = 5): Promise<DocHit[]> {
  const idx = await getIndex(root);
  const terms = [...new Set(tokenize(query))];
  if (!terms.length || !idx.chunks.length) return [];

  const N = idx.chunks.length;
  const k1 = 1.2;
  const b = 0.75;
  const scored: DocHit[] = [];

  idx.chunks.forEach((chunk, i) => {
    let score = 0;
    for (const t of terms) {
      const f = idx.termFreqs[i].get(t);
      if (!f) continue;
      const df = idx.docFreq.get(t) ?? 0;
      const idf = Math.log(1 + (N - df + 0.5) / (df + 0.5));
      score += (idf * f * (k1 + 1)) / (f + k1 * (1 - b + (b * idx.lengths[i]) / (idx.avgLength || 1)));
    }
    if (score > 0) scored.push({ ...chunk, score });
  });

  return scored.sort((a, b) => b.score - a.score).slice(0, k);
}

/** Formatted for an LLM: compact, with sources the model can cite. */
export async function searchDocsText(root: string, query: string, k = 5): Promise<string> {
  if (!query?.trim()) return "Error: query is required.";
  const hits = await searchDocs(root, query, Math.min(Math.max(k, 1), 10));
  if (!hits.length) return `No documentation matches for "${query}".`;
  return hits
    .map((h, i) => {
      const text = h.text.length > 900 ? `${h.text.slice(0, 900)}…` : h.text;
      return `[${i + 1}] ${h.file}:${h.startLine} — ${h.heading} (score ${h.score.toFixed(2)})\n${text}`;
    })
    .join("\n\n---\n\n");
}
