import { one, q } from "./db.js";
import { loadSystemPrompt } from "./agent-config.js";
import { randomToken } from "./crypto.js";
import { env } from "./env.js";
import type { ChatMessage } from "./llm.js";
import { ensureSeeded } from "./memory.js";
import { modelFor, tierFor } from "./router.js";
import { ensureProvisioned, type Tenant } from "./tenant.js";

/** Our record of an agent session: routing state plus the loop's own state (messages, model, lease). */
export interface SessionRow {
  id: string;
  user_id: string;
  channel: "chat" | "email";
  kind: string;
  title: string | null;
  status: "running" | "idle" | "waiting" | "terminated" | "error";
  requester: string | null;
  reply_tag: string | null;
  email_subject: string | null;
  last_message_id: string | null;
  correspondent: string | null;
  browserbase_session_id: string | null;
  pending_kind: "checkpoint" | "ask_user" | "send_email" | null;
  pending_event_id: string | null;
  pending_deadline: Date | null;
  last_replied_idle_id: string | null;
  review_day: Date | null;
  digest_key: string | null;
  followup_id: string | null;
  model: string | null;
  messages: ChatMessage[];
  turns: number;
  lease_until: Date | null;
  last_report: string | null;
  error: string | null;
  cost_cents: number;
  prompt_tokens: number;
  completion_tokens: number;
  created_at: Date;
  updated_at: Date;
}

export class UsageCapError extends Error {}

export async function getSession(id: string): Promise<SessionRow | undefined> {
  return one<SessionRow>("select * from agent_sessions where id = $1", [id]);
}

export async function updateSession(id: string, patch: Partial<SessionRow>): Promise<void> {
  const cols = Object.keys(patch);
  if (!cols.length) return;
  const vals = Object.values(patch).map((v) => (v !== null && typeof v === "object" && !(v instanceof Date) ? JSON.stringify(v) : v));
  await q(`update agent_sessions set ${cols.map((c, i) => `${c} = $${i + 2}`).join(", ")}, updated_at = now() where id = $1`, [id, ...vals]);
}

export async function monthUsageCents(t: Tenant): Promise<number> {
  const r = await one<{ cost_cents: string }>("select cost_cents::text from usage where user_id = $1 and month = date_trunc('month', now())::date", [t.id]);
  return Number(r?.cost_cents ?? 0);
}

/**
 * Start a session: pick the model tier from the request, write the first messages, record it.
 * The loop itself runs in api/run (kicked by the caller). Refuses past the plan's monthly cap.
 */
export async function createSession(
  t: Tenant,
  opts: { channel: "chat" | "email"; kind: string; title: string; text: string; images?: Array<{ mimeType: string; base64: string }>; row?: Partial<SessionRow>; tier?: "chat" | "task" | "hard" },
): Promise<SessionRow> {
  const cap = env.plans.monthlyCapUsd(t.plan) * 100;
  if (cap > 0 && (await monthUsageCents(t)) >= cap) {
    throw new UsageCapError(`This month's usage cap ($${(cap / 100).toFixed(0)}) is reached. It resets on the 1st, or upgrade the plan.`);
  }
  await ensureProvisioned(t);
  await ensureSeeded(t);
  const tier = opts.tier ?? tierFor(opts.text, opts.kind);
  const model = modelFor(tier, t);
  const id = `s_${Date.now().toString(36)}${randomToken(6).toLowerCase().replace(/[^a-z0-9]/g, "")}`;
  const first: ChatMessage = opts.images?.length
    ? { role: "user", content: [{ type: "text", text: opts.text }, ...opts.images.map((i) => ({ type: "image_url" as const, image_url: { url: `data:${i.mimeType};base64,${i.base64}` } }))] }
    : { role: "user", content: opts.text };
  const messages: ChatMessage[] = [{ role: "system", content: systemFor(t) }, first];
  const row = await one<SessionRow>(
    `insert into agent_sessions (id, user_id, channel, kind, title, status, reply_tag, model, messages, requester, email_subject, last_message_id, correspondent, review_day, digest_key, followup_id)
     values ($1,$2,$3,$4,$5,'running',$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) returning *`,
    [
      id,
      t.id,
      opts.channel,
      opts.kind,
      opts.title.slice(0, 200),
      `s_${randomToken(6).toLowerCase().replace(/[^a-z0-9]/g, "")}`,
      model,
      JSON.stringify(messages),
      opts.row?.requester ?? null,
      opts.row?.email_subject ?? null,
      opts.row?.last_message_id ?? null,
      opts.row?.correspondent ?? null,
      opts.row?.review_day ?? null,
      opts.row?.digest_key ?? null,
      opts.row?.followup_id ?? null,
    ],
  );
  await q("insert into usage (user_id, month, sessions) values ($1, date_trunc('month', now())::date, 1) on conflict (user_id, month) do update set sessions = usage.sessions + 1", [t.id]);
  return row!;
}

