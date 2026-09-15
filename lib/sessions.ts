import { one, q } from "./db.js";
import { loadSystemPrompt } from "./agent-config.js";
import { randomToken } from "./crypto.js";
import { env } from "./env.js";
import type { ChatMessage } from "./llm.js";
import { ensureSeeded, readMemory } from "./memory.js";
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
  cached_tokens?: number;
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
  opts: { channel: "chat" | "email"; kind: string; title: string; text: string; images?: Array<{ mimeType: string; base64: string }>; row?: Partial<SessionRow>; tier?: "chat" | "task" | "hard"; reaction?: string; recap?: string },
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
  if (opts.reaction) first.reaction = opts.reaction;
  const messages: ChatMessage[] = [{ role: "system", content: await systemFor(t) }, ...(opts.recap ? [{ role: "user" as const, content: opts.recap }] : []), first];
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
/** Memory files the model gets inline, so it never has to look up (or ask for) a default it already has. */
const KNOWN_FILES = ["standing_instructions.md", "profile.md", "facts.md", "contacts.md", "preferences.md"];
const KNOWN_BUDGET = Number(process.env.KNOWN_FACTS_CHARS ?? 9000);

/** The user's own facts, defaults and contacts, trimmed to the budget; empty template lines are dropped. */
export async function knownFacts(t: Tenant): Promise<string> {
  const parts: string[] = [];
  let used = 0;
  for (const path of KNOWN_FILES) {
    const raw = (await readMemory(t, path).catch(() => null)) ?? "";
    const lines = raw
      .split("\n")
      .filter((l) => {
        const line = l.trim();
        if (!line) return false;
        if (line.includes("___")) return false; // unfilled template value
        if (/^-\s*[^:]*:\s*$/.test(line)) return false; // "- Phone:" with nothing after it
        if (/^`/.test(line) || /^\(/.test(line) || /^Examples? of /i.test(line)) return false; // template hints
        if (/^(Fill (this|in)|Facts the playbooks|Durable things|People and companies the agent)/i.test(line)) return false;
        return true;
      })
      .filter((l, i, arr) => !(l.trim().startsWith("#") && (i === arr.length - 1 || arr[i + 1].trim().startsWith("#")))); // headings with nothing under them
    if (!lines.length) continue;
    let block = `## ${path}\n${lines.join("\n")}`;
    if (used + block.length > KNOWN_BUDGET) block = block.slice(0, Math.max(0, KNOWN_BUDGET - used)) + "\n... (read the file for the rest)";
    parts.push(block);
    used += block.length;
    if (used >= KNOWN_BUDGET) break;
  }
  return parts.join("\n\n");
}

export async function systemFor(t: Tenant): Promise<string> {
  const known = await knownFacts(t);
  const head = systemHead(t);
  if (!known) return head;
  return `${head}\n\n# What you already know about this user (from their memory files; never ask for any of it)\n${known}`;
}

function systemHead(t: Tenant): string {
  const base = loadPrompt();
  const facts = [
    `Your name is ${env.assistantName()}. When you refer to yourself or a message needs a name, use it; you are the user's assistant, not a faceless service.`,
    `User: ${t.settings.owner_name || t.name || t.email} <${t.email}>. Time zone: ${t.timezone}.`,
    env.mail.configured() ? `Your address (for send_email replies): ${t.slug}@${env.mail.domain()}.` : "Email is NOT enabled on this server: send_email and get_email_code will fail; tell the user once and work through chat.",
    env.browserbase.configured() ? "" : "The hosted browser is NOT enabled on this server: browser_* and login will fail; use web_search, memory and the calendar, and tell the user once.",
    t.googleRefreshToken ? "Google is connected: calendar, owner_inbox and drive work." : "Google is NOT connected: calendar, owner_inbox and drive will fail; use calendar.md and email instead and mention Settings > Connect Google once.",
    `Approval rules: purchases/payments up to $${Number(t.settings.auto_approve_max_usd ?? 0)} auto-approved; auto-approved action types: ${(t.settings.auto_approve_types ?? []).join(", ") || "none"}.`,
  ].filter(Boolean).join("\n");
  return `${base}\n\n# This user\n${facts}`;
}

let promptCache: string | undefined;
function loadPrompt(): string {
  return (promptCache ??= loadSystemPrompt());
}

/** Append a user message (a chat line, an email reply) and mark runnable. */
export async function appendUserMessage(row: SessionRow, text: string, images?: Array<{ mimeType: string; base64: string }>, reaction?: string): Promise<void> {
  const msg: ChatMessage = images?.length
    ? { role: "user", content: [{ type: "text", text }, ...images.map((i) => ({ type: "image_url" as const, image_url: { url: `data:${i.mimeType};base64,${i.base64}` } }))] }
    : { role: "user", content: text };
  if (reaction) msg.reaction = reaction;
  await q("update agent_sessions set messages = messages || $2::jsonb, status = 'running', updated_at = now() where id = $1", [row.id, JSON.stringify([msg])]);
}

/** Append an assistant bubble (e.g. the instant "on it" ack). Ephemeral ones show in chat but are never sent to the model. */
export async function appendAssistantMessage(row: SessionRow, text: string, ephemeral = false): Promise<void> {
  const msg: ChatMessage = ephemeral ? { role: "assistant", content: text, ephemeral: true } : { role: "assistant", content: text };
  await q("update agent_sessions set messages = messages || $2::jsonb, updated_at = now() where id = $1", [row.id, JSON.stringify([msg])]);
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
    "select * from agent_sessions where user_id = $1 and channel = 'chat' and kind = 'chat' and status <> 'terminated' and created_at > now() - ($2 || ' hours')::interval order by created_at desc limit 1",
    [userId, String(maxAgeHours)],
  );
}

/** Every chat session in the window, oldest first, so the page can show the full conversation history. */
export async function chatSessionsSince(userId: string, since: Date, limit = 200): Promise<SessionRow[]> {
  const rows = await q<SessionRow>("select * from agent_sessions where user_id = $1 and channel = 'chat' and kind = 'chat' and created_at > $2 order by created_at desc limit $3", [userId, since, limit]);
  return rows.reverse();
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
