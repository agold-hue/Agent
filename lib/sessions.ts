import { one, q } from "./db.js";
import { loadSystemPrompt } from "./agent-config.js";
import { randomToken } from "./crypto.js";
import { env } from "./env.js";
import type { ChatMessage, MessageQuote } from "./llm.js";
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
  /** For a parallel task spawned from the chat: the chat thread it belongs to. */
  parent_session_id?: string | null;
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

const now = () => new Date().toISOString();

/** Text of a message: the string, or the text parts of a multimodal message. */
export function messageText(m: ChatMessage): string {
  if (typeof m.content === "string") return m.content;
  return (m.content ?? []).filter((p) => p.type === "text").map((p) => (p as { text: string }).text).join("\n");
}

/**
 * Whether a user-role message came from the user (a chat line, an email, an upload) rather than from
 * the host. Everything the user sends is stamped `[time via channel]`; host notes (nudges, recaps,
 * screenshots, "(You are now running...)") never are, and start with "(".
 */
export function isUserMessage(m: ChatMessage): boolean {
  return m.role === "user" && !m.ephemeral && messageText(m).startsWith("[");
}

/**
 * Where the current task starts: the index of the user's latest real message. Step budgets and the
 * task clock count from here, so a long chat does not exhaust a new task before it begins.
 */
export function taskStart(messages: ChatMessage[]): number {
  for (let i = messages.length - 1; i > 0; i--) if (isUserMessage(messages[i])) return i;
  return 1;
}

/**
 * When the current task's clock started: the user's latest message, or their latest answer to a
 * question or code request (those arrive as tool results stamped by appendToolResult; the loop's own
 * tool results carry no `at`). Waiting for the user never counts against the task. Undefined for
 * sessions from before timestamps were recorded.
 */
export function taskClockStart(messages: ChatMessage[]): number | undefined {
  for (let i = messages.length - 1; i > 0; i--) {
    const m = messages[i];
    if (isUserMessage(m) || (m.role === "tool" && m.at)) return m.at ? new Date(m.at).getTime() : undefined;
  }
  return undefined;
}

/** The user's message that started the current task, without the stamp. */
export function taskUserText(messages: ChatMessage[]): string {
  const m = messages[taskStart(messages)];
  return m ? messageText(m).replace(/^\[[^\]]+\]\n/, "") : "";
}

