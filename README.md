# Chat agent with web search and dated memory

A chat agent with one tool, web search. It cites what it finds, and it remembers every conversation by date together with the evidence it used, so you can come back days later and ask "on Monday we shortlisted 5 CRM tools, has any of them changed pricing since?" and get a real answer.

How it works and why: [DESIGN.md](DESIGN.md).

## Run it

Needs Node 22.18 or newer (it uses Node's built-in TypeScript and SQLite support).

```bash
cp .env.example .env    # add ANTHROPIC_API_KEY and TAVILY_API_KEY
npm install
npm run dev
```

Open http://localhost:3000.

Keys:

- `ANTHROPIC_API_KEY`: from https://platform.claude.com
- `TAVILY_API_KEY`: web search. The free plan at https://app.tavily.com gives 1,000 searches a month.

## Try the memory

Conversations are stored in `data/agent.db` and searched by date, so the agent's memory only covers what you have asked it. To test date questions without waiting a week, open **Simulated time** at the bottom of the sidebar:

1. Set it to last Monday and ask: "We're a 20-person sales team. Shortlist 5 CRM tools for us with current per-seat pricing."
2. Click **Use real time**, start a new chat, and ask: "On Monday we shortlisted 5 CRM tools for a 20-person sales team. Has any of them changed pricing or shipped something big since?"

Messages sent while simulated time is on are stamped with that time. The web results are still today's.

## Scripts

| Command | What it does |
|---|---|
| `npm run dev` | Starts the app with auto-reload on http://localhost:3000 |
| `npm test` | Unit tests for date resolution, recall, evidence handling and prompt assembly (no API keys needed) |
| `npm run typecheck` | TypeScript check |
| `npm run eval` | Replays multi-day scenarios against the live agent with a simulated clock and writes a transcript to `data/` (uses API credits) |

## Layout

```
src/
  server.ts            HTTP API and server-sent events (Hono)
  agent/turn.ts        One turn: recall, plan, search, answer, store
  agent/planner.ts     Fast model that decides what to recall and what to search
  agent/answer.ts      Streaming answer loop with the web_search tool
  agent/prompts.ts     System prompts
  memory/dates.ts      "last Tuesday" to calendar dates in the user's time zone
  memory/recall.ts     Finds past exchanges by date and by keyword
  search/tavily.ts     Search and page re-reading, with a short cache
  search/evidence.ts   Numbered, de-duplicated sources and citation helpers
  db.ts                SQLite storage with full-text search
public/                The chat UI (plain HTML, CSS and JS)
test/                  Unit tests
eval/run.ts            End-to-end scenarios
```
