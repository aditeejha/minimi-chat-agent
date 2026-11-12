import { ApiError, type Content } from "@google/genai";
import type { Exchange, Message, StoredSource, Store, Thread } from "../db.ts";
import { recall, type RecallResult } from "../memory/recall.ts";
import { Evidence, citationsToDomains, citedNumbers, domainOf, renderSource } from "../search/evidence.ts";
import { SearchError, readPages, type SearchHit } from "../search/tavily.ts";
import { ModelsUnavailable } from "../llm.ts";
import { describeDate, describeInstant, describeNow, toLocal } from "../time.ts";
import { runSearches, streamAnswer, type Usage } from "./answer.ts";
import { isSmallTalk, makePlan, smallTalkPlan, type Plan } from "./planner.ts";

export interface SourcePreview {
  n: number;
  title: string;
  url: string;
  domain: string;
  published: string | null;
}

export interface ClientMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  createdAt: string;
  sources: SourcePreview[];
  meta: Record<string, unknown>;
}

export type TurnEvent =
  | { type: "thread"; thread: Thread }
  | { type: "status"; text: string; detail?: string[] }
  | { type: "sources"; sources: SourcePreview[] }
  | { type: "delta"; text: string }
  | { type: "reset" }
  | { type: "done"; message: ClientMessage }
  | { type: "error"; message: string };

export interface TurnInput {
  store: Store;
  threadId: string | null;
  message: string;
  now: Date;
  timeZone: string;
  owner: string;
  signal: AbortSignal;
}

const HISTORY_MESSAGES = 16;

export function preview(sources: StoredSource[]): SourcePreview[] {
  return sources.map((s) => ({ n: s.n, title: s.title, url: s.url, domain: domainOf(s.url), published: s.published }));
}

export function toClient(m: Message): ClientMessage {
  return { id: m.id, role: m.role, content: m.content, createdAt: m.createdAt, sources: preview(m.sources), meta: m.meta };
}

function titleFrom(message: string): string {
  const flat = message.replace(/\s+/g, " ").trim();
  return flat.length > 60 ? `${flat.slice(0, 57)}…` : flat;
}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function assistantForHistory(m: Message): string {
  const cited = Array.isArray(m.meta.cited) ? (m.meta.cited as number[]) : [];
  const urls = m.sources.filter((s) => cited.includes(s.n)).slice(0, 6).map((s) => s.url);
  const body = citationsToDomains(m.content, m.sources);
  return urls.length > 0 ? `${body}\n\nSources: ${urls.join(" ")}` : body;
}

export function historyContents(window: Message[]): Content[] {
  const contents: Content[] = window
    .filter((m) => m.content.trim())
    .map((m) =>
      m.role === "user"
        ? { role: "user", parts: [{ text: m.content }] }
        : { role: "model", parts: [{ text: assistantForHistory(m) }] },
    );
  while (contents[0]?.role === "model") contents.shift();
  return contents;
}

function renderExchange(e: Exchange, timeZone: string): string {
  const cited = e.sources.filter((s) => e.cited.includes(s.n)).slice(0, 6);
  const evidence = cited
    .map((s) => `- ${s.title} (${s.url}): "${clip(s.passages.replace(/\s+/g, " "), 500)}"`)
    .join("\n");
  return [
    `<exchange asked="${describeInstant(e.askedAt, timeZone)}">`,
    `<user_asked>${e.question}</user_asked>`,
    `<you_answered>${e.answer ? clip(citationsToDomains(e.answer, e.sources), 4000) : "(no answer was recorded)"}</you_answered>`,
    evidence ? `<evidence_then retrieved="${describeDate(e.localDate)}">\n${evidence}\n</evidence_then>` : "",
    "</exchange>",
  ]
    .filter(Boolean)
    .join("\n");
}

