import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chunkMarkdown, searchDocs, searchDocsText } from "../src/docs.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("chunkMarkdown splits on headings and tracks the heading path", () => {
  const md = "# Guide\nintro\n## Setup\nrun npm install\n```\n# not a heading\n```\n## Usage\nask questions";
  const chunks = chunkMarkdown("guide.md", md);
  assert.deepEqual(chunks.map((c) => c.heading), ["Guide", "Guide > Setup", "Guide > Usage"]);
  assert.equal(chunks[1].startLine, 3);
  assert.match(chunks[1].text, /# not a heading/); // fenced code is not treated as a heading
});

test("searchDocs ranks the most relevant README section first", async () => {
  const hits = await searchDocs(root, "troubleshooting invalid api key", 3);
  assert.ok(hits.length > 0);
  assert.equal(hits[0].file, "README.md");
  assert.match(hits[0].heading, /Troubleshooting/);
});

test("searchDocsText handles empty and unmatched queries", async () => {
  assert.match(await searchDocsText(root, " "), /^Error:/);
  assert.match(await searchDocsText(root, "qqqzzzxxyy"), /No documentation matches/);
});
