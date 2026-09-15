import type { ChatMessage } from "./llm.js";
import { chatSessionsSince, createSession, latestChatSession, recentProactiveSessions, type SessionRow } from "./sessions.js";
import { stampMessage } from "./transcript.js";
import type { Tenant } from "./tenant.js";

export async function currentChatSession(t: Tenant): Promise<SessionRow | undefined> {
  return latestChatSession(t.id, Number(t.settings.chat_session_max_age_hours ?? 12));
}

export async function startChatSession(t: Tenant, firstMessage: string, images?: Array<{ mimeType: string; base64: string }>, reaction?: string): Promise<SessionRow> {
  const recap = await recentRecap(t);
  return createSession(t, { channel: "chat", kind: "chat", title: `Chat ${new Date().toISOString().slice(0, 16).replace("T", " ")}`, text: stampMessage(t, firstMessage, "chat"), images, reaction, recap });
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
    if (m.role === "user" && typeof m.content === "string" && !m.content.startsWith("(")) lines.push(`User: ${m.content.replace(/^\[[^\]]+\]\n/, "").slice(0, 400)}`);
    else if (m.role === "assistant" && typeof m.content === "string" && m.content.trim() && !m.tool_calls?.length) lines.push(`You: ${m.content.trim().slice(0, 400)}`);
  }
  if (!lines.length) return undefined;
  return `(Earlier in this chat, before this task started. Continue naturally; do not repeat it.)\n${lines.slice(-8).join("\n")}`;
}

export type ChatItem =
  | { kind: "user"; id: string; text: string; at: string; reaction?: string }
  | { kind: "agent"; id: string; text: string; at: string; notice?: string }
  | { kind: "tool"; id: string; name: string; input: Record<string, unknown>; at: string; resolved: boolean }
  | { kind: "status"; id: string; status: "running" | "idle" | "waiting" | "terminated" | "error"; at: string };

/** Turn the session's message array into what the chat page renders. */
export function toChatItems(row: SessionRow): ChatItem[] {
  const items: ChatItem[] = [];
  const answered = new Set(row.messages.filter((m) => m.role === "tool").map((m) => m.tool_call_id));
  const at = new Date(row.updated_at).toISOString();
  row.messages.forEach((m: ChatMessage, i) => {
    if (m.role === "user") {
      const text = (typeof m.content === "string" ? m.content : (m.content ?? []).map((p) => (p.type === "text" ? p.text : "")).join("\n")).replace(/^\[[^\]]+\]\n/, "");
      if (text.startsWith("(You are now running") || text.startsWith("(Earlier in this chat") || text === "(screenshot)") return;
      items.push({ kind: "user", id: `${row.id}-${i}`, text, at, reaction: m.reaction });
    } else if (m.role === "assistant") {
      const text = typeof m.content === "string" ? m.content.trim() : "";
      if (text && !m.tool_calls?.length) items.push({ kind: "agent", id: `${row.id}-${i}`, text, at });
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
  items.push({ kind: "status", id: `${row.id}-status`, status: row.status, at });
  return items;
}

/** What the agent is doing right now, for the typing line, from the last tool it called. */
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
    const host = (u: unknown) => {
      try {
        return new URL(String(u)).hostname.replace(/^www\./, "");
      } catch {
        return "";
      }
    };
    switch (tc.function.name) {
      case "browser_open":
      case "browser_goto":
        return host(args.url) ? `Opening ${host(args.url)}…` : "Opening the browser…";
      case "login":
        return `Signing in to ${args.domain ?? "the site"}…`;
      case "web_search":
        return "Searching the web…";
      case "browser_watch":
        return "Waiting for a reply on the site…";
      case "browser_screenshot":
        return "Looking at the page…";
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
      default:
        return tc.function.name.startsWith("browser_") ? "Working on the site…" : "Working…";
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

/** The whole conversation for the page: every chat session in the window, oldest first; only the current one carries a status. */
export async function chatHistory(t: Tenant, current: SessionRow | undefined, days = 30): Promise<ChatItem[]> {
  const rows = await chatSessionsSince(t.id, new Date(Date.now() - days * 86_400_000));
  const out: ChatItem[] = [];
  for (const row of rows) {
    const items = toChatItems(row);
    out.push(...(current && row.id === current.id ? items : items.filter((i) => i.kind !== "status" && i.kind !== "tool")));
  }
  if (current && !rows.some((r) => r.id === current.id)) out.push(...toChatItems(current));
  return out;
}
