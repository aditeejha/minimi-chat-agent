import type { StoredSource } from "../db.ts";
import type { SearchHit } from "./tavily.ts";

const MAX_PASSAGE_CHARS = 1800;

export function normalizeUrl(raw: string): string {
  try {
    const url = new URL(raw);
    url.protocol = "https:";
    url.hash = "";
    for (const key of [...url.searchParams.keys()]) {
      if (/^(utm_|ref$|ref_|fbclid|gclid|mc_)/i.test(key)) url.searchParams.delete(key);
    }
    url.hostname = url.hostname.replace(/^www\./, "");
    return url.toString().replace(/\/$/, "");
  } catch {
    return raw;
  }
}

// support.pipedrive.com/ru/article/x and /en/article/x are one article.
function pageKey(raw: string): string {
  try {
    const url = new URL(normalizeUrl(raw));
    const path = url.pathname.replace(/^\/[a-z]{2}(?:[-_][a-z]{2,4})?(?=\/)/i, "");
    return `${url.hostname}${path}${url.search}`;
  } catch {
    return raw;
  }
}

export function domainOf(raw: string): string {
  try {
    return new URL(raw).hostname.replace(/^www\./, "");
  } catch {
    return raw;
  }
}

function clean(content: string): string {
  return content
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// The numbered evidence for one answer. Numbers are what the model cites and
// what the UI links, so a URL seen twice keeps its first number.
export class Evidence {
  sources: StoredSource[] = [];

  // A page counts as already seen if its URL matches, or if the same site has
  // a page with the same title (translations and ?query variants of one post).
  add(hit: SearchHit, retrievedAt: string): number {
    const key = pageKey(hit.url);
    const domain = domainOf(hit.url);
    const title = hit.title.trim().toLowerCase();
    const passages = clean(hit.content);
    const existing = this.sources.find(
      (s) =>
        pageKey(s.url) === key ||
        (title.length > 12 && hit.title !== hit.url && domainOf(s.url) === domain && s.title.trim().toLowerCase() === title),
    );
    if (existing) {
      if (passages && !existing.passages.includes(passages.slice(0, 80))) {
        existing.passages = `${existing.passages}\n…\n${passages}`.slice(0, MAX_PASSAGE_CHARS * 2);
      }
      if (!existing.published && hit.published) existing.published = hit.published;
      if (existing.title === existing.url && hit.title !== hit.url) existing.title = hit.title;
      return existing.n;
    }
    const source: StoredSource = {
      n: this.sources.length + 1,
      url: hit.url,
      title: hit.title.trim() || domainOf(hit.url),
      published: hit.published ? hit.published.slice(0, 10) : null,
      retrievedAt,
      passages: passages.slice(0, MAX_PASSAGE_CHARS),
    };
    this.sources.push(source);
    return source.n;
  }

  render(numbers: number[]): string {
    return numbers
      .map((n) => this.sources[n - 1])
      .filter((s): s is StoredSource => s !== undefined)
      .map(renderSource)
      .join("\n\n");
  }
}

export function renderSource(s: StoredSource): string {
  const published = s.published ? `published ${s.published}` : "publish date unknown";
  return `[${s.n}] ${s.title}\n${s.url}\n(${published}; retrieved ${s.retrievedAt.slice(0, 10)})\n${s.passages || "(no text extracted)"}`;
}

export function citedNumbers(text: string, available: number): number[] {
  const found = new Set<number>();
  for (const match of text.matchAll(/\[(\d{1,3}(?:\s*,\s*\d{1,3})*)\]/g)) {
    for (const part of (match[1] ?? "").split(",")) {
      const n = Number(part.trim());
      if (n >= 1 && n <= available) found.add(n);
    }
  }
  return [...found].sort((a, b) => a - b);
}

// Old answers are replayed to the model with their [n] markers turned into
// domains, so they can't be confused with this turn's numbering.
export function citationsToDomains(text: string, sources: StoredSource[]): string {
  return text.replace(/\[(\d{1,3}(?:\s*,\s*\d{1,3})*)\]/g, (whole, list: string) => {
    const domains = list
      .split(",")
      .map((part) => sources.find((s) => s.n === Number(part.trim())))
      .filter((s): s is StoredSource => s !== undefined)
      .map((s) => domainOf(s.url));
    return domains.length > 0 ? `(${[...new Set(domains)].join(", ")})` : whole;
  });
}
