import { one, q } from "./db.js";
import { id } from "./ids.js";
import type { MessageParam } from "./llm.js";

export type TaskStatus = "queued" | "running" | "waiting_user" | "waiting_time" | "done" | "failed" | "cancelled";

export interface Waiting {
  kind: "question" | "approval";
  tool_use_id: string;
  question?: string;
  options?: string[];
  action?: string;
  details?: string;
  amount_usd?: number;
  asked_at: string;
}

export interface Task {
  id: string;
  org_id: string;
  title: string;
  instruction: string;
  status: TaskStatus;
  outcome: "done" | "blocked" | "failed" | null;
  priority: number;
  source: string;
  parent_id: string | null;
  schedule_id: string | null;
  mail_message_id: string | null;
  created_by: string | null;
  conversation: MessageParam[];
  steps: number;
  cost_cents: number;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  model: string | null;
  scheduled_at: Date;
  wake_at: Date | null;
  waiting: Waiting | null;
  result: string | null;
  error: string | null;
  worker: string | null;
  heartbeat_at: Date | null;
  started_at: Date | null;
  finished_at: Date | null;
  last_progress: string | null;
  browser_used: boolean;
  created_at: Date;
  updated_at: Date;
}

export interface TaskEvent {
  id: string;
  task_id: string;
  org_id: string;
  kind: string;
  summary: string;
  data: Record<string, unknown> | null;
  at: Date;
}

export const getTask = (taskId: string) => one<Task>("select * from tasks where id = $1", [taskId]);

export async function createTask(t: {
  orgId: string;
  title: string;
  instruction: string;
  source?: string;
  priority?: number;
  parentId?: string;
  scheduleId?: string;
  mailMessageId?: string;
  createdBy?: string;
  scheduledAt?: Date;
  attachments?: Array<{ file_id: string; name: string }>;
}): Promise<Task> {
  const taskId = id("task");
  const row = (await one<Task>(
    `insert into tasks (id, org_id, title, instruction, source, priority, parent_id, schedule_id, mail_message_id, created_by, scheduled_at)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) returning *`,
    [taskId, t.orgId, t.title.slice(0, 200), t.instruction, t.source ?? "chat", t.priority ?? 5, t.parentId ?? null, t.scheduleId ?? null, t.mailMessageId ?? null, t.createdBy ?? null, t.scheduledAt ?? new Date()],
  ))!;
  if (t.attachments?.length) await q("update tasks set conversation = $2 where id = $1", [taskId, JSON.stringify([])]);
  await addEvent(row, "user", t.instruction.slice(0, 2000), t.attachments?.length ? { attachments: t.attachments } : undefined);
  await q("insert into usage (org_id, month, tasks) values ($1, date_trunc('month', now())::date, 1) on conflict (org_id, month) do update set tasks = usage.tasks + 1", [t.orgId]);
  return row;
}

export async function updateTask(taskId: string, patch: Partial<Record<keyof Task, unknown>>): Promise<void> {
  const cols = Object.keys(patch);
  if (!cols.length) return;
  const vals = Object.values(patch).map((v) => (v !== null && typeof v === "object" && !(v instanceof Date) ? JSON.stringify(v) : v));
  await q(`update tasks set ${cols.map((c, i) => `${c} = $${i + 2}`).join(", ")}, updated_at = now() where id = $1`, [taskId, ...vals]);
}

export async function addEvent(task: Pick<Task, "id" | "org_id">, kind: string, summary: string, data?: Record<string, unknown>): Promise<void> {
  await q("insert into task_events (id, task_id, org_id, kind, summary, data) values ($1,$2,$3,$4,$5,$6)", [id("ev"), task.id, task.org_id, kind, summary.slice(0, 4000), data ? JSON.stringify(data) : null]);
}

export const taskEvents = (taskId: string, limit = 400) => q<TaskEvent>("select * from task_events where task_id = $1 order by at asc limit $2", [taskId, limit]);

