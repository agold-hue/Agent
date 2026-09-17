import type { ChatMessage, MessageQuote } from "./llm.js";
import { activeTaskSessions, chatSessionHeadsSince, chatSessionsSince, createSession, latestChatSession, messageText, recentProactiveSessions, type SessionRow, sessionsByIds, taskStart, taskTurns, taskUserText } from "./sessions.js";
import { codeIn, isApprovalReply } from "./policy.js";
import { ASKS, isAsk, isQuickQuestion, STEERS, tierFor } from "./router.js";
import { stampMessage } from "./transcript.js";
import type { Tenant } from "./tenant.js";

export async function currentChatSession(t: Tenant): Promise<SessionRow | undefined> {
  return latestChatSession(t.id, Number(t.settings.chat_session_max_age_hours ?? 12));
}

export async function startChatSession(t: Tenant, firstMessage: string, images?: Array<{ mimeType: string; base64: string }>, reaction?: string, quote?: MessageQuote): Promise<SessionRow> {
  const recap = await recentRecap(t);
  // A thread that opens with a document or photo starts on the strong model.
  const document = !!images?.length || firstMessage.startsWith("(Attached");
  return createSession(t, { channel: "chat", kind: "chat", title: `Chat ${new Date().toISOString().slice(0, 16).replace("T", " ")}`, text: stampMessage(t, firstMessage, "chat"), images, reaction, quote, recap, ...(document ? { tier: "task" as const } : {}) });
}

/**
 * A request that runs alongside the chat as its own session (its own loop, budget and browser). Its
 * request and replies show in the chat like everything else, tagged as a task.
 */
export async function startTaskSession(t: Tenant, text: string, parent: SessionRow | undefined, quote?: MessageQuote, reaction?: string): Promise<SessionRow> {
  const title = text.replace(/^Re: (?:my|your) message "[^\n]*"\n/, "").replace(/\s+/g, " ").trim().slice(0, 120);
  return createSession(t, {
    channel: "chat",
    kind: "task",
    title,
    text: stampMessage(t, text, "chat"),
    quote,
    reaction,
    recap: "(This request runs as its own task alongside the user's chat, which may be busy with something else. Do exactly this task, keep the user posted with tell_user if it takes a while, and end with the result in a few lines; it shows in the chat as a task update.)",
    row: { parent_session_id: parent?.id ?? null },
  });
}

/**
 * A question sent while the thread is busy, answered alongside it at once. A small session of its own
 * on the chat model, with no browser: it reads the thread's progress (what the running task was asked,
 * what it has said, its last steps, what it is waiting for) and the last exchanges of the chat, and
 * answers in a line or two. Its bubbles show in the chat as plain replies, not as a task; the running
 * task is never interrupted and never has to notice the question.
 */
export async function startAsideSession(t: Tenant, text: string, main: SessionRow, quote?: MessageQuote, reaction?: string): Promise<SessionRow> {
  const tasks = await activeTaskSessions(t.id).catch(() => [] as SessionRow[]);
  const brief = progressBrief(main, tasks);
  const title = text.replace(/^Re: (?:my|your) message "[^\n]*"\n/, "").replace(/\s+/g, " ").trim().slice(0, 120);
  return createSession(t, {
    channel: "chat",
    kind: "aside",
    title,
    text: stampMessage(t, text, "chat"),
    quote,
    reaction,
    tier: "chat",
    recap: `(The user sent the message below while their chat is busy with the work listed here. Answer it now, in one or two lines, from this status and what you know; the work itself is being done by those sessions, so do not start on it, do not open the browser, and do not promise to do it. If it asks how something is going, say exactly where it stands from the steps below. If it asks for something new that is not listed, say you noted it and it will be picked up when the current work is done. Your reply shows in the chat as a normal reply.)\n\n${brief}`,
    row: { parent_session_id: main.id },
  });
}

/** At most this many side replies in flight per user; past it the question waits for the thread. */
export const ASIDE_LIMIT = Number(process.env.ASIDE_LIMIT ?? 2);

