import { ThinkingLevel } from "@google/genai";
import { z } from "zod";
import { config } from "../config.ts";
import { generate } from "../llm.ts";
import type { Exchange } from "../db.ts";
import type { RecallResult } from "../memory/recall.ts";
import { describeDate, describeInstant } from "../time.ts";
import { PLANNER_SYSTEM } from "./prompts.ts";

const PlanSchema = z.object({
  referencesPastConversation: z.boolean(),
  relevantMemoryIds: z.array(z.string()),
  needsSearch: z.boolean(),
  searches: z.array(
    z.object({
      query: z.string(),
      since: z.string().nullable(),
      domain: z.string().nullable(),
      news: z.boolean(),
    }),
  ),
  rereadUrls: z.array(z.string()),
  rereadFocus: z.string().nullable(),
  effort: z.enum(["low", "medium"]),
  status: z.string(),
});

const { $schema, ...PLAN_JSON_SCHEMA } = z.toJSONSchema(PlanSchema);

export type Plan = z.infer<typeof PlanSchema> & { source: "planner" | "fallback" | "local"; model?: string; error?: string };

const GREETING = /^(hi|hey|hello|yo|thanks|thank you|thx|ty|ok|okay|cool|great|nice|perfect|awesome|bye|goodbye|cheers|good (morning|afternoon|evening|night))\b/i;
const ASKS_SOMETHING = /\?|\d|\b(what|who|when|where|why|how|which|is|are|does|do|can|could|should|price|cost|compare|latest|news|still|changed|asked)\b/i;

// "thanks!" doesn't need a planner call (or a request from a daily quota).
export function isSmallTalk(message: string): boolean {
  const text = message.trim();
  return GREETING.test(text) && text.split(/\s+/).length <= 8 && !ASKS_SOMETHING.test(text.replace(GREETING, ""));
}

export function smallTalkPlan(): Plan {
  return {
    referencesPastConversation: false,
    relevantMemoryIds: [],
    needsSearch: false,
    searches: [],
    rereadUrls: [],
    rereadFocus: null,
    effort: "low",
    status: "Replying",
    source: "local",
  };
}

export interface PlanInput {
  message: string;
  now: string;
  timeZone: string;
  recent: { role: "user" | "assistant"; content: string }[];
  recall: RecallResult;
}

function excerpt(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

function renderCandidate(e: Exchange, matched: string, timeZone: string): string {
  const urls = e.sources
    .filter((s) => e.cited.length === 0 || e.cited.includes(s.n))
    .slice(0, 8)
    .map((s) => s.url);
  return [
    `<candidate id="${e.id}" asked="${describeInstant(e.askedAt, timeZone)}" matched="${matched}">`,
    `Q: ${excerpt(e.question, 500)}`,
    `A: ${e.answer ? excerpt(e.answer, 700) : "(no answer recorded)"}`,
    urls.length > 0 ? `Sources: ${urls.join(" ")}` : "",
    "</candidate>",
  ]
    .filter(Boolean)
    .join("\n");
}

export function planPrompt(input: PlanInput): string {
  const { recall } = input;
  const windows =
    recall.windows.length > 0
      ? recall.windows.map((w) => `"${w.phrase}" = ${w.label}`).join("; ")
      : "none";
  const candidates = [
    ...recall.byDate.map((e) => renderCandidate(e, "date", input.timeZone)),
    ...recall.byTopic.map((e) => renderCandidate(e, "keywords", input.timeZone)),
  ];
  const recent = input.recent
    .map((m) => `${m.role === "user" ? "User" : "Assistant"}: ${excerpt(m.content, 800)}`)
    .join("\n");
  const history = recall.firstDate
    ? `Memory covers ${describeDate(recall.firstDate)} to today. Days with conversations (newest first): ${recall.activeDates.map(describeDate).join(", ")}.`
    : "Memory is empty: this is the first conversation.";

  return [
    `<now>${input.now}</now>`,
    `<date_phrases>${windows}</date_phrases>`,
    `<memory_overview>${history}</memory_overview>`,
    `<candidates>\n${candidates.join("\n") || "(none)"}\n</candidates>`,
    `<recent_conversation>\n${recent || "(new conversation)"}\n</recent_conversation>`,
    `<message>\n${input.message}\n</message>`,
  ].join("\n\n");
}

export function fallbackPlan(input: PlanInput, error: string): Plan {
  return {
    referencesPastConversation: input.recall.windows.length > 0,
    relevantMemoryIds: input.recall.byDate.map((e) => e.id),
    needsSearch: true,
    searches: [{ query: input.message.slice(0, 300), since: null, domain: null, news: false }],
    rereadUrls: [],
    rereadFocus: null,
    effort: "medium",
    status: "Searching the web",
    source: "fallback",
    error,
  };
}

export async function makePlan(input: PlanInput, signal?: AbortSignal): Promise<Plan> {
  const timeout = AbortSignal.timeout(12_000);
  try {
    const { model, result } = await generate(config.plannerModels, {
      contents: [{ role: "user", parts: [{ text: planPrompt(input) }] }],
      config: {
        systemInstruction: PLANNER_SYSTEM,
        responseMimeType: "application/json",
        responseJsonSchema: PLAN_JSON_SCHEMA,
        thinkingConfig: { thinkingLevel: ThinkingLevel.MINIMAL },
        maxOutputTokens: 4000,
        abortSignal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      },
    });
    const parsed = PlanSchema.safeParse(JSON.parse(result.text ?? "null"));
    if (!parsed.success) return fallbackPlan(input, `planner returned an invalid plan: ${parsed.error.message.slice(0, 200)}`);
    const plan = parsed.data;
    const known = new Set([...input.recall.byDate, ...input.recall.byTopic].map((e) => e.id));
    const knownUrls = new Set(
      [...input.recall.byDate, ...input.recall.byTopic].flatMap((e) => e.sources.map((s) => s.url)),
    );
    return {
      ...plan,
      relevantMemoryIds: plan.relevantMemoryIds.filter((id) => known.has(id)),
      searches: plan.needsSearch ? plan.searches.filter((s) => s.query.trim()).slice(0, 6) : [],
      rereadUrls: plan.rereadUrls.filter((url) => knownUrls.has(url)).slice(0, 5),
      source: "planner",
      model,
    };
  } catch (error) {
    if (signal?.aborted) throw error;
    return fallbackPlan(input, error instanceof Error ? error.message : String(error));
  }
}