/** Per-customer preamble appended to the shared system prompt. */
function systemFor(t: Tenant): string {
  const base = loadPrompt();
  const facts = [
    `User: ${t.settings.owner_name || t.name || t.email} <${t.email}>. Time zone: ${t.timezone}.`,
    `Your address (for send_email replies): ${t.slug}@${env.mail.domain()}.`,
    t.googleRefreshToken ? "Google is connected: calendar, owner_inbox and drive work." : "Google is NOT connected: calendar, owner_inbox and drive will fail; use calendar.md and email instead and mention Settings > Connect Google once.",
    `Approval rules: purchases/payments up to $${Number(t.settings.auto_approve_max_usd ?? 0)} auto-approved; auto-approved action types: ${(t.settings.auto_approve_types ?? []).join(", ") || "none"}.`,
  ].join("\n");
  return `${base}\n\n# This user\n${facts}`;
}

let promptCache: string | undefined;
function loadPrompt(): string {
  return (promptCache ??= loadSystemPrompt());
}

/** Append a user message (a chat line, an email reply) and mark runnable. */
export async function appendUserMessage(row: SessionRow, text: string, images?: Array<{ mimeType: string; base64: string }>): Promise<void> {
  const msg: ChatMessage = images?.length
    ? { role: "user", content: [{ type: "text", text }, ...images.map((i) => ({ type: "image_url" as const, image_url: { url: `data:${i.mimeType};base64,${i.base64}` } }))] }
    : { role: "user", content: text };
  await q("update agent_sessions set messages = messages || $2::jsonb, status = 'running', updated_at = now() where id = $1", [row.id, JSON.stringify([msg])]);
}

/** Append a tool result for a pending call and mark runnable. */
export async function appendToolResult(row: SessionRow, toolCallId: string, text: string): Promise<void> {
  const msg: ChatMessage = { role: "tool", tool_call_id: toolCallId, content: text };
  await q(
    "update agent_sessions set messages = messages || $2::jsonb, status = 'running', pending_kind = null, pending_event_id = null, pending_deadline = null, updated_at = now() where id = $1",
    [row.id, JSON.stringify([msg])],
  );
}

export async function sessionByReplyTag(userId: string, tag: string): Promise<SessionRow | undefined> {
  return one<SessionRow>("select * from agent_sessions where user_id = $1 and reply_tag = $2 and status <> 'terminated' order by created_at desc limit 1", [userId, tag]);
}

export async function latestChatSession(userId: string, maxAgeHours: number): Promise<SessionRow | undefined> {
  return one<SessionRow>(
    "select * from agent_sessions where user_id = $1 and channel = 'chat' and status <> 'terminated' and created_at > now() - ($2 || ' hours')::interval order by created_at desc limit 1",
    [userId, String(maxAgeHours)],
  );
}

export async function recentProactiveSessions(userId: string, limit = 10): Promise<SessionRow[]> {
  return q<SessionRow>(
    "select * from agent_sessions where user_id = $1 and kind in ('review','weekly','followup','triage','digest','correspondence') and status in ('idle','terminated') order by created_at desc limit $2",
    [userId, limit],
  );
}

export async function expiredAskUserSessions(): Promise<SessionRow[]> {
  return q<SessionRow>("select * from agent_sessions where pending_kind = 'ask_user' and pending_deadline is not null and pending_deadline < now() and status = 'waiting'");
}

export async function hasSessionOfKindToday(userId: string, kind: string, day: string): Promise<boolean> {
  const r = await one<{ n: string }>("select count(*)::text as n from agent_sessions where user_id = $1 and kind = $2 and review_day = $3::date", [userId, kind, day]);
  return Number(r?.n ?? 0) > 0;
}

export async function hasDigestKey(userId: string, key: string): Promise<boolean> {
  const r = await one<{ n: string }>("select count(*)::text as n from agent_sessions where user_id = $1 and digest_key = $2", [userId, key]);
  return Number(r?.n ?? 0) > 0;
}

/** Sessions that should be running but nobody holds a lease on (worker died, or kick failed). */
export async function staleRunnableSessions(limit = 20): Promise<SessionRow[]> {
  return q<SessionRow>("select * from agent_sessions where status = 'running' and (lease_until is null or lease_until < now()) order by updated_at limit $1", [limit]);
}

/** Take a lease so only one worker runs the loop. Returns false if someone else holds it. */
export async function acquireLease(id: string, seconds: number): Promise<boolean> {
  const rows = await q("update agent_sessions set lease_until = now() + ($2 || ' seconds')::interval where id = $1 and status = 'running' and (lease_until is null or lease_until < now()) returning id", [id, String(seconds)]);
  return rows.length > 0;
}

export async function releaseLease(id: string): Promise<void> {
  await q("update agent_sessions set lease_until = null where id = $1", [id]);
}
