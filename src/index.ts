import dotenv from "dotenv";
// override: values in .env win over machine-level environment variables,
// so a stale ANTHROPIC_API_KEY set in Windows can't silently shadow the project key.
dotenv.config({ override: true, quiet: true });

import { runAgent } from "./agent.ts";
import { repoRoot } from "./tools.ts";
import { localToolProvider, toolProviderFromEnv, type ToolProvider } from "./tool-provider.ts";
import { GitHubClient } from "./github.ts";
import { RepoRegistry, repoPolicyFromEnv } from "./repos.ts";

// Optional "--repo <location>" (a folder path or a GitHub repo) picks the codebase;
// everything else is the question.
const args = process.argv.slice(2);
let repoArg: string | undefined;
const repoAt = args.findIndex((a) => a === "--repo");
if (repoAt !== -1) {
  repoArg = args[repoAt + 1];
  args.splice(repoAt, 2);
}
const question = args.join(" ").trim();

if (!question || (repoAt !== -1 && !repoArg)) {
  console.error('Usage: npm run ask -- [--repo <folder | owner/repo[@branch]>] "How does authentication work in this repo?"');
  process.exit(1);
}
if (!process.env.ANTHROPIC_API_KEY) {
  console.error("ANTHROPIC_API_KEY is not set. Copy .env.example to .env and add your key.");
  process.exit(1);
}

let tools: ToolProvider;
let repoLabel: string | undefined;
if (repoArg) {
  // A chosen codebase uses in-process tools confined to it, with the same rules as the
  // local web app (any folder, or only under REPO_ALLOWED_ROOTS if set; GitHub cloned).
  try {
    const token = process.env.GITHUB_TOKEN || undefined;
    const repos = new RepoRegistry({
      defaultRoot: repoRoot(),
      policy: repoPolicyFromEnv("local"),
      github: new GitHubClient({ token }),
      cloneToken: token,
    });
    console.error(`Opening ${repoArg}…`);
    const info = await repos.resolve(repoArg);
    tools = localToolProvider(repos.rootFor(info.id!));
    repoLabel = info.label;
    console.error(`Repo: ${info.label}${info.sha ? ` (${info.sha.slice(0, 7)})` : ""} (local tools)\n`);
  } catch (e) {
    console.error(`Could not open ${repoArg}: ${(e as Error).message}`);
    process.exit(1);
  }
} else {
  try {
    tools = await toolProviderFromEnv();
  } catch (e) {
    console.error(`Could not connect to MCP server at ${process.env.MCP_SERVER_URL}: ${(e as Error).message}`);
    console.error("Start it with `npm run serve` in another terminal, or remove MCP_SERVER_URL from .env.");
    process.exit(1);
  }
  console.error(tools.source === "local" ? `Repo: ${repoRoot()} (local tools)\n` : `Tools: ${tools.source}\n`);
}

try {
  const result = await runAgent(question, {
    tools,
    repoLabel,
    onToolCall: (name, input) => console.error(`  ↳ ${name} ${JSON.stringify(input)}`),
  });
  console.log(`\n${result.answer}\n`);
  console.error(
    `[${result.turns} turn(s), ${result.toolCalls} tool call(s), ` +
      `${result.usage.inputTokens} in / ${result.usage.outputTokens} out tokens]`,
  );
} catch (e) {
  console.error(`Request failed: ${(e as Error).message}`);
  process.exitCode = 1;
} finally {
  await tools.close();
}
