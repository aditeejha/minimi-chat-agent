import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { z } from "zod";
import { config, missingKeys } from "./config.ts";
import { Store } from "./db.ts";
import { runTurn, toClient } from "./agent/turn.ts";
import { safeTimeZone } from "./time.ts";

const store = new Store(config.dbPath);
const app = new Hono();

const ChatRequest = z.object({
  threadId: z.string().nullish(),
  message: z.string().trim().min(1).max(8000),
  timeZone: z.string().optional(),
  asOf: z.string().datetime({ offset: true }).nullish(),
});

app.get("/api/health", (c) =>
  c.json({ missing: missingKeys(), answerModels: config.answerModels, plannerModels: config.plannerModels }),
);

app.get("/api/threads", (c) => c.json(store.listThreads()));

app.get("/api/threads/:id/messages", (c) => {
  const thread = store.getThread(c.req.param("id"));
  if (!thread) return c.json({ error: "Thread not found" }, 404);
  return c.json({ thread, messages: store.threadMessages(thread.id).map(toClient) });
});

app.delete("/api/threads/:id", (c) => {
  store.deleteThread(c.req.param("id"));
  return c.body(null, 204);
});

app.post("/api/chat", async (c) => {
  const parsed = ChatRequest.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: "Send {message, threadId?, timeZone?, asOf?}." }, 400);
  const missing = missingKeys();
  if (missing.length > 0) {
    return c.json({ error: `Set ${missing.join(" and ")} in .env, then restart npm run dev.` }, 503);
  }

  const { threadId, message, timeZone, asOf } = parsed.data;
  return streamSSE(c, async (stream) => {
    const controller = new AbortController();
    stream.onAbort(() => controller.abort());
    try {
      for await (const event of runTurn({
        store,
        threadId: threadId ?? null,
        message,
        now: asOf ? new Date(asOf) : new Date(),
        timeZone: safeTimeZone(timeZone),
        signal: controller.signal,
      })) {
        await stream.writeSSE({ data: JSON.stringify(event) });
      }
    } catch (error) {
      if (controller.signal.aborted) return;
      console.error(error);
      const text = error instanceof Error ? error.message : String(error);
      await stream.writeSSE({ data: JSON.stringify({ type: "error", message: text }) });
    }
  });
});

app.use("/vendor/marked.js", serveStatic({ path: "node_modules/marked/lib/marked.esm.js" }));
app.use("/vendor/purify.js", serveStatic({ path: "node_modules/dompurify/dist/purify.es.mjs" }));
app.use("/*", serveStatic({ root: "public" }));

serve({ fetch: app.fetch, port: config.port }, (info) => {
  console.log(`\nChat agent running at http://localhost:${info.port}`);
  const missing = missingKeys();
  if (missing.length > 0) console.log(`Missing ${missing.join(" and ")}: copy .env.example to .env and fill them in.`);
  console.log(`Answer models: ${config.answerModels.join(", ")}. Planner: ${config.plannerModels.join(", ")}. History: ${config.dbPath}\n`);
});
