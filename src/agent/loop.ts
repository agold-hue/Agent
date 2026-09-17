import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { closeTaskTabs } from "../browser/pool.js";
import type { BrowserSession } from "../browser/actions.js";
import { config } from "../config.js";
import { q } from "../db.js";
import { fileText, getFile, readFileBytes } from "../files.js";
import { complete, estimateTokens, type ContentBlockParam, type MessageParam, type ToolResultBlock, type ToolUseBlock, Anthropic } from "../llm.js";
import { log, errText } from "../log.js";
import { mailAccounts } from "../mail/smtp.js";
import { saveMemory } from "../memory.js";
import { notify } from "../notify.js";
import { orgById, orgUsers, recordUsage, type Org } from "../orgs.js";
import { addEvent, getTask, takeInbox, updateTask, type Task, type Waiting } from "../tasks.js";
import { localStamp } from "../time.js";
import { executeTool, type ToolOutcome } from "./execute.js";
import { TOOLS } from "./tools.js";

/**
 * The agent loop for one task: model step, tools, persist, repeat. It runs in-process until the task
 * finishes, pauses for the user or for time, hits its budget, or the worker is told to stop. The
 * conversation is saved after every step, so a restart resumes exactly where it was.
 */
const here = path.dirname(fileURLToPath(import.meta.url));
let promptCache: string | undefined;
export function basePrompt(): string {
  if (promptCache) return promptCache;
  for (const p of [path.join(here, "prompt.md"), path.join(process.cwd(), "src", "agent", "prompt.md")]) {
    if (fs.existsSync(p)) return (promptCache = fs.readFileSync(p, "utf8"));
  }
  throw new Error("agent/prompt.md not found");
}

/** The per-business part of the system prompt: stable within a day, cached for five minutes. */
export async function orgPrompt(org: Org): Promise<string> {
  const users = await orgUsers(org.id);
  const mail = await mailAccounts(org.id);
  const s = org.settings;
  const kinds = (s.auto_approve_kinds ?? []).join(", ") || "none";
  const lines = [
    `# The company`,
    `Name: ${org.name}. Time zone: ${org.timezone}. People who can answer you: ${users.map((u) => `${u.name ? `${u.name} ` : ""}<${u.email}>`).join(", ") || "the owner"}.`,
    mail.length ? `Connected mailboxes: ${mail.map((m) => m.address).join(", ")} (email_search/email_read cover them; email_send sends from the first).` : `No mailbox is connected: email_send goes out from the platform address in the company's name; email_search sees only mail the platform has logged.`,
    `Approval policy: kinds pre-approved: ${kinds}; money ceiling for pre-approved kinds: $${s.auto_approve_under_usd ?? 0}; emails to outsiders ${s.auto_send_email ? "go out without approval" : "wait for approval"}. Everything else waits for a person.`,
    s.profile ? `\n# About the company (from its owner)\n${s.profile.trim()}` : `\n# About the company\n(The owner has not written a profile yet. Ask for facts you need and save them with memory_save as fact.)`,
    s.inbox_instructions ? `\n# Standing instructions for incoming mail\n${s.inbox_instructions.trim()}` : "",
  ];
  return lines.filter(Boolean).join("\n");
}

const stamp = (org: Org) => `[${localStamp(org.timezone)}]`;

/** The opening user message: the request, with attachments extracted so the model never has to ask for what is already there. */
async function openingMessage(org: Org, task: Task): Promise<MessageParam> {
  const parts: ContentBlockParam[] = [];
  let text = `${stamp(org)} Task from ${task.source === "email" ? "an incoming email" : task.source === "schedule" ? "a schedule" : task.source === "agent" ? "another task" : "the user"}: ${task.title}\n\n${task.instruction}`;
  const ev = await q<{ data: { attachments?: Array<{ file_id: string; name: string }> } | null }>("select data from task_events where task_id = $1 and kind = 'user' order by at asc limit 1", [task.id]);
  for (const att of ev[0]?.data?.attachments ?? []) {
    const f = await getFile(org.id, att.file_id);
    if (!f) continue;
    if (/^image\//.test(f.mime)) {
      const buf = await readFileBytes(f);
      if (buf.length < 4_500_000) parts.push({ type: "image", source: { type: "base64", media_type: f.mime as "image/jpeg" | "image/png" | "image/gif" | "image/webp", data: buf.toString("base64") } });
      text += `\n\n[Attached image: ${f.name} (file id ${f.id})]`;
    } else {
      const t = await fileText(f, 15_000).catch((e) => `(could not read: ${errText(e)})`);
      text += `\n\n--- Attached file "${f.name}" (file id ${f.id}; file_read for more) ---\n${t}`;
    }
  }
  parts.unshift({ type: "text", text });
  return { role: "user", content: parts };
}