/**
 * Whether a message typed while the thread is busy should be answered alongside it (a side reply)
 * rather than handed to the running task: a greeting, a thank-you, a status or knowledge question.
 * A reply to a bubble, a code, a yes, a steer and a fresh request are not.
 */
export function wantsSideReply(text: string, quote?: MessageQuote): boolean {
  if (quote || codeIn(text) || isApprovalReply(text)) return false;
  // A steer or an acknowledgement ("no, the Amex", "thanks", "ok") belongs to the running task.
  if (STEERS.test(text.replace(/^\[[^\]]*\]\n/, "").trim())) return false;
  return isQuickQuestion(text) || isAsk(text);
}

/** Maximum parallel tasks per user; past it a new request joins the main thread instead. */
export const PARALLEL_TASKS = Number(process.env.PARALLEL_TASKS ?? 20);

/** "also: book the dentist" / "in parallel, ..." asks for a task of its own; the prefix is dropped. */
export const PARALLEL_PREFIX = /^(?:also|parallel|in parallel|meanwhile|separately|new task)\s*[:,-]\s*/i;

/**
 * Whether a message typed while the thread is busy is a new task to run alongside it, rather than a
 * steer, an answer, or a question about the running one. New tasks read like requests (the task or hard
 * tier), have some length, and do not start like a correction or a question about the current work.
 */
export function isSeparateTask(text: string, quote?: MessageQuote): boolean {
  if (quote || codeIn(text)) return false;
  const t = text.trim();
  if (t.split(/\s+/).length < 3 || STEERS.test(t) || ASKS.test(t)) return false;
  return tierFor(t, "chat") !== "chat";
}

/** Short replies, approvals and codes are answers to whichever question is waiting. */
export function looksLikeAnswer(text: string): boolean {
  return isApprovalReply(text) || !!codeIn(text) || text.trim().split(/\s+/).length <= 8 || tierFor(text, "chat") === "chat";
}

/**
 * What the model reads when the user replies to an earlier bubble: the quoted line first, then the
 * message. One line, so the chat page can strip it again for display (see replyPrefix).
 */
export function withQuote(text: string, quote: MessageQuote | undefined): string {
  if (!quote) return text;
  return `${replyPrefix(quote)}${text}`;
}
export function replyPrefix(quote: MessageQuote): string {
  const excerpt = quote.text.replace(/\s+/g, " ").trim().slice(0, 160);
  return `Re: ${quote.who === "user" ? "my" : "your"} message "${excerpt}"\n`;
}

/** A tool call in the user's words, for a status line ("opened a page", "signed in"). */
const STEP_WORDS: Record<string, string> = {
  browser_open: "opened the browser",
  browser_goto: "opened a page",
  browser_click: "clicked through",
  browser_type: "filled in a form",
  browser_select: "filled in a form",
  browser_press: "filled in a form",
  browser_scroll: "read down the page",
  browser_snapshot: "read the page",
  browser_text: "read the page",
  browser_screenshot: "looked at the page",
  browser_watch: "waited for a reply on the page",
  browser_wait_for: "waited for the page",
  browser_back: "went back a page",
  login: "signed in",
  request_code: "asked you for a code",
  web_search: "searched the web",
  memory_read: "checked notes",
  memory_grep: "checked notes",
  memory_list: "checked notes",
  memory_write: "took notes",
  memory_append: "took notes",
  calendar: "checked the calendar",
  owner_inbox: "read your mail",
  send_email: "wrote an email",
  drive: "checked Drive",
  checkpoint: "asked for your ok",
  ask_user: "asked you a question",
  track_item: "updated a tracked item",
  list_items: "checked what is tracked",
  record_receipt: "filed a receipt",
  record_win: "logged a win",
  escalate_model: "switched to a stronger model",
  start_task: "started a task",
  tell_user: "posted a progress line",
};

/**
 * Where a live session stands, for a side reply: what it was asked, how long it has run, what it has
 * told the user, its last steps in plain words, and what it is waiting for. No URLs, no site names.
 */
