import {
  FinishReason,
  FunctionCallingConfigMode,
  ThinkingLevel,
  type Content,
  type FunctionDeclaration,
  type GenerateContentResponseUsageMetadata,
  type Part,
} from "@google/genai";
import { z } from "zod";
import { config } from "../config.ts";
import { generateStream } from "../llm.ts";
import { Evidence } from "../search/evidence.ts";
import { search, type SearchQuery } from "../search/tavily.ts";
import { ANSWER_SYSTEM } from "./prompts.ts";

export type AnswerEvent =
  | { type: "delta"; text: string }
  | { type: "reset" }
  | { type: "searching"; queries: string[] }
  | { type: "sources"; numbers: number[] }
  | { type: "final"; text: string; finishReason: string | null; usage: Usage; searchRounds: number; model: string };

export interface Usage {
  inputTokens: number;
  outputTokens: number;
  thinkingTokens: number;
  cachedTokens: number;
}

const MAX_SEARCH_ROUNDS = 2;
const BLOCKED = new Set<string>([
  FinishReason.SAFETY,
  FinishReason.PROHIBITED_CONTENT,
  FinishReason.BLOCKLIST,
  FinishReason.SPII,
  FinishReason.RECITATION,
]);

export const WEB_SEARCH_TOOL: FunctionDeclaration = {
  name: "web_search",
  description:
    "Search the web. Returns numbered sources with the passages that best match each query; cite them as [n]. " +
    "Send several focused queries in one call (they run in parallel) instead of one broad query. " +
    "Use `since` (YYYY-MM-DD) to keep only pages published on or after a date, e.g. for news since a past conversation; " +
    "leave it out for pricing or docs pages, which are rarely dated. Use `domain` to search one site, e.g. an official pricing page.",
  parametersJsonSchema: {
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
  history: Content[];
  turn: Part[];
  evidence: Evidence;
  effort: "low" | "medium";
  retrievedAt: string;
  signal: AbortSignal;
}): AsyncGenerator<AnswerEvent> {
  const contents: Content[] = [...options.history, { role: "user", parts: options.turn }];
  const usage: Usage = { inputTokens: 0, outputTokens: 0, thinkingTokens: 0, cachedTokens: 0 };
  // After the first round, stay on the model that started the turn: its
  // thought signatures are only valid for that model.
  let models = config.answerModels;
  let text = "";
  let searchRounds = 0;

  while (true) {
    const mustAnswer = searchRounds >= MAX_SEARCH_ROUNDS;
    const { model, result: stream } = await generateStream(models, {
      contents,
      config: {
        systemInstruction: ANSWER_SYSTEM,
        tools: [{ functionDeclarations: [WEB_SEARCH_TOOL] }],
        toolConfig: {
          functionCallingConfig: { mode: mustAnswer ? FunctionCallingConfigMode.NONE : FunctionCallingConfigMode.AUTO },
        },
        thinkingConfig: { thinkingLevel: options.effort === "medium" ? ThinkingLevel.MEDIUM : ThinkingLevel.LOW },
        maxOutputTokens: 16000,
        abortSignal: options.signal,
      },
    });
    models = [model];

    const parts: Part[] = [];
    let roundText = "";
    let finishReason: string | null = null;
    let roundUsage: GenerateContentResponseUsageMetadata | undefined;
    for await (const chunk of stream) {
      const candidate = chunk.candidates?.[0];
      for (const part of candidate?.content?.parts ?? []) {
        parts.push(part);
        if (part.text && !part.thought) {
          roundText += part.text;
          yield { type: "delta", text: part.text };
        }
      }
      if (candidate?.finishReason) finishReason = candidate.finishReason;
      roundUsage = chunk.usageMetadata ?? roundUsage;
    }
    usage.inputTokens += roundUsage?.promptTokenCount ?? 0;
    usage.outputTokens += roundUsage?.candidatesTokenCount ?? 0;
    usage.thinkingTokens += roundUsage?.thoughtsTokenCount ?? 0;
    usage.cachedTokens += roundUsage?.cachedContentTokenCount ?? 0;

    const calls = parts.filter((p) => p.functionCall);
    if (calls.length === 0 || mustAnswer) {
      text += roundText;
      if (!text.trim() && finishReason && BLOCKED.has(finishReason)) {
        text = "I can't help with that one.";
        yield { type: "delta", text };
      }
      yield { type: "final", text, finishReason, usage, searchRounds, model };
      return;
    }

    // Any text written before a search call is a preamble ("let me check"),
    // not part of the answer, so the UI is told to drop it.
    if (roundText) yield { type: "reset" };
    contents.push({ role: "model", parts });
    searchRounds += 1;

    const responses: Part[] = [];
    for (const { functionCall } of calls) {
      const call = functionCall!;
      const parsed = SearchInput.safeParse(call.args);
      let output: Record<string, unknown>;
      if (call.name !== "web_search" || !parsed.success) {
        output = { error: "Invalid input. Call web_search with {queries: [{query, since?, domain?}]}." };
      } else {
        const queries = parsed.data.queries.slice(0, 4);
        yield { type: "searching", queries: queries.map((q) => q.query) };
        const before = options.evidence.sources.length;
        const { numbers, failures } = await runSearches(queries, options.evidence, options.retrievedAt, options.signal);
        const fresh = numbers.filter((n) => n > before);
        if (fresh.length > 0) yield { type: "sources", numbers: fresh };
        const repeated = numbers.filter((n) => n <= before);
        output = {
          results: fresh.length > 0 ? options.evidence.render(fresh) : "No new sources found.",
          ...(repeated.length > 0 ? { alsoMatched: repeated.map((n) => `[${n}]`).join(" ") } : {}),
          ...(failures.length > 0 ? { failedSearches: failures } : {}),
        };
      }
      responses.push({ functionResponse: { id: call.id, name: call.name ?? "web_search", response: output } });
    }
    contents.push({ role: "user", parts: responses });
  }
}
