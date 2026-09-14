import Anthropic, { toFile } from "@anthropic-ai/sdk";
import { env } from "./env.js";
import { SANDBOX_TOOLS_MOUNT } from "./agent-config.js";
import { randomToken } from "./crypto.js";
import { insertSession, type SessionRow } from "./sessions.js";
import { ensureProvisioned, memoryMount, type Tenant } from "./tenant.js";
import { one, q } from "./db.js";

let client: Anthropic | undefined;
export function anthropic(): Anthropic {
  if (!client) client = new Anthropic({ apiKey: env.anthropic.apiKey() });
  return client;
}

export type SessionEvent = Anthropic.Beta.Sessions.BetaManagedAgentsSessionEvent;
export type CustomToolUse = Anthropic.Beta.Sessions.BetaManagedAgentsAgentCustomToolUseEvent;

export interface SessionFile {
  filename: string;
  mimeType: string;
  content: Buffer;
}

/** Monthly spend so far for a tenant, in cents. */
export async function monthUsageCents(t: Tenant): Promise<number> {
  const r = await one<{ cost_cents: string }>("select cost_cents::text from usage where user_id = $1 and month = date_trunc('month', now())::date", [t.id]);
  return Number(r?.cost_cents ?? 0);
}

export class UsageCapError extends Error {}

/**
 * Start a session for a tenant: their memory store mounted, the shared sandbox CLI, a per-session
 * budget, and our own row for routing. Refuses when the plan's monthly cap is spent.
 */
export async function createSession(
  t: Tenant,
  opts: {
    channel: "chat" | "email";
    kind: string;
    title: string;
    text: string;
    files?: SessionFile[];
    row?: Partial<SessionRow>;
  },
): Promise<SessionRow> {
  const cap = env.plans.monthlyCapUsd(t.plan) * 100;
  if (cap > 0 && (await monthUsageCents(t)) >= cap) {
    throw new UsageCapError(`This month's usage cap ($${(cap / 100).toFixed(0)}) is reached. It resets on the 1st, or upgrade the plan.`);
  }
  await ensureProvisioned(t);

  const resources: Anthropic.Beta.Sessions.SessionCreateParams["resources"] = [
    {
      type: "memory_store",
      memory_store_id: t.memoryStoreId!,
      access: "read_write",
      instructions: `This user's memory. It is mounted at ${memoryMount(t)}; treat that as $MEMORY. Read standing_instructions.md and the matching playbook before starting.`,
    },
  ];
  const toolsFile = env.anthropic.sandboxToolsFileId();
  if (toolsFile) resources.push({ type: "file", file_id: toolsFile, mount_path: SANDBOX_TOOLS_MOUNT });

  const budget = env.plans.sessionBudgetUsd();
  const text = `MEMORY=${memoryMount(t)}\n${opts.text}`;
  const session = await anthropic().beta.sessions.create({
    agent: env.anthropic.agentId(),
    environment_id: env.anthropic.environmentId(),
    title: opts.title.slice(0, 120) || "Task",
    resources,
    metadata: { user_id: t.id, channel: opts.channel, kind: opts.kind },
    ...(budget > 0 ? { budget: { type: "limit" as const, max_list_cost: { amount: String(Math.round(budget * 100)), currency: "USD" as const } } } : {}),
    ...(opts.files?.length ? {} : { initial_events: [{ type: "user.message" as const, content: [{ type: "text" as const, text }] }] }),
  });
  const row = await insertSession({
    id: session.id,
    user_id: t.id,
    channel: opts.channel,
    kind: opts.kind,
    title: opts.title.slice(0, 200),
    status: "running",
    reply_tag: `s_${randomToken(6).toLowerCase().replace(/[^a-z0-9]/g, "")}`,
    ...(opts.row ?? {}),
  });
  await q("insert into usage (user_id, month, sessions) values ($1, date_trunc('month', now())::date, 1) on conflict (user_id, month) do update set sessions = usage.sessions + 1", [t.id]);
  if (opts.files?.length) {
    for (const f of opts.files) await addFileToSession(session.id, f);
    await sendUserMessage(session.id, text);
  }
  return row;
}

