import type { ChatMessage, MessageQuote } from "./llm.js";
import { activeTaskSessions, chatSessionsSince, createSession, latestChatSession, messageText, recentProactiveSessions, type SessionRow } from "./sessions.js";
import { codeIn, isApprovalReply } from "./policy.js";
import { tierFor } from "./router.js";
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

/** Maximum parallel tasks per user; past it a new request joins the main thread instead. */
export const PARALLEL_TASKS = Number(process.env.PARALLEL_TASKS ?? 3);

/** "also: book the dentist" / "in parallel, ..." asks for a task of its own; the prefix is dropped. */
export const PARALLEL_PREFIX = /^(?:also|parallel|in parallel|meanwhile|separately|new task)\s*[:,-]\s*/i;
/** A message that steers the running task rather than starting another. */
const STEERS = /^(no|nope|wait|stop|hold on|actually|instead|never ?mind|forget it|use|try|don'?t|not that|also for|and|but|ok|okay|yes|yep|sure|go|do it|go ahead|fine|thanks|hmm+|(what|why|how|where|when)\s+(did|didn'?t|do|does|is it|are you|was|were|about|come|far|long|happened|can'?t|couldn'?t)|what'?s\s+(the\s+)?(status|going on|happening|taking)|is it|did you|are you|any (luck|update|news)|status|update\??$)\b/i;

/**
 * Whether a message typed while the thread is busy is a new task to run alongside it, rather than a
 * steer, an answer, or a remark about the running one. New tasks read like requests (the task or hard
 * tier), have some length, and do not start like a correction or a question about the current work.
 */
export function isSeparateTask(text: string, quote?: MessageQuote): boolean {
  if (quote || codeIn(text)) return false;
  const t = text.trim();
  if (t.split(/\s+/).length < 3 || STEERS.test(t)) return false;
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
  | { kind: "agent"; id: string; text: string; at: string; approx?: boolean; notice?: string; task?: string }
  | { kind: "tool"; id: string; name: string; input: Record<string, unknown>; at: string; resolved: boolean }
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
    } else if (m.role === "assistant") {
      const text = typeof m.content === "string" ? m.content.trim() : "";
      if (text && !m.tool_calls?.length) items.push({ kind: "agent", id: `${row.id}-${i}`, text, at, ...approx, ...task });
      for (const tc of m.tool_calls ?? []) {
        if (!["checkpoint", "ask_user", "send_email", "request_code"].includes(tc.function.name)) continue;
        let input: Record<string, unknown> = {};
        try {
          input = JSON.parse(tc.function.arguments);
        } catch {
          /* ignore */
        }
        items.push({ kind: "tool", id: tc.id, name: tc.function.name, input, at, resolved: answered.has(tc.id) });
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
    const label = s.kind === "review" ? "Morning brief" : s.kind === "weekly" ? "Week ahead" : s.kind === "digest" ? "Heads-ups" : s.kind === "followup" ? "Follow-up" : s.kind === "triage" ? "From your mail" : s.correspondent ? `Reply from ${s.correspondent}` : "Heads-up";
    out.push({ kind: "agent", id: `notice-${s.id}`, text: report, at: new Date(s.updated_at).toISOString(), notice: label });
  }
  return out;
}

/**
 * The whole conversation for the page: every chat session and parallel task in the window, oldest
 * first. Only the current thread carries a status; tool cards (approvals, questions, code requests)
 * show for the current thread and for tasks still going, so a task can ask the user something.
 */
export async function chatHistory(t: Tenant, current: SessionRow | undefined, days = 30): Promise<ChatItem[]> {
  const rows = await chatSessionsSince(t.id, new Date(Date.now() - days * 86_400_000), 200, { tasks: true });
  const out: ChatItem[] = [];
  for (const row of rows) {
    const items = toChatItems(row);
    const live = (current && row.id === current.id) || (row.kind === "task" && (row.status === "running" || row.status === "waiting"));
    out.push(...(current && row.id === current.id ? items : items.filter((i) => i.kind !== "status" && (live || i.kind !== "tool"))));
  }
  if (current && !rows.some((r) => r.id === current.id)) out.push(...toChatItems(current));
  return out;
}
