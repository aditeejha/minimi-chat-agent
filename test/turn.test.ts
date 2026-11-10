import assert from "node:assert/strict";
import { test } from "node:test";
import type { Message } from "../src/db.ts";
import { fallbackPlan, planPrompt, type Plan } from "../src/agent/planner.ts";
import { historyContents, renderMemory } from "../src/agent/turn.ts";
import type { RecallResult } from "../src/memory/recall.ts";

const emptyRecall: RecallResult = {
  windows: [{ from: "2026-11-09", to: "2026-11-09", phrase: "On Monday", label: "Mon 9 Nov 2026" }],
  byDate: [],
  byTopic: [],
  firstDate: "2026-11-05",
  activeDates: ["2026-11-10", "2026-11-05"],
};

const plan: Plan = {
  referencesPastConversation: true,
  relevantMemoryIds: [],
  needsSearch: true,
  searches: [],
  rereadUrls: [],
  rereadFocus: null,
  effort: "medium",
  status: "",
  source: "planner",
};

test("a reference to a conversation we don't have becomes an explicit 'no record' note", () => {
  const text = renderMemory(plan, emptyRecall, [], "Asia/Kolkata") ?? "";
  assert.match(text, /No past exchange on record/);
  assert.match(text, /"On Monday" = Mon 9 Nov 2026/);
  assert.match(text, /Thu 5 Nov 2026/);
});

test("no memory block at all for ordinary questions", () => {
  assert.equal(renderMemory({ ...plan, referencesPastConversation: false }, emptyRecall, [], "UTC"), null);
});

test("history starts with a user turn and carries sources as domains and URLs", () => {
  const base = { threadId: "t", createdAt: "", localDate: "", timeZone: "UTC", replyTo: null };
  const window: Message[] = [
    { ...base, id: "a0", role: "assistant", content: "orphan", sources: [], meta: {} },
    { ...base, id: "u1", role: "user", content: "Neon price?", sources: [], meta: {} },
    {
      ...base,
      id: "a1",
      role: "assistant",
      content: "Neon Launch is $19/month [1].",
      sources: [{ n: 1, url: "https://neon.com/pricing", title: "Neon", published: null, retrievedAt: "", passages: "" }],
      meta: { cited: [1] },
    },
  ];
  const contents = historyContents(window);
  assert.equal(contents[0]?.role, "user");
  assert.equal(contents.length, 2);
  assert.equal(contents[1]?.role, "model");
  assert.equal(contents[1]?.parts?.[0]?.text, "Neon Launch is $19/month (neon.com).\n\nSources: https://neon.com/pricing");
});

test("the planner sees resolved dates and memory coverage", () => {
  const prompt = planPrompt({ message: "On Monday we shortlisted 5 CRM tools", now: "Tuesday 10 Nov 2026, 14:00 (Asia/Kolkata)", timeZone: "Asia/Kolkata", recent: [], recall: emptyRecall });
  assert.match(prompt, /"On Monday" = Mon 9 Nov 2026/);
  assert.match(prompt, /Memory covers Thu 5 Nov 2026/);
  assert.match(prompt, /<candidates>\n\(none\)/);
});

test("if the planner fails the turn still searches", () => {
  const fallback = fallbackPlan({ message: "Neon pricing", now: "", timeZone: "UTC", recent: [], recall: emptyRecall }, "timeout");
  assert.equal(fallback.needsSearch, true);
  assert.equal(fallback.searches[0]?.query, "Neon pricing");
  assert.equal(fallback.source, "fallback");
});