export interface RunOptions {
  worker: string;
  signal?: AbortSignal;
}

export type RunEnd = "done" | "waiting" | "sleeping" | "stopped" | "cancelled" | "error";

export async function runTask(taskId: string, opts: RunOptions): Promise<RunEnd> {
  let task = (await getTask(taskId))!;
  const org = (await orgById(task.org_id))!;
  const startedAt = Date.now();
  const model = task.model ?? config.llm.taskModel();
  const browser: BrowserSession = { orgId: org.id, taskId: task.id, timezone: org.timezone, locale: org.settings.locale };
  const conv: MessageParam[] = task.conversation.length ? task.conversation : [await openingMessage(org, task)];
  const system = [
    { text: basePrompt(), cache: "1h" as const },
    { text: await orgPrompt(org), cache: "5m" as const },
  ];
  let stepsThisRun = 0;
  let lastStamp = Date.now();
  let endedWithoutFinish = 0;
  const recentSigs: string[] = [];
  const persist = (patch: Partial<Record<keyof Task, unknown>> = {}) => updateTask(task.id, { conversation: conv, steps: task.steps, cost_cents: task.cost_cents, input_tokens: task.input_tokens, output_tokens: task.output_tokens, cache_read_tokens: task.cache_read_tokens, model, heartbeat_at: new Date(), ...patch });

  try {
    if (!task.model) await updateTask(task.id, { model });
    while (true) {
      if (opts.signal?.aborted) {
        await persist({ status: "queued", worker: null });
        return "stopped";
      }
      // The DB is the source of truth for status: a cancel from the console lands here.
      const fresh = await getTask(task.id);
      if (!fresh || fresh.status !== "running") {
        log.info("task", "no longer running; leaving", { task: task.id, status: fresh?.status });
        return "cancelled";
      }
      // Messages the user sent while we were working.
      for (const m of await takeInbox(task.id)) {
        let text = `${stamp(org)} Message from the user while you work: ${m.text}`;
        for (const att of m.attachments) {
          const f = await getFile(org.id, att.file_id);
          if (f) text += `\n\n--- Attached file "${f.name}" (file id ${f.id}) ---\n${await fileText(f, 12_000).catch(() => "(unreadable)")}`;
        }
        conv.push({ role: "user", content: text });
        lastStamp = Date.now();
      }
      // Budgets.
      const elapsedMin = (Date.now() - new Date(task.started_at ?? startedAt).getTime()) / 60_000;
      const over = task.steps >= config.tasks.maxSteps() ? `You have used ${task.steps} steps, the task's limit.` : elapsedMin > config.tasks.maxMinutes() ? `This task has run ${Math.round(elapsedMin)} minutes, its time limit.` : Number(task.cost_cents) / 100 >= config.tasks.maxUsd() ? `This task has spent its budget.` : "";
      if (over) {
        const result = await wrapUp(org, task, conv, system, model, over);
        await finish(org, task, conv, "blocked", result, browser);
        return "done";
      }
      pruneContext(conv);

      // ---- model step
      let completion;
      try {
        completion = await complete({ model, system, messages: conv, tools: TOOLS, signal: opts.signal });
      } catch (e) {
        if (opts.signal?.aborted) {
          await persist({ status: "queued", worker: null });
          return "stopped";
        }
        if (e instanceof Anthropic.APIError && (e.status === 400 || e.status === 401 || e.status === 403 || e.status === 402)) {
          const msg = e.status === 401 || e.status === 403 ? "The AI provider rejected the API key." : e.status === 402 ? "The AI provider account is out of credit." : `The AI provider rejected the request: ${e.message.slice(0, 300)}`;
          await addEvent(task, "error", msg);
          await finish(org, task, conv, "failed", `${msg} Fix the setting and send "try again".`, browser);
          return "error";
        }
        throw e; // rate limits and 5xx already retried by the SDK; the worker requeues with backoff
      }
      task.steps += 1;
      stepsThisRun += 1;
      task.cost_cents = Math.round((Number(task.cost_cents) + completion.costCents) * 1000) / 1000;
      task.input_tokens = Number(task.input_tokens) + completion.usage.input + completion.usage.cacheWrite + completion.usage.cacheRead;
      task.output_tokens = Number(task.output_tokens) + completion.usage.output;
      task.cache_read_tokens = Number(task.cache_read_tokens) + completion.usage.cacheRead;
      await recordUsage(org.id, { costCents: completion.costCents, input: completion.usage.input + completion.usage.cacheWrite, output: completion.usage.output, cacheRead: completion.usage.cacheRead });
      conv.push({ role: "assistant", content: completion.message.content });
      const stop = completion.message.stop_reason;
      log.info("step", `${task.id} #${task.steps}`, { model: completion.model, stop, tools: completion.toolUses.map((t) => t.name).join(","), cents: completion.costCents, cacheRead: completion.usage.cacheRead });
      if (completion.text) await addEvent(task, "step", completion.text.slice(0, 2000));

      if (stop === "refusal") {
        const why = completion.message.stop_details && "explanation" in completion.message.stop_details ? String(completion.message.stop_details.explanation ?? "") : "";
        await finish(org, task, conv, "failed", `I can't do this task: it was declined by the model's safety policy${why ? ` (${why})` : ""}.`, browser);
        return "done";
      }
      if (stop === "max_tokens") {
        conv.push({ role: "user", content: "(Your reply was cut off at the output limit. Continue, more briefly.)" });
        await persist();
        continue;
      }
      if (!completion.toolUses.length) {
        // Text without a tool call. Once: remind about finish_task. Twice: accept the text as the result.
        endedWithoutFinish += 1;
        if (endedWithoutFinish >= 2 || !completion.text) {
          await finish(org, task, conv, "done", completion.text || "(no result)", browser);
          return "done";
        }
        conv.push({ role: "user", content: "(Your turn ended without a tool call. If the task is finished, call finish_task with the result. If not, take the next step now.)" });
        await persist();
        continue;
      }
      endedWithoutFinish = 0;

      // ---- tools
      const results: ToolResultBlock[] = [];
      let pause: { block: ToolUseBlock; outcome: Extract<ToolOutcome, { kind: "pause" | "sleep" }> } | undefined;
      let finished: Extract<ToolOutcome, { kind: "finish" }> | undefined;
      for (const block of completion.toolUses) {
        if (finished) break;
        const input = (block.input ?? {}) as Record<string, unknown>;
        const t0 = Date.now();
        let out: ToolOutcome;
        try {
          out = await executeTool({ org, task, browser }, block.name, input);
        } catch (e) {
          out = { kind: "result", content: `Tool error: ${errText(e).split("\n")[0].slice(0, 400)}`, isError: true };
        }
        const ms = Date.now() - t0;
        if (out.kind === "result") {
          const summary = out.summary ?? (typeof out.content === "string" ? out.content.split("\n")[0].slice(0, 200) : "");
          await addEvent(task, "tool", `${block.name}${describeArgs(block.name, input)} -> ${summary}`, { ms, error: !!out.isError });
          results.push({ type: "tool_result", tool_use_id: block.id, content: out.content, ...(out.isError ? { is_error: true } : {}) });
        } else if (out.kind === "finish") {
          finished = out;
        } else {
          pause = { block, outcome: out };
          break;
        }
      }
      // Loop guard: the same call with the same arguments many times in a row is a stuck model; say so once.
      for (const b of completion.toolUses) recentSigs.push(`${b.name}:${JSON.stringify(b.input)}`);
      if (recentSigs.length > 12) recentSigs.splice(0, recentSigs.length - 12);
      const lastSig = recentSigs[recentSigs.length - 1];
      const repeats = recentSigs.filter((s) => s === lastSig).length;
      const stuck = repeats >= 4 && !/^browser_wait/.test(lastSig ?? "");

      if (finished) {
        // Results of tools that ran before finish_task in the same turn still need a tool_result each.
        const pending = completion.toolUses.filter((b) => !results.some((r) => r.tool_use_id === b.id));
        for (const b of pending) results.push({ type: "tool_result", tool_use_id: b.id, content: b.name === "finish_task" ? "Task finished." : "(not executed: the task finished)" });
        conv.push({ role: "user", content: results });
        await finish(org, task, conv, finished.outcome, finished.result, browser);
        return "done";
      }
      if (pause) {
        const others = completion.toolUses.filter((b) => b.id !== pause!.block.id && !results.some((r) => r.tool_use_id === b.id));
        for (const b of others) results.push({ type: "tool_result", tool_use_id: b.id, content: "(not executed: the task paused before this call; call it again after the pause if still needed)" });
        if (pause.outcome.kind === "sleep") {
          const waiting: Waiting & { pending_results?: ToolResultBlock[]; reason?: string } = { kind: "question", tool_use_id: pause.block.id, asked_at: new Date().toISOString(), pending_results: results, reason: pause.outcome.reason };
          await addEvent(task, "system", `Sleeping until ${localStamp(org.timezone, pause.outcome.wakeAt)}: ${pause.outcome.reason}`);
          await persist({ status: "waiting_time", wake_at: pause.outcome.wakeAt, waiting, worker: null, last_progress: `Waiting until ${localStamp(org.timezone, pause.outcome.wakeAt).slice(0, 20)}: ${pause.outcome.reason}`.slice(0, 500) });
          await closeTaskTabs(org.id, task.id).catch(() => {});
          return "sleeping";
        }
        const w = pause.outcome.waiting;
        const waiting: Waiting & { pending_results?: ToolResultBlock[]; on_approve?: unknown } = { kind: w.kind, tool_use_id: pause.block.id, question: w.question, options: w.options, action: w.action, details: w.details, amount_usd: w.amount_usd, asked_at: new Date().toISOString(), pending_results: results, on_approve: w.on_approve };
        await addEvent(task, w.kind, pause.outcome.summary, { details: w.details, options: w.options, amount_usd: w.amount_usd });
        await persist({ status: "waiting_user", waiting, worker: null, last_progress: pause.outcome.summary.slice(0, 500) });
        await notify(org, { kind: "needs_you", title: w.kind === "approval" ? `Approval needed: ${w.action}` : `Question: ${task.title}`, body: w.kind === "approval" ? `${w.details ?? ""}${w.amount_usd !== undefined ? `\nAmount: $${w.amount_usd}` : ""}` : w.question, taskId: task.id });
        return "waiting";
      }
      const content: ContentBlockParam[] = [...results];
      if (stuck) content.push({ type: "text", text: "(Host note: you have made the same call with the same arguments several times in a row and the page is not changing. That route is a dead end. Read the page fresh, take a different route, or finish_task with outcome blocked and say exactly what is in the way.)" });
      if (Date.now() - lastStamp > 10 * 60_000) {
        content.push({ type: "text", text: `(Now: ${localStamp(org.timezone)})` });
        lastStamp = Date.now();
      }
      conv.push({ role: "user", content });
      await persist();
    }
  } catch (e) {
    log.error("task", "run failed", e, { task: task.id, steps: stepsThisRun });
    // Retry later with the conversation intact; give up after repeated crashes.
    const crashes = Number((await q<{ n: string }>("select count(*)::text as n from task_events where task_id = $1 and kind = 'error' and at > now() - interval '1 hour'", [task.id]))[0]?.n ?? 0);
    await addEvent(task, "error", errText(e).slice(0, 500));
    if (crashes >= 4) {
      await finish(org, task, conv, "failed", `I hit repeated errors and stopped: ${errText(e).slice(0, 300)}. Send "try again" to resume.`, browser);
      return "error";
    }
    await persist({ status: "queued", worker: null, scheduled_at: new Date(Date.now() + Math.min(60_000 * 2 ** crashes, 15 * 60_000)) });
    return "error";
  }
}

