# Design

The three example questions in the brief are all about time: what was said on a date, and whether it is still true. So the agent is built around one idea: **every answer is stored as a dated snapshot of the evidence it was based on.** A later "has anything changed?" compares that evidence with today's, rather than asking the model to remember.

## How a turn works

```
message ─► recall ─► plan ─► search + re-read ─► answer (streamed) ─► store
           SQLite    small     Tavily, in          large model,
           no LLM    model     parallel            web_search tool
```

1. **Recall, with no model call.** Date phrases ("on Monday", "last Tuesday", "3 November", "last week") are parsed with chrono and turned into calendar-date windows in the user's time zone, which the browser sends with each message. Every past exchange in those windows is a candidate, plus the top keyword matches from SQLite full-text search. This takes milliseconds.
2. **Plan, with a small model.** Claude Haiku 5.5, with structured output, sees the message, the recent conversation and the candidates. It decides which past exchanges matter, whether to search, up to six searches to run in parallel (with a `since` date filter or a single domain where useful), which previously cited pages to re-read, and whether this needs low or medium effort.
3. **Search.** Tavily's `fast` depth returns the passages of each page that best match the query, so a pricing page arrives as its price table. Results are de-duplicated by URL and numbered. Pages the agent cited in the recalled answer are fetched again so old and new versions can be compared.
4. **Answer.** Claude Opus 5.5 streams the answer from a single user turn that holds the current local time, the recalled exchanges (question, answer and the passages they cited, with their dates), and today's numbered sources. It keeps the `web_search` tool for follow-up searches, up to two rounds.
5. **Store.** The answer, every source with the exact passages the model saw, the plan and the timings are saved. That record is what the next "is this still correct?" works from.

## Why it is built this way

- **Fast.** The planner replaces the agent's first round trip. A large model deciding what to search typically spends a few seconds before the first search; the planner makes the same decision in about one. All searches run in parallel, so the answer model usually needs one call. The system prompt is static and cached; per-turn data goes in the user turn.
- **Right.** The model only cites numbered sources, and the server checks every citation against the evidence list. Time-sensitive facts carry their date. When the user refers to a conversation that isn't on record, the context says so explicitly ("No past exchange on record... records start on Thu 5 Nov"), because a model is bad at noticing that something is missing.
- **Time is data.** The clock is passed into each turn rather than read with `new Date()`, so "Monday" is the user's Monday, tests can pin the date, and the UI's simulated time lets you test a week of memory in five minutes.
- **One tool.** The model can call exactly one tool, `web_search`. Memory is retrieved by the harness, not by a tool call: date maths is deterministic code and is unit-tested.
- **Plain old answers in history.** Earlier turns are replayed as text, with their `[n]` citations rewritten as domains. Old search results are not replayed, so stale evidence never sits in context looking fresh, and the context stays small.

## Considered and rejected

- **A plain tool-calling loop** where the large model decides everything. It is simpler, but slower: one more large-model round trip before every search.
- **Memory as a second tool** (`recall(date)`). It costs a round trip, puts date arithmetic in the model's hands, and the brief asks for one tool.
- **Embeddings and a vector store for recall.** The questions are anchored by dates and named products. Date windows plus full-text search cover them with no extra service. Worth adding once a user's history outgrows keywords.
- **Anthropic's built-in web search tool.** Quick to wire up, but it hides the search layer: no control over date filters, re-reading cited pages, de-duplication or caching.
- **A structured "claims ledger"** extracted after each answer. It needs an extra model call per turn. Storing the cited passages gives the same before-and-after comparison.
- **LangChain or similar.** At this size it adds indirection without saving code, and it hides the steps reviewers want to see.

## With another week

- **A real eval set.** About 50 multi-day conversations, graded by a model against time-stamped ground truth, plus p50 and p95 latency per stage. `npm run eval` is the skeleton.
- **Change watching.** Re-check pages cited in recent answers in the background and tell the user, unprompted, when something they asked about has changed.
- **Structural diffs.** Store full page snapshots and diff pricing tables cell by cell instead of comparing passages.
- **Faster first words.** Start a search on the raw message while the planner runs, and skip the planner for obvious small talk with a local classifier.
- **Native citations** using `search_result` content blocks, so each claim maps to an exact passage.
- **Accounts.** Per-user memory, export, and a "forget this" control that also removes stored evidence.
