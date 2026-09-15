import { releaseBrowser } from "./browser.js";
import { disconnectBrowser } from "./browser-tools.js";
import { q } from "./db.js";
import { env } from "./env.js";
import { tools } from "./agent-config.js";
import { complete, costCents, estimateTokens, LLMError, supportsVision, warmCatalog, type ChatMessage, type Completion } from "./llm.js";
import { appendTranscript } from "./memory.js";
import { deferToDigest, notifyOwner, shouldDefer } from "./notify.js";
import { isQuickQuestion, modelFor, tierOfModel } from "./router.js";
import { acquireLease, getMessages, getSession, messageText, persistTurn, taskClockStart, taskStart, taskTurns, taskUserText, updateSession, type SessionRow, systemFor } from "./sessions.js";
import { tenantById, type Tenant } from "./tenant.js";
import { executeTool } from "./tools.js";

/**
 * The agent loop, resumable. Each invocation runs turns until the task is done, the model needs
 * the user, the time budget is spent, or the session budget is spent. State lives in the DB after
 * every turn, so any worker can pick it up.
 *
 * Budgets are per task (from the user's latest message), not per chat thread: a thread that has
 * done ten tasks still gives the eleventh a full budget. The thread itself has a larger ceiling,
 * after which it rolls over to a fresh one with a recap.
 */
const MAX_TASK_TURNS = Number(process.env.MAX_TURNS_PER_TASK ?? 100);
const MAX_SESSION_TURNS = Number(process.env.MAX_TURNS_PER_SESSION ?? 300);
// Wall clock per task, not counting time spent waiting for the user. A task that runs longer than
// this stops with a report of where it got to; the user can say "keep going".
const TASK_TIME_LIMIT_MS = Number(process.env.TASK_TIME_LIMIT_MINUTES ?? 15) * 60_000;
// After this long with nothing shown to the user, the model is told to post a one-line progress note.
const PROGRESS_NOTE_MS = Number(process.env.PROGRESS_NOTE_MINUTES ?? 3) * 60_000;
// A quick question ("what's up", "thanks", "how's it going") gets this many tool steps, then a reply.
const QUICK_STEPS = Number(process.env.QUICK_STEPS ?? 3);
const QUICK_TIME_MS = Number(process.env.QUICK_SECONDS ?? 75) * 1000;
const CONTEXT_TOKENS = Number(process.env.CONTEXT_TOKEN_BUDGET ?? 40_000);
// Compact down to this share of the budget so the prefix then stays stable (and cached) for many turns.
const COMPACT_TARGET = 0.6;
// A chat session is one long conversation; once it has done this much work it is closed after the
// current task and the next message starts a fresh one (with a recap), so the context stays sharp.
const CHAT_ROLLOVER_TURNS = Number(process.env.CHAT_ROLLOVER_TURNS ?? 120);
const CHAT_ROLLOVER_SHARE = 0.6;
// How many identical tool calls in a row count as a stuck loop (a real failure hit ~40).
const LOOP_LIMIT = Number(process.env.LOOP_LIMIT ?? 6);

export type RunOutcome = "done" | "waiting" | "continue" | "error" | "busy";

/**
 * A chat session that can do no more work: the next message must start a fresh one. A one-off
 * provider error does NOT exhaust the chat — the same thread stays open so the user can just retry
 * and keep their context, instead of silently losing the conversation. Only a hard, terminated
 * session or the real thread/spend limits roll over.
 */
export function chatSessionExhausted(row: SessionRow): boolean {
  const cap = env.plans.sessionBudgetUsd() * 100;
  return row.status === "terminated" || row.turns >= MAX_SESSION_TURNS || (cap > 0 && Number(row.cost_cents) >= cap);
}

