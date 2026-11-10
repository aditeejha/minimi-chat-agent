import { marked } from "/vendor/marked.js";
import DOMPurify from "/vendor/purify.js";

const $ = (id) => document.getElementById(id);
const els = {
  sidebar: $("sidebar"),
  threads: $("threads"),
  newChat: $("new-chat"),
  menu: $("menu"),
  title: $("thread-title"),
  remove: $("delete-thread"),
  banner: $("banner"),
  messages: $("messages"),
  empty: $("empty"),
  form: $("composer"),
  input: $("input"),
  send: $("send"),
  stop: $("stop"),
  clockInput: $("clock-input"),
  clockClear: $("clock-clear"),
  clockBadge: $("clock-badge"),
};

const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
const state = { threadId: null, threads: [], controller: null };

marked.use({ gfm: true, breaks: false });

function storageGet(key) {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function storageSet(key, value) {
  try {
    if (value == null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    // storage unavailable: the setting just won't persist
  }
}

function simulatedTime() {
  const value = els.clockInput.value;
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function syncClock() {
  const on = Boolean(simulatedTime());
  els.clockBadge.hidden = !on;
  storageSet("simulated-time", els.clockInput.value || null);
}

function formatStamp(iso) {
  const date = new Date(iso);
  return date.toLocaleString(undefined, {
    weekday: "short",
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function dayLabel(iso) {
  const date = new Date(iso);
  const today = new Date();
  const yesterday = new Date();
  yesterday.setDate(today.getDate() - 1);
  if (date.toDateString() === today.toDateString()) return "Today";
  if (date.toDateString() === yesterday.toDateString()) return "Yesterday";
  return date.toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" });
}

function showBanner(text, isError = false) {
  els.banner.hidden = !text;
  els.banner.textContent = text || "";
  els.banner.classList.toggle("error", isError);
}

function linkCitations(root, sources) {
  const byNumber = new Map(sources.map((s) => [s.n, s]));
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: (node) =>
      node.parentElement?.closest("code, pre, a") ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT,
  });
  const nodes = [];
  while (walker.nextNode()) nodes.push(walker.currentNode);
  for (const node of nodes) {
    const text = node.nodeValue;
    const pattern = /\[(\d{1,3}(?:\s*,\s*\d{1,3})*)\]/g;
    if (!pattern.test(text)) continue;
    pattern.lastIndex = 0;
    const fragment = document.createDocumentFragment();
    let last = 0;
    for (const match of text.matchAll(pattern)) {
      fragment.append(text.slice(last, match.index));
      for (const part of match[1].split(",")) {
        const n = Number(part.trim());
        const source = byNumber.get(n);
        if (source) {
          const a = document.createElement("a");
          a.className = "cite";
          a.href = source.url;
          a.target = "_blank";
          a.rel = "noopener noreferrer";
          a.title = `${source.title} (${source.domain})`;
          a.textContent = String(n);
          fragment.append(a);
        } else {
          fragment.append(`[${n}]`);
        }
      }
      last = match.index + match[0].length;
    }
    fragment.append(text.slice(last));
    node.replaceWith(fragment);
  }
}

function renderMarkdown(target, text, sources) {
  target.innerHTML = DOMPurify.sanitize(marked.parse(text));
  for (const a of target.querySelectorAll("a[href]")) {
    a.target = "_blank";
    a.rel = "noopener noreferrer";
  }
  linkCitations(target, sources);
}

function scrollToEnd(force = false) {
  const box = els.messages;
  const nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 160;
  if (force || nearBottom) box.scrollTop = box.scrollHeight;
}

function addUserMessage(content, createdAt) {
  els.empty.hidden = true;
  const wrap = document.createElement("div");
  wrap.className = "msg user";
  const body = document.createElement("div");
  body.className = "body";
  body.textContent = content;
  const stamp = document.createElement("div");
  stamp.className = "stamp";
  stamp.textContent = formatStamp(createdAt);
  wrap.append(body, stamp);
  els.messages.append(wrap);
  scrollToEnd(true);
}

function metaLine(meta, sources) {
  const parts = [];
  const timings = meta?.timings;
  if (timings?.totalMs) parts.push(`${(timings.totalMs / 1000).toFixed(1)}s`);
  if (timings?.firstTokenMs) parts.push(`first words at ${(timings.firstTokenMs / 1000).toFixed(1)}s`);
  const plan = meta?.plan;
  const searches = (plan?.searches?.length ?? 0) + (plan?.rereadUrls?.length ?? 0);
  if (searches > 0) parts.push(`${searches} lookup${searches === 1 ? "" : "s"}`);
  if (plan?.followUpSearchRounds) parts.push(`${plan.followUpSearchRounds} follow-up search round${plan.followUpSearchRounds === 1 ? "" : "s"}`);
  if (sources.length > 0) parts.push(`${sources.length} source${sources.length === 1 ? "" : "s"} read`);
  const recalled = plan?.recalled?.length ?? 0;
  if (recalled > 0) parts.push(`recalled ${recalled} earlier exchange${recalled === 1 ? "" : "s"}`);
  if (meta?.interrupted) parts.push(`interrupted: ${meta.interrupted}`);
  return parts.join(" · ");
}

function renderSources(container, sources, cited) {
  container.replaceChildren();
  if (sources.length === 0) return;
  const citedSet = new Set(cited ?? []);
  const ordered = [...sources].sort((a, b) => Number(citedSet.has(b.n)) - Number(citedSet.has(a.n)) || a.n - b.n);
  const details = document.createElement("details");
  details.className = "sources";
  const summary = document.createElement("summary");
  const usedCount = sources.filter((s) => citedSet.has(s.n)).length;
  summary.textContent = cited ? `Sources: ${usedCount} cited, ${sources.length} read` : `${sources.length} sources`;
  const list = document.createElement("ol");
  for (const s of ordered) {
    const li = document.createElement("li");
    if (cited && !citedSet.has(s.n)) li.className = "uncited";
    const n = document.createElement("span");
    n.className = "n";
    n.textContent = `[${s.n}]`;
    const info = document.createElement("span");
    const a = document.createElement("a");
    a.href = s.url;
    a.target = "_blank";
    a.rel = "noopener noreferrer";
    a.textContent = s.title;
    const domain = document.createElement("span");
    domain.className = "domain";
    domain.textContent = ` · ${s.domain}${s.published ? ` · ${s.published}` : ""}`;
    info.append(a, domain);
    li.append(n, info);
    list.append(li);
  }
  details.append(summary, list);
  container.append(details);
}

function createAssistantView() {
  els.empty.hidden = true;
  const wrap = document.createElement("div");
  wrap.className = "msg assistant";
  const status = document.createElement("div");
  status.className = "status";
  status.innerHTML = '<span class="dot"></span><span class="label">Thinking</span>';
  const detail = document.createElement("ul");
  detail.className = "status-detail";
  const body = document.createElement("div");
  body.className = "body";
  const sources = document.createElement("div");
  const meta = document.createElement("div");
  meta.className = "meta";
  wrap.append(status, detail, body, sources, meta);
  els.messages.append(wrap);
  scrollToEnd(true);

  let text = "";
  let sourceList = [];
  let frame = 0;
  const paint = () => {
    frame = 0;
    renderMarkdown(body, text, sourceList);
    scrollToEnd();
  };

  return {
    status(label, items) {
      status.hidden = false;
      status.querySelector(".label").textContent = label;
      detail.replaceChildren(
        ...(items ?? []).map((item) => {
          const li = document.createElement("li");
          li.textContent = item;
          return li;
        }),
      );
    },
    sources(list) {
      sourceList = list;
      renderSources(sources, list, null);
    },
    delta(chunk) {
      if (!text) {
        status.hidden = true;
        detail.replaceChildren();
      }
      text += chunk;
      if (!frame) frame = requestAnimationFrame(paint);
    },
    finish(message) {
      if (frame) cancelAnimationFrame(frame);
      status.hidden = true;
      detail.replaceChildren();
      text = message.content;
      sourceList = message.sources;
      renderMarkdown(body, text, sourceList);
      renderSources(sources, message.sources, message.meta?.cited ?? []);
      meta.textContent = metaLine(message.meta, message.sources);
      scrollToEnd();
    },
    fail(errorText) {
      if (frame) cancelAnimationFrame(frame);
      status.hidden = true;
      detail.replaceChildren();
      if (text) renderMarkdown(body, text, sourceList);
      const p = document.createElement("p");
      p.className = "error-text";
      p.textContent = errorText;
      meta.replaceChildren(p);
    },
  };
}

function renderThreads() {
  els.threads.replaceChildren();
  let lastDay = null;
  for (const thread of state.threads) {
    const day = dayLabel(thread.updatedAt);
    if (day !== lastDay) {
      const heading = document.createElement("div");
      heading.className = "day";
      heading.textContent = day;
      els.threads.append(heading);
      lastDay = day;
    }
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = thread.title;
    button.title = thread.title;
    if (thread.id === state.threadId) button.classList.add("active");
    button.addEventListener("click", () => {
      openThread(thread.id);
      els.sidebar.classList.remove("open");
    });
    els.threads.append(button);
  }
}

async function loadThreads() {
  const response = await fetch("/api/threads");
  state.threads = response.ok ? await response.json() : [];
  renderThreads();
}

function resetView() {
  for (const node of [...els.messages.children]) if (node !== els.empty) node.remove();
  els.empty.hidden = false;
}

function newChat() {
  if (state.controller) return;
  state.threadId = null;
  history.replaceState(null, "", "/");
  els.title.textContent = "New chat";
  els.remove.hidden = true;
  resetView();
  renderThreads();
  els.input.focus();
}

async function openThread(id) {
  if (state.controller) return;
  const response = await fetch(`/api/threads/${encodeURIComponent(id)}/messages`);
  if (!response.ok) {
    newChat();
    return;
  }
  const data = await response.json();
  state.threadId = data.thread.id;
  history.replaceState(null, "", `#${data.thread.id}`);
  els.title.textContent = data.thread.title;
  els.remove.hidden = false;
  resetView();
  for (const message of data.messages) {
    if (message.role === "user") addUserMessage(message.content, message.createdAt);
    else createAssistantView().finish(message);
  }
  renderThreads();
  scrollToEnd(true);
}

async function* readEvents(response) {
  const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += value;
    let boundary;
    while ((boundary = buffer.indexOf("\n\n")) !== -1) {
      const chunk = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      const data = chunk
        .split("\n")
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trimStart())
        .join("\n");
      if (data) yield JSON.parse(data);
    }
  }
}

function setBusy(busy) {
  els.send.hidden = busy;
  els.stop.hidden = !busy;
  els.input.disabled = busy;
  els.newChat.disabled = busy;
}

async function send(text) {
  if (state.controller || !text.trim()) return;
  showBanner("");
  const asOf = simulatedTime();
  addUserMessage(text, asOf ?? new Date().toISOString());
  const view = createAssistantView();
  const controller = new AbortController();
  state.controller = controller;
  setBusy(true);

  try {
    const response = await fetch("/api/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ threadId: state.threadId, message: text, timeZone, asOf }),
      signal: controller.signal,
    });
    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      view.fail(body.error ?? `Request failed (${response.status})`);
      return;
    }
    for await (const event of readEvents(response)) {
      if (event.type === "thread") {
        state.threadId = event.thread.id;
        els.title.textContent = event.thread.title;
        els.remove.hidden = false;
        history.replaceState(null, "", `#${event.thread.id}`);
      } else if (event.type === "status") {
        view.status(event.text, event.detail);
      } else if (event.type === "sources") {
        view.sources(event.sources);
      } else if (event.type === "delta") {
        view.delta(event.text);
      } else if (event.type === "done") {
        view.finish(event.message);
      } else if (event.type === "error") {
        view.fail(event.message);
      }
    }
  } catch (error) {
    if (controller.signal.aborted) view.fail("Stopped.");
    else view.fail(`Connection lost: ${error.message}`);
  } finally {
    state.controller = null;
    setBusy(false);
    els.input.focus();
    loadThreads();
  }
}