export function sessionProgress(row: SessionRow): string {
  const start = taskStart(row.messages);
  const asked = taskUserText(row.messages).replace(/^Re: (?:my|your) message "[^\n]*"\n/, "").replace(/\s+/g, " ").trim().slice(0, 200);
  const first = row.messages[start]?.at ?? row.created_at;
  const mins = Math.max(0, Math.round((Date.now() - new Date(first).getTime()) / 60_000));
  const said: string[] = [];
  const steps: string[] = [];
  let waiting = "";
  for (let i = start; i < row.messages.length; i++) {
    const m = row.messages[i];
    if (m.role !== "assistant") continue;
    if (m.ephemeral && typeof m.content === "string" && m.content.trim()) said.push(m.content.trim().slice(0, 200));
    for (const tc of m.tool_calls ?? []) {
      const words = STEP_WORDS[tc.function.name] ?? "worked on it";
      if (steps[steps.length - 1] !== words) steps.push(words);
      if (row.status === "waiting" && tc.id === row.pending_event_id) {
        let args: Record<string, unknown> = {};
        try {
          args = JSON.parse(tc.function.arguments);
        } catch {
          /* ignore */
        }
        if (tc.function.name === "checkpoint") waiting = `your ok on: ${String(args.summary ?? "").slice(0, 160)}`;
        else if (tc.function.name === "send_email") waiting = `your ok to send an email to ${String(args.to ?? "someone")}`;
        else if (tc.function.name === "request_code") waiting = "a code from your phone";
        else if (tc.function.name === "ask_user") waiting = `your answer to: ${((args.questions as Array<{ question: string }>) ?? []).map((q) => q.question).join(" / ").slice(0, 200)}`;
      }
    }
  }
  const lines = [`- Asked: "${asked || row.title || "a task"}" (${row.kind === "task" ? "a task alongside the chat" : "the chat thread"}, ${row.status === "waiting" ? "waiting on the user" : "running"}, ${mins} min in, ${taskTurns(row.messages)} steps)`];
  if (said.length) lines.push(`  Told the user so far: ${said.slice(-3).map((s) => `"${s}"`).join(" · ")}`);
  if (steps.length) lines.push(`  Last steps: ${steps.slice(-6).join(", ")}`);
  if (waiting) lines.push(`  Waiting for: ${waiting}`);
  return lines.join("\n");
}

/**
 * The task's state as the host can see it, for the context after compaction has dropped turns: the
 * goal, what the user was told, the steps taken, the last tool error. No model call; deterministic.
 */
