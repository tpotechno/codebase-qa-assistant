import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readFile, searchCode, safeResolve, safeResolveReal } from "../src/tools.ts";

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

test("read_file refuses a symlink inside the repo that points outside it", async (t) => {
  // A repo whose file is a symlink to something outside the repo (a cloned repo could ship one).
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "cqa-link-"));
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const repo = path.join(base, "repo");
  await fs.mkdir(repo);
  await fs.writeFile(path.join(base, "secret.txt"), "top secret");
  await fs.writeFile(path.join(repo, "ok.txt"), "fine");
  try {
    await fs.symlink(path.join(base, "secret.txt"), path.join(repo, "leak.txt"), "file");
  } catch (e) {
    // Windows without Developer Mode can't create symlinks; nothing to test there.
    if ((e as NodeJS.ErrnoException).code === "EPERM") return t.skip("symlinks not permitted here");
    throw e;
  }
  assert.match(await readFile({ path: "leak.txt" }, repo), /outside the repository root/);
  assert.match(await readFile({ path: "ok.txt" }, repo), /^ok\.txt \(lines 1-1 of 1\)/);
  await assert.rejects(safeResolveReal(repo, "leak.txt"), /outside the repository root/);
});

test("read_file refuses a directory link that leads outside the repo", async (t) => {
  // "junction" needs no special rights on Windows and is a plain directory symlink elsewhere.
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "cqa-dirlink-"));
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const repo = path.join(base, "repo");
  const outside = path.join(base, "outside");
  await fs.mkdir(repo);
  await fs.mkdir(outside);
  await fs.writeFile(path.join(outside, "secret.txt"), "top secret");
  await fs.symlink(outside, path.join(repo, "linked"), "junction");
  assert.match(await readFile({ path: "linked/secret.txt" }, repo), /outside the repository root/);
});
