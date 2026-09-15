import { releaseBrowser } from "./browser.js";
import { disconnectBrowser } from "./browser-tools.js";
import { q } from "./db.js";
import { env } from "./env.js";
import { tools } from "./agent-config.js";
import { complete, costCents, estimateTokens, LLMError, supportsVision, warmCatalog, type ChatMessage } from "./llm.js";
import { appendTranscript } from "./memory.js";
import { deferToDigest, notifyOwner, shouldDefer } from "./notify.js";
import { acquireLease, getSession, releaseLease, updateSession, type SessionRow, systemFor } from "./sessions.js";
import { tenantById, type Tenant } from "./tenant.js";
import { executeTool } from "./tools.js";

/**
 * The agent loop, resumable. Each invocation runs turns until the task is done, the model needs
 * the user, the time budget is spent, or the session budget is spent. State lives in the DB after
 * every turn, so any worker can pick it up.
 */
const MAX_TURNS = Number(process.env.MAX_TURNS_PER_SESSION ?? 120);
const CONTEXT_TOKENS = Number(process.env.CONTEXT_TOKEN_BUDGET ?? 40_000);
// Compact down to this share of the budget so the prefix then stays stable (and cached) for many turns.
const COMPACT_TARGET = 0.6;
// A chat session is one long conversation; once it has done this much work it is closed after the
// current task and the next message starts a fresh one (with a recap), so per-task limits never
// silence the chat.
const CHAT_ROLLOVER_TURNS = Number(process.env.CHAT_ROLLOVER_TURNS ?? 60);
const CHAT_ROLLOVER_SHARE = 0.6;

export type RunOutcome = "done" | "waiting" | "continue" | "error" | "busy";

/** A chat session that can do no more work: the next message must start a fresh one. */
export function chatSessionExhausted(row: SessionRow): boolean {
  const cap = env.plans.sessionBudgetUsd() * 100;
  return row.status === "terminated" || row.status === "error" || row.turns >= MAX_TURNS || (cap > 0 && Number(row.cost_cents) >= cap);
}

