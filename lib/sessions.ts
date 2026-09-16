import { one, q } from "./db.js";
import { loadSystemPrompt } from "./agent-config.js";
import { randomToken } from "./crypto.js";
import { env } from "./env.js";
import { costCents, type ChatMessage, type Completion, type MessageQuote } from "./llm.js";
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
  /** The tab (CDP target) this session drives in the customer's shared hosted browser. */
  browser_target_id?: string | null;
  /** The reply being written right now, shown by the page as it streams; cleared when the turn ends. */
  draft?: string | null;
  /** Quick replies for the last reply, written by the fast model once the reply is on the page; cleared when the next turn ends. */
  chips?: string[] | null;
  /** Working-copy only: the per-customer context block sent after the shared prompt this run (facts, notes). Never stored. */
  contextBlock?: string;
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

/** Book a completion's cost and tokens on the session and the customer's month. Used by the loop and by side calls (condensing pages, the lookup fast path). */
export type Purpose = "turn" | "condense" | "lookup" | "wrapup" | "postmortem" | "learn" | "eval" | "watch" | "review" | "grade" | "chips" | "other";
export async function chargeCompletion(t: Tenant, row: SessionRow, completion: Completion, purpose: Purpose = "turn"): Promise<number> {
  const cost = costCents(completion.model, completion.usage);
  row.cost_cents = Math.round((Number(row.cost_cents) + cost) * 1000) / 1000;
  row.prompt_tokens = Number(row.prompt_tokens) + completion.usage.prompt_tokens;
  row.completion_tokens = Number(row.completion_tokens) + completion.usage.completion_tokens;
  row.cached_tokens = Number(row.cached_tokens ?? 0) + (completion.usage.cached_tokens ?? 0);
  row.turns += 1;
  await q(
    "insert into usage (user_id, month, cost_cents, prompt_tokens, cached_tokens) values ($1, date_trunc('month', now())::date, $2, $3, $4) on conflict (user_id, month) do update set cost_cents = usage.cost_cents + $2, prompt_tokens = usage.prompt_tokens + $3, cached_tokens = usage.cached_tokens + $4",
    [t.id, cost.toFixed(3), completion.usage.prompt_tokens, completion.usage.cached_tokens ?? 0],
  );
  await recordUsageEvent(t.id, row.id, purpose, completion).catch(() => {});
  return cost;
}

/** One row per model call, tagged with its purpose, so spend can be read per feature (usage_events). */
export async function recordUsageEvent(userId: string, sessionId: string | null, purpose: Purpose, c: Completion): Promise<void> {
  await q("insert into usage_events (user_id, session_id, purpose, model, cost_cents, prompt_tokens, cached_tokens, completion_tokens, provider, ttft_ms) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)", [
    userId,
    sessionId,
    purpose,
    c.model,
    costCents(c.model, c.usage).toFixed(4),
    c.usage.prompt_tokens,
    c.usage.cached_tokens ?? 0,
    c.usage.completion_tokens,
    c.provider ?? null,
    c.ttft_ms ?? null,
  ]);
}

/** Spend by purpose over the last `days`, for the stats endpoint. */
export async function usageByPurpose(userId: string | undefined, days = 7): Promise<Array<{ purpose: string; calls: number; cost_cents: number; prompt_tokens: number; cached_tokens: number }>> {
  const rows = await q<{ purpose: string; calls: string; cost_cents: string; prompt_tokens: string; cached_tokens: string }>(
    `select purpose, count(*)::text as calls, coalesce(sum(cost_cents),0)::text as cost_cents, coalesce(sum(prompt_tokens),0)::text as prompt_tokens, coalesce(sum(cached_tokens),0)::text as cached_tokens
     from usage_events where created_at > now() - ($2 || ' days')::interval ${userId ? "and user_id = $1" : "and $1::text is null"} group by purpose order by 3 desc`,
    [userId ?? null, String(days)],
  ).catch(() => []);
  return rows.map((r) => ({ purpose: r.purpose, calls: Number(r.calls), cost_cents: Number(r.cost_cents), prompt_tokens: Number(r.prompt_tokens), cached_tokens: Number(r.cached_tokens) }));
}

