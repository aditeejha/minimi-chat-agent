import assert from "node:assert/strict";
import { test } from "node:test";
import { resolvePastDates } from "../src/memory/dates.ts";
import { toLocal } from "../src/time.ts";

// Tuesday 10 Nov 2026, 14:00 in Kolkata.
const today = toLocal(new Date("2026-11-10T08:30:00Z"), "Asia/Kolkata");

function windows(text: string, at = today) {
  return resolvePastDates(text, at).map((w) => [w.from, w.to]);
}

test("the three examples from the brief", () => {
  assert.deepEqual(
    windows("On Monday we shortlisted 5 CRM tools for a 20-person sales team. Has any of them changed pricing or shipped something big since?"),
    [["2026-11-09", "2026-11-09"]],
  );
  assert.deepEqual(windows("What did I ask you on 3 November? Is your answer still correct today?"), [
    ["2026-11-03", "2026-11-03"],
  ]);
  assert.deepEqual(windows("Last Tuesday I asked you about Postgres hosting. Has any pricing changed since then?"), [
    ["2026-11-03", "2026-11-03"],
  ]);
});

test("bare weekdays lean into the past", () => {
  assert.deepEqual(windows("on Friday you told me"), [["2026-11-06", "2026-11-06"]]);
  assert.deepEqual(windows("on Tuesday we talked"), [["2026-11-03", "2026-11-03"]]);
});

test("weeks, months and fuzzy day counts become ranges", () => {
  assert.deepEqual(windows("last week you said"), [["2026-11-02", "2026-11-08"]]);
  assert.deepEqual(windows("in October you said"), [["2026-10-01", "2026-10-31"]]);
  assert.deepEqual(windows("earlier this month"), [["2026-11-01", "2026-11-10"]]);
  assert.deepEqual(windows("a few days ago"), [["2026-11-06", "2026-11-08"]]);
});

test("a date later this year means last year", () => {
  assert.deepEqual(windows("what did we discuss on 20 November"), [["2025-11-20", "2025-11-20"]]);
});

test("future and non-date phrases are ignored", () => {
  assert.deepEqual(windows("what is the weather tomorrow"), []);
  assert.deepEqual(windows("5 CRM tools for a 20-person team"), []);
  assert.deepEqual(windows("is it still true today"), []);
});

test("yesterday is the user's yesterday, not the server's", () => {
  const instant = new Date("2026-11-09T20:00:00Z");
  assert.deepEqual(windows("yesterday", toLocal(instant, "Asia/Kolkata")), [["2026-11-09", "2026-11-09"]]);
  assert.deepEqual(windows("yesterday", toLocal(instant, "America/Los_Angeles")), [["2026-11-08", "2026-11-08"]]);
});