export async function addFileToSession(sessionId: string, f: SessionFile): Promise<string> {
  const uploaded = await anthropic().beta.files.upload({ file: await toFile(f.content, f.filename, { type: f.mimeType }) });
  const safe = f.filename.replace(/[^A-Za-z0-9._-]/g, "_");
  await anthropic().beta.sessions.resources.add(sessionId, { type: "file", file_id: uploaded.id, mount_path: `/workspace/inbox/${safe}` });
  return `/workspace/inbox/${safe}`;
}

export async function listSessionOutputs(sessionId: string): Promise<Array<{ id: string; filename: string; mimeType: string }>> {
  const out: Array<{ id: string; filename: string; mimeType: string }> = [];
  for await (const f of anthropic().beta.files.list({ scope_id: sessionId, betas: ["managed-agents-2026-04-01"] })) {
    out.push({ id: f.id, filename: f.filename, mimeType: f.mime_type });
  }
  return out;
}

export async function downloadFile(fileId: string): Promise<Buffer> {
  const resp = await anthropic().beta.files.download(fileId);
  return Buffer.from(await resp.arrayBuffer());
}

export async function sendUserMessage(sessionId: string, text: string): Promise<void> {
  await anthropic().beta.sessions.events.send(sessionId, { events: [{ type: "user.message", content: [{ type: "text", text }] }] });
}

export async function sendToolResult(sessionId: string, toolUseEventId: string, text: string, isError = false) {
  await anthropic().beta.sessions.events.send(sessionId, {
    events: [{ type: "user.custom_tool_result", custom_tool_use_id: toolUseEventId, content: [{ type: "text", text }], is_error: isError }],
  });
}

export async function listAllEvents(sessionId: string): Promise<SessionEvent[]> {
  const out: SessionEvent[] = [];
  for await (const ev of anthropic().beta.sessions.events.list(sessionId, { limit: 1000 })) out.push(ev);
  return out;
}

/** Record a session's cost so far against the tenant's month. Idempotent per session. */
export async function recordSessionCost(t: Tenant, sessionId: string): Promise<void> {
  const s = await anthropic().beta.sessions.retrieve(sessionId).catch(() => undefined);
  const amount = (s as { usage?: { list_cost?: { amount?: string } } } | undefined)?.usage?.list_cost?.amount;
  if (!amount) return;
  const cents = Number(amount);
  if (!Number.isFinite(cents)) return;
  const prev = await one<{ cost_cents: string }>("select cost_cents::text from session_costs where session_id = $1", [sessionId]);
  const delta = cents - Number(prev?.cost_cents ?? 0);
  if (delta <= 0) return;
  await q("insert into session_costs (session_id, cost_cents) values ($1, $2) on conflict (session_id) do update set cost_cents = $2", [sessionId, cents]);
  await q("insert into usage (user_id, month, cost_cents) values ($1, date_trunc('month', now())::date, $2) on conflict (user_id, month) do update set cost_cents = usage.cost_cents + $2", [t.id, delta]);
}

/** Text of every agent.message after the last user.message. */
export function latestAgentReport(events: SessionEvent[]): string {
  let lastUser = -1;
  events.forEach((e, i) => {
    if (e.type === "user.message") lastUser = i;
  });
  const parts: string[] = [];
  for (const e of events.slice(lastUser + 1)) {
    if (e.type === "agent.message") for (const b of e.content) if (b.type === "text") parts.push(b.text);
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

export function pendingCustomToolUses(events: SessionEvent[]): CustomToolUse[] {
  const idle = lastIdleEvent(events);
  if (!idle || idle.stop_reason.type !== "requires_action") return [];
  const answered = new Set(events.filter((e) => e.type === "user.custom_tool_result").map((e) => e.custom_tool_use_id));
  const byId = new Map(events.map((e) => [e.id, e] as const));
  const out: CustomToolUse[] = [];
  for (const id of idle.stop_reason.event_ids) {
    const e = byId.get(id);
    if (e && e.type === "agent.custom_tool_use" && !answered.has(e.id)) out.push(e);
  }
  return out;
}
