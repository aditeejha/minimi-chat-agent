import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { config } from "../config.ts";
import { anthropic } from "../llm.ts";
import { Evidence } from "../search/evidence.ts";
import { search, type SearchQuery } from "../search/tavily.ts";
import { ANSWER_SYSTEM } from "./prompts.ts";

type MessageParam = Anthropic.Beta.Messages.BetaMessageParam;
type ContentBlockParam = Anthropic.Beta.Messages.BetaContentBlockParam;
type ToolResult = Anthropic.Beta.Messages.BetaToolResultBlockParam;
type Tool = Anthropic.Beta.Messages.BetaTool;

export type AnswerEvent =
  | { type: "delta"; text: string }
  | { type: "searching"; queries: string[] }
  | { type: "sources"; numbers: number[] }
  | { type: "final"; text: string; stopReason: string | null; usage: Usage; searchRounds: number };

export interface Usage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

const MAX_SEARCH_ROUNDS = 2;

// Models that accept server-side refusal fallbacks ("default" routing).
const FALLBACK_MODELS = new Set(["claude-opus-5-5", "claude-opus-5", "claude-fable-5-1", "claude-sonnet-5-5"]);

export const WEB_SEARCH_TOOL: Tool = {
  name: "web_search",
  description:
    "Search the web. Returns numbered sources with the passages that best match each query; cite them as [n]. " +
    "Send several focused queries in one call (they run in parallel) instead of one broad query. " +
    "Use `since` (YYYY-MM-DD) to keep only pages published on or after a date, e.g. for news since a past conversation; " +
    "leave it out for pricing or docs pages, which are rarely dated. Use `domain` to search one site, e.g. an official pricing page.",
  input_schema: {
    type: "object",
    properties: {
      queries: {
        type: "array",
        description: "1 to 4 searches to run in parallel.",
        items: {
          type: "object",
          properties: {
            query: { type: "string", description: "A specific, self-contained search query." },
            since: { type: "string", description: "Optional. Only results published on or after this date (YYYY-MM-DD)." },
            domain: { type: "string", description: "Optional. Restrict to one site, e.g. pipedrive.com." },
          },
          required: ["query"],
        },
      },
    },
    required: ["queries"],
  },
  eager_input_streaming: true,
};

const SearchInput = z.object({
  queries: z
    .array(
      z.object({
        query: z.string().min(1),
        since: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
        domain: z.string().optional(),
      }),
    )
    .min(1),
});

export async function runSearches(
  queries: SearchQuery[],
  evidence: Evidence,
  retrievedAt: string,
  signal?: AbortSignal,
): Promise<{ numbers: number[]; failures: string[] }> {
  const settled = await Promise.allSettled(queries.map((q) => search(q, signal)));
  const numbers: number[] = [];
  const failures: string[] = [];
  settled.forEach((result, i) => {
    if (result.status === "rejected") {
      failures.push(`"${queries[i]?.query}": ${result.reason instanceof Error ? result.reason.message : result.reason}`);
      return;
    }
    for (const hit of result.value) {
      const n = evidence.add(hit, retrievedAt);
      if (!numbers.includes(n)) numbers.push(n);
    }
  });
  return { numbers, failures };
}

export async function* streamAnswer(options: {
  history: MessageParam[];
  turn: ContentBlockParam[];
  evidence: Evidence;
  effort: "low" | "medium";
  retrievedAt: string;
  signal: AbortSignal;
}): AsyncGenerator<AnswerEvent> {
  const model = config.answerModel;
  const messages: MessageParam[] = [...options.history, { role: "user", content: options.turn }];
  const usage: Usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
  let text = "";
  let searchRounds = 0;

  while (true) {
    const mustAnswer = searchRounds >= MAX_SEARCH_ROUNDS;
    const stream = anthropic().beta.messages.stream(
      {
        model,
        max_tokens: 32000,
        system: [{ type: "text", text: ANSWER_SYSTEM, cache_control: { type: "ephemeral" } }],
        tools: [WEB_SEARCH_TOOL],
        tool_choice: mustAnswer ? { type: "none" } : { type: "auto" },
        output_config: { effort: options.effort },
        cache_control: { type: "ephemeral" },
        messages,
        ...(FALLBACK_MODELS.has(model)
          ? { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" as const }
          : {}),
      },
      { signal: options.signal },
    );

    for await (const event of stream) {
      if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
        text += event.delta.text;
        yield { type: "delta", text: event.delta.text };
      }
    }

    const message = await stream.finalMessage();
    usage.inputTokens += message.usage.input_tokens;
    usage.outputTokens += message.usage.output_tokens;
    usage.cacheReadTokens += message.usage.cache_read_input_tokens ?? 0;
    usage.cacheWriteTokens += message.usage.cache_creation_input_tokens ?? 0;

    const toolUses = message.content.filter(
      (block): block is Anthropic.Beta.Messages.BetaToolUseBlock => block.type === "tool_use",
    );
    if (message.stop_reason !== "tool_use" || toolUses.length === 0 || mustAnswer) {
      if (message.stop_reason === "refusal" && !text.trim()) {
        const refusal = "I can't help with that one.";
        text = refusal;
        yield { type: "delta", text: refusal };
      }
      yield { type: "final", text, stopReason: message.stop_reason, usage, searchRounds };
      return;
    }

    messages.push({ role: "assistant", content: message.content });
    searchRounds += 1;

    const results: ToolResult[] = [];
    for (const toolUse of toolUses) {
      const parsed = SearchInput.safeParse(toolUse.input);
      if (toolUse.name !== "web_search" || !parsed.success) {
        results.push({
          type: "tool_result",
          tool_use_id: toolUse.id,
          is_error: true,
          content: "Invalid input. Call web_search with {queries: [{query, since?, domain?}]}.",
        });
        continue;
      }
      const queries = parsed.data.queries.slice(0, 4);
      yield { type: "searching", queries: queries.map((q) => q.query) };
      const before = options.evidence.sources.length;
      const { numbers, failures } = await runSearches(queries, options.evidence, options.retrievedAt, options.signal);
      const fresh = numbers.filter((n) => n > before);
      if (fresh.length > 0) yield { type: "sources", numbers: fresh };
      const repeated = numbers.filter((n) => n <= before);
      const body = [
        fresh.length > 0 ? options.evidence.render(fresh) : "No new sources found.",
        repeated.length > 0 ? `Also matched sources you already have: ${repeated.map((n) => `[${n}]`).join(" ")}` : "",
        failures.length > 0 ? `Some searches failed: ${failures.join("; ")}` : "",
      ]
        .filter(Boolean)
        .join("\n\n");
      results.push({
        type: "tool_result",
        tool_use_id: toolUse.id,
        content: body,
        is_error: numbers.length === 0 && failures.length > 0,
      });
    }
    messages.push({ role: "user", content: results });
  }
}
