import assert from "node:assert/strict";
import { test } from "node:test";
import { Store } from "../src/db.ts";
import { keywords, recall } from "../src/memory/recall.ts";
import { toLocal } from "../src/time.ts";

const zone = "Asia/Kolkata";

function exchange(store: Store, threadId: string, at: string, question: string, answer: string) {
  const local = toLocal(new Date(at), zone);
  const user = store.addMessage({
    threadId,
    role: "user",
    content: question,
    createdAt: at,
    localDate: local.date,
    timeZone: zone,
    replyTo: null,
    sources: [],
    meta: {},
  });
  store.addMessage({
    threadId,
    role: "assistant",
    content: answer,
    createdAt: new Date(new Date(at).getTime() + 5000).toISOString(),
    localDate: local.date,
    timeZone: zone,
    replyTo: user.id,
    sources: [
      { n: 1, url: "https://www.pipedrive.com/en/pricing", title: "Pipedrive pricing", published: null, retrievedAt: at, passages: "Advanced $39" },
    ],
    meta: { cited: [1] },
  });
  return user.id;
}

function seeded() {
  const store = new Store(":memory:");
  const crm = store.createThread("CRM shortlist", "2026-11-09T04:30:00Z");
  const pg = store.createThread("Postgres", "2026-11-03T06:00:00Z");
  const crmId = exchange(
    store,
    crm.id,
    "2026-11-09T04:30:00Z",
    "Shortlist 5 CRM tools for a 20-person sales team",
    "HubSpot, Pipedrive [1], Salesforce, Zoho, Freshsales",
  );
  const pgId = exchange(
    store,
    pg.id,
    "2026-11-03T06:00:00Z",
    "Cheapest managed Postgres hosting for a startup?",
    "Neon, Supabase and RDS compared",
  );
  return { store, crmId, pgId };
}

const today = toLocal(new Date("2026-11-12T06:00:00Z"), zone);

test("a date phrase pulls in that day's exchanges with their answers and sources", () => {
  const { store, crmId } = seeded();
  const result = recall(store, "On Monday we shortlisted 5 CRM tools. Has any changed pricing since?", today, new Set());
  assert.equal(result.byDate.length, 1);
  assert.equal(result.byDate[0]?.id, crmId);
  assert.match(result.byDate[0]?.answer ?? "", /Pipedrive/);
  assert.deepEqual(result.byDate[0]?.cited, [1]);
  assert.equal(result.byDate[0]?.sources[0]?.url, "https://www.pipedrive.com/en/pricing");
});

test("topic words find exchanges from any date", () => {
  const { store, pgId } = seeded();
  const result = recall(store, "You told me about postgres hosting once. Still accurate?", today, new Set());
  assert.equal(result.byDate.length, 0);
  assert.equal(result.byTopic[0]?.id, pgId);
});

test("exchanges already in the conversation are not recalled twice", () => {
  const { store, crmId } = seeded();
  const result = recall(store, "On Monday we shortlisted CRM tools", today, new Set([crmId]));
  assert.equal(result.byDate.length, 0);
  assert.equal(result.byTopic.length, 0);
});

test("an empty memory says so", () => {
  const store = new Store(":memory:");
  const result = recall(store, "What did I ask you on 3 November?", today, new Set());
  assert.equal(result.firstDate, null);
  assert.deepEqual(result.byDate, []);
  assert.equal(result.windows[0]?.from, "2026-11-03");
});

test("keywords drop filler and date words", () => {
  assert.deepEqual(keywords("Last Tuesday I asked you about Postgres hosting. Has any pricing changed since then?"), [
    "postgres",
    "hosting",
    "pricing",
  ]);
});
