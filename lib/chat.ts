import { createSession, latestAgentReport, listAllEvents, type SessionEvent } from "./anthropic.js";
import { latestChatSession, recentProactiveSessions, type SessionRow } from "./sessions.js";
import { stampMessage } from "./transcript.js";
import type { Tenant } from "./tenant.js";

export async function currentChatSession(t: Tenant): Promise<SessionRow | undefined> {
  return latestChatSession(t.id, Number(t.settings.chat_session_max_age_hours ?? 12));
}

export async function startChatSession(t: Tenant, firstMessage: string): Promise<SessionRow> {
  return createSession(t, {
    channel: "chat",
    kind: "chat",
    title: `Chat ${new Date().toISOString().slice(0, 16).replace("T", " ")}`,
    text: stampMessage(t, firstMessage, "chat"),
  });
}

export type ChatItem =
  | { kind: "user"; id: string; text: string; at: string }
  | { kind: "agent"; id: string; text: string; at: string; notice?: string }
  | { kind: "tool"; id: string; name: string; input: Record<string, unknown>; at: string; resolved: boolean }
  | { kind: "status"; id: string; status: "running" | "idle" | "terminated"; stop?: string; at: string };

export function toChatItems(events: SessionEvent[]): ChatItem[] {
  const answered = new Set(events.filter((e) => e.type === "user.custom_tool_result").map((e) => e.custom_tool_use_id));
  const items: ChatItem[] = [];
  for (const e of events) {
    const at = "processed_at" in e && e.processed_at ? e.processed_at : new Date().toISOString();
    switch (e.type) {
      case "user.message": {
        const text = e.content
          .map((b) => ("text" in b ? b.text : ""))
          .join("\n")
          .replace(/^MEMORY=\S+\n/, "")
          .replace(/^\[[^\]]+\]\n/, "");
        items.push({ kind: "user", id: e.id, text, at });
        break;
      }
      case "agent.message": {
        const text = e.content.map((b) => (b.type === "text" ? b.text : "")).join("");
        if (text.trim()) items.push({ kind: "agent", id: e.id, text, at });
        break;
      }
      case "agent.custom_tool_use":
        if (e.name === "checkpoint" || e.name === "ask_user" || e.name === "send_email") {
          items.push({ kind: "tool", id: e.id, name: e.name, input: e.input as Record<string, unknown>, at, resolved: answered.has(e.id) });
        }
        break;
      case "session.status_running":
        items.push({ kind: "status", id: e.id, status: "running", at });
        break;
      case "session.status_idle":
        items.push({ kind: "status", id: e.id, status: "idle", stop: e.stop_reason.type, at });
        break;
      case "session.status_terminated":
        items.push({ kind: "status", id: e.id, status: "terminated", at });
        break;
      default:
        break;
    }
  }
  return items;
}

/** Heads-ups from sessions the agent started on its own, so they show in chat as well as email. */
export async function recentNotices(t: Tenant, limit = 10): Promise<ChatItem[]> {
  const out: ChatItem[] = [];
  for (const s of await recentProactiveSessions(t.id, limit)) {
    const events = await listAllEvents(s.id).catch(() => [] as SessionEvent[]);
    const report = latestAgentReport(events);
    if (!report || /^NO_REPORT\b/.test(report.trim())) continue;
    const label =
      s.kind === "review" ? "Morning brief" : s.kind === "weekly" ? "Week ahead" : s.kind === "digest" ? "Heads-ups" : s.kind === "followup" ? "Follow-up" : s.kind === "triage" ? "From your mail" : s.correspondent ? `Reply from ${s.correspondent}` : "Heads-up";
    const last = [...events].reverse().find((e) => e.type === "agent.message");
    out.push({ kind: "agent", id: `notice-${s.id}`, text: report, at: last && "processed_at" in last ? last.processed_at : new Date(s.created_at).toISOString(), notice: label });
  }
  return out;
}