export function taskStateNote(messages: ChatMessage[]): string | undefined {
  const start = taskStart(messages);
  const goal = taskUserText(messages).replace(/\s+/g, " ").trim().slice(0, 300);
  if (!goal) return undefined;
  const said: string[] = [];
  const steps: string[] = [];
  const calls = new Map<string, string>();
  let lastError = "";
  let lastUrl = "";
  for (let i = start; i < messages.length; i++) {
    const m = messages[i];
    if (m.role === "assistant") {
      if (m.ephemeral && typeof m.content === "string" && m.content.trim()) said.push(m.content.trim().slice(0, 160));
      for (const tc of m.tool_calls ?? []) {
        calls.set(tc.id, tc.function.name);
        const words = STEP_WORDS[tc.function.name] ?? tc.function.name.replace(/_/g, " ");
        if (steps[steps.length - 1] !== words) steps.push(words);
        if (tc.function.name === "browser_goto" || tc.function.name === "browser_open") {
          try {
            lastUrl = String((JSON.parse(tc.function.arguments) as { url?: string }).url ?? lastUrl);
          } catch {
            /* ignore */
          }
        }
      }
    } else if (m.role === "tool" && typeof m.content === "string") {
      if (/^Tool .* failed|needs_user|no_credentials|did not appear|stopped at|error/i.test(m.content.slice(0, 200))) lastError = `${calls.get(m.tool_call_id ?? "") ?? "a step"}: ${m.content.split("\n")[0].slice(0, 160)}`;
      const url = m.content.split("\n").find((l) => /^https?:\/\//.test(l.trim()));
      if (url) lastUrl = url.trim();
    }
  }
  const lines = [`(Task state so far, kept by the host because earlier turns were dropped from context:`, `- Goal: ${goal}`];
  if (steps.length) lines.push(`- Done: ${steps.slice(-12).join(", ")} (${steps.length} kinds of step)`);
  if (said.length) lines.push(`- Told the user: ${said.slice(-3).map((s) => `"${s}"`).join(" · ")}`);
  if (lastUrl) lines.push(`- Last page: ${lastUrl.slice(0, 160)}`);
  if (lastError) lines.push(`- Last problem: ${lastError}`);
  lines.push("Continue from here; do not redo what is done.)");
  return lines.join("\n");
}

/**
 * Threading: an agent bubble carries a quote of the request it answers whenever that request is not
 * the bubble right above it (another task's lines, the user's next message or a side reply came in
 * between), so in a busy chat every reply reads as a reply to something, never as a new thread. The
 * items must already be in display order.
 */
export function threadReplies(items: ChatItem[]): ChatItem[] {
  return items.map((it, i) => {
    if (it.kind !== "agent" || !it.replyTo) return it;
    let j = i - 1;
    // Lines of the same answer (an "on it", a progress line, the reply) sit between the request and this bubble.
    while (j >= 0 && items[j].kind === "agent" && (items[j] as { replyTo?: string }).replyTo === it.replyTo) j--;
    const adjacent = j >= 0 && items[j].id === it.replyTo;
    const { replyTo, replyText, replyQuoted, ...rest } = it;
    // A message the user sent as a reply to a bubble gets its answer as a reply too, always.
    return (adjacent && !replyQuoted) || !replyText ? rest : { ...rest, quote: { id: replyTo, who: "user", text: replyText } };
  }) as ChatItem[];
}

/** "?", "status", "any luck?": a ping that wants one line on where things stand, no model needed. */
export const STATUS_PING = /^(\?+|status\??|update\??|progress\??|eta\??|any (?:luck|update|news|progress)\??|you there\??|still there\??|hello\??|well\??|and\??|so\??)$/i;

/**
 * One human line on where the work stands, written by the host from the thread's own progress:
 * "Still on it: pay the Con Ed bill, 4 min in. Signed in, pulling up the bill now." No model call.
 */
export function statusLine(main: SessionRow, tasks: SessionRow[]): string {
  const live = [main, ...tasks.filter((s) => s.id !== main.id)].filter((s) => s.status === "running" || s.status === "waiting");
  if (!live.length) return "Nothing running right now.";
  const parts = live.slice(0, 3).map((s) => {
    const start = taskStart(s.messages);
    const asked = taskUserText(s.messages).replace(/^Re: (?:my|your) message "[^\n]*"\n/, "").replace(/\s+/g, " ").trim().slice(0, 80);
    const mins = Math.max(1, Math.round((Date.now() - new Date(s.messages[start]?.at ?? s.created_at).getTime()) / 60_000));
    let said = "";
    let step = "";
    let waiting = "";
    for (let i = start; i < s.messages.length; i++) {
      const m = s.messages[i];
      if (m.role !== "assistant") continue;
      if (m.ephemeral && typeof m.content === "string" && m.content.trim()) said = m.content.trim().slice(0, 120);
      for (const tc of m.tool_calls ?? []) {
        step = STEP_WORDS[tc.function.name] ?? step;
        if (s.status === "waiting" && tc.id === s.pending_event_id) waiting = tc.function.name === "request_code" ? "a code from you" : tc.function.name === "ask_user" ? "your answer" : "your ok";
      }
    }
    const where = waiting ? `waiting on ${waiting}` : said ? said.replace(/[.]+$/, "") : step ? `just ${step}` : "getting started";
    return `${s === main ? "Still on" : "Alongside,"} "${asked}" (${mins} min): ${where}.`;
  });
  return parts.join(" ");
}

/** What is going on right now across the chat thread and its parallel tasks, plus the last exchanges. */
export function progressBrief(main: SessionRow, tasks: SessionRow[]): string {
  const live = [main, ...tasks.filter((s) => s.id !== main.id)].filter((s) => s.status === "running" || s.status === "waiting");
  const parts: string[] = [];
  if (live.length) parts.push(`# In progress right now\n${live.map(sessionProgress).join("\n")}`);
  const recent: string[] = [];
  for (const m of main.messages) {
    if (m.role === "user" && !m.ephemeral && typeof m.content === "string" && m.content.startsWith("[")) recent.push(`User: ${m.content.replace(/^\[[^\]]+\]\n/, "").replace(/\s+/g, " ").slice(0, 300)}`);
    else if (m.role === "assistant" && typeof m.content === "string" && m.content.trim() && !m.tool_calls?.length) recent.push(`You: ${m.content.trim().replace(/\s+/g, " ").slice(0, 400)}`);
  }
  if (recent.length) parts.push(`# The chat so far (newest last)\n${recent.slice(-10).join("\n")}`);
  return parts.join("\n\n").slice(0, 6000);
}

/**
 * The last exchanges of the previous chat session, so a session that rolled over (step or spend
 * limit, error) continues the conversation instead of starting blank. Hidden from the chat page.
 */
async function recentRecap(t: Tenant): Promise<string | undefined> {
  const previous = (await chatSessionsSince(t.id, new Date(Date.now() - 24 * 3_600_000), 3)).pop();
  if (!previous) return undefined;
  const lines: string[] = [];
  for (const m of previous.messages) {
    if (m.ephemeral) continue; // the "on it" ack and progress lines are not part of the record
    if (m.role === "user" && typeof m.content === "string" && !m.content.startsWith("(")) lines.push(`User: ${m.content.replace(/^\[[^\]]+\]\n/, "").slice(0, 400)}`);
    else if (m.role === "assistant" && typeof m.content === "string" && m.content.trim() && !m.tool_calls?.length) lines.push(`You: ${m.content.trim().slice(0, 600)}`);
  }
  if (!lines.length) return undefined;
  return `(Earlier in this chat, before this task started. Continue naturally; do not repeat it. Anything the browser was in the middle of is gone; start that over if it is still wanted.)\n${lines.slice(-12).join("\n")}`;
}

export type ChatItem =
  | { kind: "user"; id: string; text: string; at: string; approx?: boolean; reaction?: string; quote?: MessageQuote; task?: string }
  | { kind: "agent"; id: string; text: string; at: string; approx?: boolean; notice?: string; task?: string; quote?: MessageQuote; replyTo?: string; replyText?: string; replyQuoted?: boolean }
  | { kind: "tool"; id: string; name: string; input: Record<string, unknown>; at: string; resolved: boolean; preview?: string }
  | { kind: "status"; id: string; status: "running" | "idle" | "waiting" | "terminated" | "error"; at: string };

/** Turn the session's message array into what the chat page renders. */
export function toChatItems(row: SessionRow): ChatItem[] {
  const items: ChatItem[] = [];
  const answered = new Set(row.messages.filter((m) => m.role === "tool").map((m) => m.tool_call_id));
  // Times never go backwards down the list: a message from before timestamps were recorded takes
  // the time of the one before it (the thread's start for the first), and a stamped one that is
  // earlier than its predecessor is clamped. The history endpoint sorts bubbles by time, and a list
  // that is not monotonic here would be reordered there: after timestamps were introduced, old
  // bubbles fell back to the thread's last-update time, sorted below every new message, and a
  // freshly typed line landed in the middle of the page, "invisible".
  let last = new Date(row.created_at).toISOString();
  const task = row.kind === "task" ? { task: (row.title ?? "task").slice(0, 60) } : {};
  // The request each agent line answers, for threading (see threadReplies).
  let reply: { replyTo: string; replyText: string; replyQuoted: boolean } | undefined;
  row.messages.forEach((m: ChatMessage, i) => {
    const at = m.at && m.at > last ? m.at : last;
    last = at;
    // A bubble with no recorded time is placed, not timed: the page shows no clock on it.
    const approx = m.at ? {} : { approx: true };
    if (m.role === "user") {
      const raw = messageText(m);
      // Host notes (nudges, recaps, screenshots, model switches) are never stamped; everything the user sent is.
      if (raw.startsWith("(")) return;
      let text = raw.replace(/^\[[^\]]+\]\n/, "");
      if (m.quote && text.startsWith(replyPrefix(m.quote))) text = text.slice(replyPrefix(m.quote).length);
      // An attachment shows as its name, not as the host's note and the extracted contents.
      const file = text.match(/^\(Attached (?:file|photo):?\s+(.+?)(?:[;,)]|\):)/);
      if (file) text = `📎 ${file[1].trim()}`;
      else if (text.startsWith("(voice note) ")) text = `🎤 ${text.slice("(voice note) ".length)}`;
      items.push({ kind: "user", id: `${row.id}-${i}`, text, at, ...approx, reaction: m.reaction, ...(m.quote ? { quote: m.quote } : {}), ...task });
      // A steer typed mid-task ("no, the Amex") is not what the task's report answers; the request is.
      const next = row.messages[i + 1];
      const steer = next?.role === "user" && messageText(next).startsWith("(That message arrived while you are mid-task");
      if (!steer || !reply) reply = { replyTo: `${row.id}-${i}`, replyText: text.replace(/\s+/g, " ").slice(0, 160), replyQuoted: !!m.quote };
    } else if (m.role === "assistant") {
      const text = typeof m.content === "string" ? m.content.trim() : "";
      // A draft the host sent back to the model (an offer instead of an answer, an unverified figure) is not a bubble.
      if (text && !m.tool_calls?.length && !m.superseded) items.push({ kind: "agent", id: `${row.id}-${i}`, text, at, ...approx, ...task, ...(reply ?? {}) });
      for (const tc of m.tool_calls ?? []) {
        if (!["checkpoint", "ask_user", "send_email", "request_code"].includes(tc.function.name)) continue;
        let input: Record<string, unknown> = {};
        try {
          input = JSON.parse(tc.function.arguments);
        } catch {
          /* ignore */
        }
        // The id carries the session, so a reply to this card is routed back to it.
        const preview = m.previews?.[tc.id] ? `/api/receipts?image=${encodeURIComponent(m.previews[tc.id])}` : undefined;
        items.push({ kind: "tool", id: `${row.id}-${i}t${tc.id.replace(/[^\w-]/g, "")}`, name: tc.function.name, input, at, resolved: answered.has(tc.id), ...(preview ? { preview } : {}) });
      }
    }
  });
  items.push({ kind: "status", id: `${row.id}-status`, status: row.status, at: last });
  return items;
}

