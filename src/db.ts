import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";

export interface StoredSource {
  n: number;
  url: string;
  title: string;
  published: string | null;
  retrievedAt: string;
  passages: string;
}

export interface Thread {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
}

export interface Message {
  id: string;
  threadId: string;
  role: "user" | "assistant";
  content: string;
  createdAt: string;
  localDate: string;
  timeZone: string;
  replyTo: string | null;
  sources: StoredSource[];
  meta: Record<string, unknown>;
}

// One question and the answer it got. This is the unit the agent remembers.
export interface Exchange {
  id: string;
  threadId: string;
  askedAt: string;
  localDate: string;
  timeZone: string;
  question: string;
  answer: string | null;
  sources: StoredSource[];
  cited: number[];
}

// Every thread belongs to an owner (one per browser on a shared deployment),
// and every read below is scoped to it, so visitors never see each other's
// conversations or recall each other's answers.
const SCHEMA = `
CREATE TABLE IF NOT EXISTS threads (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  owner TEXT NOT NULL DEFAULT 'local'
);
CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
  content TEXT NOT NULL,
  created_at TEXT NOT NULL,
  local_date TEXT NOT NULL,
  time_zone TEXT NOT NULL,
  reply_to TEXT,
  sources TEXT NOT NULL DEFAULT '[]',
  meta TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS messages_by_thread ON messages(thread_id, created_at);
CREATE INDEX IF NOT EXISTS messages_by_date ON messages(local_date);
CREATE INDEX IF NOT EXISTS messages_by_reply ON messages(reply_to);
CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
  content, content='messages', content_rowid='rowid', tokenize='porter unicode61'
);
CREATE TRIGGER IF NOT EXISTS messages_fts_insert AFTER INSERT ON messages BEGIN
  INSERT INTO messages_fts(rowid, content) VALUES (new.rowid, new.content);
END;
CREATE TRIGGER IF NOT EXISTS messages_fts_delete AFTER DELETE ON messages BEGIN
  INSERT INTO messages_fts(messages_fts, rowid, content) VALUES ('delete', old.rowid, old.content);
END;
`;

const EXCHANGE_SELECT = `
SELECT u.id, u.thread_id, u.created_at, u.local_date, u.time_zone, u.content AS question,
       a.content AS answer, a.sources, a.meta
FROM messages u
JOIN threads t ON t.id = u.thread_id
LEFT JOIN messages a ON a.reply_to = u.id AND a.role = 'assistant'
WHERE u.role = 'user' AND t.owner = ?`;

type Row = Record<string, unknown>;