function describeArgs(name: string, input: Record<string, unknown>): string {
  const keys = ["url", "ref", "text", "query", "to", "subject", "key", "name", "file_id", "when", "title", "site", "direction", "key"];
  const parts: string[] = [];
  for (const k of keys) if (input[k] !== undefined && input[k] !== "") parts.push(`${k}=${JSON.stringify(String(input[k]).slice(0, 60))}`);
  if (name === "browser_fill" && Array.isArray(input.fields)) parts.push(`${(input.fields as unknown[]).length} fields`);
  return parts.length ? `(${parts.join(" ")})` : "";
}

/**
 * Keep the context in bounds without touching the cached prefix every step: when the estimate passes the
 * threshold, stub every old tool result in one pass and leave the tail alone. Images older than the last
 * two are dropped the same way.
 */
export function pruneContext(conv: MessageParam[]): void {
  if (estimateTokens(conv) < config.llm.pruneAtTokens()) return;
  const keep = config.llm.keepRecentToolResults();
  let seen = 0;
  let images = 0;
  for (let i = conv.length - 1; i >= 0; i--) {
    const m = conv[i];
    if (m.role !== "user" || typeof m.content === "string") continue;
    for (let j = m.content.length - 1; j >= 0; j--) {
      const b = m.content[j];
      if (b.type !== "tool_result") continue;
      seen++;
      if (Array.isArray(b.content)) {
        for (let k = 0; k < b.content.length; k++) {
          const c = b.content[k];
          if (c.type === "image") {
            images++;
            if (images > 2) b.content[k] = { type: "text", text: "(earlier screenshot removed to save context)" };
          }
        }
      }
      if (seen <= keep) continue;
      const text = typeof b.content === "string" ? b.content : (b.content ?? []).map((c) => (c.type === "text" ? c.text : "")).join("\n");
      if (text.length > 600) b.content = text.slice(0, 400) + "\n... [older result trimmed; call the tool again if you need it]";
    }
  }
}

