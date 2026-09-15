import { releaseBrowser } from "./browser.js";
import { q } from "./db.js";
import { env } from "./env.js";
import { tools } from "./agent-config.js";
import { complete, costCents, estimateTokens, LLMError, supportsVision, type ChatMessage } from "./llm.js";
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

export type RunOutcome = "done" | "waiting" | "continue" | "error" | "busy";

export async function runSession(sessionId: string, opts: { budgetMs?: number } = {}): Promise<RunOutcome> {
  const budgetMs = opts.budgetMs ?? 240_000;
  const started = Date.now();
  if (!(await acquireLease(sessionId, Math.ceil(budgetMs / 1000) + 60))) return "busy";
  let row = (await getSession(sessionId))!;
  const t = (await tenantById(row.user_id))!;
  // The system message is rebuilt every run, so a session started hours ago sees today's prompt,
  // today's settings, and which services (browser, mail, Google) are available right now.
  if (row.messages[0]?.role === "system") row.messages[0] = { role: "system", content: systemFor(t) };
  const sessionCap = env.plans.sessionBudgetUsd() * 100;

  try {
    while (Date.now() - started < budgetMs) {
      if (row.turns >= MAX_TURNS) return await finish(t, row, "I've hit the step limit for one task. Here's where I got to:\n\n" + (lastAssistantText(row.messages) || "(no summary)"), "idle");
      if (sessionCap > 0 && row.cost_cents >= sessionCap) return await finish(t, row, `Hit the per-task spend cap, so I paused. Say "continue" if you want me to keep going.\n\n${lastAssistantText(row.messages)}`, "idle");

      compact(row.messages);
      let completion;
      try {
        completion = await complete({ model: row.model!, messages: row.messages, tools });
      } catch (err) {
        if (err instanceof LLMError && err.retryable) throw err; // worker will retry via cron sweep
        return await finish(t, row, `The AI provider rejected the request (${err instanceof Error ? err.message.slice(0, 200) : "error"}). Try again or tell me to use a different approach.`, "error");
      }
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
        const out = await executeTool(t, row, call.function.name, args, call.id);
        if (out.pending) {
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
  await updateSession(row.id, { messages: row.messages, turns: row.turns, cost_cents: row.cost_cents, prompt_tokens: row.prompt_tokens, completion_tokens: row.completion_tokens, cached_tokens: row.cached_tokens, status, last_report: report.slice(0, 20_000), lease_until: null, model: row.model });
  if (report && !silent) {
    // Mail triage can wait for the check-in times; a timer the user or the agent set fires on time.
    const holdable = row.kind === "triage";
    if (holdable && shouldDefer(t, report)) await deferToDigest(t, "From your mail", report);
    else await notifyOwner(t, row, report, row.kind === "review" ? "Morning brief" : row.kind === "weekly" ? "Week ahead" : row.kind === "digest" ? "Heads-ups" : undefined);
    await appendTranscript(t, { channel: row.channel, role: "agent", text: report }).catch(() => {});
  }
  if (proactive && row.browserbase_session_id) await releaseBrowser(row.browserbase_session_id).catch(() => {});
  return status === "error" ? "error" : "done";
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
function compact(messages: ChatMessage[]): void {
  if (estimateTokens(messages) < CONTEXT_TOKENS) return;
  const keepTail = 12;
  for (let i = 1; i < messages.length - keepTail; i++) {
    const m = messages[i];
    if (m.role === "tool" && typeof m.content === "string" && m.content.length > 300) {
      m.content = m.content.slice(0, 200) + "\n... [older tool output trimmed]";
    } else if (m.role === "user" && Array.isArray(m.content)) {
      m.content = m.content.filter((p) => p.type === "text").map((p) => (p.type === "text" ? p : p)) as ChatMessage["content"];
      if (Array.isArray(m.content) && !m.content.length) m.content = "(screenshot removed)";
    }
  }
  if (estimateTokens(messages) < CONTEXT_TOKENS) return;
  // Still too big: drop the oldest middle turns entirely, keeping system + first user message.
  // Go well under the budget in one pass: every drop changes the prefix and invalidates the cache.
  while (estimateTokens(messages) >= CONTEXT_TOKENS * COMPACT_TARGET && messages.length > keepTail + 2) {
    const victim = messages[2];
    messages.splice(2, 1);
    // Never leave a dangling tool result without its call, or a call without its result.
    if (victim.role === "assistant" && victim.tool_calls) while (messages[2]?.role === "tool") messages.splice(2, 1);
  }
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
