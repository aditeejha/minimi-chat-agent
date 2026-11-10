import type { Exchange, Store } from "../db.ts";
import type { LocalTime } from "../time.ts";
import { resolvePastDates, type DateWindow } from "./dates.ts";

export interface RecallResult {
  windows: DateWindow[];
  byDate: Exchange[];
  byTopic: Exchange[];
  firstDate: string | null;
  activeDates: string[];
}

const STOPWORDS = new Set(
  `a about above after again against all am an and any are as at be because been before being below between both
  but by can could did do does doing down during each few for from further had has have having he her here hers him
  his how i if in into is it its itself just me more most my myself no nor not now of off on once only or other our
  ours out over own same she should so some such than that the their theirs them then there these they this those
  through to too under until up very was we were what when where which while who whom why will with would you your
  yours yourself also ask asked tell told said say says know think still since ago last earlier today yesterday
  week weeks month months day days monday tuesday wednesday thursday friday saturday sunday january february march
  april may june july august september october november december jan feb mar apr jun jul aug sep sept oct nov dec
  answer answers question questions correct right wrong changed change changes anything something thing things
  any any one ones get got please thanks hey hi hello`
    .split(/\s+/)
    .filter(Boolean),
);

export function keywords(text: string, max = 8): string[] {
  const words = text.toLowerCase().match(/[\p{L}\p{N}][\p{L}\p{N}.+#-]*/gu) ?? [];
  const out: string[] = [];
  for (const raw of words) {
    const word = raw.replace(/[.+#-]+$/, "");
    if (word.length < 3 || STOPWORDS.has(word) || /^\d+$/.test(word)) continue;
    if (!out.includes(word)) out.push(word);
    if (out.length === max) break;
  }
  return out;
}

export function ftsQuery(words: string[]): string | null {
  if (words.length === 0) return null;
  return words.map((w) => `"${w.replace(/"/g, "")}"`).join(" OR ");
}

// Cheap, deterministic candidate retrieval: no model call. Date phrases pull in
// every exchange from that window; keywords pull in topical matches from any
// date. The planner then decides which candidates actually matter.
export function recall(
  store: Store,
  text: string,
  today: LocalTime,
  excludeIds: Set<string>,
): RecallResult {
  const windows = resolvePastDates(text, today);
  const byDate: Exchange[] = [];
  for (const window of windows) {
    for (const exchange of store.exchangesBetween(window.from, window.to, 12)) {
      if (!excludeIds.has(exchange.id) && !byDate.some((e) => e.id === exchange.id)) byDate.push(exchange);
    }
  }

  const query = ftsQuery(keywords(text));
  const byTopic = query
    ? store
        .exchangesMatching(query, 8)
        .filter((e) => !excludeIds.has(e.id) && !byDate.some((d) => d.id === e.id))
        .slice(0, 5)
    : [];

  return {
    windows,
    byDate,
    byTopic,
    firstDate: store.historyBounds().first,
    activeDates: store.activeDates(10),
  };
}