export async function listTasks(orgId: string, opts: { status?: TaskStatus[]; limit?: number; before?: Date } = {}): Promise<Task[]> {
  const params: unknown[] = [orgId];
  let where = "org_id = $1";
  if (opts.status?.length) {
    params.push(opts.status);
    where += ` and status = any($${params.length})`;
  }
  if (opts.before) {
    params.push(opts.before);
    where += ` and created_at < $${params.length}`;
  }
  params.push(opts.limit ?? 50);
  return q<Task>(`select id, org_id, title, instruction, status, outcome, priority, source, parent_id, schedule_id, mail_message_id, created_by, steps, cost_cents, model, scheduled_at, wake_at, waiting, result, error, started_at, finished_at, last_progress, browser_used, created_at, updated_at, '[]'::jsonb as conversation, 0 as input_tokens, 0 as output_tokens, 0 as cache_read_tokens, null as worker, heartbeat_at from tasks where ${where} order by created_at desc limit $${params.length}`, params);
}

/** Atomically claim the next runnable task (queued and due). Postgres `for update skip locked` keeps workers from colliding. */
export async function claimTask(worker: string, busyOrgs: Map<string, number>, perOrg: number): Promise<Task | undefined> {
  const saturated = [...busyOrgs.entries()].filter(([, n]) => n >= perOrg).map(([o]) => o);
  const row = await one<Task>(
    `update tasks set status = 'running', worker = $1, heartbeat_at = now(), started_at = coalesce(started_at, now()), updated_at = now()
     where id = (select id from tasks where status = 'queued' and scheduled_at <= now() and not (org_id = any($2::text[])) order by priority asc, scheduled_at asc, created_at asc limit 1 for update skip locked)
     returning *`,
    [worker, saturated],
  );
  return row;
}

/** Tasks the user must answer (a question or an approval). */
export const waitingTasks = (orgId: string) => q<Task>("select * from tasks where org_id = $1 and status = 'waiting_user' order by updated_at desc", [orgId]);

/** A message for a task: if it is waiting on the user, this is the answer; otherwise it is delivered at the next step. */
export async function sendToTask(task: Task, text: string, attachments: Array<{ file_id: string; name: string }> = []): Promise<"answered" | "queued" | "restarted"> {
  await addEvent(task, "user", text, attachments.length ? { attachments } : undefined);
  if (task.status === "waiting_user" && task.waiting) {
    const answer = attachments.length ? `${text}\n(attached: ${attachments.map((a) => `${a.name} [file ${a.file_id}]`).join(", ")})` : text;
    const conv = task.conversation.slice();
    conv.push({ role: "user", content: [{ type: "tool_result", tool_use_id: task.waiting.tool_use_id, content: `User replied: ${answer}` }] });
    await updateTask(task.id, { conversation: conv, waiting: null, status: "queued", scheduled_at: new Date() });
    return "answered";
  }
  if (task.status === "running" || task.status === "queued" || task.status === "waiting_time") {
    await q("insert into task_inbox (id, task_id, text, attachments) values ($1,$2,$3,$4)", [id("msg"), task.id, text, JSON.stringify(attachments)]);
    if (task.status === "waiting_time") await updateTask(task.id, { status: "queued", scheduled_at: new Date(), wake_at: null });
    return "queued";
  }
  // Finished task: the follow-up continues the same conversation so the worker keeps its context.
  await q("insert into task_inbox (id, task_id, text, attachments) values ($1,$2,$3,$4)", [id("msg"), task.id, text, JSON.stringify(attachments)]);
  await updateTask(task.id, { status: "queued", scheduled_at: new Date(), outcome: null, result: null, error: null, finished_at: null, waiting: null });
  return "restarted";
}

export async function takeInbox(taskId: string): Promise<Array<{ text: string; attachments: Array<{ file_id: string; name: string }> }>> {
  const rows = await q<{ id: string; text: string; attachments: Array<{ file_id: string; name: string }> }>("select id, text, attachments from task_inbox where task_id = $1 and delivered_at is null order by created_at", [taskId]);
  if (rows.length) await q("update task_inbox set delivered_at = now() where id = any($1::text[])", [rows.map((r) => r.id)]);
  return rows;
}

export async function cancelTask(task: Task): Promise<void> {
  await updateTask(task.id, { status: "cancelled", finished_at: new Date(), waiting: null });
  await addEvent(task, "system", "Cancelled by the user");
}

export async function orgTaskCounts(): Promise<Map<string, number>> {
  const rows = await q<{ org_id: string; n: string }>("select org_id, count(*)::text as n from tasks where status = 'running' group by org_id");
  return new Map(rows.map((r) => [r.org_id, Number(r.n)]));
}