/** The host is stopping the task: one call, no tools, for an honest report of where things stand. */
async function wrapUp(org: Org, task: Task, conv: MessageParam[], system: Array<{ text: string; cache?: "1h" | "5m" }>, model: string, reason: string): Promise<string> {
  try {
    const c = await complete({
      model,
      system,
      messages: [...conv, { role: "user", content: `(${reason} Stop now and report to the user in a few short lines: what got done, what you found (figures, references), and exactly what is blocking or what you need from them. Plain words, no tool calls.)` }],
      tools: TOOLS,
      toolChoice: "none",
      maxTokens: 2000,
      effort: "medium",
    });
    task.cost_cents = Math.round((Number(task.cost_cents) + c.costCents) * 1000) / 1000;
    await recordUsage(org.id, { costCents: c.costCents, input: c.usage.input + c.usage.cacheWrite, output: c.usage.output, cacheRead: c.usage.cacheRead });
    if (c.text) return `${c.text}\n\n(Stopped by the host: ${reason.toLowerCase()} Send "keep going" to continue.)`;
  } catch (e) {
    log.error("task", "wrap-up failed", e, { task: task.id });
  }
  return `Stopped: ${reason} Send "keep going" to continue from here.`;
}

/** The task ends: persist, remember, close the browser, tell the user and any parent task. */
async function finish(org: Org, task: Task, conv: MessageParam[], outcome: "done" | "blocked" | "failed", result: string, browser: BrowserSession): Promise<void> {
  const status = outcome === "failed" ? "failed" : "done";
  await updateTask(task.id, { conversation: conv, steps: task.steps, cost_cents: task.cost_cents, input_tokens: task.input_tokens, output_tokens: task.output_tokens, cache_read_tokens: task.cache_read_tokens, status, outcome, result: result.slice(0, 20_000), finished_at: new Date(), worker: null, waiting: null, last_progress: null });
  await addEvent(task, "result", result.slice(0, 4000), { outcome });
  await saveMemory(org.id, "history", `${new Date().toISOString().slice(0, 10)} ${task.title}`.slice(0, 200), `Outcome: ${outcome}\nRequest: ${task.instruction.slice(0, 600)}\nResult: ${result.slice(0, 2500)}`).catch(() => {});
  await closeTaskTabs(org.id, task.id).catch(() => {});
  void browser;
  await notify(org, { kind: outcome === "done" ? "done" : outcome === "blocked" ? "needs_you" : "failed", title: `${outcome === "done" ? "Done" : outcome === "blocked" ? "Needs you" : "Failed"}: ${task.title}`, body: result.slice(0, 2000), taskId: task.id });
  if (task.parent_id) {
    const parent = await getTask(task.parent_id);
    if (parent && ["running", "queued", "waiting_time", "waiting_user"].includes(parent.status)) {
      await q("insert into task_inbox (id, task_id, text) values ($1,$2,$3)", [`msg_${task.id}`, parent.id, `Sub-task "${task.title}" (${task.id}) finished with outcome ${outcome}:\n${result.slice(0, 4000)}`]);
      if (parent.status === "waiting_time") await updateTask(parent.id, { status: "queued", scheduled_at: new Date(), wake_at: null });
    }
  }
  log.info("task", `finished ${task.id}`, { outcome, steps: task.steps, cents: task.cost_cents });
}