export function renderMemory(plan: Plan, memory: RecallResult, relevant: Exchange[], timeZone: string): string | null {
  const parts = relevant.map((e) => renderExchange(e, timeZone));
  if (plan.referencesPastConversation && relevant.length === 0) {
    const resolved = memory.windows.map((w) => `"${w.phrase}" = ${w.label}`).join("; ");
    const coverage = memory.firstDate
      ? `Your records start on ${describeDate(memory.firstDate)}. Days with conversations: ${memory.activeDates.map(describeDate).join(", ")}.`
      : "There are no earlier conversations on record at all.";
    parts.push(
      `No past exchange on record matches what the user refers to.${resolved ? ` Dates in the message: ${resolved}.` : ""} ${coverage}`,
    );
  }
  return parts.length > 0 ? parts.join("\n\n") : null;
}

function describeError(error: unknown): string {
  if (error instanceof ModelsUnavailable && /quota/.test(error.message)) {
    return `${error.message} Free Gemini keys allow about 20 requests per model per day; each question uses two or three. Wait for the daily reset, or use a key with billing enabled.`;
  }
  if (error instanceof ApiError) {
    if (error.status === 400 && /api key/i.test(error.message)) return "The Gemini API key was rejected. Check GEMINI_API_KEY in .env.";
    if (error.status === 401 || error.status === 403) return "The Gemini API key was rejected. Check GEMINI_API_KEY in .env.";
    if (error.status === 429) return "The Gemini API is rate-limiting this key. Try again in a minute.";
    return `The Gemini API returned an error (${error.status}): ${error.message.slice(0, 300)}`;
  }
  if (error instanceof SearchError) return error.message;
  if (error instanceof TypeError && /fetch failed/i.test(error.message)) return "Couldn't reach the model API. Check your connection.";
  return error instanceof Error ? error.message : String(error);
}

