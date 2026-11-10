# Design

The three example questions in the brief are all about time: what was said on a date, and whether it is still true. So the agent is built around one idea: **every answer is stored as a dated snapshot of the evidence it was based on.** A later "has anything changed?" compares that evidence with today's, rather than asking the model to remember.

## How a turn works

```
message ─► recall ─► plan ─► search + re-read ─► answer (streamed) ─► store
           SQLite    small     Tavily, in          Gemini Flash,
           no LLM    model     parallel            web_search tool
```

1. **Recall, with no model call.** Date phrases ("on Monday", "last Tuesday", "3 November", "last week") are parsed with chrono and turned into calendar-date windows in the user's time zone, which the browser sends with each message. Every past exchange in those windows is a candidate, plus the top keyword matches from SQLite full-text search. This takes milliseconds.
2. **Plan, with a small model.** Gemini Flash-Lite, constrained to a JSON schema, sees the message, the recent conversation and the candidates. It decides which past exchanges matter, whether to search, up to six searches to run in parallel (with a `since` date filter or a single domain where useful), which previously cited pages to re-read, and how hard the answer model should think.
3. **Search.** Tavily's `fast` depth returns the passages of each page that best match the query, so a pricing page arrives as its price table. Results are de-duplicated by URL and numbered. Pages cited in the recalled answer are fetched again so old and new versions can be compared.
4. **Answer.** Gemini Flash streams the answer from a single user turn that holds the current local time, the recalled exchanges (question, answer and the passages they cited, with their dates) and today's numbered sources. It keeps the `web_search` tool for follow-up searches, up to two rounds.
5. **Store.** The answer, every source with the exact passages the model saw, the plan and the timings are saved. That record is what the next "is this still correct?" works from.

## Why it is built this way

- **Fast.** The planner replaces the agent's first round trip: instead of the answer model thinking, calling a tool and waiting, a small model picks the searches and they all run at once, so the answer model usually needs one call. Thinking is set low for lookups and medium only for comparisons and re-checks.
- **Right.** The model only cites numbered sources, and the server checks every citation against the evidence list. Time-sensitive facts carry their date. When the user refers to a conversation that isn't on record, the context says so explicitly ("No past exchange on record... records start on Thu 5 Nov"), because models are bad at noticing that something is missing.
- **Time is data.** The clock is passed into each turn rather than read with `new Date()`, so "Monday" is the user's Monday, tests can pin the date, and the UI's simulated time lets you test a week of memory in five minutes.
- **One tool.** The model can call exactly one tool, `web_search`. Memory is retrieved by the harness, not by a tool call: date maths is deterministic code and is unit-tested.
- **Plain old answers in history.** Earlier turns are replayed as text, with `[n]` citations rewritten as domains. Old search results are not replayed, so stale evidence never sits in context looking fresh, and the context stays small.
- **Free to run.** Gemini and Tavily both have free tiers, so anyone can run it. Free keys get rate-limited, so each role has a list of models: one that answers 429 or 5xx sits out for two minutes and the next takes over. A turn stays on one model once it starts, because Gemini's thought signatures are tied to it.

## Considered and rejected

- **A plain tool-calling loop** where one model decides everything. Simpler, but slower: one more model round trip before every search.
- **Memory as a second tool** (`recall(date)`). It costs a round trip, puts date arithmetic in the model's hands, and the brief asks for one tool.
- **Embeddings and a vector store for recall.** The questions are anchored by dates and named products. Date windows plus full-text search cover them with no extra service. Worth adding once a user's history outgrows keywords.
- **Gemini's built-in Google Search grounding.** Quick to wire up, but it hides the search layer: no date filters, no re-reading of cited pages, no control over which passages the model sees.
- **A structured "claims ledger"** extracted after each answer. It needs an extra model call per turn. Storing the cited passages gives the same before-and-after comparison.
- **LangChain or a provider-agnostic SDK.** At this size it adds indirection without saving code, and it hides the steps reviewers want to see. The model calls live in two small files.

## With another week

- **A real eval set.** About 50 multi-day conversations, graded by a model against time-stamped ground truth, plus p50 and p95 latency per stage. `npm run eval` is the skeleton.
- **Pick models by measurement.** Run that set against several models per stage (planner, answer) and choose on quality per second, not by default.
- **Change watching.** Re-check pages cited in recent answers in the background and tell the user, unprompted, when something they asked about has changed.
- **Structural diffs.** Store full page snapshots and diff pricing tables cell by cell instead of comparing passages.
- **Faster first words.** Start a search on the raw message while the planner runs, and skip the planner for obvious small talk with a local classifier.
- **Accounts.** Per-user memory, export, and a "forget this" control that also removes stored evidence.
