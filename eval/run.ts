// Replays multi-day conversations against the real agent with a simulated
// clock, then checks what can be checked mechanically: was the right past
// exchange recalled, were sources cited, how long did it take.
// Usage: npm run eval [-- scenario-name]

import { mkdirSync, writeFileSync } from "node:fs";
import { missingKeys } from "../src/config.ts";
import { Store } from "../src/db.ts";
import { runTurn, type ClientMessage } from "../src/agent/turn.ts";

interface Step {
  at: Date;
  message: string;
  newThread?: boolean;
  checks: ((m: ClientMessage, ids: string[]) => string | null)[];
}

interface Scenario {
  name: string;
  steps: Step[];
}

const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
const now = new Date();

function daysBefore(weekday: number, hour: number): Date {
  const d = new Date(now);
  d.setHours(hour, 0, 0, 0);
  do d.setDate(d.getDate() - 1);
  while (d.getDay() !== weekday);
  return d;
}

function pastDate(month: number, day: number, hour: number): Date {
  const d = new Date(now.getFullYear(), month - 1, day, hour);
  if (d > now) d.setFullYear(d.getFullYear() - 1);
  return d;
}

type Meta = {
  cited?: number[];
  plan?: { recalled?: { id: string }[]; searches?: unknown[]; rereadUrls?: unknown[] };
  timings?: { firstTokenMs?: number; totalMs?: number };
};
const meta = (m: ClientMessage) => m.meta as Meta;

const recalls = (stepIndex: number) => (m: ClientMessage, ids: string[]) =>
  meta(m).plan?.recalled?.some((r) => r.id === ids[stepIndex]) ? null : `did not recall step ${stepIndex + 1}`;
const citesAtLeast = (n: number) => (m: ClientMessage) =>
  (meta(m).cited?.length ?? 0) >= n ? null : `cited ${meta(m).cited?.length ?? 0} sources, wanted ${n}+`;
const says = (pattern: RegExp, what: string) => (m: ClientMessage) => (pattern.test(m.content) ? null : `doesn't ${what}`);
const noSearch = (m: ClientMessage) =>
  (meta(m).plan?.searches?.length ?? 0) === 0 ? null : "searched when it didn't need to";

const scenarios: Scenario[] = [
  {
    name: "crm-since-monday",
    steps: [
      {
        at: daysBefore(1, 10),
        message: "We're a 20-person sales team. Shortlist 5 CRM tools for us with current per-seat pricing.",
        checks: [citesAtLeast(3)],
      },
      {
        at: now,
        newThread: true,
        message:
          "On Monday we shortlisted 5 CRM tools for a 20-person sales team. Has any of them changed pricing or shipped something big since?",
        checks: [recalls(0), citesAtLeast(3)],
      },
    ],
  },
  {
    name: "what-did-i-ask-on-3-november",
    steps: [
      {
        at: pastDate(11, 3, 11),
        message: "Which managed Postgres hosts are cheapest for a small production app? Neon, Supabase, RDS, anything else worth it?",
        checks: [citesAtLeast(2)],
      },
      {
        at: now,
        newThread: true,
        message: "What did I ask you on 3 November? Is your answer still correct today?",
        checks: [recalls(0), says(/postgres/i, "mention Postgres"), citesAtLeast(2)],
      },
    ],
  },
  {
    name: "no-record-of-last-tuesday",
    steps: [
      {
        at: now,
        message: "Last Tuesday I asked you about Postgres hosting. Has any pricing changed since then?",
        checks: [says(/(don't|do not|no) (have )?(a )?(record|conversation|history)|not on record|can't find|cannot find/i, "admit it has no record")],
      },
    ],
  },
  {
    name: "small-talk-is-instant",
    steps: [{ at: now, message: "hey, thanks for the help earlier!", checks: [noSearch] }],
  },
  {
    name: "fresh-fact",
    steps: [{ at: now, message: "What's the latest stable Node.js LTS version and when does it go end-of-life?", checks: [citesAtLeast(1)] }],
  },
];

async function run() {
  const missing = missingKeys();
  if (missing.length > 0) {
    console.error(`Set ${missing.join(" and ")} in .env first.`);
    process.exit(1);
  }
  const only = process.argv[2];
  const transcript: string[] = [`# Eval run ${now.toISOString()} (${timeZone})\n`];
  const rows: string[][] = [];

  for (const scenario of scenarios.filter((s) => !only || s.name === only)) {
    const store = new Store(":memory:");
    const ids: string[] = [];
    let threadId: string | null = null;
    transcript.push(`## ${scenario.name}\n`);

    for (const [i, step] of scenario.steps.entries()) {
      if (step.newThread) threadId = null;
      let answer: ClientMessage | null = null;
      let error: string | null = null;
      for await (const event of runTurn({
        store,
        threadId,
        message: step.message,
        now: step.at,
        timeZone,
        signal: new AbortController().signal,
      })) {
        if (event.type === "thread") threadId = event.thread.id;
        if (event.type === "done") answer = event.message;
        if (event.type === "error") error = event.message;
      }
      const userId = store.threadMessages(threadId ?? "").filter((m) => m.role === "user").at(-1)?.id ?? "";
      ids.push(userId);

      const problems = answer ? step.checks.map((check) => check(answer, ids)).filter((p): p is string => p !== null) : [error ?? "no answer"];
      const t = answer ? meta(answer).timings : undefined;
      rows.push([
        `${scenario.name} #${i + 1}`,
        problems.length === 0 ? "pass" : `FAIL: ${problems.join("; ")}`,
        t?.firstTokenMs ? `${(t.firstTokenMs / 1000).toFixed(1)}s` : "-",
        t?.totalMs ? `${(t.totalMs / 1000).toFixed(1)}s` : "-",
      ]);
      transcript.push(
        `**${step.at.toString().slice(0, 21)} - user:** ${step.message}\n`,
        `**assistant** (${rows.at(-1)?.slice(1).join(", ")}):\n\n${answer?.content ?? error}\n`,
        answer && answer.sources.length > 0
          ? `Sources:\n${answer.sources.map((s) => `- [${s.n}] ${s.title} - ${s.url}`).join("\n")}\n`
          : "",
      );
      console.log(`${rows.at(-1)?.join("  |  ")}`);
    }
  }

  mkdirSync("data", { recursive: true });
  const file = `data/eval-${now.toISOString().replace(/[:.]/g, "-")}.md`;
  transcript.push(`\n## Summary\n\n| step | result | first words | total |\n|---|---|---|---|\n${rows.map((r) => `| ${r.join(" | ")} |`).join("\n")}\n`);
  writeFileSync(file, transcript.join("\n"));
  console.log(`\nFull transcript: ${file}`);
  if (rows.some((r) => r[1] !== "pass")) process.exitCode = 1;
}

await run();