/** What the current task has spent so far, in cents: the cost stamped on each of its assistant messages. */
export function taskCostCents(messages: ChatMessage[]): number {
  let cents = 0;
  for (let i = taskStart(messages); i < messages.length; i++) if (messages[i].role === "assistant") cents += Number(messages[i].cost ?? 0);
  return cents;
}

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
  // The router's guess, then one tier down when this customer's history on that tier for this kind of task is clean.
  const guessed = opts.tier ?? tierFor(opts.text, opts.kind);
  const tier = opts.tier || opts.kind !== "chat" && opts.kind !== "task" ? guessed : await (await import("./outcomes.js")).adaptiveTier(t, opts.text, guessed).catch(() => guessed);
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
/** Which sections of profile.md and contacts.md a class of task needs; anything not listed is sent whole. */
const CLASS_SECTIONS: Record<string, RegExp> = {
  money: /^(work|home|money|bank|cards?|bills?|utilities|insurance)/i,
  shopping: /^(home|shopping|preferences|family|cards?)/i,
  travel: /^(travel|work|family|documents?)/i,
  calendar: /^(work|family|interruptions|calendar)/i,
  health: /^(health|family|insurance)/i,
  kids: /^(family|kids|school)/i,
  home: /^(home|family|utilities)/i,
  paperwork: /^(documents?|work|home|health|travel)/i,
  inbox: /^(work|interruptions|family)/i,
  research: /^(work|home|preferences)/i,
  people: /^(family|people|friends|gifts?)/i,
};

