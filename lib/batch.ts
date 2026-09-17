import { one, q } from "./db.js";
import { costCents, type ChatMessage } from "./llm.js";
import { appendMemory } from "./memory.js";
import { recordUsageEvent } from "./sessions.js";
import { tenantById } from "./tenant.js";

/**
 * Deferred single model calls through Anthropic's Message Batches API, which bills half price and
 * answers within hours. Only work nobody is waiting on goes here: today the post-mortem written into
 * history/failures.md after a task that did not finish. Without ANTHROPIC_API_KEY the same call runs
 * immediately at the normal price, so nothing depends on the batch path being configured.
 *
 * The cron submits pending jobs every few minutes as one batch and polls submitted batches; results
 * are applied per job kind. Messages are stored in the OpenAI shape the rest of the code uses and
 * converted to Anthropic's on submission.
 */
export type BatchKind = "postmortem";

export interface BatchPayload {
  messages: ChatMessage[];
  max_tokens: number;
  /** Per-kind data needed to apply the result (for a post-mortem: the memory path and header line). */
  meta: Record<string, string>;
}

export function batchConfigured(): boolean {
  return !!process.env.ANTHROPIC_API_KEY && (process.env.BATCH_API ?? "on") !== "off";
}
const BATCH_MODEL = () => process.env.BATCH_MODEL ?? "claude-haiku-4-5-20251001";
const API = "https://api.anthropic.com/v1/messages/batches";
const headers = () => ({ "x-api-key": process.env.ANTHROPIC_API_KEY!, "anthropic-version": "2023-06-01", "Content-Type": "application/json" });

export async function enqueue(userId: string, kind: BatchKind, payload: BatchPayload): Promise<string> {
  const r = await one<{ id: string }>("insert into batch_jobs (user_id, kind, payload) values ($1, $2, $3::jsonb) returning id", [userId, kind, JSON.stringify(payload)]);
  return r!.id;
}

/** OpenAI-shaped messages to Anthropic's: the system string apart, tool traffic flattened to text, roles alternating. */
export function toAnthropic(messages: ChatMessage[]): { system: string; messages: Array<{ role: "user" | "assistant"; content: string }> } {
  const system: string[] = [];
  const out: Array<{ role: "user" | "assistant"; content: string }> = [];
  const push = (role: "user" | "assistant", text: string) => {
    if (!text.trim()) return;
    const last = out[out.length - 1];
    if (last && last.role === role) last.content += `\n\n${text}`;
    else out.push({ role, content: text });
  };
  for (const m of messages) {
    if (m.ephemeral) continue;
    const text = typeof m.content === "string" ? m.content : (m.content ?? []).filter((p) => p.type === "text").map((p) => (p as { text: string }).text).join("\n");
    if (m.role === "system") system.push(text);
    else if (m.role === "assistant") push("assistant", [text, ...(m.tool_calls ?? []).map((c) => `(called ${c.function.name} ${c.function.arguments.slice(0, 300)})`)].filter(Boolean).join("\n"));
    else if (m.role === "tool") push("user", `(tool result)\n${text.slice(0, 4000)}`);
    else push("user", text);
  }
  if (!out.length || out[0].role !== "user") out.unshift({ role: "user", content: "(continue)" });
  return { system: system.join("\n\n"), messages: out };
}

/** Pending jobs become one batch. Returns how many were submitted. */
export async function submitPending(limit = 500): Promise<number> {
  if (!batchConfigured()) return 0;
  const jobs = await q<{ id: string; payload: BatchPayload }>("select id, payload from batch_jobs where status = 'pending' order by created_at limit $1", [limit]);
  if (!jobs.length) return 0;
  const requests = jobs.map((j) => {
    const { system, messages } = toAnthropic(j.payload.messages);
    return { custom_id: j.id, params: { model: BATCH_MODEL(), max_tokens: j.payload.max_tokens || 400, ...(system ? { system } : {}), messages } };
  });
  const res = await fetch(API, { method: "POST", headers: headers(), body: JSON.stringify({ requests }), signal: AbortSignal.timeout(30_000) });
  const data = (await res.json().catch(() => ({}))) as { id?: string; error?: { message?: string } };
  if (!res.ok || !data.id) {
    console.error(`[batch] submit failed: ${res.status} ${data.error?.message ?? ""}`);
    if (res.status === 400 || res.status === 401 || res.status === 403) await q("update batch_jobs set status = 'failed', result = $2, updated_at = now() where id = any($1::uuid[])", [jobs.map((j) => j.id), `submit ${res.status}: ${data.error?.message ?? ""}`.slice(0, 500)]);
    return 0;
  }
  await q("update batch_jobs set status = 'submitted', batch_id = $2, updated_at = now() where id = any($1::uuid[])", [jobs.map((j) => j.id), data.id]);
  console.log(`[batch] submitted ${jobs.length} job(s) as ${data.id}`);
  return jobs.length;
}

