import { createSession, listRecentSessions, meta, type Session, type SessionEvent } from "./anthropic.js";
import { stampMessage } from "./transcript.js";

function maxAgeHours(): number {
  return Number(process.env.CHAT_SESSION_MAX_AGE_HOURS || "12");
}

/** The current chat session: the newest live one started recently, otherwise none. */
export async function currentChatSession(): Promise<Session | undefined> {
  const cutoff = Date.now() - maxAgeHours() * 3_600_000;
  const candidates = (await listRecentSessions())
    .filter((s) => meta(s).channel === "chat" && s.status !== "terminated")
    .filter((s) => new Date(s.created_at).getTime() > cutoff)
    .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
  return candidates[0];
}

export async function startChatSession(firstMessage: string): Promise<Session> {
  return createSession({
    channel: "chat",
    title: `Chat ${new Date().toISOString().slice(0, 16).replace("T", " ")}`,
    text: stampMessage(firstMessage, "chat"),
  });
}

/** Shape the chat UI renders. Built from the event list (history) or the live stream. */
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
        const text = e.content.map((b) => ("text" in b ? b.text : "")).join("\n").replace(/^\[[^\]]+\]\n/, "");
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

/**
 * Heads-ups: reports from sessions the agent started on its own (daily review, timers and
 * watches, mail triage, third-party replies) so they show in chat as well as email.
 */
export async function recentNotices(limit = 10): Promise<ChatItem[]> {
  const { listRecentSessions, listAllEvents, latestAgentReport, meta: metaOf } = await import("./anthropic.js");
  const sessions = (await listRecentSessions())
    .filter((s) => {
      const m = metaOf(s);
      return (m.proactive === "1" || m.correspondent) && s.status !== "running";
    })
    .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())
    .slice(0, limit);
  const out: ChatItem[] = [];
  for (const s of sessions) {
    const events = await listAllEvents(s.id);
    const report = latestAgentReport(events);
    if (!report || /^NO_REPORT\b/.test(report.trim())) continue;
    const m = metaOf(s);
    const label = m.review_day ? "Morning brief" : m.followup_id ? "Follow-up" : m.triage_count ? "From your mail" : m.correspondent ? `Reply from ${m.correspondent}` : "Heads-up";
    const last = [...events].reverse().find((e) => e.type === "agent.message");
    out.push({ kind: "agent", id: `notice-${s.id}`, text: report, at: last && "processed_at" in last ? last.processed_at : s.created_at, notice: label });
  }
  return out;
}
