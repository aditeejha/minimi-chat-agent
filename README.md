# Chat agent with web search and dated memory

A chat agent with one tool, web search. It cites what it finds, and it remembers every conversation by date together with the evidence it used, so you can come back days later and ask "on Monday we shortlisted 5 CRM tools, has any of them changed pricing since?" and get a real answer.

How it works and why: [DESIGN.md](DESIGN.md).

## Run it

Needs Node 22.18 or newer (it uses Node's built-in TypeScript and SQLite support).

```bash
cp .env.example .env    # add GEMINI_API_KEY and TAVILY_API_KEY
npm install
npm run dev
```

Open http://localhost:3000.

Keys:

- `GEMINI_API_KEY`: free at https://aistudio.google.com/apikey, no card needed.
- `TAVILY_API_KEY`: web search. The free plan at https://app.tavily.com gives 1,000 searches a month.

A free Gemini key allows about 20 requests per model per day, and a question uses two or three: one for the planner (on a Flash-Lite model) and one or two for the answer. When a model is busy or out of quota, the agent moves to the next one in `ANSWER_MODELS` or `PLANNER_MODELS`, ending with Flash-Lite. Expect around 25 to 30 questions a day on a free key; for longer sessions, use a key from a project with billing enabled.

## Try the memory

Conversations are stored in `data/agent.db` and searched by date, so the agent's memory only covers what you have asked it. To test date questions without waiting a week, open **Simulated time** at the bottom of the sidebar:

1. Set it to last Monday and ask: "We're a 20-person sales team. Shortlist 5 CRM tools for us with current per-seat pricing."
2. Click **Use real time**, start a new chat, and ask: "On Monday we shortlisted 5 CRM tools for a 20-person sales team. Has any of them changed pricing or shipped something big since?"

Messages sent while simulated time is on are stamped with that time. The web results are still today's.

Each browser gets its own memory through a cookie, so on a shared deployment visitors never see each other's conversations.

## Deploy

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/aditeejha/minimi-chat-agent)

`render.yaml` describes a free Render web service. The button asks for `GEMINI_API_KEY` and `TAVILY_API_KEY`, then builds with `npm ci` and starts with `npm start`. On the free plan the service sleeps after 15 minutes without traffic (the next request takes about a minute), and its disk is temporary, so memory starts empty again after a restart. Every visitor also shares the Gemini key's daily quota.

## Scripts

| Command | What it does |
|---|---|
| `npm run dev` | Starts the app with auto-reload on http://localhost:3000 |
| `npm test` | Unit tests for date resolution, recall, evidence handling and prompt assembly (no API keys needed) |
| `npm run typecheck` | TypeScript check |
| `npm run eval` | Replays multi-day scenarios against the live agent with a simulated clock and writes a transcript to `data/` (uses your API quota) |

## Layout

```
src/
  server.ts            HTTP API and server-sent events (Hono)
  agent/turn.ts        One turn: recall, plan, search, answer, store
  agent/planner.ts     Small model that decides what to recall and what to search
  agent/answer.ts      Streaming answer loop with the web_search tool
  llm.ts               Gemini client with per-model fallback
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