export async function runSession(sessionId: string, opts: { budgetMs?: number } = {}): Promise<RunOutcome> {
  const budgetMs = opts.budgetMs ?? 240_000;
  const started = Date.now();
  if (!(await acquireLease(sessionId, Math.ceil(budgetMs / 1000) + 60))) return "busy";
  let row = (await getSession(sessionId))!;
  const t = (await tenantById(row.user_id))!;
  await warmCatalog().catch(() => {});
  // The system message is rebuilt every run, so a session started hours ago sees today's prompt,
  // today's settings, and which services (browser, mail, Google) are available right now.
  if (row.messages[0]?.role === "system") row.messages[0] = { role: "system", content: await systemFor(t) };
  const sessionCap = env.plans.sessionBudgetUsd() * 100;

  try {
    while (Date.now() - started < budgetMs) {
      if (row.turns >= MAX_TURNS) return await finish(t, row, "I've hit the step limit for one task, so I stopped here. Here's where I got to:\n\n" + (lastAssistantText(row.messages) || "(no summary)") + "\n\nSend the next message and I'll pick it up fresh.", "idle");
      if (sessionCap > 0 && row.cost_cents >= sessionCap) return await finish(t, row, `Hit the per-task spend cap, so I paused here. Say "continue" and I'll keep going in a fresh task.\n\n${lastAssistantText(row.messages)}`, "idle");

      // The stored conversation is the user's record and is never trimmed; the model gets a working copy
      // kept under the context budget.
      const context = compacted(row.messages);
      const turnStart = Date.now();
      const timings: string[] = [];
      let completion;
      try {
        completion = await complete({ model: row.model!, messages: context, tools });
      } catch (err) {
        if (err instanceof LLMError && err.retryable) throw err; // worker will retry via cron sweep
        return await finish(t, row, `The AI provider rejected the request (${err instanceof Error ? err.message.slice(0, 200) : "error"}). Try again or tell me to use a different approach.`, "error");
      }
      timings.push(`llm=${((Date.now() - turnStart) / 1000).toFixed(1)}s`);
      const cost = costCents(completion.model, completion.usage);
      row.cost_cents = Math.round((Number(row.cost_cents) + cost) * 1000) / 1000;
      row.prompt_tokens = Number(row.prompt_tokens) + completion.usage.prompt_tokens;
      row.completion_tokens = Number(row.completion_tokens) + completion.usage.completion_tokens;
      row.cached_tokens = Number(row.cached_tokens ?? 0) + (completion.usage.cached_tokens ?? 0);
      row.turns += 1;
      row.messages.push(completion.message);
      await q(
        "insert into usage (user_id, month, cost_cents, prompt_tokens, cached_tokens) values ($1, date_trunc('month', now())::date, $2, $3, $4) on conflict (user_id, month) do update set cost_cents = usage.cost_cents + $2, prompt_tokens = usage.prompt_tokens + $3, cached_tokens = usage.cached_tokens + $4",
        [t.id, cost.toFixed(3), completion.usage.prompt_tokens, completion.usage.cached_tokens ?? 0],
      );

      const calls = completion.message.tool_calls ?? [];
      if (!calls.length) {
        const text = typeof completion.message.content === "string" ? completion.message.content.trim() : "";
        const nudge = stallNudge(row, text);
        if (nudge) {
          // The model "ended" with a promise or a question it should not ask; send it back to work.
          row.messages.push({ role: "user", content: nudge });
          await updateSession(row.id, { messages: row.messages, turns: row.turns, cost_cents: row.cost_cents, prompt_tokens: row.prompt_tokens, completion_tokens: row.completion_tokens, cached_tokens: row.cached_tokens });
          console.log(`[turn] ${row.id} #${row.turns} ${completion.model} ${timings.join(" ")} nudge: ${text.slice(0, 80).replace(/\s+/g, " ")}`);
          continue;
        }
        console.log(`[turn] ${row.id} #${row.turns} ${completion.model} ${timings.join(" ")} reply`);
        return await finish(t, row, text, "idle");
      }

      for (const call of calls) {
        let args: Record<string, unknown> = {};
        try {
          args = JSON.parse(call.function.arguments || "{}");
        } catch {
          row.messages.push({ role: "tool", tool_call_id: call.id, content: "Invalid JSON arguments; call again with valid JSON." });
          continue;
        }
        const toolStart = Date.now();
        const out = await executeTool(t, row, call.function.name, args, call.id);
        timings.push(`${call.function.name}=${((Date.now() - toolStart) / 1000).toFixed(1)}s`);
        if (out.pending) {
          console.log(`[turn] ${row.id} #${row.turns} ${completion.model} ${timings.join(" ")} pending:${out.pending}`);
          row.status = "waiting";
          await updateSession(row.id, { messages: row.messages, turns: row.turns, cost_cents: row.cost_cents, prompt_tokens: row.prompt_tokens, completion_tokens: row.completion_tokens, cached_tokens: row.cached_tokens, status: "waiting", pending_kind: out.pending, pending_event_id: call.id, lease_until: null });
          return "waiting";
        }
        row.messages.push({ role: "tool", tool_call_id: call.id, content: out.text || "(ok)" });
        if (out.imageBase64 && supportsVision(row.model ?? "")) {
          row.messages.push({ role: "user", content: [{ type: "text", text: "(screenshot)" }, { type: "image_url", image_url: { url: `data:image/jpeg;base64,${out.imageBase64}` } }] });
        } else if (out.imageBase64) {
          row.messages[row.messages.length - 1].content = "Screenshot taken, but this model cannot view images. Use browser_text or browser_snapshot instead, or escalate_model.";
        }
        if (out.escalateTo) {
          row.model = out.escalateTo;
          row.messages.push({ role: "user", content: `(You are now running on a more capable model. Continue the task from the notes above.)` });
        }
      }
      await updateSession(row.id, { messages: row.messages, turns: row.turns, cost_cents: row.cost_cents, prompt_tokens: row.prompt_tokens, completion_tokens: row.completion_tokens, cached_tokens: row.cached_tokens, model: row.model });
      console.log(`[turn] ${row.id} #${row.turns} ${completion.model} ${timings.join(" ")} total=${((Date.now() - turnStart) / 1000).toFixed(1)}s`);
    }
    // Out of time for this invocation; a follow-up kick continues it.
    await updateSession(row.id, { lease_until: null });
    return "continue";
  } catch (err) {
    await updateSession(row.id, { lease_until: null, error: (err instanceof Error ? err.message : String(err)).slice(0, 500) });
    throw err;
  }
}

