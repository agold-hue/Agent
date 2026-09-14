import type { ChatMessage } from "./llm.js";
import { createSession, latestChatSession, recentProactiveSessions, type SessionRow } from "./sessions.js";
import { stampMessage } from "./transcript.js";
import type { Tenant } from "./tenant.js";

export async function currentChatSession(t: Tenant): Promise<SessionRow | undefined> {
  return latestChatSession(t.id, Number(t.settings.chat_session_max_age_hours ?? 12));
}

export async function startChatSession(t: Tenant, firstMessage: string, images?: Array<{ mimeType: string; base64: string }>): Promise<SessionRow> {
  return createSession(t, { channel: "chat", kind: "chat", title: `Chat ${new Date().toISOString().slice(0, 16).replace("T", " ")}`, text: stampMessage(t, firstMessage, "chat"), images });
}

export type ChatItem =
  | { kind: "user"; id: string; text: string; at: string }
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
      if (text.startsWith("(You are now running") || text === "(screenshot)") return;
      items.push({ kind: "user", id: `${row.id}-${i}`, text, at });
    } else if (m.role === "assistant") {
      const text = typeof m.content === "string" ? m.content.trim() : "";
      if (text && !m.tool_calls?.length) items.push({ kind: "agent", id: `${row.id}-${i}`, text, at });
      for (const tc of m.tool_calls ?? []) {
        if (!["checkpoint", "ask_user", "send_email"].includes(tc.function.name)) continue;
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