/** What the agent is doing right now, for the typing line, from the last tool it called. */
/** The parallel tasks still going, for the page's strip. */
export async function taskStrip(t: Tenant): Promise<Array<{ id: string; title: string; status: string; activity: string | null }>> {
  const tasks = await activeTaskSessions(t.id).catch(() => [] as SessionRow[]);
  return tasks.map((s) => ({ id: s.id, title: (s.title ?? "task").slice(0, 80), status: s.status, activity: s.status === "waiting" ? "waiting for you" : activityOf(s) }));
}

export function activityOf(row: SessionRow | undefined): string | null {
  if (!row || row.status !== "running") return null;
  for (let i = row.messages.length - 1; i >= 0; i--) {
    const m = row.messages[i];
    if (m.role !== "assistant" || !m.tool_calls?.length) continue;
    const tc = m.tool_calls[m.tool_calls.length - 1];
    let args: Record<string, unknown> = {};
    try {
      args = JSON.parse(tc.function.arguments);
    } catch {
      /* ignore */
    }
    // Never name the site or reveal a URL in the status line; keep it to what Pete is doing.
    switch (tc.function.name) {
      case "browser_open":
      case "browser_goto":
        return "Looking that up…";
      case "login":
        return "Signing you in…";
      case "web_search":
        return "Searching…";
      case "browser_watch":
      case "browser_wait_for":
        return "Waiting on the page…";
      case "browser_screenshot":
        return "Reading the page…";
      case "memory_read":
      case "memory_grep":
      case "memory_list":
        return "Checking my notes…";
      case "memory_write":
      case "memory_append":
        return "Taking notes…";
      case "calendar":
        return "Checking the calendar…";
      case "owner_inbox":
        return "Reading your mail…";
      case "send_email":
        return "Writing an email…";
      case "browser_fill_form":
        return "Filling in the form…";
      case "browser_click_text":
      case "browser_click":
        return "Working through the page…";
      case "browser_find":
        return "Looking for it on the page…";
      case "browser_download":
        return "Downloading it…";
      case "browser_upload":
        return "Attaching the file…";
      case "browser_pdf":
      case "make_pdf":
        return "Writing the document…";
      case "fill_pdf":
      case "read_pdf_fields":
        return "Filling in the PDF…";
      case "solve_captcha":
        return "Getting past a bot check…";
      case "record_lesson":
        return "Noting that for next time…";
      case "escalate_model":
        return "Bringing in a stronger model…";
      case "tell_user":
        return "Typing…";
      default:
        return "Working…";
    }
  }
  return "Thinking…";
}