/** The task ended for this turn: deliver the report on the right channel and mark idle. */
async function finish(t: Tenant, row: SessionRow, report: string, status: "idle" | "error"): Promise<RunOutcome> {
  const proactive = ["review", "weekly", "followup", "triage", "digest"].includes(row.kind);
  const silent = /^NO_REPORT\b/.test(report.trim()) && proactive;
  // The chat page renders the message list, so a report the loop wrote itself (step limit, spend cap,
  // provider error) must be in it or the user sees nothing at all.
  if (report && !silent && lastAssistantText(row.messages) !== report.trim()) row.messages.push({ role: "assistant", content: report });
  const sessionCap = env.plans.sessionBudgetUsd() * 100;
  const limitHit = row.turns >= MAX_TURNS || (sessionCap > 0 && row.cost_cents >= sessionCap);
  const rollOver = row.kind === "chat" && (status === "error" || limitHit || row.turns >= CHAT_ROLLOVER_TURNS || (sessionCap > 0 && row.cost_cents >= sessionCap * CHAT_ROLLOVER_SHARE));
  if (rollOver) status = "terminated" as typeof status;
  await updateSession(row.id, { messages: row.messages, turns: row.turns, cost_cents: row.cost_cents, prompt_tokens: row.prompt_tokens, completion_tokens: row.completion_tokens, cached_tokens: row.cached_tokens, status, last_report: report.slice(0, 20_000), lease_until: null, model: row.model });
  if (report && !silent) {
    // Mail triage can wait for the check-in times; a timer the user or the agent set fires on time.
    const holdable = row.kind === "triage";
    if (holdable && shouldDefer(t, report)) await deferToDigest(t, "From your mail", report);
    else await notifyOwner(t, row, report, row.kind === "review" ? "Morning brief" : row.kind === "weekly" ? "Week ahead" : row.kind === "digest" ? "Heads-ups" : undefined);
    await appendTranscript(t, { channel: row.channel, role: "agent", text: report }).catch(() => {});
  }
  if (row.browserbase_session_id) {
    await disconnectBrowser(row.browserbase_session_id);
    if (proactive) await releaseBrowser(row.browserbase_session_id).catch(() => {});
  }
  return status === "error" ? "error" : "done";
}

/**
 * A reply with no tool call is the end of the task. Cheaper models sometimes end with a promise
 * instead ("I'll try again now", "I'll search for the price directly"), so the user gets narration
 * three times and never the result; or they ask in prose for a default that is in the prompt
 * (the home address). Both go back to the model as a short note, at most twice per user message.
 */
export const NUDGE_PREFIX = "(Not done yet:";
const MAX_NUDGES = 2;
const PROMISED_ACTION =
  /\b(i(?:'|’)?ll|i will|let me|i(?:'|’)?m going to|i am going to)\s+(now\s+)?(try|attempt|retry|proceed|go ahead|give it|keep trying|have another|take another|search for|look (?:for|up)|open)\b|\btry(?:ing)?\s+(again|one more time|once more|another|a different)\b/i;
