import { releaseBrowser } from "./browser.js";
import { batchConfigured, enqueue } from "./batch.js";
import { checkpointPaths, recordPaths } from "./browser-extras.js";
import { closeTab, disconnectBrowser, runBrowserTool } from "./browser-tools.js";
import { q } from "./db.js";
import { env } from "./env.js";
import { tools, toolsFor, type ToolOpts } from "./agent-config.js";
import { complete, estimateTokens, LLMError, supportsVision, warmCatalog, type ChatMessage, type Completion } from "./llm.js";
import { appendMemory, appendTranscript } from "./memory.js";
import { appendAssistantMessage } from "./sessions.js";
import { deferToDigest, notifyOwner, shouldDefer } from "./notify.js";
import { quickLookup } from "./research.js";
import { isHardSite, isLookupQuestion, isQuickQuestion, modelFor, nextTier, RANK, reasoningFor, tierOfModel, type Tier } from "./router.js";
import { stubPageResult, stubSearchResult } from "./search.js";
import { registrableDomain } from "./credentials.js";
import { learnFromCorrection } from "./learn.js";
import { guessOutcome, reflect } from "./learning.js";
import { detectFixes, gradeReply, keepPromise, recordFixes, suggestReplies } from "./proactive.js";
import { loadModelHistory } from "./model-history.js";
import { recordOutcome, taskClassKey } from "./outcomes.js";
import { readMemory } from "./memory.js";
import { acquireLease, browserShared, chargeCompletion, customerContext, extendLease, getLoopState, getMessages, getSession, isUserMessage, LeaseLostError, messageText, monthUsageCents, persistTurn, releaseLease, quickSystem, sharedSystem, sitesIn, takePrefetch, taskClockStart, taskCostCents, taskStart, taskTurns, taskUserText, updateSession, type SessionRow } from "./sessions.js";
import { tenantById, type Tenant } from "./tenant.js";
import { executeTool, type ToolOutcome } from "./tools.js";
import { compactAfterHandoff, HANDOFF_PREFIX, HANDOFF_REQUEST, pageStuck, PREFLIGHT_PREFIX, preflightNote, ROUTES_PREFIX, SCOPE_PREFIX, scopeNote, SPLIT_REPORT_NOTE, splitTurnModel, stuckRoutesNote, tooDearForValue, valueAtStake, valueBudgetCents, VETO_PREFIX, vetoReport } from "./tactics.js";
import { taskStateNote } from "./chat.js";

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
// How long a fresh message waits for siblings typed right after it before the run starts.
const SIBLING_WAIT_MS = Number(process.env.SIBLING_WAIT_MS ?? 600);
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
/**
 * Turns in a row that call no tool and show the user nothing before the host steps in. The loop
 * guard above watches for repeated tool calls; this watches for the opposite failure, a model that
 * stops calling tools at all and just writes.
 */
const BARREN_LIMIT = Number(process.env.BARREN_TURN_LIMIT ?? 4);
/** The most time the loop will hold back for a turn that might run long. */
const MAX_TURN_HEADROOM_MS = Number(process.env.MAX_TURN_HEADROOM_MS ?? 90_000);
/** Tools with no side effects on the world: safe to run concurrently when the model asks for several at once. */
export const READ_ONLY_TOOLS = new Set(["web_search", "fetch_page", "memory_read", "memory_grep", "memory_list", "list_items", "browser_find", "list_files", "read_pdf_fields", "get_email_code"]);
/** Browser steps that change the page. Several in one turn run in order and only the last returns a snapshot. */
const BROWSER_ACTIONS = new Set(["browser_goto", "browser_click", "browser_type", "browser_select", "browser_press", "browser_scroll", "browser_back", "browser_fill_form"]);
/** Tools that only tidy up after the result: a turn made of these runs on the fast model. */
const HOUSEKEEPING_TOOLS = new Set(["memory_write", "memory_append", "record_win", "record_receipt", "track_item"]);
/** After a chat reply the worker stays for this long, holding the lease, and continues in place when the next message lands (no kick, no cold start). */
const WARM_WAIT_MS = Number(process.env.WARM_WAIT_MS ?? 25_000);
/** Output cap for a turn that follows a tool result: another tool call or a short reply, never an essay. */
const TOOL_TURN_MAX_TOKENS = Number(process.env.TOOL_TURN_MAX_TOKENS ?? 1200);

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

/** How long each turn's write renews the lease for; a turn that runs longer than this can be taken over by the sweep, and the old worker's next write is refused. */
const LEASE_RENEW_MS = Number(process.env.LEASE_RENEW_SECONDS ?? 240) * 1000;

export async function runSession(sessionId: string, opts: { budgetMs?: number; leased?: string; noSiblingWait?: boolean } = {}): Promise<RunOutcome> {
  const budgetMs = opts.budgetMs ?? 240_000;
  const started = Date.now();
  // The lease names its holder; every write from the loop is fenced on that token, so one session
  // never has two writers even when a turn outlives the lease and the sweep starts another worker.
  const owner = opts.leased ?? (await acquireLease(sessionId, Math.ceil(budgetMs / 1000) + 60));
  if (!owner) return "busy";
  if (opts.leased && !(await extendLease(sessionId, owner, new Date(Date.now() + budgetMs + 60_000)))) return "busy";
  const outcome = await runLoop(sessionId, started, budgetMs, { ...opts, owner });
  // The reply is out. Instead of leaving, wait a moment for the next message on this thread: a
  // follow-up ("and the other one?") then starts in this warm process with the context in memory,
  // skipping the kick and the cold start. The lease is held meanwhile, so chat/send does not kick.
  if (outcome === "done" && WARM_WAIT_MS > 0 && Date.now() - started + WARM_WAIT_MS + 30_000 < budgetMs) {
    const state = await getLoopState(sessionId).catch(() => undefined);
    if (state?.status === "idle" && (await getSession(sessionId))?.kind === "chat") {
      if (!(await extendLease(sessionId, owner, new Date(Date.now() + WARM_WAIT_MS + 10_000)))) return outcome;
      const until = Date.now() + WARM_WAIT_MS;
      while (Date.now() < until) {
        await new Promise((r) => setTimeout(r, 500));
        const now = await getLoopState(sessionId).catch(() => undefined);
        if (now?.status === "running") {
          console.log(`[run] ${sessionId}: next message picked up warm`);
          return await runSession(sessionId, { budgetMs: budgetMs - (Date.now() - started), leased: owner, noSiblingWait: true });
        }
        if (now && now.status !== "idle") break;
      }
      await releaseLease(sessionId, owner);
      const left = await getSession(sessionId).catch(() => undefined);
      if (left?.browserbase_session_id) await disconnectBrowser(left.browserbase_session_id);
    }
  }
  return outcome;
}