export async function* runTurn(input: TurnInput): AsyncGenerator<TurnEvent> {
  const { store, message, timeZone, signal } = input;
  const started = performance.now();
  const elapsed = () => Math.round(performance.now() - started);
  const nowIso = input.now.toISOString();
  const local = toLocal(input.now, timeZone);

  const thread =
    (input.threadId && store.getThread(input.threadId, input.owner)) || store.createThread(titleFrom(message), nowIso, input.owner);
  yield { type: "thread", thread };

  const window = store.threadMessages(thread.id).slice(-HISTORY_MESSAGES);
  const userMessage = store.addMessage({
    threadId: thread.id,
    role: "user",
    content: message,
    createdAt: nowIso,
    localDate: local.date,
    timeZone,
    replyTo: null,
    sources: [],
    meta: {},
  });

  const excluded = new Set(window.filter((m) => m.role === "user").map((m) => m.id));
  excluded.add(userMessage.id);
  const memory = recall(store, message, local, excluded, input.owner);

  const now = describeNow(input.now, timeZone);
  const smallTalk = isSmallTalk(message);
  if (!smallTalk) yield { type: "status", text: "Working out what to look up" };
  const plan = smallTalk
    ? smallTalkPlan()
    : await makePlan(
        {
          message,
          now,
          timeZone,
          recent: window.slice(-6).map((m) => ({ role: m.role, content: m.content })),
          recall: memory,
        },
        signal,
      );
  const planMs = elapsed();

  const evidence = new Evidence();
  const failures: string[] = [];
  let searchMs = 0;
  if (plan.searches.length > 0 || plan.rereadUrls.length > 0) {
    yield {
      type: "status",
      text: plan.status || "Searching the web",
      detail: [...plan.searches.map((s) => s.query), ...plan.rereadUrls.map((u) => `re-read ${domainOf(u)}`)],
    };
    const focus = plan.rereadFocus || message;
    const rereads: Promise<SearchHit[]> = plan.rereadUrls.length
      ? readPages(plan.rereadUrls, focus, signal).catch((error: unknown) => {
          failures.push(`re-reading earlier sources: ${describeError(error)}`);
          return [];
        })
      : Promise.resolve([]);
    const searched = await runSearches(plan.searches, evidence, nowIso, signal);
    failures.push(...searched.failures);
    const oldTitles = new Map(memory.byDate.concat(memory.byTopic).flatMap((e) => e.sources.map((s) => [s.url, s.title])));
    for (const hit of await rereads) {
      evidence.add({ ...hit, title: `${oldTitles.get(hit.url) ?? domainOf(hit.url)} (re-read today)` }, nowIso);
    }
    searchMs = elapsed() - planMs;
    if (evidence.sources.length > 0) yield { type: "sources", sources: preview(evidence.sources) };
  }

  const candidates = [...memory.byDate, ...memory.byTopic];
  const relevant = (
    plan.source === "fallback" ? memory.byDate : candidates.filter((e) => plan.relevantMemoryIds.includes(e.id))
  ).sort((a, b) => a.askedAt.localeCompare(b.askedAt));
  const memoryText = renderMemory(plan, memory, relevant, timeZone);
  const datePhrases = memory.windows.map((w) => `"${w.phrase}" = ${w.label}`).join("; ");
  const webText =
    evidence.sources.length > 0
      ? evidence.sources.map(renderSource).join("\n\n")
      : plan.searches.length > 0
        ? "The planned searches returned nothing."
        : null;
  const context = [
    "<turn_context>",
    `<now>${now}</now>`,
    datePhrases ? `<date_phrases>${datePhrases}</date_phrases>` : "",
    memoryText ? `<memory>\n${memoryText}\n</memory>` : "",
    webText ? `<web_results>\n${webText}${failures.length > 0 ? `\n\nSome lookups failed: ${failures.join("; ")}` : ""}\n</web_results>` : "",
    "</turn_context>",
  ]
    .filter(Boolean)
    .join("\n");

  yield {
    type: "status",
    text: evidence.sources.length > 0 ? `Reading ${evidence.sources.length} source${evidence.sources.length === 1 ? "" : "s"}` : "Writing",
  };

  let text = "";
  let firstTokenMs: number | null = null;
  let usage: Usage | null = null;
  let finishReason: string | null = null;
  let model: string | null = null;
  let searchRounds = 0;
  let failure: string | null = null;
  try {
    for await (const event of streamAnswer({
      history: historyContents(window),
      turn: [{ text: context }, { text: message }],
      evidence,
      effort: plan.effort,
      retrievedAt: nowIso,
      signal,
    })) {
      if (event.type === "delta") {
        firstTokenMs ??= elapsed();
        text += event.text;
        yield { type: "delta", text: event.text };
      } else if (event.type === "reset") {
        text = "";
        firstTokenMs = null;
        yield { type: "reset" };
      } else if (event.type === "searching") {
        yield { type: "status", text: "Searching again", detail: event.queries };
      } else if (event.type === "sources") {
        yield { type: "sources", sources: preview(evidence.sources) };
      } else {
        text = event.text;
        usage = event.usage;
        finishReason = event.finishReason;
        searchRounds = event.searchRounds;
        model = event.model;
      }
    }
  } catch (error) {
    failure = signal.aborted ? "stopped by user" : describeError(error);
  }

  if (!text.trim() && failure) {
    if (!signal.aborted) yield { type: "error", message: failure };
    return;
  }

  const cited = citedNumbers(text, evidence.sources.length);
  const assistant = store.addMessage({
    threadId: thread.id,
    role: "assistant",
    content: text,
    createdAt: new Date(input.now.getTime() + elapsed()).toISOString(),
    localDate: local.date,
    timeZone,
    replyTo: userMessage.id,
    sources: evidence.sources,
    meta: {
      cited,
      interrupted: failure ?? undefined,
      finishReason,
      model,
      plan: {
        source: plan.source,
        model: plan.model,
        error: plan.error,
        referencesPastConversation: plan.referencesPastConversation,
        recalled: relevant.map((e) => ({ id: e.id, askedAt: e.askedAt })),
        searches: plan.searches,
        rereadUrls: plan.rereadUrls,
        effort: plan.effort,
        followUpSearchRounds: searchRounds,
      },
      timings: { planMs, searchMs, firstTokenMs, totalMs: elapsed() },
      usage,
    },
  });
  yield { type: "done", message: toClient(assistant) };
}