/** Submitted batches that have ended: fetch their results and apply each job. Returns how many jobs finished. */
export async function pollSubmitted(): Promise<number> {
  if (!batchConfigured()) return 0;
  const batches = await q<{ batch_id: string }>("select distinct batch_id from batch_jobs where status = 'submitted' and batch_id is not null");
  let done = 0;
  for (const { batch_id } of batches) {
    const res = await fetch(`${API}/${batch_id}`, { headers: headers(), signal: AbortSignal.timeout(20_000) });
    const info = (await res.json().catch(() => ({}))) as { processing_status?: string; results_url?: string; error?: { message?: string } };
    if (!res.ok) {
      console.error(`[batch] ${batch_id}: ${res.status} ${info.error?.message ?? ""}`);
      if (res.status === 404) await q("update batch_jobs set status = 'failed', result = 'batch not found', updated_at = now() where batch_id = $1", [batch_id]);
      continue;
    }
    if (info.processing_status !== "ended" || !info.results_url) continue;
    const body = await (await fetch(info.results_url, { headers: headers(), signal: AbortSignal.timeout(60_000) })).text();
    for (const line of body.split("\n").filter(Boolean)) {
      let r: { custom_id: string; result: { type: string; message?: { model?: string; content?: Array<{ type: string; text?: string }>; usage?: { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number } }; error?: { message?: string } } };
      try {
        r = JSON.parse(line);
      } catch {
        continue;
      }
      const job = await one<{ id: string; user_id: string; kind: BatchKind; payload: BatchPayload }>("select id, user_id, kind, payload from batch_jobs where id = $1 and status = 'submitted'", [r.custom_id]);
      if (!job) continue;
      if (r.result.type !== "succeeded" || !r.result.message) {
        await q("update batch_jobs set status = 'failed', result = $2, updated_at = now() where id = $1", [job.id, (r.result.error?.message ?? r.result.type).slice(0, 500)]);
        continue;
      }
      const text = (r.result.message.content ?? []).filter((c) => c.type === "text").map((c) => c.text ?? "").join("\n").trim();
      await applyResult(job, text).catch((err) => console.error(`[batch] apply ${job.id}: ${err instanceof Error ? err.message : String(err)}`));
      const usage = r.result.message.usage ?? {};
      const completion = { model: `anthropic/${r.result.message.model ?? BATCH_MODEL()}`, message: { role: "assistant" as const, content: text }, finish_reason: "stop", usage: { prompt_tokens: usage.input_tokens ?? 0, completion_tokens: usage.output_tokens ?? 0, cached_tokens: usage.cache_read_input_tokens ?? 0 } };
      // Batch pricing is half the list price; the price table has the list price.
      const half = costCents(completion.model, completion.usage) / 2;
      await recordUsageEvent(job.user_id, null, job.kind === "postmortem" ? "postmortem" : "other", { ...completion, usage: { ...completion.usage, cost_usd: half / 100 } }).catch(() => {});
      await q("update batch_jobs set status = 'done', result = $2, updated_at = now() where id = $1", [job.id, text.slice(0, 4000)]);
      done++;
    }
  }
  return done;
}

async function applyResult(job: { user_id: string; kind: BatchKind; payload: BatchPayload }, text: string): Promise<void> {
  if (job.kind === "postmortem") {
    if (!text) return;
    const t = await tenantById(job.user_id);
    if (!t) return;
    await appendMemory(t, job.payload.meta.path || "history/failures.md", `\n${job.payload.meta.header ?? ""}\n${text}\n`);
  }
}

/** Old finished jobs are not kept. */
export async function pruneBatches(): Promise<void> {
  await q("delete from batch_jobs where status in ('done', 'failed') and updated_at < now() - interval '14 days'").catch(() => {});
}