const ASKS_FOR_ADDRESS = /\b(provide|tell me|what(?:'|’)?s|what is|send me|confirm|i need|share)\b[^.?\n]{0,60}\b(your|the)\s+(current\s+|pickup\s+|home\s+|starting\s+|exact\s+)?(location|address)\b/i;

export function stallNudge(row: SessionRow, reply: string): string | undefined {
  if (!reply || /^NO_REPORT\b/.test(reply)) return undefined;
  // Count nudges since the user's last real message (host notes start with "(").
  let nudges = 0;
  for (let i = row.messages.length - 1; i > 0; i--) {
    const m = row.messages[i];
    if (m.role !== "user") continue;
    const c = typeof m.content === "string" ? m.content : "";
    if (c.startsWith(NUDGE_PREFIX)) nudges++;
    else if (!c.startsWith("(")) break;
  }
  if (nudges >= MAX_NUDGES) return undefined;
  const system = typeof row.messages[0]?.content === "string" ? row.messages[0].content : "";
  const homeKnown = /home address[^\n]*:\s*\S/i.test(system);
  if (homeKnown && ASKS_FOR_ADDRESS.test(reply)) {
    return `${NUDGE_PREFIX} you asked for the user's address. It is already in your system prompt under "What you already know about this user" (home address); never ask for it. Use it now and continue the task.)`;
  }
  if (PROMISED_ACTION.test(reply)) {
    return `${NUDGE_PREFIX} that reply promised an action and then ended your turn, so nothing happened and the user is still waiting. A reply without a tool call ends the task. Do the step now with tools instead of describing it. If the same route already failed twice, take a different one: another site, a direct URL, web_search, or escalate_model. Then end with the result, or with exactly where you are stuck and the live-view link.)`;
  }
  return undefined;
}

function lastAssistantText(messages: ChatMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role === "assistant" && typeof m.content === "string" && m.content.trim()) return m.content.trim();
  }
  return "";
}

/**
 * Keep the context under budget: old tool results (page snapshots) shrink to a one-line stub, and
 * old screenshots are dropped. The system prompt and the last few turns are always kept.
 */
/**
 * Old screenshots are dead weight once the model has acted on them: keep only the most recent image,
 * replacing earlier ones with their text (or a stub). A long browser task otherwise re-sends every
 * past screenshot on every turn, and images are by far the most expensive thing in the context.
 * Operates on copies; the stored conversation keeps every screenshot.
 */
export function dropStaleScreenshots(messages: ChatMessage[]): ChatMessage[] {
  let keptImage = false;
  for (let i = messages.length - 1; i >= 1; i--) {
    const m = messages[i];
    if (m.role !== "user" || !Array.isArray(m.content) || !m.content.some((p) => p.type === "image_url")) continue;
    if (!keptImage) {
      keptImage = true;
      continue;
    }
    const text = m.content.filter((p) => p.type === "text");
    m.content = text.length ? text : "(earlier screenshot dropped to save context)";
  }
  return messages;
}

function compacted(stored: ChatMessage[]): ChatMessage[] {
  const messages = dropStaleScreenshots(stored.map((m) => ({ ...m })));
  if (estimateTokens(messages) < CONTEXT_TOKENS) return messages;
  const keepTail = 12;
  for (let i = 1; i < messages.length - keepTail; i++) {
    const m = messages[i];
    if (m.role === "tool" && typeof m.content === "string" && m.content.length > 300) {
      m.content = m.content.slice(0, 200) + "\n... [older tool output trimmed]";
    } else if (m.role === "user" && Array.isArray(m.content)) {
      const text = m.content.filter((p) => p.type === "text");
      m.content = text.length ? text : "(screenshot removed)";
    }
  }
  if (estimateTokens(messages) < CONTEXT_TOKENS) return messages;
  // Still too big: drop the oldest middle turns entirely, keeping system + first user message.
  // Go well under the budget in one pass: every drop changes the prefix and invalidates the cache.
  while (estimateTokens(messages) >= CONTEXT_TOKENS * COMPACT_TARGET && messages.length > keepTail + 2) {
    const victim = messages[2];
    messages.splice(2, 1);
    // Never leave a dangling tool result without its call, or a call without its result.
    if (victim.role === "assistant" && victim.tool_calls) while (messages[2]?.role === "tool") messages.splice(2, 1);
  }
  return messages;
}

/** Fire-and-forget: ask a worker to continue this session. */
export async function kick(sessionId: string): Promise<void> {
  const url = `${env.appUrl()}/api/run?session=${encodeURIComponent(sessionId)}`;
  try {
    // The secret travels in a header, never in the URL, so request logs do not carry it.
    await fetch(url, { method: "POST", headers: { Authorization: `Bearer ${env.cronSecret()}` }, signal: AbortSignal.timeout(3000) });
  } catch {
    /* the cron sweep picks it up if the kick did not land */
  }
}