/** Heads-ups from sessions the agent started on its own, so they show in chat as well as email. */
export async function recentNotices(t: Tenant, limit = 10): Promise<ChatItem[]> {
  const out: ChatItem[] = [];
  for (const s of await recentProactiveSessions(t.id, limit)) {
    const report = (s.last_report ?? "").trim();
    if (!report || /^NO_REPORT\b/.test(report)) continue;
    const label = s.kind === "review" ? "Morning brief" : s.kind === "weekly" ? "Week ahead" : s.kind === "digest" ? "Heads-ups" : s.kind === "followup" ? "Follow-up" : s.kind === "triage" ? "From your mail" : s.kind === "inbox" ? "Inbox" : s.correspondent ? `Reply from ${s.correspondent}` : "Heads-up";
    out.push({ kind: "agent", id: `notice-${s.id}`, text: report, at: new Date(s.updated_at).toISOString(), notice: label });
  }
  return out;
}

/**
 * The whole conversation for the page: every chat session and parallel task in the window, oldest
 * first. Only the current thread carries a status; tool cards (approvals, questions, code requests)
 * show for the current thread and for tasks still going, so a task can ask the user something.
 */
/**
 * Rendered timelines per session, keyed on the row state they were rendered from. A poll or a
 * stream tick re-reads only the sessions that changed since the last rendering in this worker (one
 * session while a reply is being written), not a week of message arrays every time.
 */
