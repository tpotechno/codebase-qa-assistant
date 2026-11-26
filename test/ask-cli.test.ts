import { test } from "node:test";
import assert from "node:assert/strict";
import { AskUsageError, parseAskArgs } from "../src/ask-cli-lib.ts";

test("parseAskArgs joins the words of the question", () => {
  assert.deepEqual(parseAskArgs(["How", "does", "auth", "work?"]), { question: "How does auth work?", repo: undefined });
});

test("parseAskArgs takes --repo anywhere on the line", () => {
  assert.deepEqual(parseAskArgs(["--repo", "octocat/Hello-World", "What", "is", "this?"]), {
    question: "What is this?",
    repo: "octocat/Hello-World",
  });
  assert.deepEqual(parseAskArgs(["What is this?", "--repo", "C:\\source\\repos\\app"]), {
    question: "What is this?",
    repo: "C:\\source\\repos\\app",
  });
});

test("parseAskArgs refuses a missing question, a missing --repo value, and two --repo flags", () => {
  const usage = (argv: string[]) => assert.throws(() => parseAskArgs(argv), AskUsageError, argv.join(" "));
  usage([]);
  usage(["--repo", "acme/widgets"]);
  usage(["What is this?", "--repo"]);
  usage(["--repo", "--other", "What is this?"]);
  usage(["--repo", "a/b", "--repo", "c/d", "q"]);
});