const stamp = () => new Date().toISOString();

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
  // Everything up to here is already in the DB; the loop only ever appends beyond this index, so a
  // message the user sends mid-task (its own atomic append) is never overwritten.
  let persisted = row.messages.length;
  // Loop guard: a cheap model can get wedged repeating one action (40x browser_press in a real case)
  // or a short cycle of them (snapshot, click, snapshot, click...), burning the whole step budget
  // with zero progress. Track recent tool calls; on a repeating pattern, escalate once to a stronger
  // model, then stop with a clear message rather than spin.
  const sigs: string[] = [];
  let escalatedForLoop = false;
  const save = (patch: Partial<SessionRow> = {}) =>
    persistTurn(row.id, row.messages.slice(persisted), { turns: row.turns, cost_cents: row.cost_cents, prompt_tokens: row.prompt_tokens, completion_tokens: row.completion_tokens, cached_tokens: row.cached_tokens, model: row.model, ...patch }).then(() => {
      persisted = row.messages.length;
    });

  try {
    while (Date.now() - started < budgetMs) {
      // Resync to the DB (the source of truth) so a message the user sent mid-task is picked up and
      // handled in this same session, never lost. The DB only grows (every writer appends), so adopt
      // it whenever it is longer, keeping our freshly rebuilt system prompt in slot 0.
      const dbMsgs = await getMessages(sessionId).catch(() => null);
      if (dbMsgs && dbMsgs.length > row.messages.length) {
        const sys = row.messages[0];
        row.messages = dbMsgs;
        if (sys?.role === "system" && row.messages[0]?.role === "system") row.messages[0] = sys;
      }
      persisted = row.messages.length;

      // ---- budgets, checked against the current task
      if (sessionCap > 0 && row.cost_cents >= sessionCap) {
        return await finish(t, row, persisted, await wrapUp(t, row, "You hit the spend cap for this thread.", "Hit the spend cap for this thread, so I paused here."), "idle");
      }
      if (row.turns >= MAX_SESSION_TURNS) {
        const summary = await wrapUp(t, row, "This thread has reached its step ceiling.", "This thread has run long, so I'm closing it here.");
        return await finish(t, row, persisted, `${summary}\n\nYour next message starts a fresh thread; I'll carry over a recap.`, "idle");
      }
      const steps = taskTurns(row.messages);
      if (steps >= MAX_TASK_TURNS) {
        const summary = await wrapUp(t, row, `You have taken ${steps} steps on this task without finishing.`, `I've taken ${steps} steps on this without finishing, so I stopped.`);
        return await finish(t, row, persisted, `${summary}\n\nTell me to keep going, or what to change.`, "idle");
      }
      const clock = taskClockStart(row.messages);
      const elapsed = clock ? Date.now() - clock : 0;
      if (TASK_TIME_LIMIT_MS > 0 && elapsed > TASK_TIME_LIMIT_MS) {
        const mins = Math.round(elapsed / 60_000);
        const summary = await wrapUp(t, row, `You have been on this task for ${mins} minutes without finishing.`, `I've been on this for ${mins} minutes without finishing, so I stopped.`);
        return await finish(t, row, persisted, `${summary}\n\nTell me to keep going, or what to change.`, "idle");
      }
      // A quick question must not turn into a task: a few lookups, then the reply. Past that, the
      // model is told to answer with what it has; if it still will not, the host wraps it up.
      const quick = isQuickQuestion(taskUserText(row.messages));
      if (quick && (steps >= QUICK_STEPS || elapsed > QUICK_TIME_MS)) {
        if (hasHostNote(row.messages, QUICK_NOTE) && steps >= QUICK_STEPS + 2) {
          return await finish(t, row, persisted, await wrapUp(t, row, "This was a quick question and you kept working instead of answering.", "Here's where things stand."), "idle");
        }
        if (!hasHostNote(row.messages, QUICK_NOTE)) {
          row.messages.push({ role: "user", content: QUICK_NOTE });
          await save();
        }
      }
      // A long task with nothing said yet: ask for a one-line progress note (once per task).
      if (!quick && PROGRESS_NOTE_MS > 0 && elapsed > PROGRESS_NOTE_MS && !shownSinceTaskStart(row.messages) && !hasHostNote(row.messages, PROGRESS_NOTE)) {
        row.messages.push({ role: "user", content: PROGRESS_NOTE });
        await save();
      }

      // The stored conversation is the user's record and is never trimmed; the model gets a working copy
      // kept under the context budget.
      const context = compacted(row.messages);
      const turnStart = Date.now();
      const timings: string[] = [];
      let completion: Completion;
      try {
        completion = await complete({ model: row.model!, messages: context, tools });
      } catch (err) {
        if (err instanceof LLMError && err.retryable) throw err; // worker will retry via cron sweep
        return await finish(t, row, persisted, `The AI provider rejected the request (${err instanceof Error ? err.message.slice(0, 200) : "error"}). Try again or tell me to use a different approach.`, "error");
      }
      timings.push(`llm=${((Date.now() - turnStart) / 1000).toFixed(1)}s`);
      await charge(t, row, completion);
      row.messages.push({ ...completion.message, at: stamp() });

      const calls = completion.message.tool_calls ?? [];
      if (!calls.length) {
        // The reply is what the user reads: drop the closing filler chat models add.
        if (typeof completion.message.content === "string") completion.message.content = row.messages[row.messages.length - 1].content = unfilled(completion.message.content);
        const text = typeof completion.message.content === "string" ? completion.message.content.trim() : "";
        const nudge = stallNudge(row, text);
        if (nudge) {
          // The model "ended" with a promise, an offer to look something up, an empty reply, or a
          // question it should not ask; send it back to work.
          row.messages.push({ role: "user", content: nudge });
          await save();
          console.log(`[turn] ${row.id} #${row.turns} ${completion.model} ${timings.join(" ")} nudge: ${text.slice(0, 80).replace(/\s+/g, " ")}`);
          continue;
        }
        if (!text) {
          // Still nothing after a nudge: the user must not be left with a blank. Get a summary.
          return await finish(t, row, persisted, await wrapUp(t, row, "Your last reply was empty.", "I stopped without a result."), "idle");
        }
        // The task looks done. If the user sent something while we were finishing, handle it too
        // instead of ending: persist this reply and loop, where the top picks the new message up.
        const pending = await getMessages(sessionId).catch(() => null);
        if (pending && pending.length > persisted) {
          await save();
          console.log(`[turn] ${row.id} #${row.turns} ${completion.model} ${timings.join(" ")} reply+more`);
          continue;
        }
        console.log(`[turn] ${row.id} #${row.turns} ${completion.model} ${timings.join(" ")} reply`);
        return await finish(t, row, persisted, text, "idle");
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
          await save({ status: "waiting", pending_kind: out.pending, pending_event_id: call.id, lease_until: null });
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

      // Loop guard. Polling waits (browser_watch/browser_wait_for) are meant to repeat, so they don't count.
      for (const c of calls) if (!/^browser_(watch|wait_for)$/.test(c.function.name)) sigs.push(`${c.function.name}:${c.function.arguments}`);
      if (sigs.length > 24) sigs.splice(0, sigs.length - 24);
      const lastSig = sigs[sigs.length - 1] ?? "";
      // Reading a long page means scrolling many times; give scrolling three times the rope.
      const period = loopPeriod(sigs, lastSig.startsWith("browser_scroll:") ? LOOP_LIMIT * 3 : LOOP_LIMIT);
      if (period) {
        await save();
        if (!escalatedForLoop && tierOfModel(row.model ?? "", t) !== "hard") {
          // Give it one real chance to break out on a stronger model before giving up.
          escalatedForLoop = true;
          row.model = modelFor("hard", t);
          sigs.length = 0;
          row.messages.push({ role: "user", content: "(You have repeated the same steps several times with no progress — this is a dead end. Stop repeating them. Read the page fresh and take a completely different approach. If a login failed, a code or captcha is blocking you, or the site simply will not let you through, do NOT keep trying: stop and tell the user in one line exactly what is blocking you and what you need from them. You are now on a stronger model.)" });
          await save();
          console.log(`[turn] ${row.id} #${row.turns} loop (period ${period}) on ${lastSig.slice(0, 40)} -> escalate`);
          continue;
        }
        console.log(`[turn] ${row.id} #${row.turns} loop (period ${period}) on ${lastSig.slice(0, 40)} -> stop`);
        return await finish(t, row, persisted, await wrapUp(t, row, "You kept repeating the same steps with no progress and were stopped.", stuckMessage(row)), "idle");
      }

      await save();
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

/** Book a completion's cost and tokens on the session and the month. */
async function charge(t: Tenant, row: SessionRow, completion: Completion): Promise<void> {
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
}

/**
 * The task is being stopped by the host (step or time limit, a loop, an empty reply): ask the model
 * for a short, honest report of where it got to instead of quoting its last line, which in a real
 * case was just "On it, Boss". One cheap call, no tools; `fallback` is used if it fails.
 */
async function wrapUp(t: Tenant, row: SessionRow, reason: string, fallback: string): Promise<string> {
  try {
    const context = compacted(row.messages);
    context.push({
      role: "user",
      content: `(${reason} Stop working now and report to the user in at most three short lines: what you got done, what you found (figures, confirmation numbers), and exactly what is blocking or what you need from them. Plain words, no tool calls, no promises, no browser links, no site names.)`,
    });
    const c = await complete({ model: row.model!, messages: context, tools, toolChoice: "none", maxTokens: 400 });
    await charge(t, row, c);
    const text = typeof c.message.content === "string" ? c.message.content.trim() : "";
    if (text && !c.message.tool_calls?.length) return text;
  } catch (err) {
    console.error(`[wrapup] ${row.id}: ${err instanceof Error ? err.message : String(err)}`);
  }
  const last = lastAssistantText(row.messages);
  return last ? `${fallback} Here's where I got to:\n\n${last}` : fallback;
}

/** The task ended for this turn: deliver the report on the right channel and mark idle. */
async function finish(t: Tenant, row: SessionRow, persisted: number, report: string, status: "idle" | "error"): Promise<RunOutcome> {
  const proactive = ["review", "weekly", "followup", "triage", "digest"].includes(row.kind);
  const silent = /^NO_REPORT\b/.test(report.trim()) && proactive;
  // The chat page renders the message list, so a report the loop wrote itself (step limit, spend cap,
  // provider error) must be in it or the user sees nothing at all.
  if (report && !silent && lastAssistantText(row.messages) !== report.trim()) row.messages.push({ role: "assistant", content: report, at: stamp() });
  const sessionCap = env.plans.sessionBudgetUsd() * 100;
  const limitHit = row.turns >= MAX_SESSION_TURNS || (sessionCap > 0 && row.cost_cents >= sessionCap);
  // A provider error no longer terminates the chat: the thread stays open (status "error", still
  // resumable) so the next message continues it with full context. Only the real limits roll over.
  const rollOver = row.kind === "chat" && (limitHit || row.turns >= CHAT_ROLLOVER_TURNS || (sessionCap > 0 && row.cost_cents >= sessionCap * CHAT_ROLLOVER_SHARE));
  if (rollOver) status = "terminated" as typeof status;
  // Append-only: never overwrite the whole array, or a message the user just sent is lost.
  await persistTurn(row.id, row.messages.slice(persisted), { turns: row.turns, cost_cents: row.cost_cents, prompt_tokens: row.prompt_tokens, completion_tokens: row.completion_tokens, cached_tokens: row.cached_tokens, status, last_report: report.slice(0, 20_000), lease_until: null, model: row.model });
  // A message that landed while we were finishing: flip back to running and re-kick so it gets
  // answered now, instead of sitting idle until the user sends something else.
  if (!rollOver && status === "idle") {
    const after = await getMessages(row.id).catch(() => null);
    if (after && after.length > row.messages.length) {
      await updateSession(row.id, { status: "running", lease_until: null });
      await kick(row.id);
    }
  }
  if (report && !silent) {
    // Mail triage can wait for the check-in times; a timer the user or the agent set fires on time.
    const holdable = row.kind === "triage";
    if (holdable && shouldDefer(t, report)) await deferToDigest(t, "From your mail", report);
    else await notifyOwner(t, row, report, row.kind === "review" ? "Morning brief" : row.kind === "weekly" ? "Week ahead" : row.kind === "digest" ? "Heads-ups" : undefined);
    await appendTranscript(t, { channel: row.channel, role: "agent", text: report }).catch(() => {});
  }
  if (row.browserbase_session_id) {
    await disconnectBrowser(row.browserbase_session_id);
    // Self-started sessions and parallel tasks are done with their browser; the chat thread keeps its own.
    if (proactive || row.kind === "task") await releaseBrowser(row.browserbase_session_id).catch(() => {});
  }
  return status === "error" ? "error" : "done";
}

/**
 * A reply with no tool call is the end of the task. Cheaper models sometimes end with a promise
 * instead ("I'll try again now", "I'll search for the price directly"), so the user gets narration
 * three times and never the result; or they offer to look something up instead of looking it up
 * ("Want me to check the balance?"); or they ask in prose for a default that is in the prompt (the
 * home address); or they reply with nothing at all. Each goes back to the model as a short note,
 * each kind once and at most twice per user message.
 */
export const NUDGE_PREFIX = "(Not done yet:";
const MAX_NUDGES = 2;
const NUDGES: Record<string, string> = {
  address: `${NUDGE_PREFIX} you asked for the user's address. It is already in your system prompt under "What you already know about this user" (home address); never ask for it. Use it now and continue the task.)`,
  promise: `${NUDGE_PREFIX} that reply promised an action and then ended your turn, so nothing happened and the user is still waiting. A reply without a tool call ends the task. Do the step now with tools instead of describing it. If the same route already failed twice, take a different one: another site, a direct URL, web_search, or escalate_model. Then end with the result, or with exactly where you are stuck.)`,
  offer: `${NUDGE_PREFIX} you offered to look something up instead of looking it up. "Want me to check?" is never a reply. If it is something you can find yourself (a balance, a price, a page, a status, a date), do it now with tools and reply with what you found. Only a step that spends money, messages an outsider, or commits the user waits for a yes; if that is what you asked about, send the same reply again unchanged.)`,
  empty: `${NUDGE_PREFIX} that reply was empty, so the user saw nothing. Reply with the result, or with exactly where you are and what you need from them.)`,
  gaveUp: `${NUDGE_PREFIX} that reply gives up after only a few steps. A capable assistant does not report failure until a different route has failed too: another page or a direct URL, the site's search, web_search for the answer or the right page, a fresh browser_wait_for and snapshot, or escalate_model. Try the next route now with tools. Report failure only after it fails as well, and then say exactly what you tried and what the user can do. If the request is genuinely impossible for you (a phone call, something physical), send the same reply again unchanged.)`,
};
const GAVE_UP = /\b(couldn'?t|could not|unable to|can'?t|cannot|wasn'?t able|not able to|failed to|didn'?t work|no luck|not possible)\b/i;
/** A task that stops with a failure report before this many steps has not really tried. */
const GAVE_UP_STEPS = Number(process.env.GAVE_UP_STEPS ?? 12);
const PROMISED_ACTION =
  /\b(i(?:'|’)?ll|i will|let me|i(?:'|’)?m going to|i am going to)\s+(now\s+)?(try|attempt|retry|proceed|go ahead|give it|keep trying|have another|take another|search for|look (?:for|up)|open)\b|\btry(?:ing)?\s+(again|one more time|once more|another|a different)\b/i;
const ASKS_FOR_ADDRESS = /\b(provide|tell me|what(?:'|’)?s|what is|send me|confirm|i need|share)\b[^.?\n]{0,60}\b(your|the)\s+(current\s+|pickup\s+|home\s+|starting\s+|exact\s+)?(location|address)\b/i;
const OFFERS_LOOKUP = /\b(want|would you like|do you want|should|shall)\s+(me|i)\s+(to\s+)?(check|look|pull|find|see|verify|confirm|dig|get|grab|open|read|search|run|log)\b/i;

export function stallNudge(row: SessionRow, reply: string): string | undefined {
  if (/^NO_REPORT\b/.test(reply)) return undefined;
  // Nudges already given since the user's last real message (host notes start with "(").
  const given = new Set<string>();
  for (let i = row.messages.length - 1; i > 0; i--) {
    const m = row.messages[i];
    if (m.role !== "user" || m.ephemeral) continue;
    const c = messageText(m);
    if (c.startsWith(NUDGE_PREFIX)) {
      for (const [kind, text] of Object.entries(NUDGES)) if (c === text) given.add(kind);
    } else if (!c.startsWith("(")) break;
  }
  if (given.size >= MAX_NUDGES) return undefined;
  const pick = (kind: string) => (given.has(kind) ? undefined : NUDGES[kind]);
  if (!reply.trim()) return pick("empty");
  const system = typeof row.messages[0]?.content === "string" ? row.messages[0].content : "";
  const homeKnown = /home address[^\n]*:\s*\S/i.test(system);
  if (homeKnown && ASKS_FOR_ADDRESS.test(reply)) return pick("address");
  if (PROMISED_ACTION.test(reply)) return pick("promise");
  if (OFFERS_LOOKUP.test(reply)) return pick("offer");
  // Giving up early on a task that used tools: a few steps in, the first failure is not the answer.
  if (GAVE_UP.test(reply) && taskUsedTools(row.messages) && taskTurns(row.messages) < GAVE_UP_STEPS) return pick("gaveUp");
  return undefined;
}

function taskUsedTools(messages: ChatMessage[]): boolean {
  for (let i = taskStart(messages); i < messages.length; i++) if (messages[i].role === "assistant" && messages[i].tool_calls?.length) return true;
  return false;
}

/**
 * Closing filler a chat model tacks on ("Anything else on your mind tonight?", "Let me know if you
 * need anything else!", "Hope this helps!"): removed before the user sees it. Only trailing sentences
 * go; a real question stays, and a reply is never emptied.
 */
const FILLER = /\s*(?:(?:is there )?anything else[^.!?\n]*[.!?]|what else can (?:i|we)[^.!?\n]*[.!?]|(?:just )?let me know (?:if|when|what)[^.!?\n]*[.!?]|(?:i )?hope (?:this|that) helps[^.!?\n]*[.!?]|happy to help[^.!?\n]*[.!?]|(?:feel free|don'?t hesitate) to[^.!?\n]*[.!?]|(?:i'?m|i am) here (?:if|whenever)[^.!?\n]*[.!?]|you'?re all set[.!]|have a (?:great|good|nice)[^.!?\n]*[.!?])\s*$/i;
export function unfilled(text: string): string {
  let out = text.trimEnd();
  for (let i = 0; i < 3; i++) {
    const next = out.replace(FILLER, "");
    if (next === out) break;
    out = next.trimEnd();
  }
  return out.trim() ? out : text;
}

/** The host's note when a greeting or status question is turning into a task. */
export const QUICK_NOTE = "(That was a quick question, not a task. Reply now, in one or two lines, from what you already know and what you just looked up. Do not open the browser or start on open items; if something needs doing, say so in half a line and wait for the go-ahead.)";

/** The host's request for a progress line during a long, silent task. */
export const PROGRESS_NOTE = "(Several minutes in and the user has heard nothing. Call tell_user now with one line on where you are and what comes next, then continue the task.)";

function hasHostNote(messages: ChatMessage[], note: string): boolean {
  for (let i = messages.length - 1; i >= taskStart(messages); i--) if (messages[i].role === "user" && messageText(messages[i]) === note) return true;
  return false;
}

/** Whether the user has seen anything from the agent since the task started: a tell_user line or a reply. */
export function shownSinceTaskStart(messages: ChatMessage[]): boolean {
  for (let i = taskStart(messages); i < messages.length; i++) {
    const m = messages[i];
    if (m.role !== "assistant" || m.ephemeral) continue;
    if (m.tool_calls?.some((c) => c.function.name === "tell_user")) return true;
    if (!m.tool_calls?.length && typeof m.content === "string" && m.content.trim()) return true;
  }
  return false;
}

/**
 * The period (1..3) of the pattern the recent tool calls repeat, or 0 when they do not look stuck.
 * The same call `limit` times in a row is period 1; the same pair of calls `limit` times over is
 * period 2 (snapshot, click [12], snapshot, click [12], ...). Different arguments break the pattern,
 * so filling a form or working through a list never trips it.
 */
export function loopPeriod(sigs: string[], limit: number): number {
  const n = sigs.length;
  for (let p = 1; p <= 3; p++) {
    const need = limit * p;
    if (n < need) continue;
    let same = true;
    for (let i = n - need + p; i < n && same; i++) if (sigs[i] !== sigs[i - p]) same = false;
    if (same) return p;
  }
  return 0;
}

function lastAssistantText(messages: ChatMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    // Skip the ephemeral "on it" ack and tell_user copies, or a summary would just quote "On it, Boss".
    if (m.role === "assistant" && !m.ephemeral && !m.tool_calls?.length && typeof m.content === "string" && m.content.trim()) return m.content.trim();
  }
  return "";
}

/** A useful message when the loop guard trips and the model cannot summarise: tailored if the recent tool results show a login/verification wall. */
function stuckMessage(row: SessionRow): string {
  const recent = row.messages.slice(-12).map((m) => (typeof m.content === "string" ? m.content : "")).join("\n").toLowerCase();
  if (/needs_user|password form is still|rejected the (login|saved password)|no_credentials/.test(recent)) {
    return "I couldn't get signed in — the site blocked the automated login (it likely needs a code, a captcha, or the saved login is off). I stopped instead of spinning on it. Want me to try again, or check the login under Settings › Logins?";
  }
  if (/captcha|verify you are human|are you a robot|challenge|bot check/.test(recent)) {
    return "The site's bot check won't let me sign in. Open the Logins tab, tap Watch the browser, sign in there once (it sticks), then tell me \"done\" and I'll take it from there.";
  }
  return "I got stuck repeating the same step without making progress, so I stopped instead of burning time. Tell me to retry or point me at a different approach and I'll jump back on it.";
}

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

/**
 * Keep the context under budget: old tool results (page snapshots) shrink to a one-line stub, and
 * old screenshots are dropped. The system prompt and the last few turns are always kept.
 */
export function compacted(stored: ChatMessage[]): ChatMessage[] {
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