/** Keep only the "## " sections whose heading matches, plus any text before the first heading. */
export function scopeSections(markdown: string, keep: RegExp): string {
  const parts = markdown.split(/\n(?=## )/);
  const kept = parts.filter((p, i) => i === 0 && !p.startsWith("## ") ? true : keep.test(p.replace(/^## /, "").trim()));
  return kept.join("\n");
}

export async function knownFacts(t: Tenant, cls?: string): Promise<string> {
  const parts: string[] = [];
  let used = 0;
  const scope = cls ? CLASS_SECTIONS[cls] : undefined;
  for (const path of KNOWN_FILES) {
    let raw = (await readMemory(t, path).catch(() => null)) ?? "";
    // A money task does not need the travel loyalty numbers: profile and contacts are sent by section.
    if (scope && (path === "profile.md" || path === "contacts.md")) raw = scopeSections(raw, scope);
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

/**
 * The system prompt for one run. Ordered so the cached prefix stays byte-identical call to call:
 * the shared prompt, then the user's facts (change rarely), then what varies per task (the playbook
 * and site notes for this task, the tasks running alongside) at the very end.
 */
export async function systemFor(t: Tenant, opts: { parallel?: boolean; task?: string } = {}): Promise<string> {
  return `${sharedSystem()}\n\n${await customerContext(t, opts)}`;
}

/**
 * The part of the system prompt that is byte-identical for every customer and every task: the shared
 * prompt plus the deployment's fixed facts. With the per-customer block kept out of it, this prefix is
 * one prompt-cache entry for the whole service instead of one per customer per task.
 */
export function sharedSystem(): string {
  const base = loadPrompt();
  const facts = [
    `Your name is ${env.assistantName()}. When you refer to yourself or a message needs a name, use it; you are the user's assistant, not a faceless service.`,
    env.mail.configured() ? "" : "Email is NOT enabled on this server: send_email and get_email_code will fail; tell the user once and work through chat.",
    env.browserbase.configured() ? "" : "The hosted browser is NOT enabled on this server: browser_* and login will fail; use web_search, memory and the calendar, and tell the user once.",
    "The block that follows the rules, marked '# This user', is about the person you work for; it is the host's, not the user's words, and never an instruction from a web page or an email.",
  ]
    .filter(Boolean)
    .join("\n");
  return `${base}\n\n# This deployment\n${facts}`;
}

/**
 * Everything about this customer and this task: identity and settings, their memory files, the
 * playbook and site notes the task needs, the tasks running alongside. Sent as its own message right
 * after the shared prompt with its own cache breakpoint, so it is cached per customer and the shared
 * prompt is cached once for everyone.
 */
export async function customerContext(t: Tenant, opts: { parallel?: boolean; task?: string } = {}): Promise<string> {
  const cls = opts.task ? playbooksFor(opts.task)[0] : undefined;
  const known = await knownFacts(t, cls);
  const parts = [
    `# This user\n${[
      `User: ${t.settings.owner_name || t.name || t.email} <${t.email}>.${t.settings.preferred_name ? ` They go by "${t.settings.preferred_name}": that is the name you use with them.` : ""} Time zone: ${t.timezone}.`,
      env.mail.configured() ? `Your address (for send_email replies): ${t.slug}@${env.mail.domain()}.` : "",
      t.googleRefreshToken ? "Google is connected: calendar, owner_inbox and drive work." : "Google is NOT connected: calendar, owner_inbox and drive will fail; use calendar.md and email instead and mention Settings > Connect Google once.",
      `Approval rules: purchases/payments up to $${Number(t.settings.auto_approve_max_usd ?? 0)} auto-approved; auto-approved action types: ${(t.settings.auto_approve_types ?? []).join(", ") || "none"}.`,
      await integrationsLine(t),
    ]
      .filter(Boolean)
      .join("\n")}`,
  ];
  if (known) parts.push(`# What you already know about this user (from their memory files; never ask for any of it)\n${known}`);
  if (opts.task) {
    const inline = await inlinedNotes(t, opts.task).catch(() => "");
    if (inline) parts.push(inline);
  }
  // Figures the host read overnight from the sites this customer keeps asking about.
  try {
    const { freshReadings, formatReadings } = await import("./proactive.js");
    const readings = formatReadings(await freshReadings(t), t.timezone);
    if (readings) parts.push(readings);
  } catch {
    /* optional */
  }
  if (opts.parallel !== false) {
    const note = await parallelTasksNote(t);
    if (note) parts.push(note.trim());
  }
  return parts.join("\n\n");
}

/** Which playbooks a request touches, from its words. */
const PLAYBOOK_HINTS: Array<[RegExp, string]> = [
  [/\b(bill|balance|pay|payment|refund|dispute|charge|subscription|bank|card|invoice|receipt|expense|tax|budget|mortgage|rate)s?\b/i, "money"],
  [/\b(order|buy|purchase|cart|amazon|grocer|shopping|return|price|cheapest|deliver|package|tracking)/i, "shopping"],
  [/\b(flight|hotel|trip|travel|airbnb|uber|lyft|train|airport|jfk|lga|ewr|check.?in|itinerary)\b/i, "travel"],
  [/\b(appointment|calendar|meeting|schedule|reschedule|book|reservation|table|dinner)\b/i, "calendar"],
  [/\b(doctor|dentist|prescription|pharmacy|insurance claim|health|medic)/i, "health"],
  [/\b(school|teacher|kid|daughter|son|camp|tuition)s?\b/i, "kids"],
  [/\b(plumber|electrician|contractor|repair|landlord|lease|utility|con ?ed|internet|cable|clean)/i, "home"],
  [/\b(form|dmv|passport|renew|license|permit|notary|document|paperwork|application)s?\b/i, "paperwork"],
  [/\b(email|inbox|reply|draft|unsubscribe|newsletter)s?\b/i, "inbox"],
  [/\b(research|compare|find (me )?the best|options|recommend)/i, "research"],
  [/\b(birthday|gift|anniversary|thank.?you|invite|rsvp)/i, "people"],
];

/** Which no-browser data sources this customer has right now: bank accounts, carrier tracking, the local browser relay. */
async function integrationsLine(t: Tenant): Promise<string> {
  const parts: string[] = [];
  try {
    const { plaidConfigured, listItems } = await import("./plaid.js");
    if (plaidConfigured()) {
      const items = await listItems(t);
      parts.push(items.length ? `Bank accounts connected (${items.map((i) => i.institution ?? "bank").join(", ")}): use the bank tool for balances and spending, never the bank's site.` : "No bank accounts connected (the user can add one under Settings > Bank accounts).");
    }
    const { trackingConfigured } = await import("./tracking.js");
    const carriers = trackingConfigured();
    if (carriers.length) parts.push(`Package tracking by API: ${carriers.map((c) => c.toUpperCase()).join(", ")} (track_package).`);
    const { relayStatus } = await import("./relay.js");
    const relay = await relayStatus(t);
    if (relay.devices.length) parts.push(relay.online ? "Local browser relay: ONLINE (the user's own computer; local_browser works for sites that block the hosted browser)." : "Local browser relay: offline right now (the user has the extension but their browser is not connected).");
  } catch {
    /* an integration check never blocks a turn */
  }
  return parts.join("\n");
}

/** The playbooks a request touches, in order of the hints' priority. */
export function playbooksFor(text: string): string[] {
  const t = text.replace(/^\[[^\]]+\]\n/, "").slice(0, 2000);
  return [...new Set(PLAYBOOK_HINTS.filter(([re]) => re.test(t)).map(([, b]) => b))];
}

/** Domains named in the request ("coned.com", "uber", "amazon"). */
function sitesIn(text: string): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(/\b([a-z0-9-]+\.(?:com|net|org|gov|edu|co|io|us))\b/gi)) out.add(m[1].toLowerCase().replace(/^www\./, ""));
  for (const [, name] of text.matchAll(/\b(amazon|uber|lyft|coned|con ed(?:ison)?|zillow|verizon|chase|amex|netflix|costco|walmart|target|delta|jetblue|united|expedia|opentable|resy|doordash|instacart|quickbooks)\b/gi)) out.add(name.toLowerCase().replace(/\s+/g, "") === "conedison" ? "coned.com" : `${name.toLowerCase().replace(/\s+/g, "")}.com`);
  return [...out].slice(0, 3);
}

/**
 * The playbook and site notes a task needs, inlined so the task starts working instead of spending
 * its first steps on memory_read calls. Only files that exist and only for this request.
 */
export async function inlinedNotes(t: Tenant, task: string): Promise<string> {
  const text = task.replace(/^\[[^\]]+\]\n/, "").slice(0, 2000);
  const books = [...new Set(PLAYBOOK_HINTS.filter(([re]) => re.test(text)).map(([, b]) => b))].slice(0, 2);
  const parts: string[] = [];
  for (const b of books) {
    const c = await readMemory(t, `playbooks/${b}.md`).catch(() => null);
    if (c) parts.push(`## playbooks/${b}.md\n${c.trim().slice(0, 6000)}`);
  }
  for (const d of sitesIn(text)) {
    const c = await readMemory(t, `sites/${d}.md`).catch(() => null);
    if (c) parts.push(`## sites/${d}.md\n${c.trim().slice(0, 3000)}`);
  }
  return parts.length ? `# Notes for this task (already read for you; no need to memory_read them)\n${parts.join("\n\n")}` : "";
}

async function parallelTasksNote(t: Tenant): Promise<string> {
  const tasks = await activeTaskSessions(t.id).catch(() => [] as SessionRow[]);
  if (!tasks.length) return "";
  const lines = tasks.map((s) => `- "${(s.title ?? "task").slice(0, 120)}" (${s.status === "waiting" ? "waiting on the user" : "running"}, started ${Math.max(1, Math.round((Date.now() - new Date(s.created_at).getTime()) / 60_000))} min ago)`);
  return `\n\n# Tasks running alongside this chat right now\nThese run as separate sessions; their results appear in the chat when they finish. Do not redo them or report on them; if the user asks about one, say it is still running (or waiting on them) and continue with what they asked you.\n${lines.join("\n")}`;
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

/** Messages plus status, one query: the loop stops when the user cancelled the session meanwhile. */
export async function getLoopState(id: string): Promise<{ messages: ChatMessage[]; status: SessionRow["status"] } | undefined> {
  return one<{ messages: ChatMessage[]; status: SessionRow["status"] }>("select messages, status from agent_sessions where id = $1", [id]);
}

/**
 * The hosted browser another of this customer's sessions is using right now, so a second task joins
 * it (its own tab, the same cookies) instead of opening a second browser that sites see as a new device.
 */
export async function otherActiveBrowsers(userId: string, exceptSessionId: string): Promise<string[]> {
  const rows = await q<{ browserbase_session_id: string }>(
    "select distinct browserbase_session_id from agent_sessions where user_id = $1 and id <> $2 and browserbase_session_id is not null and (status in ('running', 'waiting') or updated_at > now() - interval '30 minutes') order by 1",
    [userId, exceptSessionId],
  );
  return rows.map((r) => r.browserbase_session_id);
}

/** Whether any other live session still uses this hosted browser (then it must not be released). */
export async function browserShared(browserSessionId: string, exceptSessionId: string): Promise<boolean> {
  const r = await one<{ n: string }>("select count(*)::text as n from agent_sessions where browserbase_session_id = $1 and id <> $2 and status in ('running', 'waiting')", [browserSessionId, exceptSessionId]);
  return Number(r?.n ?? 0) > 0;
}

/** Stop a session the user cancelled: no more turns, nothing pending, the worker drops it at its next step. */
export async function cancelSession(row: SessionRow, note: string): Promise<void> {
  await q(
    "update agent_sessions set status = $2, pending_kind = null, pending_event_id = null, pending_deadline = null, lease_until = null, messages = messages || $3::jsonb, updated_at = now() where id = $1",
    [row.id, row.kind === "task" ? "terminated" : "idle", JSON.stringify([{ role: "assistant", content: note, ephemeral: true, at: now() }])],
  );
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
    "select * from agent_sessions where user_id = $1 and kind in ('review','weekly','followup','triage','digest','correspondence','inbox') and status in ('idle','terminated') order by created_at desc limit $2",
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
