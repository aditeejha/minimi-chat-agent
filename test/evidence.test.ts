import assert from "node:assert/strict";
import { test } from "node:test";
import { Evidence, citationsToDomains, citedNumbers, normalizeUrl } from "../src/search/evidence.ts";
import { withoutSiteOperator } from "../src/search/tavily.ts";

const at = "2026-11-10T08:30:00.000Z";

test("the same page found twice keeps one number and merges passages", () => {
  const evidence = new Evidence();
  const a = evidence.add({ url: "https://www.hubspot.com/pricing/sales?utm_source=x", title: "HubSpot", published: null, content: "Starter $20" }, at);
  const b = evidence.add({ url: "https://hubspot.com/pricing/sales/", title: "HubSpot Sales", published: "2026-11-01", content: "Pro $100" }, at);
  const c = evidence.add({ url: "https://www.pipedrive.com/pricing", title: "Pipedrive", published: null, content: "Lite $14" }, at);
  assert.equal(a, 1);
  assert.equal(b, 1);
  assert.equal(c, 2);
  assert.match(evidence.sources[0]?.passages ?? "", /Starter \$20[\s\S]*Pro \$100/);
  assert.equal(evidence.sources[0]?.published, "2026-11-01");
});

test("normalizeUrl ignores protocol, tracking params, www and trailing slashes", () => {
  assert.equal(normalizeUrl("http://www.example.com/a/?utm_medium=x&id=3#top"), "https://example.com/a/?id=3");
});

test("translations of one post on the same site count once", () => {
  const evidence = new Evidence();
  const title = "Node.js — Evolving the Node.js Release Schedule";
  const a = evidence.add({ url: "https://nodejs.org/en/blog/announcements/evolving", title, published: null, content: "en" }, at);
  const b = evidence.add({ url: "https://nodejs.org/ko/blog/announcements/evolving", title, published: null, content: "ko" }, at);
  const c = evidence.add({ url: "https://example.com/evolving", title, published: null, content: "mirror" }, at);
  assert.deepEqual([a, b, c], [1, 1, 2]);
});

test("only citations that point at real sources count", () => {
  assert.deepEqual(citedNumbers("Pipedrive is $14 [2]. HubSpot [1, 3]. Bogus [9].", 3), [1, 2, 3]);
});

test("old answers are replayed with domains instead of numbers", () => {
  const sources = [
    { n: 1, url: "https://www.hubspot.com/pricing", title: "HubSpot", published: null, retrievedAt: at, passages: "" },
    { n: 2, url: "https://neon.com/pricing", title: "Neon", published: null, retrievedAt: at, passages: "" },
  ];
  assert.equal(citationsToDomains("HubSpot $20 [1]; Neon free tier [1, 2]; ghost [7].", sources), "HubSpot $20 (hubspot.com); Neon free tier (hubspot.com, neon.com); ghost [7].");
});

test("a site: operator in a query becomes a domain filter", () => {
  assert.deepEqual(withoutSiteOperator({ query: "site:pipedrive.com pricing per seat" }), { query: "pricing per seat", domain: "pipedrive.com" });
  assert.deepEqual(withoutSiteOperator({ query: "site:nodejs.org/en/about/previous-releases" }), { query: "about previous releases", domain: "nodejs.org" });
  assert.deepEqual(withoutSiteOperator({ query: "Node.js LTS" }), { query: "Node.js LTS" });
});