const rendered = new Map<string, { key: string; items: ChatItem[] }>();
const RENDER_CACHE_MAX = Number(process.env.HISTORY_RENDER_CACHE ?? 400);
const renderKey = (s: { updated_at: Date; status: string; pending_kind: string | null }) => `${new Date(s.updated_at).toISOString()}:${s.status}:${s.pending_kind ?? ""}`;

export async function chatHistory(t: Tenant, current: SessionRow | undefined, days = 30): Promise<ChatItem[]> {
  const heads = await chatSessionHeadsSince(t.id, new Date(Date.now() - days * 86_400_000), Number(process.env.HISTORY_SESSIONS ?? 60), { tasks: true });
  const stale = heads.filter((h) => rendered.get(h.id)?.key !== renderKey(h));
  for (const row of await sessionsByIds(stale.map((h) => h.id))) {
    rendered.delete(row.id);
    rendered.set(row.id, { key: renderKey(row), items: toChatItems(row) });
  }
  while (rendered.size > RENDER_CACHE_MAX) rendered.delete(rendered.keys().next().value!);
  const out: ChatItem[] = [];
  for (const head of heads) {
    const items = rendered.get(head.id)?.items ?? [];
    const live = (current && head.id === current.id) || (head.kind === "task" && (head.status === "running" || head.status === "waiting"));
    out.push(...(current && head.id === current.id ? items : items.filter((i) => i.kind !== "status" && (live || i.kind !== "tool"))));
  }
  if (current && !heads.some((r) => r.id === current.id)) out.push(...toChatItems(current));
  return out;
}