/** How many model turns the current task has used. */
export function taskTurns(messages: ChatMessage[]): number {
  let n = 0;
  for (let i = taskStart(messages); i < messages.length; i++) if (messages[i].role === "assistant" && !messages[i].ephemeral) n++;
  return n;
}

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
  opts: { channel: "chat" | "email"; kind: string; title: string; text: string; images?: Array<{ mimeType: string; base64: string }>; row?: Partial<SessionRow>; tier?: "chat" | "task" | "hard"; reaction?: string; quote?: MessageQuote; recap?: string },
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
    ? { role: "user", content: [{ type: "text", text: opts.text }, ...opts.images.map((i) => ({ type: "image_url" as const, image_url: { url: `data:${i.mimeType};base64,${i.base64}` } }))], at: now() }
    : { role: "user", content: opts.text, at: now() };
  if (opts.reaction) first.reaction = opts.reaction;
  if (opts.quote) first.quote = opts.quote;
  const messages: ChatMessage[] = [{ role: "system", content: await systemFor(t) }, ...(opts.recap ? [{ role: "user" as const, content: opts.recap }] : []), first];
  const row = await one<SessionRow>(
    `insert into agent_sessions (id, user_id, channel, kind, title, status, reply_tag, model, messages, requester, email_subject, last_message_id, correspondent, review_day, digest_key, followup_id, parent_session_id)
     values ($1,$2,$3,$4,$5,'running',$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) returning *`,
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
      opts.row?.parent_session_id ?? null,
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

export async function systemFor(t: Tenant, opts: { parallel?: boolean } = {}): Promise<string> {
  const known = await knownFacts(t);
  const head = systemHead(t) + (opts.parallel === false ? "" : await parallelTasksNote(t));
  if (!known) return head;
  return `${head}\n\n# What you already know about this user (from their memory files; never ask for any of it)\n${known}`;
}

async function parallelTasksNote(t: Tenant): Promise<string> {
  const tasks = await activeTaskSessions(t.id).catch(() => [] as SessionRow[]);
  if (!tasks.length) return "";
  const lines = tasks.map((s) => `- "${(s.title ?? "task").slice(0, 120)}" (${s.status === "waiting" ? "waiting on the user" : "running"}, started ${Math.max(1, Math.round((Date.now() - new Date(s.created_at).getTime()) / 60_000))} min ago)`);
  return `\n\n# Tasks running alongside this chat right now\nThese run as separate sessions; their results appear in the chat when they finish. Do not redo them or report on them; if the user asks about one, say it is still running (or waiting on them) and continue with what they asked you.\n${lines.join("\n")}`;
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
export async function appendUserMessage(row: SessionRow, text: string, images?: Array<{ mimeType: string; base64: string }>, reaction?: string, quote?: MessageQuote): Promise<void> {
  const msg: ChatMessage = images?.length
    ? { role: "user", content: [{ type: "text", text }, ...images.map((i) => ({ type: "image_url" as const, image_url: { url: `data:${i.mimeType};base64,${i.base64}` } }))], at: now() }
    : { role: "user", content: text, at: now() };
  if (reaction) msg.reaction = reaction;
  if (quote) msg.quote = quote;
  await q("update agent_sessions set messages = messages || $2::jsonb, status = 'running', updated_at = now() where id = $1", [row.id, JSON.stringify([msg])]);
}

/** A note from the host to the model (a hint about the user's last message). Never shown in chat; does not start a task. */
export async function appendHostNote(row: SessionRow, text: string): Promise<void> {
  await q("update agent_sessions set messages = messages || $2::jsonb, updated_at = now() where id = $1", [row.id, JSON.stringify([{ role: "user", content: text }])]);
}

/** Just the message array, re-read fresh — used by the loop to pick up a message the user sent while it was working. */
export async function getMessages(id: string): Promise<ChatMessage[]> {
  const r = await one<{ messages: ChatMessage[] }>("select messages from agent_sessions where id = $1", [id]);
  return r?.messages ?? [];
}

/**
 * Append messages to a session AND set scalar fields in one atomic write, without ever overwriting
 * the whole messages array. This is how the running loop persists each turn: a full-array overwrite
 * would clobber a message the user sent (a separate atomic append) while the loop was working, which
 * made typed chats vanish. `messages` in the patch is ignored; pass the new messages in `append`.
 */
export async function persistTurn(id: string, append: ChatMessage[], patch: Partial<SessionRow> = {}): Promise<void> {
  const vals: unknown[] = [id, JSON.stringify(append)];
  const sets = ["messages = messages || $2::jsonb"];
  for (const [k, v] of Object.entries(patch)) {
    if (k === "messages" || k === "id") continue;
    vals.push(v !== null && typeof v === "object" && !(v instanceof Date) ? JSON.stringify(v) : v);
    sets.push(`${k} = $${vals.length}`);
  }
  await q(`update agent_sessions set ${sets.join(", ")}, updated_at = now() where id = $1`, vals);
}

/** Append an assistant bubble (e.g. the instant "on it" ack). Ephemeral ones show in chat but are never sent to the model. */
export async function appendAssistantMessage(row: SessionRow, text: string, ephemeral = false): Promise<void> {
  const msg: ChatMessage = ephemeral ? { role: "assistant", content: text, ephemeral: true, at: now() } : { role: "assistant", content: text, at: now() };
  await q("update agent_sessions set messages = messages || $2::jsonb, updated_at = now() where id = $1", [row.id, JSON.stringify([msg])]);
}

/** Show the user's own text as a chat bubble (with its reaction) when it answered a question. UI-only: the model gets the answer via the tool result, so this echo is ephemeral. */
export async function appendUserEcho(row: SessionRow, text: string, reaction?: string, quote?: MessageQuote): Promise<void> {
  const msg: ChatMessage = { role: "user", content: text, ephemeral: true, at: now(), ...(reaction ? { reaction } : {}), ...(quote ? { quote } : {}) };
  await q("update agent_sessions set messages = messages || $2::jsonb where id = $1", [row.id, JSON.stringify([msg])]);
}

/** Append a tool result for a pending call (the user's answer) and mark runnable. Stamped: the task clock restarts here. */
export async function appendToolResult(row: SessionRow, toolCallId: string, text: string): Promise<void> {
  const msg: ChatMessage = { role: "tool", tool_call_id: toolCallId, content: text, at: now() };
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

/** Every chat session in the window (and, with tasks, the parallel tasks spawned from chat), oldest first, so the page can show the full conversation. */
export async function chatSessionsSince(userId: string, since: Date, limit = 200, opts: { tasks?: boolean } = {}): Promise<SessionRow[]> {
  const kinds = opts.tasks ? ["chat", "task"] : ["chat"];
  const rows = await q<SessionRow>("select * from agent_sessions where user_id = $1 and channel = 'chat' and kind = any($4::text[]) and created_at > $2 order by created_at desc limit $3", [userId, since, limit, kinds]);
  return rows.reverse();
}

/** Parallel tasks still going (running, or waiting on the user), oldest first. */
export async function activeTaskSessions(userId: string): Promise<SessionRow[]> {
  return q<SessionRow>("select * from agent_sessions where user_id = $1 and channel = 'chat' and kind = 'task' and status in ('running', 'waiting') order by created_at", [userId]);
}

/** A chat-side session by id, only if it belongs to this user. */
export async function ownSession(userId: string, id: string): Promise<SessionRow | undefined> {
  return one<SessionRow>("select * from agent_sessions where id = $1 and user_id = $2 and channel = 'chat'", [id, userId]);
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