async function runLoop(sessionId: string, started: number, budgetMs: number, opts: { noSiblingWait?: boolean; owner: string }): Promise<RunOutcome> {
  let row = (await getSession(sessionId))!;
  row.lease_owner = opts.owner;
  const t = (await tenantById(row.user_id))!;
  await Promise.all([warmCatalog().catch(() => {}), loadModelHistory()]);
  // The system message is rebuilt every run, so a session started hours ago sees today's prompt,
  // today's settings, and which services (browser, mail, Google) are available right now.
  // Messages typed in quick succession ("add milk", "remind me at 3", "note Sam's number") are one
  // call, not three: a request under two seconds old waits a moment for its siblings. Short: every
  // chat message is that young when its run starts, so this wait is on the path to every reply.
  const lastAt = row.messages[row.messages.length - 1]?.at;
  if (!opts.noSiblingWait && SIBLING_WAIT_MS > 0 && lastAt && Date.now() - new Date(lastAt).getTime() < 2000) {
    await new Promise((r) => setTimeout(r, SIBLING_WAIT_MS));
    row = (await getSession(sessionId)) ?? row;
  }
  // The system message is the prompt every customer shares (one cache entry for the whole service);
  // this customer's facts and this task's notes travel as their own block right after it. A side
  // reply (a question answered alongside a busy thread) carries its own status brief and never
  // touches a site: no playbook or site notes, no list of parallel tasks.
  const aside = row.kind === "aside";
  // A quick question or a side reply runs on a prompt a tenth the size; everything else on the shared
  // prompt trimmed to its kind (task sessions without the proactive rules, proactive ones without the
  // browser rules): three small cache entries instead of one large one.
  const quickRun = aside || (isQuickQuestion(taskUserText(row.messages)) && tierOfModel(row.model ?? "", t) === "chat");
  if (row.messages[0]?.role === "system") row.messages[0] = { role: "system", content: quickRun ? quickSystem() : sharedSystem(row.kind) };
  row.contextBlock = (!aside && takePrefetch(t.id, taskUserText(row.messages))) || (await customerContext(t, aside ? { parallel: false } : { task: taskUserText(row.messages) }));
  // The tools this customer can use: no Google tools without Google, no bank tool without a bank link.
  const toolOpts = await toolOptsFor(t, row);
  // Near the plan's monthly cap, step the tier down instead of hard-stopping at the cap later.
  const landed = await softLanding(t, row.model ?? "").catch(() => undefined);
  if (landed && landed !== row.model) {
    console.log(`[route] ${row.id}: soft landing ${row.model} -> ${landed}`);
    row.model = landed;
    await updateSession(row.id, { model: landed });
  }
  const sessionCap = env.plans.sessionBudgetUsd() * 100;
  // Everything up to here is already in the DB; the loop only ever appends beyond this index, so a
  // message the user sends mid-task (its own atomic append) is never overwritten.
  let persisted = row.messages.length;
  // Loop guard: a cheap model can get wedged repeating one action (40x browser_press in a real case)
  // or a short cycle of them (snapshot, click, snapshot, click...), burning the whole step budget
  // with zero progress. Track recent tool calls; on a repeating pattern, escalate once to a stronger
  // model, then stop with a clear message rather than spin.
  const sigs: string[] = [];
  // Turns in a row that called no tool and showed the user nothing.
  let barren = 0;
  let escalatedForBarren = false;
  let escalatedForLoop = false;
  let escalatedForStall = false;
  // The browser opened on the task's site while the model thinks about its first step (F6).
  let warm: Promise<unknown> | undefined;
  let warmed = false;
  // Every write is fenced on the lease and renews it (capped a little past this slice), so a worker
  // that lost the lease stops at its next write and a live one is never taken over mid-task.
  const fence = () => ({ owner: opts.owner, until: new Date(Math.min(Date.now() + LEASE_RENEW_MS, started + budgetMs + 90_000)) });
  const save = (patch: Partial<SessionRow> = {}) =>
    persistTurn(row.id, row.messages.slice(persisted), { turns: row.turns, cost_cents: row.cost_cents, prompt_tokens: row.prompt_tokens, completion_tokens: row.completion_tokens, cached_tokens: row.cached_tokens, model: row.model, draft: null, ...patch }, fence()).then(() => {
      persisted = row.messages.length;
    });

  try {
    // A turn is started only when there is room to finish it. The loop used to start one with a
    // millisecond left, and a single browser_click took 87 seconds — so the invocation blew past its
    // budget and Vercel killed it at 300s mid-turn, losing the work and stalling the session until
    // cron swept it. Headroom tracks the longest turn this run has actually taken.
    let longestTurnMs = 20_000;
    while (Date.now() - started < budgetMs - Math.min(longestTurnMs, MAX_TURN_HEADROOM_MS)) {
      // Resync to the DB (the source of truth) so a message the user sent mid-task is picked up and
      // handled in this same session, never lost. The DB only grows (every writer appends), so adopt
      // it whenever it is longer, keeping our freshly rebuilt system prompt in slot 0.
      const state = await getLoopState(sessionId).catch(() => undefined);
      // The user stopped this session meanwhile: drop it here, nothing more is written.
      if (state && state.status !== "running") {
        console.log(`[turn] ${row.id} #${row.turns} cancelled (${state.status})`);
        if (row.browserbase_session_id) await disconnectBrowser(row.browserbase_session_id);
        return "done";
      }
      const dbMsgs = state?.messages;
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
      // Budgets by class: a greeting gets a few steps, a lookup a couple of dozen, real work the full
      // budget. A stuck lookup never burns a refund-sized budget.
      const cls = taskClass(row, t);
      const steps = taskTurns(row.messages);
      if (steps >= cls.steps) {
        const summary = await wrapUp(t, row, `You have taken ${steps} steps on this task without finishing.`, `I've taken ${steps} steps on this without finishing, so I stopped.`);
        return await finish(t, row, persisted, `${summary}\n\nTell me to keep going, or what to change.`, "idle");
      }
      const spent = taskCostCents(row.messages);
      if (cls.cents > 0 && spent >= cls.cents) {
        const usd = (spent / 100).toFixed(2);
        const worth = cls.valueUsd !== undefined ? ` The task is about $${cls.valueUsd}, so more spend is not worth it.` : "";
        const summary = await wrapUp(t, row, `You have spent $${usd} on this task without finishing.${worth}`, `I've spent $${usd} on this without finishing, so I stopped.${cls.valueUsd !== undefined ? ` For a $${cls.valueUsd} matter that is where it stops paying.` : ""}`);
        return await finish(t, row, persisted, `${summary}\n\nTell me to keep going, or what to change.`, "idle");
      }
      const clock = taskClockStart(row.messages);
      const elapsed = clock ? Date.now() - clock : 0;
      if (cls.ms > 0 && elapsed > cls.ms) {
        const mins = Math.round(elapsed / 60_000);
        const summary = await wrapUp(t, row, `You have been on this task for ${mins} minutes without finishing.`, `I've been on this for ${mins} minutes without finishing, so I stopped.`);
        return await finish(t, row, persisted, `${summary}\n\nTell me to keep going, or what to change.`, "idle");
      }
      // A quick question must not turn into a task: a few lookups, then the reply. Past that, the
      // model is told to answer with what it has; if it still will not, the host wraps it up.
      // Once a quick question has escalated off the chat tier it is a task: full tools, full budget.
      const quick = aside || (isQuickQuestion(taskUserText(row.messages)) && tierOfModel(row.model ?? "", t) === "chat");
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

      // "done" / "signed in" after a takeover: the user finished on their side. Show the model the page
      // as it stands now and the task it was on, so it continues instead of asking what to do.
      if (steps === 0 && row.browserbase_session_id && TAKEOVER_DONE.test(taskUserText(row.messages)) && !hasHostNotePrefix(row.messages, RESUME_PREFIX)) {
        const previous = previousTaskText(row.messages);
        const snap = await runBrowserTool(t, row, "browser_snapshot", {}).catch(() => undefined);
        if (previous || snap) {
          row.messages.push({ role: "user", content: `${RESUME_PREFIX} the user says they finished their part (signed in, solved the check, or did the step by hand). ${previous ? `Continue the task they asked for before, without asking again: "${previous.slice(0, 400)}". ` : ""}${snap ? `The browser shows this now:\n\n${snap.text.slice(0, 6000)}` : "Snapshot the browser and carry on."})` });
          await save();
        }
      }

      // A plain factual question ("what time does Costco close", "how much is a Metro-North ticket to
      // White Plains", "who's the mayor of NYC") is answered by one search and one fast-model call,
      // no tools, no loop. When the sources do not answer it, the search results are left as a note
      // and the full loop takes over. A short fact question is also "quick" by word count; the lookup
      // shape wins, since the alternative is the full loop with every tool: one turn to decide to
      // search and one to reply, each on the whole prompt.
      if (steps === 0 && (row.kind === "chat" || row.kind === "task") && !arrivedMidTask(row.messages) && isLookupQuestion(taskUserText(row.messages))) {
        const answer = await quickLookup(t, row, taskUserText(row.messages)).catch((err) => {
          console.error(`[lookup] ${row.id}: ${err instanceof Error ? err.message : String(err)}`);
          return undefined;
        });
        if (answer) return await finish(t, row, persisted, answer, "idle");
        if (row.messages.length > persisted) await save();
      }

      // The first step of a browser task: what it will need that is not in place (a login, Google, an
      // address) is said now, so the one question comes up front rather than twenty steps in; and the
      // browser opens on the task's site while the model thinks, so its first browser step finds a page.
      const browserTask = !quick && (row.kind === "chat" || row.kind === "task") && RANK[tierOfModel(row.model ?? "", t)] >= RANK.task && !arrivedMidTask(row.messages);
      if (steps === 0 && browserTask && !hasHostNotePrefix(row.messages, PREFLIGHT_PREFIX)) {
        const note = await preflightNote(t, row).catch(() => undefined);
        if (note) {
          row.messages.push({ role: "user", content: note });
          await save();
        }
      }
      if (steps === 0 && browserTask && !warmed && env.browserbase.configured() && !row.browserbase_session_id) {
        const site = sitesIn(taskUserText(row.messages))[0];
        if (site && !isLookupQuestion(taskUserText(row.messages))) {
          warmed = true;
          warm = runBrowserTool(t, row, "browser_open", { url: `https://${site}` }).catch((err: unknown) => console.error(`[warm] ${row.id}: ${err instanceof Error ? err.message : String(err)}`));
        }
      }

      // The stored conversation is the user's record and is never trimmed; the model gets a working copy
      // kept under the context budget.
      const context = withContextBlock(compacted(row.messages), row.contextBlock);
      const turnStart = Date.now();
      const trackTurn = () => {
        longestTurnMs = Math.max(longestTurnMs, Date.now() - turnStart);
      };
      const timings: string[] = [];
      const early = new Map<string, Promise<ToolOutcome>>();
      let completion: Completion;
      let turnModel = row.model!;
      try {
        // The reply streams into `draft` (throttled) so the page shows it as it is written.
        let lastDraft = 0;
        const midTask = row.messages[row.messages.length - 1]?.role === "tool";
        const cheapTurn = housekeepingTurn(row.messages);
        // On a hard-tier task the judgment model plans and decides; the clicking runs on the task model.
        const split = cheapTurn ? undefined : splitTurnModel(row, modelFor("task", t), t);
        turnModel = cheapTurn ? modelFor("chat", t) : split ?? row.model!;
        early.clear();
        completion = await complete({
          // A read-only call (a search, a page read, a memory lookup) starts the moment its JSON is
          // complete in the stream, while the model is still producing the rest of its turn.
          onToolCall: (call) => {
            if (!READ_ONLY_TOOLS.has(call.function.name) || early.has(call.id)) return;
            try {
              early.set(call.id, executeTool(t, row, call.function.name, JSON.parse(call.function.arguments || "{}") as Record<string, unknown>, call.id));
            } catch {
              /* invalid JSON: the loop reports it */
            }
          },
          model: turnModel,
          reasoning: reasoningFor(tierOfModel(turnModel, t)),
          messages: context,
          tools: toolsFor(quick ? "quick" : "all", toolOpts),
          maxTokens: maxTokensFor(row, turnModel, t, midTask),
          onText: (text) => {
            if (Date.now() - lastDraft < 700) return;
            lastDraft = Date.now();
            void q("update agent_sessions set draft = $2 where id = $1", [row.id, text.slice(0, 4000)]).catch(() => {});
          },
        });
      } catch (err) {
        if (err instanceof LLMError && err.retryable) throw err; // worker will retry via cron sweep
        return await finish(t, row, persisted, providerProblem(err), "error");
      }
      timings.push(`llm=${((Date.now() - turnStart) / 1000).toFixed(1)}s`);
      const cents = await chargeCompletion(t, row, completion);
      row.messages.push({ ...completion.message, at: stamp(), cost: cents });

      const calls = completion.message.tool_calls ?? [];
      if (calls.length) barren = 0;
      if (!calls.length) {
        // A turn that calls no tool and delivers nothing to the user is a turn that did not happen.
        // One or two are normal (a reply cut off, a nudge, a hand-off). A run of them is a model
        // talking to itself: in one real session fifteen turns in a row produced 600 tokens of prose,
        // no tool call and no reply, six seconds each, until the invocation hit the 300-second wall.
        // The loop guard could not see it, because it watches tool calls and there were none.
        barren++;
        if (barren >= BARREN_LIMIT) {
          trackTurn();
          await save();
          const stuckOn = tierOfModel(row.model ?? "", t);
          const up = nextTier(stuckOn);
          if (!escalatedForBarren && up && !tooDearForValue(taskUserText(row.messages), up)) {
            escalatedForBarren = true;
            barren = 0;
            await recordOutcome(t, row.id, taskClassKey(taskUserText(row.messages)), stuckOn, false, outcomeExtra(row)).catch(() => {});
            await handoff(t, row);
            row.model = modelFor(up, t);
            row.messages.push({ role: "user", content: "(Your last few turns produced text but took no action and told the user nothing, so nothing has happened. Stop writing and act: take the next step with a tool, or, if the task cannot be done, say in one line exactly what is blocking you. You are now on a stronger model.)" });
            await save();
            console.log(`[turn] ${row.id} #${row.turns} ${barrenLabel(completion)} x${BARREN_LIMIT} -> escalate`);
            continue;
          }
          console.log(`[turn] ${row.id} #${row.turns} ${barrenLabel(completion)} x${BARREN_LIMIT} -> stop`);
          return await finish(t, row, persisted, await wrapUp(t, row, "You have taken several turns in a row without acting or reporting.", "I got stuck going round in circles on this without getting anywhere, so I stopped rather than keep burning time."), "idle");
        }
        // The reply is what the user reads: drop the closing filler chat models add, and the links and
        // reference markers a search-shaped answer drags along (unless the user asked for links).
        if (typeof completion.message.content === "string") completion.message.content = row.messages[row.messages.length - 1].content = unfilled(calm(stripCitations(completion.message.content, taskUserText(row.messages))));
        let text = typeof completion.message.content === "string" ? completion.message.content.trim() : "";
        // "NO_REPORT" belongs on its own, never on the end of a report: the token goes, the words stay.
        if (/NO_REPORT/.test(text)) {
          text = stripNoReport(text);
          row.messages[row.messages.length - 1].content = text || "NO_REPORT";
          if (!text) text = "NO_REPORT";
        }
        // A reply the provider cut mid-sentence ("bought for $3") never reaches the user: once, the model
        // is asked for the whole reply again, with room to write it.
        if (text && !/^NO_REPORT\b/.test(text) && (completion.finish_reason === "length" || completion.finish_reason === "cut" || looksCut(text)) && !hasHostNotePrefix(row.messages, CUT_PREFIX)) {
          supersedeLastReply(row.messages);
          row.messages.push({ role: "user", content: `${CUT_PREFIX} your reply stopped mid-sentence after "${text.slice(-60).replace(/\s+/g, " ")}". Send the whole reply again, complete, as if for the first time.)` });
          await save();
          console.log(`[turn] ${row.id} #${row.turns} ${completion.model} ${timings.join(" ")} cut (${completion.finish_reason})`);
          continue;
        }
        if (text && turnModel !== row.model && tierOfModel(turnModel, t) === "task" && RANK[tierOfModel(row.model ?? "", t)] >= RANK.hard) {
          // The clicking model wrote the report: the judgment model checks it and sends its own.
          supersedeLastReply(row.messages);
          row.messages.push({ role: "user", content: SPLIT_REPORT_NOTE });
          await save();
          console.log(`[turn] ${row.id} #${row.turns} ${completion.model} ${timings.join(" ")} split-report`);
          continue;
        }
        const nudge = stallNudge(row, text);
        if (nudge) {
          // The model "ended" with a promise, an offer to look something up, an empty reply, or a
          // question it should not ask; send it back to work. The draft stays in its context (so
          // "send the same reply again" works) but never reaches the chat page.
          supersedeLastReply(row.messages);
          row.messages.push({ role: "user", content: nudge });
          await save();
          console.log(`[turn] ${row.id} #${row.turns} ${completion.model} ${timings.join(" ")} nudge: ${text.slice(0, 80).replace(/\s+/g, " ")}`);
          continue;
        }
        if (promisesAction(text, true) && (row.kind === "chat" || row.kind === "task")) {
          // Nudged already and still promising instead of doing: this model narrates, so a stronger one
          // takes the task from a hand-off (and the failure goes on this model's record). If that one
          // promises too, the task stops with an honest line rather than a promise nobody keeps.
          supersedeLastReply(row.messages);
          const stuckOn = tierOfModel(row.model ?? "", t);
          const up = nextTier(stuckOn);
          if (!escalatedForStall && up && !tooDearForValue(taskUserText(row.messages), up)) {
            escalatedForStall = true;
            await recordOutcome(t, row.id, taskClassKey(taskUserText(row.messages)), stuckOn, false, outcomeExtra(row)).catch(() => {});
            await handoff(t, row);
            row.model = modelFor(up, t);
            row.messages.push({ role: "user", content: "(Your last replies announced a step instead of taking it, so nothing has happened and the user is still waiting. You are now on a stronger model. Do the step now with tools, from the hand-off above; a reply without a tool call ends the task. End with the result, or with exactly where you are stuck and what you need from the user.)" });
            await save();
            console.log(`[turn] ${row.id} #${row.turns} ${completion.model} ${timings.join(" ")} promise again -> escalate`);
            continue;
          }
          console.log(`[turn] ${row.id} #${row.turns} ${completion.model} ${timings.join(" ")} promise again -> stop`);
          return await finish(t, row, persisted, await wrapUp(t, row, "You have announced this step several times without taking it and are being stopped.", "I said I'd do this and didn't get it done, so I stopped."), "idle");
        }
        // A total for a period nothing read covers ("$140.68 for 2026" off a six-week view): back to the
        // full read, once. Then a draft that gives up or reports a partial window meets a second model's
        // veto naming the route not taken, once.
        if (text && (row.kind === "chat" || row.kind === "task") && !hasHostNotePrefix(row.messages, SCOPE_PREFIX)) {
          const scope = scopeNote(row.messages, text);
          if (scope) {
            supersedeLastReply(row.messages);
            row.messages.push({ role: "user", content: scope });
            await save();
            console.log(`[turn] ${row.id} #${row.turns} ${completion.model} ${timings.join(" ")} scope`);
            continue;
          }
        }
        if (text && (row.kind === "chat" || row.kind === "task") && taskUsedTools(row.messages) && !hasHostNotePrefix(row.messages, VETO_PREFIX)) {
          const veto = await vetoReport(t, row, text).catch(() => undefined);
          if (veto) {
            supersedeLastReply(row.messages);
            row.messages.push({ role: "user", content: veto });
            await save();
            console.log(`[turn] ${row.id} #${row.turns} ${completion.model} ${timings.join(" ")} veto`);
            continue;
          }
        }
        // Figures in the reply that appear nowhere in what the model read or was told this task: one
        // turn to re-read and correct them (or show the arithmetic), before the user sees them.
        if (text && taskUsedTools(row.messages) && !hasHostNotePrefix(row.messages, VERIFY_PREFIX)) {
          const missing = unverifiedFigures(row.messages, text, row.contextBlock);
          if (missing.length) {
            supersedeLastReply(row.messages);
            row.messages.push({ role: "user", content: `${VERIFY_PREFIX} these figures in your reply do not appear in anything you read or were told during this task: ${missing.join(", ")}. Re-read the source (browser_text, browser_extract, fetch_page, the tool result) and correct them, or if each is a calculation, show it in the reply (e.g. 3 × $12.50 = $37.50). Then send the reply again as if for the first time: never mention this check, a correction, or where a figure came from.)` });
            await save();
            console.log(`[turn] ${row.id} #${row.turns} ${completion.model} ${timings.join(" ")} verify: ${missing.join(",")}`);
            continue;
          }
        }
        // The task worked a site it has no notes for: one more turn to write sites/<domain>.md, so the
        // next visit is a five-step task instead of thirty, then the same reply again.
        // The reply stands as is and reaches the page now; the note is written behind it.
        if (text && (row.kind === "chat" || row.kind === "task") && !hasHostNotePrefix(row.messages, SITE_NOTE_PREFIX)) {
          const missing = await siteNotesMissing(t, row.messages).catch(() => [] as string[]);
          if (missing.length) {
            row.messages.push({ role: "user", content: `${SITE_NOTE_PREFIX} you worked on ${missing.join(" and ")} in this task and there is no sites/${missing[0]}.md yet. The user already has your reply above; do not send it again. Write the note now with memory_write, under 40 lines: ## Sign-in (URL, what it asks, whether a code comes), ## Fast path (the exact URLs and clicks that got this result), ## Where things live, ## Quirks, ## Last verified (today). Then reply with exactly NO_REPORT.)` });
            await save();
            console.log(`[turn] ${row.id} #${row.turns} ${completion.model} ${timings.join(" ")} site-note: ${missing.join(",")}`);
            continue;
          }
        }
        if (!text) {
          // Still nothing after a nudge: the user must not be left with a blank. Get a summary.
          return await finish(t, row, persisted, await wrapUp(t, row, "Your last reply was empty.", "I stopped without a result."), "idle");
        }
        // The reply answered a message that landed mid-task, and the task it interrupted never got its
        // report: the reply stands, and the task continues from where it was instead of being dropped.
        if (arrivedMidTask(row.messages) && !hasHostNotePrefix(row.messages, RESUME_TASK_PREFIX)) {
          const earlier = unfinishedEarlierTask(row.messages);
          if (earlier) {
            await save();
            row.messages.push({ role: "user", content: `${RESUME_TASK_PREFIX} that answered the user's last message. The task before it is still unfinished: "${earlier.slice(0, 300)}". Continue it now from where you were (the browser is where you left it); do not start over and do not repeat the answer you just gave. When it is done, reply with the result.)` });
            await save();
            console.log(`[turn] ${row.id} #${row.turns} ${completion.model} ${timings.join(" ")} reply+resume`);
            continue;
          }
        }
        // The task looks done. If the user sent something while we were finishing, handle it too
        // instead of ending: persist this reply and loop, where the top picks the new message up.
        const pending = await getMessages(sessionId).catch(() => null);
        if (pending && pending.length > persisted) {
          await save();
          // A refinement typed right after ("last 2 hours only") is answered as a delta, not the whole thing again.
          row.messages = (await getMessages(sessionId).catch(() => row.messages)) ?? row.messages;
          if (row.messages[0]?.role === "system") row.messages[0] = { role: "system", content: sharedSystem() };
          persisted = row.messages.length;
          row.messages.push({ role: "user", content: SECOND_MESSAGE_NOTE });
          await save();
          console.log(`[turn] ${row.id} #${row.turns} ${completion.model} ${timings.join(" ")} reply+more`);
          continue;
        }
        console.log(`[turn] ${row.id} #${row.turns} ${completion.model} ${timings.join(" ")} reply`);
        return await finish(t, row, persisted, text, "idle");
      }

      // Read-only calls issued together (several searches, page reads, memory lookups) run at once;
      // everything that acts (browser steps, mail, checkpoints) runs in order, one at a time.
      const parsedArgs = calls.map((c) => {
        try {
          return JSON.parse(c.function.arguments || "{}") as Record<string, unknown>;
        } catch {
          return undefined;
        }
      });
      if (warm && calls.some((c) => c.function.name.startsWith("browser_") || c.function.name === "login")) {
        await warm;
        warm = undefined;
      }
      const lastBrowserAction = calls.reduce((last, c, i) => (BROWSER_ACTIONS.has(c.function.name) ? i : last), -1);
      const ahead = new Map<number, Promise<ToolOutcome>>();
      if (calls.length > 1) calls.forEach((c, i) => parsedArgs[i] && READ_ONLY_TOOLS.has(c.function.name) && !early.has(c.id) && ahead.set(i, executeTool(t, row, c.function.name, parsedArgs[i]!, c.id)));
      for (const [i, call] of calls.entries()) {
        const args = parsedArgs[i];
        if (!args) {
          row.messages.push({ role: "tool", tool_call_id: call.id, content: "Invalid JSON arguments; call again with valid JSON." });
          continue;
        }
        const toolStart = Date.now();
        const started_early = early.get(call.id);
        let out = await withTick(row, call.function.name, started_early ? started_early : ahead.has(i) ? ahead.get(i)! : executeTool(t, row, call.function.name, args, call.id));
        // Several browser actions in one turn: the page comes back once, with the last of them.
        if (BROWSER_ACTIONS.has(call.function.name) && lastBrowserAction > i && !/^Tool .* failed/.test(out.text)) out = { ...out, text: `${out.text.split("\n\n")[0]}\n(page snapshot omitted: the last browser action in this turn returns the page)` };
        timings.push(`${call.function.name}=${((Date.now() - toolStart) / 1000).toFixed(1)}s${started_early ? "»" : ahead.has(i) ? "‖" : ""}`);
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
          if (row.kind === "chat" || row.kind === "task") await recordOutcome(t, row.id, taskClassKey(taskUserText(row.messages)), tierOfModel(row.model ?? "", t), false, outcomeExtra(row)).catch(() => {});
          await handoff(t, row);
          row.model = out.escalateTo;
          row.messages.push({ role: "user", content: `(You are now running on a more capable model. Continue the task from the hand-off above.)` });
        }
      }

      // Learning every step: the browser steps so far on this site are checkpointed as a path and the
      // pages reached go in the site's index, so a task that stops anywhere still leaves what worked.
      if ((row.kind === "chat" || row.kind === "task") && calls.some((c) => c.function.name.startsWith("browser_"))) {
        const site = await checkpointPaths(t, row).catch(() => undefined);
        if (site) console.log(`[paths] ${row.id} #${row.turns} checkpoint ${site}`);
      }

      // The page did not change after two actions: a person would try a different route now. The host
      // lists the ones not yet tried (site-note URLs, recorded paths, find-by-label, search), once per task.
      if ((row.kind === "chat" || row.kind === "task") && pageStuck(row.messages) && !hasHostNotePrefix(row.messages, ROUTES_PREFIX)) {
        row.messages.push({ role: "user", content: await stuckRoutesNote(t, row).catch(() => `${ROUTES_PREFIX} Take a different route now: a direct URL, browser_find by label, web_search for the page, or escalate_model.)`) });
        console.log(`[turn] ${row.id} #${row.turns} page stuck -> routes note`);
      }

      // Navigating to a site on the hard list while on the task tier: move up now, before it fails.
      if (tierOfModel(row.model ?? "", t) === "task") {
        const hardUrl = calls.map((c, i) => (c.function.name === "browser_goto" || c.function.name === "browser_open" ? String(parsedArgs[i]?.url ?? "") : "")).find((u) => u && isHardSite(u));
        if (hardUrl) {
          row.model = modelFor("hard", t);
          row.messages.push({ role: "user", content: `(This site is on the hard list, so you are now on the stronger model. Continue the task from here.)` });
          console.log(`[route] ${row.id}: hard site ${hardUrl.slice(0, 60)} -> ${row.model}`);
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
        const stuckOn = tierOfModel(row.model ?? "", t);
        const up: Tier = stuckOn === "hard" ? "max" : "hard";
        if (!escalatedForLoop && stuckOn !== "max" && !tooDearForValue(taskUserText(row.messages), up)) {
          // Give it one real chance to break out on a stronger model before giving up: the judgment
          // model for the cheap tiers, the top model when the judgment model itself is stuck. Not for
          // a small amount: a $9 matter does not buy the dear model.
          escalatedForLoop = true;
          if (row.kind === "chat" || row.kind === "task") await recordOutcome(t, row.id, taskClassKey(taskUserText(row.messages)), stuckOn, false, outcomeExtra(row)).catch(() => {});
          await handoff(t, row);
          row.model = modelFor(up, t);
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
    await releaseLease(row.id, opts.owner);
    return "continue";
  } catch (err) {
    if (err instanceof LeaseLostError) {
      // Another worker holds this session now (this turn outlived the lease): leave everything to it.
      console.error(`[turn] ${row.id} #${row.turns} lease lost; stopping this worker`);
      return "busy";
    }
    await releaseLease(row.id, opts.owner, { error: (err instanceof Error ? err.message : String(err)).slice(0, 500) });
    throw err;
  }
}

/** The model the task ran on and the site it worked, for the outcome record. */
function outcomeExtra(row: SessionRow): { model?: string; site?: string } {
  const visited = [...siteActivity(row.messages).visited.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
  return { model: row.model ?? undefined, site: visited ?? sitesIn(taskUserText(row.messages))[0] };
}

/** What went wrong and what would have prevented it, appended to history/failures.md for the morning review. */
async function postMortem(t: Tenant, row: SessionRow, report: string): Promise<void> {
  if (row.kind !== "chat" && row.kind !== "task") return;
  const context = compacted(row.messages).slice(-14);
  context.unshift({ role: "system", content: "You write a three-line post-mortem of a task that did not finish: (1) what was asked and where it stopped, (2) the real cause in one line (a site's bot check, a wrong route, a missing login, an expired code, a host limit), (3) the one concrete change that would have made it succeed (a URL to use, an order of steps, a setting for the user to add). Plain text, no headings." });
  context.push({ role: "user", content: `(The task ended with this report to the user: "${report.slice(0, 400)}". Write the post-mortem now.)` });
  const sites = [...new Set([...row.messages.flatMap((m) => (typeof m.content === "string" ? m.content.match(/https?:\/\/([\w.-]+)/g) ?? [] : [])).map((u) => u.replace(/^https?:\/\//, "").replace(/^www\./, ""))])].slice(0, 3);
  const header = `### ${new Date().toISOString().slice(0, 16).replace("T", " ")} · ${(row.title ?? row.kind).slice(0, 80)}${sites.length ? ` · ${sites.join(", ")}` : ""}`;
  // Nobody is waiting for a post-mortem: through the half-price batch endpoint when it is configured.
  if (batchConfigured()) {
    await enqueue(t.id, "postmortem", { messages: context, max_tokens: 300, meta: { path: "history/failures.md", header } });
    return;
  }
  const c = await complete({ model: modelFor("chat", t), messages: context, maxTokens: 300 });
  await chargeCompletion(t, row, c, "postmortem").catch(() => {});
  const text = typeof c.message.content === "string" ? c.message.content.trim() : "";
  if (!text) return;
  await appendMemory(t, "history/failures.md", `\n${header}\n${text}\n`);
}

/**
 * The reflection pass: after every real task the host asks a cheap model what it would do differently,
 * and stores the answer as scoped lessons plus per-site notes (lib/learning.ts). It runs on the way
 * out, capped in time, and its failure never reaches the user.
 *
 * Skipped for greetings and for sessions with no tool use: there is nothing to learn from "thanks".
 */
async function learn(t: Tenant, row: SessionRow, report: string): Promise<void> {
  if (process.env.LEARNING === "off") return;
  if (!["chat", "task", "followup", "correspondence"].includes(row.kind)) return;
  const request = taskUserText(row.messages);
  if (!request || isQuickQuestion(request)) return;
  const steps = taskTurns(row.messages);
  if (steps < 2 && guessOutcome(report) !== "blocked") return;
  const clock = taskClockStart(row.messages);
  const timeout = Number(process.env.LEARN_TIMEOUT_MS ?? 25_000);
  await Promise.race([
    reflect(t, {
      sessionId: row.id,
      kind: row.kind,
      request,
      report,
      steps,
      seconds: clock ? (Date.now() - clock) / 1000 : 0,
      costCents: Number(row.cost_cents),
      context: compacted(row.messages).slice(-20),
    }),
    new Promise((r) => setTimeout(r, timeout)),
  ]);
}

/** A provider failure in the user's words, not the provider's JSON. */
function providerProblem(err: unknown): string {
  const status = err instanceof LLMError ? err.status : undefined;
  const msg = err instanceof Error ? err.message : String(err);
  if (status === 402) return "I can't run right now: the AI account is out of credits. Add credits at openrouter.ai/credits, then say \"try again\" and I'll pick up where I was.";
  if (status === 401 || status === 403) return "I can't reach the AI provider: the API key was rejected. Check LLM_API_KEY in the server settings, then say \"try again\".";
  return `The AI provider rejected the request (${msg.replace(/\s+/g, " ").slice(0, 160)}). Say "try again", or tell me to use a different approach.`;
}

/**
 * What a task may spend, by class. Quick questions are capped elsewhere (QUICK_STEPS); a task-tier
 * request (a lookup, a form, a bill) gets a middle budget; hard-tier work (refunds, negotiations,
 * projects) and self-started reviews get the full one.
 */
function taskClass(row: SessionRow, t: Tenant): { steps: number; ms: number; cents: number; valueUsd?: number } {
  const tier = tierOfModel(row.model ?? "", t);
  // Spend per task, by class: a lookup (a balance, a price, a figure off a page) stops at LOOKUP_BUDGET_USD
  // with a summary instead of running its whole step budget on a strong model; real work gets TASK_BUDGET_USD
  // (the session budget by default). 0 disables a cap. A request that names an amount caps its own spend
  // at a share of that amount: a $9 subscription never buys a dollar of model time.
  const taskCents = Number(process.env.TASK_BUDGET_USD ?? env.plans.sessionBudgetUsd()) * 100;
  const lookupCents = Number(process.env.LOOKUP_BUDGET_USD ?? 1) * 100;
  let cls: { steps: number; ms: number; cents: number; valueUsd?: number } = { steps: MAX_TASK_TURNS, ms: TASK_TIME_LIMIT_MS, cents: taskCents };
  if ((row.kind === "chat" || row.kind === "task") && tier === "task") cls = { steps: Number(process.env.MAX_TURNS_LOOKUP ?? Math.min(MAX_TASK_TURNS, 60)), ms: Math.min(TASK_TIME_LIMIT_MS, Number(process.env.LOOKUP_TIME_LIMIT_MINUTES ?? 10) * 60_000), cents: lookupCents };
  if (row.kind === "chat" || row.kind === "task") {
    const amount = valueAtStake(taskUserText(row.messages));
    if (amount !== undefined) {
      const byValue = valueBudgetCents(amount, lookupCents, cls.cents);
      if (byValue < cls.cents || cls.cents === 0) cls = { ...cls, cents: byValue, valueUsd: amount };
    }
  }
  return cls;
}

/**
 * The departing model writes a ten-line hand-off before a stronger model takes over: the goal, what is
 * established, what failed and why, what to try next. The new model then reads that and the last few
 * turns instead of forty turns of flailing at full price (compactAfterHandoff), and does better for it.
 */
async function handoff(t: Tenant, row: SessionRow): Promise<void> {
  if (!row.model || (process.env.HANDOFF ?? "on") === "off") return;
  try {
    const context = withContextBlock(compacted(row.messages), row.contextBlock);
    context.push({ role: "user", content: HANDOFF_REQUEST });
    const c = await complete({ model: row.model, messages: context, tools, toolChoice: "none", maxTokens: 400, reasoning: "low" });
    await chargeCompletion(t, row, c, "handoff").catch(() => {});
    const text = typeof c.message.content === "string" ? c.message.content.trim() : "";
    if (text && !c.message.tool_calls?.length) row.messages.push({ role: "user", content: `${HANDOFF_PREFIX}\n${text.slice(0, 1800)})` });
  } catch (err) {
    console.error(`[handoff] ${row.id}: ${err instanceof Error ? err.message : String(err)}`);
  }
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
    const c = await complete({ model: row.model!, messages: withContextBlock(context, row.contextBlock), tools, toolChoice: "none", maxTokens: 400, reasoning: "low" });
    await chargeCompletion(t, row, c, "wrapup");
    const text = typeof c.message.content === "string" ? c.message.content.trim() : "";
    if (text && !c.message.tool_calls?.length) return text;
    // A cheap model that ignores tool_choice and calls a tool anyway: once more on the fast model, no tools at all.
    const c2 = await complete({ model: modelFor("chat", t), messages: withContextBlock(context, row.contextBlock), maxTokens: 400, reasoning: "none" });
    await chargeCompletion(t, row, c2, "wrapup");
    const text2 = typeof c2.message.content === "string" ? c2.message.content.trim() : "";
    if (text2 && !c2.message.tool_calls?.length) return text2;
  } catch (err) {
    console.error(`[wrapup] ${row.id}: ${err instanceof Error ? err.message : String(err)}`);
  }
  // What the user already saw stands on its own; the host's reason goes underneath in one plain line.
  const last = lastAssistantText(row.messages);
  return last ? `${last}\n\n(${fallback.replace(/^I(?:'ve| have)? /, "I ")})` : fallback;
}

/** The task ended for this turn: deliver the report on the right channel and mark idle. */
async function finish(t: Tenant, row: SessionRow, persisted: number, report: string, status: "idle" | "error"): Promise<RunOutcome> {
  const proactive = ["review", "weekly", "followup", "triage", "digest", "inbox"].includes(row.kind);
  // "NO_REPORT" tacked onto the end of a real report is noise; alone, it means silence (proactive kinds only).
  if (/NO_REPORT/.test(report)) report = stripNoReport(report) || "NO_REPORT";
  // A task that answered, then only wrote its site note: the reply already in the thread is the report.
  if (!proactive && /^NO_REPORT\b/.test(report.trim()) && lastAssistantText(row.messages)) report = lastAssistantText(row.messages);
  const silent = /^NO_REPORT\b/.test(report.trim()) && proactive;
  // The chat page renders the message list, so a report the loop wrote itself (step limit, spend cap,
  // provider error) must be in it or the user sees nothing at all.
  if (report && !silent && lastAssistantText(row.messages) !== report.trim()) row.messages.push({ role: "assistant", content: report, at: stamp() });
  const failedWords = notDelivered(report);
  const sessionCap = env.plans.sessionBudgetUsd() * 100;
  const limitHit = row.turns >= MAX_SESSION_TURNS || (sessionCap > 0 && row.cost_cents >= sessionCap);
  // A provider error no longer terminates the chat: the thread stays open (status "error", still
  // resumable) so the next message continues it with full context. Only the real limits roll over.
  const rollOver = row.kind === "chat" && (limitHit || row.turns >= CHAT_ROLLOVER_TURNS || (sessionCap > 0 && row.cost_cents >= sessionCap * CHAT_ROLLOVER_SHARE));
  if (rollOver) status = "terminated" as typeof status;
  // The reply reaches the page now. Append-only: never overwrite the whole array, or a message the
  // user just sent is lost. Everything below is bookkeeping the user never waits for.
  await persistTurn(row.id, row.messages.slice(persisted), { turns: row.turns, cost_cents: row.cost_cents, prompt_tokens: row.prompt_tokens, completion_tokens: row.completion_tokens, cached_tokens: row.cached_tokens, status, last_report: report.slice(0, 20_000), lease_until: null, model: row.model, draft: null, chips: null }, row.lease_owner ? { owner: row.lease_owner } : undefined);
  // The user hears first. This used to sit at the end, behind up to seven housekeeping model calls —
  // about half a minute in the logs — so an email or a phone notification arrived that much late.
  if (report && !silent) {
    // Mail triage can wait for the check-in times; a timer the user or the agent set fires on time.
    const holdable = row.kind === "triage";
    if (holdable && shouldDefer(t, report)) await deferToDigest(t, "From your mail", report);
    else await notifyOwner(t, row, report, row.kind === "review" ? "Morning brief" : row.kind === "weekly" ? "Week ahead" : row.kind === "digest" ? "Heads-ups" : undefined);
  }
  // A message that landed while we were finishing: flip back to running and re-kick so it gets
  // answered now, instead of sitting idle until the user sends something else.
  if (!rollOver && status === "idle") {
    const after = await getMessages(row.id).catch(() => null);
    if (after && after.length > row.messages.length) {
      if (row.lease_owner) await releaseLease(row.id, row.lease_owner, { status: "running" });
      else await updateSession(row.id, { status: "running", lease_until: null });
      await kick(row.id);
    }
  }

  // Everything below is bookkeeping nobody is waiting for, and most of it is a model call of its own:
  // the chips, the post-mortem, the correction, the promise, the grade, the paths, the lessons. Run
  // serially they took about thirty seconds of wall clock per task and held the invocation open to
  // the point of hitting Vercel's 300-second wall. They are independent of each other, so they go
  // together — except the two that both rewrite sites/<domain>.md, which would race.
  const chatOrTask = row.kind === "chat" || row.kind === "task";
  const finished = status === "idle" && !failedWords;
  const housekeeping: Array<Promise<unknown>> = [];
  const quietly = (label: string, work: () => Promise<unknown>) => housekeeping.push(work().catch((e: unknown) => console.error(`[after] ${row.id} ${label}: ${e instanceof Error ? e.message : String(e)}`)));

  if (status === "error" || failedWords) quietly("post-mortem", () => postMortem(t, row, report));
  if (report && !silent) quietly("transcript", () => appendTranscript(t, { channel: row.channel, role: "agent", text: report }));
  if (chatOrTask) {
    // The chips under the reply, from the reply itself; the page picks them up on its next poll.
    if (status === "idle" && report && !silent) quietly("chips", () => suggestReplies(t, row, report));
    // How this kind of task ended on this tier, for the adaptive router; and the rule in a correction, if this task was one.
    if (taskUsedTools(row.messages)) quietly("outcome", () => recordOutcome(t, row.id, taskClassKey(taskUserText(row.messages)), tierOfModel(row.model ?? "", t), finished, outcomeExtra(row)));
    quietly("correction", async () => {
      const learned = await learnFromCorrection(t, row);
      if (learned) console.log(`[learn] ${row.id}: ${learned}`);
    });
    // A promise in the reply ("I'll check back Thursday") is kept by the host if the model set no follow-up.
    if (status === "idle" && report)
      quietly("promise", async () => {
        const due = await keepPromise(t, row, report);
        if (due) console.log(`[promise] ${row.id}: follow-up ${due.toISOString()}`);
      });
    // What blocked the task becomes a fix card the user can act on in one tap.
    if (failedWords || status === "error")
      quietly("fixes", async () => {
        const { relayStatus } = await import("./relay.js");
        const relay = await relayStatus(t).catch(() => ({ online: false }));
        const fixes = detectFixes(row.messages, !!t.googleRefreshToken, relay.online);
        if (fixes.length) await recordFixes(t, fixes);
      });
    if (status === "idle" && report && taskUsedTools(row.messages)) quietly("grade", () => gradeReply(t, row, report));
    // The two that write sites/<domain>.md, in order, so neither loses the other's edit: what the
    // browser actually did on each site, then what the reflection learned about it.
    quietly("paths+lessons", async () => {
      const domains = [...siteActivity(row.messages).visited].filter(([, n]) => n >= (finished ? 3 : 2)).map(([d]) => d);
      if (domains.length) {
        const written = await recordPaths(t, row, domains, report, finished).catch(() => [] as string[]);
        if (written.length) console.log(`[paths] ${row.id}: recorded ${written.join(", ")}${finished ? "" : " (unfinished)"}`);
      }
      await learn(t, row, report);
    });
  } else {
    quietly("lessons", () => learn(t, row, report));
  }
  await Promise.allSettled(housekeeping);
  if (row.browserbase_session_id) {
    // A finished task or self-started session lets go of its tab; the browser itself is released only
    // when no other live session of this customer is using it (one browser per customer).
    if (proactive || row.kind === "task") {
      await closeTab(row).catch(() => {});
      if (!(await browserShared(row.browserbase_session_id, row.id).catch(() => true))) await releaseBrowser(row.browserbase_session_id).catch(() => {});
    }
    // A chat thread keeps its connection through the warm wait: the next browser task skips the reconnect.
    if (!(row.kind === "chat" && status === "idle" && WARM_WAIT_MS > 0)) await disconnectBrowser(row.browserbase_session_id);
  }
  return status === "error" ? "error" : "done";
}

/** The tools this customer can actually use right now, plus every tool already called in the thread. */
async function toolOptsFor(t: Tenant, row: SessionRow): Promise<ToolOpts> {
  const keep = new Set<string>();
  for (const m of row.messages) for (const c of m.tool_calls ?? []) keep.add(c.function.name);
  const opts: ToolOpts = { google: !!t.googleRefreshToken, keep };
  try {
    const { plaidConfigured } = await import("./plaid.js");
    opts.bank = plaidConfigured();
    const { trackingConfigured } = await import("./tracking.js");
    opts.tracking = trackingConfigured().length > 0;
    const { relayStatus } = await import("./relay.js");
    opts.relay = (await relayStatus(t)).devices.length > 0;
  } catch {
    /* an integration check never blocks a turn */
  }
  return opts;
}

/** Output cap for a turn: a few hundred tokens on the chat tier, a thousand and a half on clicking turns, the full cap for judgment and for a reply asked for again after a cut. */
function maxTokensFor(row: SessionRow, model: string, t: Tenant, midTask: boolean): number | undefined {
  if (hasHostNotePrefix(row.messages, CUT_PREFIX)) return 4000;
  const tier = tierOfModel(model, t);
  const cap = Number(process.env[`MAX_TOKENS_${tier.toUpperCase()}`] ?? { chat: 600, task: 1500, hard: 4000, max: 4000 }[tier]);
  return midTask && TOOL_TURN_MAX_TOKENS > 0 ? Math.min(TOOL_TURN_MAX_TOKENS, cap) : cap;
}

/** A tool that runs long posts one progress line so a slow page never looks like silence. */
const TICK_AFTER_MS = Number(process.env.TOOL_TICK_MS ?? 7000);
const TICK_WORDS: Record<string, string> = { browser_goto: "Loading the page…", browser_open: "Opening the browser…", browser_wait_for: "Waiting for the page…", browser_watch: "Waiting for a reply on the page…", browser_extract: "Reading the list…", browser_run_path: "Going through the site…", login: "Signing in…", spending_report: "Reading the history, page by page…", web_search: "Searching…", fetch_page: "Reading the page…", browser_fill_form: "Filling in the form…" };
async function withTick<T>(row: SessionRow, tool: string, work: Promise<T>): Promise<T> {
  if (row.channel !== "chat" || TICK_AFTER_MS <= 0) return work;
  const timer = setTimeout(() => {
    void appendAssistantMessage(row, TICK_WORDS[tool] ?? "Still working…", true).catch(() => {});
  }, TICK_AFTER_MS);
  try {
    return await work;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * A session the host finished itself (a standing order whose recorded path read the figure): the
 * report goes into the thread and to the user, the tab closes, no model turn at all.
 */
export async function hostFinish(t: Tenant, row: SessionRow, report: string): Promise<void> {
  await persistTurn(row.id, [{ role: "assistant", content: report, at: stamp() }], { status: "idle", last_report: report.slice(0, 20_000), lease_until: null });
  await notifyOwner(t, row, report);
  await appendTranscript(t, { channel: row.channel, role: "agent", text: report }).catch(() => {});
  if (row.browserbase_session_id) {
    await closeTab(row).catch(() => {});
    if (!(await browserShared(row.browserbase_session_id, row.id).catch(() => true))) await releaseBrowser(row.browserbase_session_id).catch(() => {});
    await disconnectBrowser(row.browserbase_session_id);
  }
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
/** A promise for later ("I'll check back Thursday", "once it arrives") is a follow-up the host keeps, not a stall. */
const LATER = /\b(tomorrow|tonight|this evening|this afternoon|thursday|friday|monday|tuesday|wednesday|saturday|sunday|next week|next month|later today|in (?:a few|\d+) (?:hours?|minutes?|days?)|when (?:it|they|the|you)|once (?:it|they|the|you)|after (?:it|they|the|you)|every \d+|as soon as)\b/i;
/** "I'll check your account", "let me look", "going to try again": an action announced instead of taken. */
const PROMISED_ACTION =
  /\b(i(?:'|’)?ll|i will|let me|i(?:'|’)?m going to|i am going to|i(?:'|’)?m about to|i(?:'|’)?ll go ahead and)\s+(now\s+|just\s+|go\s+(?:and\s+)?|quickly\s+)?(try|attempt|retry|proceed|go ahead|give it|keep trying|have another|take another|take a (?:quick )?look|look (?:for|up|at|into|through)|search|open|grab|pull|fetch|dig|request|submit|download|check|re-?check|verify|confirm|review|read|scan|run|start|get (?:on|started|that|this|it|back to|you)|do (?:that|this|it)|handle|log ?in|sign ?in|head (?:to|over)|go (?:to|through)|find|see|work on)\b|\btry(?:ing)?\s+(again|one more time|once more|another|a different)\b/i;
/** A short reply that is only an acknowledgement: "One moment.", "On it!", "Hang tight", "I'll let you know." Nothing was done and the user is still waiting. */
const ACK_ONLY =
  /^\W*(?:(?:sure|ok(?:ay)?|got it|understood|absolutely|of course|right away|no problem|sounds good|yes)[,.!]?\s*)*(?:one (?:moment|sec(?:ond)?|minute)|(?:just )?(?:a|another) (?:moment|sec(?:ond)?|minute)|give me (?:a|one) (?:moment|sec(?:ond)?|minute)|hang tight|hold on|stand by|bear with me|(?:i(?:'|’)?m )?on it|will do|let me|i(?:'|’)?ll|i will|i(?:'|’)?m going to|i am going to)\b/i;
/** "Checking now.", "Looking into it.": a step in progress as the whole reply; only very short, or ending in "now". */
const IN_PROGRESS = /^\W*(?:(?:sure|ok(?:ay)?|got it|right away)[,.!]?\s*)*(?:checking|looking|pulling|opening|searching|logging|signing|running|working|getting|reading|scanning|verifying|digging)\b/i;

/**
 * Whether a reply announces a step instead of taking it (a promise or a bare acknowledgement).
 * `strict` also demands that nothing in it reads as a result (no figure, amount, link) and that it
 * is short: a false positive then costs one nudge, never an escalation or a stop.
 */
export function promisesAction(reply: string, strict = false): boolean {
  const r = reply.trim();
  if (!r) return false;
  // Sentences that promise for later are follow-ups, not stalls; strip them before looking.
  const now = r.split(/(?<=[.!?])\s+/).filter((s) => !LATER.test(s)).join(" ");
  if (!now) return false;
  const words = now.split(/\s+/).length;
  const bare = !/[\d$€£%]|https?:/.test(now);
  if (PROMISED_ACTION.test(now)) return !strict || (bare && words <= 60);
  if (!bare || words > 30) return false;
  if (ACK_ONLY.test(now)) return true;
  return IN_PROGRESS.test(now) && (words <= 6 || (words <= 15 && /\bnow\b/i.test(now)));
}
const ASKS_FOR_ADDRESS = /\b(provide|tell me|what(?:'|’)?s|what is|send me|confirm|i need|share)\b[^.?\n]{0,60}\b(your|the)\s+(current\s+|pickup\s+|home\s+|starting\s+|exact\s+)?(location|address)\b/i;
const OFFERS_LOOKUP =
  /\b(want|would you like|do you want|should|shall|need)\s+(me|i)\s+(to\s+)?(check|look|pull|find|see|verify|confirm|dig|get|grab|open|read|search|run|log)\b|\bsay the word\b|\bjust (?:say|tell me|give me the (?:word|go|nod|ok))\b|\b(?:let me know|tell me) (?:if|whether|when) you(?:'d| would)? (?:want|like|need)\b|\bif you (?:want|like|'d like)(?:,)? (?:i(?:'|’)?ll|i can)\b|\b(?:happy|glad) to (?:grab|pull|fetch|dig|check|look)[^.!?\n]{0,40}\bif\b/i;

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
  const system = `${typeof row.messages[0]?.content === "string" ? row.messages[0].content : ""}\n${row.contextBlock ?? ""}`;
  const homeKnown = /home address[^\n]*:\s*\S/i.test(system);
  if (homeKnown && ASKS_FOR_ADDRESS.test(reply)) return pick("address");
  if (promisesAction(reply)) return pick("promise");
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

/**
 * Whether the user's latest message landed while the thread was still working (the model was mid
 * tool call, or the host stamped it as mid-task): then it is handled inside the running task, never
 * as a fresh lookup that would end that task.
 */
export function arrivedMidTask(messages: ChatMessage[]): boolean {
  const start = taskStart(messages);
  const prev = messages[start - 1];
  if (prev && (prev.role === "tool" || (prev.role === "assistant" && prev.tool_calls?.length))) return true;
  for (let i = start + 1; i < messages.length; i++) if (messages[i].role === "user" && messageText(messages[i]).startsWith("(That message arrived while you are mid-task")) return true;
  return false;
}

/** The reply the model just gave is being sent back to it: hide it from the chat, keep it for the model. */
export function supersedeLastReply(messages: ChatMessage[]): void {
  const last = messages[messages.length - 1];
  if (last?.role === "assistant" && !last.tool_calls?.length) last.superseded = true;
}

export const CUT_PREFIX = "(Cut off:";
export const RESUME_TASK_PREFIX = "(Back to the task:";
export const SECOND_MESSAGE_NOTE = "(The user sent another message while you were replying; it is above. If your last reply already covers it, answer only with what is different or new, in a line or two; never send the same content again.)";
/** A reply that ends on a connector, a colon, a dangling "$3": the provider stopped mid-sentence. Terminal punctuation means it ended on purpose. */
export function looksCut(text: string): boolean {
  const t = text.trimEnd();
  if (!t || /[.!?…)"'”»\]]$/.test(t) || t.length < 12) return false;
  return /[:;,\-–—]$|\b(and|or|but|for|to|at|with|the|a|an|of|in|on|by|is|are|was|were|from|that|which|your|my)$/i.test(t);
}
/** "NO_REPORT" only counts alone; on the end of a report it is noise from a model that read the rule too well. */
export function stripNoReport(text: string): string {
  return text.replace(/(^|\n)\s*NO_REPORT\.?\s*(?=\n|$)/g, "$1").replace(/\s*\bNO_REPORT\b\.?\s*$/, "").replace(/^\s*NO_REPORT\b\.?\s*/, "").trim();
}
/**
 * The request before the user's latest message, when that latest message landed mid-task and the
 * earlier request never got its reply: the task the interruption should go back to.
 */
export function unfinishedEarlierTask(messages: ChatMessage[]): string | undefined {
  const start = taskStart(messages);
  let prev = -1;
  for (let i = start - 1; i > 0; i--) if (isUserMessage(messages[i])) { prev = i; break; }
  if (prev < 0) return undefined;
  let usedTools = false;
  for (let i = prev + 1; i < start; i++) {
    const m = messages[i];
    if (m.role !== "assistant" || m.ephemeral) continue;
    if (m.tool_calls?.length) usedTools = true;
    else if (typeof m.content === "string" && m.content.trim() && !m.superseded) return undefined; // it got its reply
  }
  if (!usedTools) return undefined;
  const text = messageText(messages[prev]).replace(/^\[[^\]]+\]\n/, "").replace(/^Re: (?:my|your) message "[^\n]*"\n/, "").trim();
  // A steer or a question is not a task to go back to.
  return text.split(/\s+/).length >= 3 && !/^(\?|status|update|any luck)/i.test(text) ? text : undefined;
}

/** "done", "signed in": the user finished a takeover step; the task resumes from the current page. */
export const TAKEOVER_DONE = /^(ok(ay)?[,.! ]*)?(done|all done|i'?m done|signed in|logged in|i'?m in|i signed in|i logged in|finished|it'?s done|you'?re in|you should be in|try (it )?now|go ahead now)\b/i;
export const RESUME_PREFIX = "(Resuming:";

/** The user's request before the current one (the task a "done" continues). */
export function previousTaskText(messages: ChatMessage[]): string | undefined {
  const start = taskStart(messages);
  for (let i = start - 1; i > 0; i--) if (isUserMessage(messages[i])) return messageText(messages[i]).replace(/^\[[^\]]+\]\n/, "");
  return undefined;
}

export const VERIFY_PREFIX = "(Verify before you finish:";
const MONEY = /\$\s?\d[\d,]*(?:\.\d{1,2})?/g;
const PHONE = /\(?\b\d{3}\)?[-.\s]\d{3}[-.\s]\d{4}\b/g;
const CONFIRMATION = /\b(?=[A-Z0-9-]{6,}\b)(?=[A-Z0-9-]*\d)(?=[A-Z0-9-]*[A-Z])[A-Z0-9-]+\b/g;

/**
 * Figures in a reply that nothing in the thread supports: dollar amounts, phone numbers and
 * confirmation-style codes that appear in no tool result, no user message, no earlier reply and not
 * in the system prompt. Amounts are compared without separators, phones by digits, codes by exact token.
 */
export function unverifiedFigures(messages: ChatMessage[], reply: string, context = ""): string[] {
  const parts: string[] = [context];
  // The whole thread counts: what the task read or was told, and every reply the user already has
  // from earlier tasks. Only this task's own drafts and acks are left out (they may carry the figure
  // being checked).
  const start = taskStart(messages);
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (m.role === "assistant" && (i >= start || m.superseded || m.ephemeral)) continue;
    parts.push(messageText(m));
  }
  const corpus = parts.join("\n");
  const plain = corpus.replace(/,/g, "");
  const digits = corpus.replace(/\D/g, "");
  const missing = new Set<string>();
  for (const m of reply.match(MONEY) ?? []) {
    const amount = m.replace(/[$\s,]/g, "");
    if (!plain.includes(amount) && !plain.includes(amount.replace(/\.00$/, ""))) missing.add(m.replace(/\s/g, ""));
  }
  for (const m of reply.match(PHONE) ?? []) if (!digits.includes(m.replace(/\D/g, ""))) missing.add(m);
  for (const m of reply.match(CONFIRMATION) ?? []) if (!corpus.toLowerCase().includes(m.toLowerCase())) missing.add(m);
  return [...missing].slice(0, 8);
}

/** A turn that only tidies up after the result (the site-note request, or the wrap-up after a receipt or win) runs on the fast model. */
export function housekeepingTurn(messages: ChatMessage[]): boolean {
  const last = messages[messages.length - 1];
  if (last?.role === "user" && messageText(last).startsWith(SITE_NOTE_PREFIX)) return true;
  // The previous assistant turn recorded the receipt or the win: what follows is bookkeeping and the reply.
  for (let i = messages.length - 1; i >= taskStart(messages); i--) {
    const m = messages[i];
    if (m.role !== "assistant" || m.ephemeral) continue;
    const names = (m.tool_calls ?? []).map((c) => c.function.name);
    return names.length > 0 && names.every((n) => HOUSEKEEPING_TOOLS.has(n)) && names.some((n) => n === "record_receipt" || n === "record_win");
  }
  return false;
}

/** Near the monthly cap the tier steps down instead of the month ending in a hard stop: hard -> task at 80%, task -> chat at 95%. */
export function softLandedTier(share: number, tier: Tier): Tier {
  const hardAt = Number(process.env.SOFT_LANDING_HARD ?? 0.8);
  const taskAt = Number(process.env.SOFT_LANDING_TASK ?? 0.95);
  if ((tier === "hard" || tier === "max") && share >= hardAt) return share >= taskAt ? "chat" : "task";
  if (tier === "task" && share >= taskAt) return "chat";
  return tier;
}

async function softLanding(t: Tenant, model: string): Promise<string | undefined> {
  const cap = env.plans.monthlyCapUsd(t.plan) * 100;
  if (cap <= 0 || !model) return undefined;
  const tier = tierOfModel(model, t);
  if (tier === "chat") return undefined;
  const landed = softLandedTier((await monthUsageCents(t)) / cap, tier);
  return landed === tier ? undefined : modelFor(landed, t);
}

/** The host's request, once per task, for the site notes a browser task left unwritten. */
export const SITE_NOTE_PREFIX = "(Before you finish:";
/** Browser steps a task must have taken on a site before the host asks for notes on it; a two-step visit needs none. */
const SITE_NOTE_MIN_STEPS = Number(process.env.SITE_NOTE_MIN_STEPS ?? 5);
const NO_SITE_NOTES = /(^|\.)(duckduckgo|google|bing|yahoo|browserbase)\.(com|org)$/i;

/** The sites this task drove the browser on (by domain) and the site notes it wrote or updated. */
export function siteActivity(messages: ChatMessage[]): { visited: Map<string, number>; noted: Set<string> } {
  const visited = new Map<string, number>();
  const noted = new Set<string>();
  let current = "";
  for (let i = taskStart(messages); i < messages.length; i++) {
    for (const c of messages[i].tool_calls ?? []) {
      let args: Record<string, unknown> = {};
      try {
        args = JSON.parse(c.function.arguments || "{}");
      } catch {
        continue;
      }
      const name = c.function.name;
      if ((name === "browser_goto" || name === "browser_open") && typeof args.url === "string") current = registrableDomain(args.url);
      else if (name === "login" && typeof args.domain === "string") current = registrableDomain(args.domain);
      if (name.startsWith("browser_") || name === "login") {
        if (current && !NO_SITE_NOTES.test(current)) visited.set(current, (visited.get(current) ?? 0) + 1);
      }
      if ((name === "memory_write" || name === "memory_append") && typeof args.path === "string") {
        const m = args.path.match(/^sites\/([^/]+)\.md$/);
        if (m) noted.add(registrableDomain(m[1]));
      }
    }
  }
  return { visited, noted };
}

/** Domains this task worked for several steps, with no site note written in the task and none on file. */
async function siteNotesMissing(t: Tenant, messages: ChatMessage[]): Promise<string[]> {
  const { visited, noted } = siteActivity(messages);
  const out: string[] = [];
  for (const [domain, steps] of visited) {
    if (steps < SITE_NOTE_MIN_STEPS || noted.has(domain)) continue;
    if ((await readMemory(t, `sites/${domain}.md`)) == null) out.push(domain);
  }
  return out.slice(0, 2);
}

function hasHostNotePrefix(messages: ChatMessage[], prefix: string): boolean {
  for (let i = messages.length - 1; i >= taskStart(messages); i--) if (messages[i].role === "user" && messageText(messages[i]).startsWith(prefix)) return true;
  return false;
}

/**
 * The voice rule "no exclamation marks", enforced: a reply's sentence-ending "!" becomes "." unless it
 * sits inside quotation marks (a draft the user will send, a name). "!?" keeps the question mark.
 */
export function calm(text: string): string {
  let inQuote = false;
  let out = "";
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '"' || ch === "“" || ch === "”") inQuote = ch === '"' ? !inQuote : ch === "“";
    if (ch === "!" && !inQuote) {
      const next = text[i + 1] ?? "";
      if (next === "?") continue; // "!?" -> "?"
      if (out.endsWith(".") || out.endsWith("!")) continue; // "!!" collapses
      out += ".";
      continue;
    }
    out += ch;
  }
  return out;
}

/** Whether the user asked for links or sources themselves, in which case they stay. */
const WANTS_LINKS = /\b(link|links|url|urls|source|sources|where did you (see|get|read)|cite|citation|reference)\b/i;

/**
 * Chat replies are for a person: no "[[2]](https://...)" trails, no bare URLs in parentheses, no
 * "Sources:" block, no "[n]" markers. Removed by the host when they slip through, unless the user
 * asked for the links. Markdown links keep their text.
 */
export function stripCitations(text: string, userText = ""): string {
  if (WANTS_LINKS.test(userText)) return text;
  let out = text
    .replace(/\[\[?\d+\]?\]\((https?:\/\/[^)\s]+)\)/g, "") // [[2]](https://...) and [2](https://...)
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, "$1") // [text](url) -> text
    .replace(/\s?\((?:source|sources|via|per)?:?\s*https?:\/\/[^)\s]+\)/gi, "") // (https://...) or (source: https://...)
    .replace(/\s?\[\d+(?:,\s?\d+)*\]/g, "") // [2] [3, 4]
    .replace(/(^|\n)\s*(sources?|references?)\s*:?\s*\n(?:.*(?:https?:\/\/|^\s*[-•*\d]).*\n?)+$/gim, "$1") // a trailing Sources block
    .replace(/https?:\/\/\S+/g, (u) => (u.length > 0 ? "" : u)); // any bare URL left
  out = out.replace(/[ \t]+([.,;:])/g, "$1").replace(/[ \t]{2,}/g, " ").replace(/\n{3,}/g, "\n\n").trim();
  return out || text;
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
/** Tool results (page snapshots, memory files) older than this many are stubbed on every call: once acted on, a snapshot is dead weight. */
const RECENT_TOOL_RESULTS = Number(process.env.RECENT_TOOL_RESULTS ?? 6);

/** The working copy with this customer's context block right after the shared prompt, marked as its own cache boundary. */
export function withContextBlock(messages: ChatMessage[], block: string | undefined): ChatMessage[] {
  if (!block) return messages;
  return [messages[0], { role: "user", content: block, cacheBoundary: true }, ...messages.slice(1)];
}

/** Which tool produced each result, by call id. */
function toolNames(messages: ChatMessage[]): Map<string, string> {
  const names = new Map<string, string>();
  for (const m of messages) for (const c of m.tool_calls ?? []) names.set(c.id, c.function.name);
  return names;
}

/**
 * An old tool result once the model has acted on it. A search keeps its `[n]` result lines (title
 * and URL, so any of them can still be fetched) and loses the snippets and page text; a page read
 * keeps its header line; anything else keeps its first 240 characters.
 */
export function stubToolResult(tool: string | undefined, content: string): string {
  if (tool === "web_search") return stubSearchResult(content);
  if (tool === "fetch_page") return stubPageResult(content);
  return content.slice(0, 240) + "\n... [older output trimmed; call the tool again if you need it]";
}

/** Earlier tasks in a long thread collapse to a recap once this many messages precede the current task. */
const RECAP_AFTER_MESSAGES = Number(process.env.RECAP_AFTER_MESSAGES ?? 12);
const RECAP_MAX_CHARS = 3500;

/**
 * A long chat thread drags every earlier task into every call. Once the current task starts deep in
 * the thread, everything before it becomes one note: each earlier request with the reply it got,
 * oldest first, built deterministically so the prefix stays identical (and cached) for the whole task.
 * The stored thread is untouched; the details are in memory files if the model needs them.
 */
export function recapEarlier(messages: ChatMessage[]): ChatMessage[] {
  const start = taskStart(messages);
  if (start - 1 <= RECAP_AFTER_MESSAGES) return messages;
  const pairs: string[] = [];
  let request: string | undefined;
  for (let i = 1; i < start; i++) {
    const m = messages[i];
    if (isUserMessage(m)) {
      if (request) pairs.push(`- ${request}\n  agent: (no reply recorded)`);
      const text = messageText(m);
      const when = text.match(/^\[([^\]]+)\]/)?.[1]?.split(" via")[0] ?? "";
      request = `${when ? `[${when}] ` : ""}user: ${text.replace(/^\[[^\]]+\]\n/, "").replace(/\s+/g, " ").slice(0, 200)}`;
    } else if (request && m.role === "assistant" && !m.ephemeral && !m.tool_calls?.length && typeof m.content === "string" && m.content.trim()) {
      pairs.push(`- ${request}\n  agent: ${m.content.replace(/\s+/g, " ").slice(0, 300)}`);
      request = undefined;
    }
  }
  if (request) pairs.push(`- ${request}\n  agent: (no reply recorded)`);
  let recap = pairs.slice(-10).join("\n");
  while (recap.length > RECAP_MAX_CHARS && pairs.length > 1) {
    pairs.shift();
    recap = pairs.slice(-10).join("\n");
  }
  const note: ChatMessage = { role: "user", content: `(Earlier in this thread, oldest first; the pages and details are gone from context, memory files and the tools have them if needed:\n${recap || "- (nothing of note)"})` };
  return [messages[0], note, ...messages.slice(start)];
}

/**
 * How many of the newest tool results stay whole: between RECENT_TOOL_RESULTS and twice that, so the
 * stub boundary moves once every RECENT_TOOL_RESULTS turns instead of every turn. A boundary that
 * moved every turn re-wrote one message per call, and on Claude everything after the first changed
 * message is read again at full price; with hysteresis the prefix stays byte-identical for a run of turns.
 */
export function wholeResultCount(total: number, recent = RECENT_TOOL_RESULTS): number {
  if (total <= recent) return total;
  return recent + ((total - recent) % recent);
}

export function compacted(stored: ChatMessage[]): ChatMessage[] {
  const messages = compactAfterHandoff(recapEarlier(dropStaleScreenshots(stored.map((m) => ({ ...m })))));
  // Always: keep only the newest tool results in full. The user's messages and the assistant's own
  // words stay, so the model remembers what it found; the raw page it found it on does not need to
  // ride along on every later call. The stable prefix keeps the prompt cache warm.
  const names = toolNames(messages);
  const total = messages.filter((m) => m.role === "tool" && typeof m.content === "string").length;
  const whole = wholeResultCount(total);
  let recent = 0;
  for (let i = messages.length - 1; i >= 1; i--) {
    const m = messages[i];
    if (m.role !== "tool" || typeof m.content !== "string") continue;
    if (recent < whole) recent++;
    else if (m.content.length > 400) m.content = stubToolResult(names.get(m.tool_call_id ?? ""), m.content);
  }
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
  let dropped = false;
  while (estimateTokens(messages) >= CONTEXT_TOKENS * COMPACT_TARGET && messages.length > keepTail + 2) {
    const victim = messages[2];
    messages.splice(2, 1);
    dropped = true;
    // Never leave a dangling tool result without its call, or a call without its result.
    if (victim.role === "assistant" && victim.tool_calls) while (messages[2]?.role === "tool") messages.splice(2, 1);
  }
  // Turns were dropped: the plan could go with them. A host-built state of the task (goal, what has
  // been done and said, the last steps, what blocked) is pinned right after the first message, so
  // the thread survives the cut. Built from the stored thread, no model call.
  if (dropped) {
    const state = taskStateNote(stored);
    if (state) messages.splice(2, 0, { role: "user", content: state });
  }
  return messages;
}

/** Fire-and-forget: ask a worker to continue this session. */
export async function kick(sessionId: string): Promise<void> {
  const url = `${env.appUrl()}/api/run?session=${encodeURIComponent(sessionId)}`;
  try {
    // The secret travels in a header, never in the URL, so request logs do not carry it.
    // The worker runs its whole slice before answering, so this never completes; it only needs to
    // be delivered. A short wait keeps the chat request snappy; the cron sweep is the backstop.
    await fetch(url, { method: "POST", headers: { Authorization: `Bearer ${env.cronSecret()}` }, signal: AbortSignal.timeout(Number(process.env.KICK_WAIT_MS ?? 500)) });
  } catch {
    /* the cron sweep picks it up if the kick did not land */
  }
}

/** Why a turn produced nothing, for the log: the usual cause is prose cut off at the tier's output cap. */
function barrenLabel(c: Completion): string {
  const out = c.usage.completion_tokens;
  return `barren (${c.finish_reason}${out ? `, ${out} tokens of prose` : ", nothing"})`;
}

/**
 * Whether a final report means the task did NOT get done. Six failure words used to decide this, and
 * the adaptive router trains on it, so a reply that promised instead of delivering was recorded as a
 * success: "It's drafted with all the details we agreed on — just needs to be generated into a PDF.
 * Say 'go' and I'll produce it." scored as a win for the cheapest model, which then kept being
 * chosen for that kind of work. A promise is not a delivery.
 */
export function notDelivered(report: string): boolean {
  const head = report.slice(0, 300);
  if (/\b(stopped|couldn'?t|could not|unable|blocked|failed|ran out of|gave up)\b/i.test(head)) return true;
  // "just needs to be…", "say go and I'll…", "I'll produce it", "ready for me to…": the work is still
  // in front of the model, not behind it.
  if (/\b(just needs? to be|still needs? to be|ready (for me )?to (be )?(generate|produce|send|submit|create)|say ["']?go["']?|let me know (and|if) I'?ll|shall I (go ahead|proceed)|want me to (go ahead|proceed|do it))\b/i.test(head)) return true;
  if (/\b(i'?ll|i will|let me) (now )?(generate|produce|create|write|draft|send|submit|start|do) (it|that|this|them)\b/i.test(head)) return true;
  return false;
}
