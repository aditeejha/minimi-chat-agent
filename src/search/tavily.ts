import { config } from "../config.ts";

export interface SearchQuery {
  query: string;
  since?: string | null;
  domain?: string | null;
  news?: boolean;
}

export interface SearchHit {
  url: string;
  title: string;
  published: string | null;
  content: string;
}

export class SearchError extends Error {}

const ENDPOINT = "https://api.tavily.com";
const CACHE_TTL_MS = 10 * 60 * 1000;
const cache = new Map<string, { at: number; hits: SearchHit[] }>();

async function post(path: string, body: unknown, signal?: AbortSignal): Promise<Record<string, unknown>> {
  if (!config.tavilyApiKey) throw new SearchError("TAVILY_API_KEY is not set");
  const timeout = AbortSignal.timeout(15_000);
  const response = await fetch(`${ENDPOINT}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${config.tavilyApiKey}` },
    body: JSON.stringify(body),
    signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
  });
  if (!response.ok) {
    const detail = (await response.text()).slice(0, 200);
    throw new SearchError(`Tavily ${path} failed with ${response.status}: ${detail}`);
  }
  return (await response.json()) as Record<string, unknown>;
}

function cached(key: string): SearchHit[] | null {
  const entry = cache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.at > CACHE_TTL_MS) {
    cache.delete(key);
    return null;
  }
  return entry.hits;
}

function remember(key: string, hits: SearchHit[]): SearchHit[] {
  cache.set(key, { at: Date.now(), hits });
  if (cache.size > 500) cache.delete(cache.keys().next().value as string);
  return hits;
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

// Tavily sends dates like "Thu, 11 Jun 2026 06:31:21 GMT".
export function isoDate(value: unknown): string | null {
  const raw = text(value);
  if (!raw) return null;
  const date = new Date(raw);
  return Number.isNaN(date.getTime()) ? null : date.toISOString().slice(0, 10);
}

const GENERIC = new Set(
  `pricing price prices cost costs change changes changed new news latest update updates updated announcement
  announces announced launch launches launched feature features release releases plan plans tier tiers per seat
  seats user users month monthly year yearly annual best top compare comparison review reviews guide official
  what when which how does the and for with from vs versus 2024 2025 2026 2027 since today current`.split(/\s+/),
);

function distinctiveTerms(query: string): string[] {
  const words = query.toLowerCase().match(/[\p{L}\p{N}][\p{L}\p{N}.+#-]*/gu) ?? [];
  return [...new Set(words.map((w) => w.replace(/[.+#-]+$/, "")).filter((w) => w.length > 2 && !GENERIC.has(w)))];
}

// Tavily's relevance score is not reliable once a date filter is on (a
// Pokémon story scored 1.0 for "Salesforce pricing change"), so a result has
// to mention at least half of the query's distinctive words to count.
export function looksRelevant(query: string, hit: SearchHit): boolean {
  const terms = distinctiveTerms(query);
  if (terms.length === 0) return true;
  const haystack = `${hit.title} ${hit.url} ${hit.content}`.toLowerCase();
  const found = terms.filter((t) => haystack.includes(t)).length;
  return found >= Math.ceil(terms.length / 2);
}

// "fast" depth returns the chunks of each page that best match the query, so
// a pricing page arrives as its price table rather than its hero banner.
export async function search(q: SearchQuery, signal?: AbortSignal): Promise<SearchHit[]> {
  const body: Record<string, unknown> = {
    query: q.query,
    search_depth: "fast",
    chunks_per_source: 3,
    max_results: 5,
    include_published_date: true,
    topic: q.news ? "news" : "general",
  };
  if (q.since) body.start_date = q.since;
  if (q.domain) body.include_domains = [q.domain];

  const key = JSON.stringify(body);
  const hit = cached(key);
  if (hit) return hit;

  const data = await post("/search", body, signal);
  const results = Array.isArray(data.results) ? (data.results as Record<string, unknown>[]) : [];
  return remember(
    key,
    results
      .filter((r) => text(r.url))
      .map((r) => ({
        url: text(r.url),
        title: text(r.title) || text(r.url),
        published: isoDate(r.published_date),
        content: text(r.content),
      }))
      .filter((hit) => looksRelevant(q.query, hit))
      .slice(0, 4),
  );
}

// Re-reads pages we cited before, ranked against what we want to check on them.
export async function readPages(urls: string[], focus: string, signal?: AbortSignal): Promise<SearchHit[]> {
  if (urls.length === 0) return [];
  const body = { urls: urls.slice(0, 10), query: focus, chunks_per_source: 3, extract_depth: "basic", format: "markdown" };
  const key = JSON.stringify(body);
  const hit = cached(key);
  if (hit) return hit;

  const data = await post("/extract", body, signal);
  const results = Array.isArray(data.results) ? (data.results as Record<string, unknown>[]) : [];
  return remember(
    key,
    results
      .filter((r) => text(r.url) && text(r.raw_content))
      .map((r) => ({ url: text(r.url), title: text(r.url), published: null, content: text(r.raw_content) })),
  );
}