function autosize() {
  els.input.style.height = "auto";
  els.input.style.height = `${Math.min(els.input.scrollHeight, 200)}px`;
}

els.form.addEventListener("submit", (event) => {
  event.preventDefault();
  const text = els.input.value;
  els.input.value = "";
  autosize();
  send(text);
});

els.input.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    els.form.requestSubmit();
  }
});

els.input.addEventListener("input", autosize);
els.stop.addEventListener("click", () => state.controller?.abort());
els.newChat.addEventListener("click", newChat);
els.menu.addEventListener("click", () => els.sidebar.classList.toggle("open"));

els.remove.addEventListener("click", async () => {
  if (!state.threadId || state.controller) return;
  if (!confirm("Delete this conversation? I will also forget it.")) return;
  await fetch(`/api/threads/${encodeURIComponent(state.threadId)}`, { method: "DELETE" });
  newChat();
  loadThreads();
});

for (const button of document.querySelectorAll(".suggestions button")) {
  button.addEventListener("click", () => send(button.textContent));
}

window.addEventListener("hashchange", () => {
  const id = location.hash.slice(1);
  if (id && id !== state.threadId) openThread(id);
  else if (!id && state.threadId) newChat();
});

els.clockInput.addEventListener("change", syncClock);
els.clockClear.addEventListener("click", () => {
  els.clockInput.value = "";
  syncClock();
});

async function boot() {
  els.clockInput.value = storageGet("simulated-time") ?? "";
  syncClock();
  const health = await fetch("/api/health")
    .then((r) => r.json())
    .catch(() => null);
  if (health?.missing?.length) {
    showBanner(`Missing ${health.missing.join(" and ")}. Add them to .env and restart npm run dev.`, true);
  }
  await loadThreads();
  const fromHash = location.hash.slice(1);
  if (fromHash) await openThread(fromHash);
  els.input.focus();
}

boot();
