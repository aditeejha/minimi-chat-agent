# Design

The brief's example questions are all about time: what was said on a date, and whether it is still true. So the agent is built around one idea: **every answer is stored as a dated snapshot of the evidence behind it.** "Has anything changed?" then compares that evidence with today's, instead of asking a model to remember.

## How a turn works

```
message ─► recall ─► plan ─► search + re-read ─► answer (streamed) ─► store
           SQLite    Flash-Lite  Tavily, all       Gemini Flash,
           no LLM    JSON plan   in parallel       web_search tool
```

1. **Recall, no model call.** Date phrases ("on Monday", "last Tuesday", "3 November", "last week") become calendar-date windows in the user's time zone (chrono plus unit-tested rules). Exchanges in those windows, plus top keyword matches from SQLite full-text search, are the candidates. Milliseconds.
2. **Plan.** Flash-Lite, held to a JSON schema, picks the relevant past exchanges, up to six parallel searches (with a `since` date or one domain), which previously cited pages to re-read, and how hard the answer model should think.
3. **Search.** Tavily `fast` returns the passages that best match each query, so a pricing page arrives as its price table. Results are filtered, de-duplicated and numbered.
4. **Answer.** Gemini Flash streams from one user turn holding the local time, the recalled exchanges (question, answer, cited passages, dates) and today's sources. It keeps `web_search` for one follow-up round.
5. **Store.** Answer, sources with the exact passages the model saw, plan and timings. The next "is this still correct?" works from this record.

## Why this way

- **Fast.** The planner replaces the agent's first round trip: a small model picks the searches and they run at once, so the answer model usually needs one call. Flash took 1.8s to its first word at minimal thinking and 5.1s at low, so lookups use minimal and only re-checks and comparisons use low. Small talk skips the planner. Measured on a free key: plan 2.0s, search 0.7s, first words 7.9s.
- **Right.** Only numbered sources may be cited, and the server checks every citation. Prices and versions carry dates. "Unchanged" needs a citation from today, and a "change" must compare the same plan on both sides. When the user mentions a conversation that isn't on record, the context says so explicitly, because models are bad at noticing absence.
- **Clean evidence.** Duplicates across http/https, tracking parameters, translations and same-title pages are merged. A result must mention the query's distinctive words, because Tavily's score is unreliable with a date filter: a Pokémon story scored 1.0 for "Salesforce pricing change".
- **Time is data.** The clock is passed into each turn, not read with `new Date()`. "Monday" is the user's Monday, tests pin the date, and the UI's simulated time tests a week of memory in minutes.
- **One tool.** The model can call only `web_search`. Memory is fetched by the harness, so date maths is code, not model output.
- **Small, honest context.** Earlier turns are replayed as text with citations rewritten as domains. Old search results are not replayed, so stale evidence never looks fresh.
- **Degrades instead of failing.** Free Gemini keys allow about 20 requests per model per day and often return "503 high demand". Each role has a list of models; a failing one sits out (until Google's reset time for a spent quota) and the next takes over, ending with Flash-Lite. A watchdog aborts a silent stream (one hung for five minutes in testing) and retries elsewhere if nothing has reached the user.

## Considered and rejected

- **A plain tool-calling loop.** Simpler, but one more model round trip before every search.
- **Memory as a second tool.** Costs a round trip, hands date arithmetic to the model, and the brief asks for one tool.
- **Embeddings for recall.** The questions are anchored by dates and product names; date windows plus full-text search cover them with no extra service.
- **Gemini's built-in Google Search.** It hides the search layer: no date filters, no re-reading cited pages, no say in which passages the model sees.
- **A "claims ledger" extracted after each answer.** An extra model call per turn; stored passages give the same before-and-after comparison.
- **LangChain or a multi-provider SDK.** Indirection without saving code at this size. The model calls live in two small files.

## With another week

- **A real eval set:** about 50 multi-day conversations graded against time-stamped ground truth, with p50/p95 latency per stage. `npm run eval` is the skeleton.
- **Models chosen by measurement**, per stage, on quality per second.
- **Change watching:** re-check cited pages in the background and tell the user, unprompted, when something they asked about changed.
- **Structural diffs** of stored page snapshots, so pricing tables compare cell by cell.
- **Faster first words:** start searching on the raw message while the planner runs.
- **Accounts:** per-user memory, export, and "forget this" that also deletes stored evidence.