function toThread(row: Row): Thread {
  return {
    id: String(row.id),
    title: String(row.title),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function toMessage(row: Row): Message {
  return {
    id: String(row.id),
    threadId: String(row.thread_id),
    role: row.role === "assistant" ? "assistant" : "user",
    content: String(row.content),
    createdAt: String(row.created_at),
    localDate: String(row.local_date),
    timeZone: String(row.time_zone),
    replyTo: row.reply_to == null ? null : String(row.reply_to),
    sources: JSON.parse(String(row.sources ?? "[]")) as StoredSource[],
    meta: JSON.parse(String(row.meta ?? "{}")) as Record<string, unknown>,
  };
}

function toExchange(row: Row): Exchange {
  const meta = JSON.parse(String(row.meta ?? "{}")) as { cited?: number[] };
  return {
    id: String(row.id),
    threadId: String(row.thread_id),
    askedAt: String(row.created_at),
    localDate: String(row.local_date),
    timeZone: String(row.time_zone),
    question: String(row.question),
    answer: row.answer == null ? null : String(row.answer),
    sources: JSON.parse(String(row.sources ?? "[]")) as StoredSource[],
    cited: Array.isArray(meta.cited) ? meta.cited : [],
  };
}

export class Store {
  db: DatabaseSync;

  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
    this.db.exec(SCHEMA);
    const columns = this.db.prepare("PRAGMA table_info(threads)").all() as Row[];
    if (!columns.some((c) => c.name === "owner")) {
      this.db.exec("ALTER TABLE threads ADD COLUMN owner TEXT NOT NULL DEFAULT 'local'");
    }
    this.db.exec("CREATE INDEX IF NOT EXISTS threads_by_owner ON threads(owner, updated_at)");
  }

  createThread(title: string, at: string, owner: string): Thread {
    const thread = { id: randomUUID(), title, createdAt: at, updatedAt: at };
    this.db
      .prepare("INSERT INTO threads (id, title, created_at, updated_at, owner) VALUES (?, ?, ?, ?, ?)")
      .run(thread.id, thread.title, thread.createdAt, thread.updatedAt, owner);
    return thread;
  }

  getThread(id: string, owner: string): Thread | null {
    const row = this.db.prepare("SELECT * FROM threads WHERE id = ? AND owner = ?").get(id, owner) as Row | undefined;
    return row ? toThread(row) : null;
  }

  listThreads(owner: string): Thread[] {
    return (this.db.prepare("SELECT * FROM threads WHERE owner = ? ORDER BY updated_at DESC").all(owner) as Row[]).map(
      toThread,
    );
  }

  deleteThread(id: string, owner: string): void {
    if (!this.getThread(id, owner)) return;
    this.db.prepare("DELETE FROM messages WHERE thread_id = ?").run(id);
    this.db.prepare("DELETE FROM threads WHERE id = ?").run(id);
  }

  addMessage(input: Omit<Message, "id">): Message {
    const message = { id: randomUUID(), ...input };
    this.db
      .prepare(
        `INSERT INTO messages (id, thread_id, role, content, created_at, local_date, time_zone, reply_to, sources, meta)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        message.id,
        message.threadId,
        message.role,
        message.content,
        message.createdAt,
        message.localDate,
        message.timeZone,
        message.replyTo,
        JSON.stringify(message.sources),
        JSON.stringify(message.meta),
      );
    this.db.prepare("UPDATE threads SET updated_at = ? WHERE id = ?").run(message.createdAt, message.threadId);
    return message;
  }

  threadMessages(threadId: string): Message[] {
    return (
      this.db
        .prepare("SELECT * FROM messages WHERE thread_id = ? ORDER BY created_at, rowid")
        .all(threadId) as Row[]
    ).map(toMessage);
  }

  exchangesBetween(owner: string, from: string, to: string, limit: number): Exchange[] {
    return (
      this.db
        .prepare(`${EXCHANGE_SELECT} AND u.local_date BETWEEN ? AND ? ORDER BY u.created_at DESC LIMIT ?`)
        .all(owner, from, to, limit) as Row[]
    ).map(toExchange);
  }

  exchangesMatching(owner: string, ftsQuery: string, limit: number): Exchange[] {
    const rows = this.db
      .prepare(
        `SELECT m.id, m.role, m.reply_to FROM messages_fts f
         JOIN messages m ON m.rowid = f.rowid
         JOIN threads t ON t.id = m.thread_id
         WHERE messages_fts MATCH ? AND t.owner = ? ORDER BY bm25(messages_fts) LIMIT ?`,
      )
      .all(ftsQuery, owner, limit * 3) as Row[];
    const ids: string[] = [];
    for (const row of rows) {
      const id = row.role === "user" ? String(row.id) : row.reply_to == null ? null : String(row.reply_to);
      if (id && !ids.includes(id)) ids.push(id);
      if (ids.length === limit) break;
    }
    if (ids.length === 0) return [];
    const placeholders = ids.map(() => "?").join(", ");
    const found = (
      this.db.prepare(`${EXCHANGE_SELECT} AND u.id IN (${placeholders})`).all(owner, ...ids) as Row[]
    ).map(toExchange);
    return ids.map((id) => found.find((e) => e.id === id)).filter((e): e is Exchange => e !== undefined);
  }

  historyBounds(owner: string): { first: string | null; count: number } {
    const row = this.db
      .prepare(
        `SELECT MIN(m.local_date) AS first, COUNT(*) AS count FROM messages m
         JOIN threads t ON t.id = m.thread_id WHERE m.role = 'user' AND t.owner = ?`,
      )
      .get(owner) as Row;
    return { first: row.first == null ? null : String(row.first), count: Number(row.count) };
  }

  activeDates(owner: string, limit: number): string[] {
    return (
      this.db
        .prepare(
          `SELECT DISTINCT m.local_date FROM messages m JOIN threads t ON t.id = m.thread_id
           WHERE t.owner = ? ORDER BY m.local_date DESC LIMIT ?`,
        )
        .all(owner, limit) as Row[]
    ).map((row) => String(row.local_date));
  }
}
