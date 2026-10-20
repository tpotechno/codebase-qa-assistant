import Anthropic from "@anthropic-ai/sdk";
import { localToolProvider, type ToolProvider } from "./tool-provider.ts";

const SYSTEM_PROMPT = `You are a senior engineer answering questions about a codebase.
Use the available tools to ground every answer in the actual code and docs.
- Use search_docs for intent and design questions, search_code to locate symbols.
- Search before you read; read only the ranges you need.
- Cite files as path:line when you reference code.
- If the code doesn't answer the question, say so instead of guessing.
Keep answers concise and specific.`;

export interface AgentOptions {
  model?: string;
  maxTurns?: number;
  maxTokens?: number;
  /** Called for each tool call so a CLI or UI can show progress. */
  onToolCall?: (name: string, input: unknown) => void;
  /** Where tools come from (in-process or an MCP server). Defaults to local. */
  tools?: ToolProvider;
  /** Injectable for tests. */
  client?: Pick<Anthropic, "messages">;
}

export interface AgentResult {
  answer: string;
  turns: number;
  toolCalls: number;
  usage: { inputTokens: number; outputTokens: number };
  stopReason: string | null;
}

/**
 * Hand-written Messages API tool loop:
 * call Claude -> execute any tool_use blocks -> send tool_result blocks back -> repeat
 * until Claude stops asking for tools (or we hit maxTurns).
 */
export async function runAgent(question: string, opts: AgentOptions = {}): Promise<AgentResult> {
  const client = opts.client ?? new Anthropic();
  const model = opts.model ?? process.env.CLAUDE_MODEL ?? "claude-sonnet-5-5";
  const maxTurns = opts.maxTurns ?? 10;
  const provider = opts.tools ?? localToolProvider();
  const tools = await provider.listTools();

  const messages: Anthropic.MessageParam[] = [{ role: "user", content: question }];
  const usage = { inputTokens: 0, outputTokens: 0 };
  let toolCalls = 0;

  for (let turn = 1; turn <= maxTurns; turn++) {
    const response = await client.messages.create({
      model,
      max_tokens: opts.maxTokens ?? 2048,
      system: SYSTEM_PROMPT,
      tools,
      messages,
    });

    usage.inputTokens += response.usage.input_tokens;
    usage.outputTokens += response.usage.output_tokens;
    messages.push({ role: "assistant", content: response.content });

    const toolUses = response.content.filter(
      (b): b is Anthropic.ToolUseBlock => b.type === "tool_use",
    );

    if (response.stop_reason !== "tool_use" || toolUses.length === 0) {
      const answer = response.content
        .filter((b): b is Anthropic.TextBlock => b.type === "text")
        .map((b) => b.text)
        .join("\n")
        .trim();
      return { answer, turns: turn, toolCalls, usage, stopReason: response.stop_reason };
    }

    const results: Anthropic.ToolResultBlockParam[] = [];
    for (const use of toolUses) {
      toolCalls++;
      opts.onToolCall?.(use.name, use.input);
      let content: string;
      let isError = false;
      try {
        ({ content, isError } = await provider.callTool(use.name, use.input));
      } catch (e) {
        content = `Error: ${(e as Error).message}`;
        isError = true;
      }
      results.push({ type: "tool_result", tool_use_id: use.id, content, is_error: isError });
    }
    messages.push({ role: "user", content: results });
  }

  return {
    answer: `Stopped after ${maxTurns} turns without a final answer. Try a narrower question.`,
    turns: maxTurns,
    toolCalls,
    usage,
    stopReason: "max_turns",
  };
}
