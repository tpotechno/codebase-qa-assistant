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
  onToolCall?: (name: string, input: unknown, id: string) => void;
  /** Called with each tool's result (same id as onToolCall). */
  onToolResult?: (id: string, result: { content: string; isError: boolean }) => void;
  /**
   * Stream text as it is generated. When set, responses are streamed; `turn` lets a UI tell
   * the final answer apart from the short notes Claude writes before calling tools.
   */
  onText?: (delta: string, turn: number) => void;
  /** Abort the run (e.g. the browser disconnected). Stops in-flight API calls too. */
  signal?: AbortSignal;
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
    if (opts.signal?.aborted) {
      // The signal's reason is a DOMException named "AbortError" unless the caller supplied one.
      const reason = opts.signal.reason;
      throw reason instanceof Error ? reason : Object.assign(new Error("Aborted"), { name: "AbortError" });
    }
    const params: Anthropic.MessageCreateParamsNonStreaming = {
      model,
      max_tokens: opts.maxTokens ?? 2048,
      system: SYSTEM_PROMPT,
      tools,
      messages,
    };
    let response: Anthropic.Message;
    // Stream when the caller wants text as it arrives. Clients without stream() (the test
    // fakes) fall back to create(), and onText is simply not called. On abort, the SDK
    // rejects finalMessage() with an abort error, so the loop can't hang mid-stream.
    if (opts.onText && typeof client.messages.stream === "function") {
      const stream = client.messages.stream(params, { signal: opts.signal });
      stream.on("text", (delta) => opts.onText!(delta, turn));
      response = await stream.finalMessage();
    } else {
      response = await client.messages.create(params, { signal: opts.signal });
    }

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
      opts.onToolCall?.(use.name, use.input, use.id);
      let content: string;
      let isError = false;
      try {
        ({ content, isError } = await provider.callTool(use.name, use.input));
      } catch (e) {
        content = `Error: ${(e as Error).message}`;
        isError = true;
      }
      opts.onToolResult?.(use.id, { content, isError });
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
