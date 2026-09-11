import Anthropic from "@anthropic-ai/sdk";
import { env } from "./env.js";
import { MEMORY_STORE_NAME, SANDBOX_TOOLS_MOUNT } from "./agent-config.js";

let client: Anthropic | undefined;
export function anthropic(): Anthropic {
  if (!client) client = new Anthropic({ apiKey: env.anthropic.apiKey() });
  return client;
}

export type SessionEvent = Anthropic.Beta.Sessions.BetaManagedAgentsSessionEvent;
export type CustomToolUse = Anthropic.Beta.Sessions.BetaManagedAgentsAgentCustomToolUseEvent;
export type Session = Anthropic.Beta.Sessions.BetaManagedAgentsSession;

/**
 * Session metadata is our only state store. Keys (max 16, values <= 512 chars):
 *   gmail_thread_id, gmail_subject, last_gmail_message_id,
 *   browserbase_session_id,
 *   pending_kind (checkpoint | ask_user), pending_event_id, pending_since, pending_deadline,
 *   last_replied_idle_id
 */
export type Meta = Record<string, string>;

export function meta(session: Session): Meta {
  return (session.metadata ?? {}) as Meta;
}

export async function setMeta(sessionId: string, patch: Record<string, string | null>): Promise<void> {
  const session = await anthropic().beta.sessions.retrieve(sessionId);
  const merged: Record<string, string> = { ...meta(session) };
  for (const [k, v] of Object.entries(patch)) {
    if (v === null) delete merged[k];
    else merged[k] = v.slice(0, 512);
  }
  await anthropic().beta.sessions.update(sessionId, { metadata: merged });
}

export async function findSessionByThread(threadId: string): Promise<Session | undefined> {
  const page = await anthropic().beta.sessions.list({ agent_id: env.anthropic.agentId(), limit: 100 });
  for (const s of page.data) {
    if (meta(s).gmail_thread_id === threadId && s.status !== "terminated") return s;
  }
  return undefined;
}

export async function listRecentSessions(): Promise<Session[]> {
  const page = await anthropic().beta.sessions.list({ agent_id: env.anthropic.agentId(), limit: 100 });
  return page.data;
}

export async function createTaskSession(opts: {
  threadId: string;
  subject: string;
  messageId: string;
  text: string;
}): Promise<Session> {
  const resources: Anthropic.Beta.Sessions.SessionCreateParams["resources"] = [
    {
      type: "memory_store",
      memory_store_id: env.anthropic.memoryStoreId(),
      access: "read_write",
      instructions:
        "The user's standing instructions, preferences, per-site notes and task history. Read standing_instructions.md before starting.",
    },
  ];
  const toolsFile = env.anthropic.sandboxToolsFileId();
  if (toolsFile) resources.push({ type: "file", file_id: toolsFile, mount_path: SANDBOX_TOOLS_MOUNT });

  const budget = env.policy.sessionBudgetUsd();
  return anthropic().beta.sessions.create({
    agent: env.anthropic.agentId(),
    environment_id: env.anthropic.environmentId(),
    title: opts.subject.slice(0, 120) || "Email task",
    resources,
    metadata: {
      gmail_thread_id: opts.threadId,
      gmail_subject: opts.subject.slice(0, 200),
      last_gmail_message_id: opts.messageId,
      memory_mount: `/mnt/memory/${MEMORY_STORE_NAME}`,
    },
    // Budget amount is minor units (cents) as an integer string, per the API.
    ...(budget > 0 ? { budget: { type: "limit" as const, max_list_cost: { amount: String(Math.round(budget * 100)), currency: "USD" as const } } } : {}),
    initial_events: [{ type: "user.message", content: [{ type: "text", text: opts.text }] }],
  });
}

export async function sendUserMessage(sessionId: string, text: string): Promise<void> {
  await anthropic().beta.sessions.events.send(sessionId, {
    events: [{ type: "user.message", content: [{ type: "text", text }] }],
  });
}

export async function sendToolResult(sessionId: string, toolUseEventId: string, text: string, isError = false) {
  await anthropic().beta.sessions.events.send(sessionId, {
    events: [
      {
        type: "user.custom_tool_result",
        custom_tool_use_id: toolUseEventId,
        content: [{ type: "text", text }],
        is_error: isError,
      },
    ],
  });
}

export async function listAllEvents(sessionId: string): Promise<SessionEvent[]> {
  const out: SessionEvent[] = [];
  for await (const ev of anthropic().beta.sessions.events.list(sessionId, { limit: 1000 })) out.push(ev);
  return out;
}

/** Text of every agent.message after the last user.message (i.e. the report for the latest turn). */
export function latestAgentReport(events: SessionEvent[]): string {
  let lastUser = -1;
  events.forEach((e, i) => {
    if (e.type === "user.message") lastUser = i;
  });
  const parts: string[] = [];
  for (const e of events.slice(lastUser + 1)) {
    if (e.type === "agent.message") {
      for (const b of e.content) if (b.type === "text") parts.push(b.text);
    }
  }
  return parts.join("\n\n").trim();
}

export function lastIdleEvent(events: SessionEvent[]) {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (e.type === "session.status_idle") return e;
  }
  return undefined;
}

/** Custom tool calls the session is blocked on right now. */
export function pendingCustomToolUses(events: SessionEvent[]): CustomToolUse[] {
  const idle = lastIdleEvent(events);
  if (!idle || idle.stop_reason.type !== "requires_action") return [];
  const answered = new Set(
    events.filter((e) => e.type === "user.custom_tool_result").map((e) => e.custom_tool_use_id),
  );
  const byId = new Map(events.map((e) => [e.id, e] as const));
  const out: CustomToolUse[] = [];
  for (const id of idle.stop_reason.event_ids) {
    const e = byId.get(id);
    if (e && e.type === "agent.custom_tool_use" && !answered.has(e.id)) out.push(e);
  }
  return out;
}
