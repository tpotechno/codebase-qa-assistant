import dotenv from "dotenv";
// override: values in .env win over machine-level environment variables,
// so a stale ANTHROPIC_API_KEY set in Windows can't silently shadow the project key.
dotenv.config({ override: true, quiet: true });

import { runAgent } from "./agent.ts";
import { repoRoot } from "./tools.ts";
import { toolProviderFromEnv } from "./tool-provider.ts";

const question = process.argv.slice(2).join(" ").trim();

if (!question) {
  console.error('Usage: npm run ask -- "How does authentication work in this repo?"');
  process.exit(1);
}
if (!process.env.ANTHROPIC_API_KEY) {
  console.error("ANTHROPIC_API_KEY is not set. Copy .env.example to .env and add your key.");
  process.exit(1);
}

let tools;
try {
  tools = await toolProviderFromEnv();
} catch (e) {
  console.error(`Could not connect to MCP server at ${process.env.MCP_SERVER_URL}: ${(e as Error).message}`);
  console.error("Start it with `npm run serve` in another terminal, or remove MCP_SERVER_URL from .env.");
  process.exit(1);
}
console.error(tools.source === "local" ? `Repo: ${repoRoot()} (local tools)\n` : `Tools: ${tools.source}\n`);

try {
  const result = await runAgent(question, {
    tools,
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
