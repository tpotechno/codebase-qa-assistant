import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readFile, searchCode, safeResolve } from "../src/tools.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("search_code finds a known symbol with file:line and context", async () => {
  const out = await searchCode({ query: "stop_reason", k: 2, path_glob: "src/" }, root);
  assert.match(out, /src\/agent\.ts:\d+/);
  assert.match(out, /match\(es\)/);
});

test("search_code reports no matches cleanly", async () => {
  const out = await searchCode({ query: "zz_definitely_not_present_zz" + "" }, path.join(root, "src"));
  assert.match(out, /No matches/);
});

test("read_file returns numbered lines and respects ranges", async () => {
  const out = await readFile({ path: "src/index.ts", start: 1, end: 3 }, root);
  assert.match(out, /lines 1-3 of \d+/);
  assert.match(out, /^1  import/m);
});

test("read_file refuses paths outside the repo root", async () => {
  const out = await readFile({ path: "../../etc/passwd" }, root);
  assert.match(out, /outside the repository root/);
  assert.throws(() => safeResolve(root, "/etc/passwd"));
});
