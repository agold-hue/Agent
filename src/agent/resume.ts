import { q } from "../db.js";
import { id } from "../ids.js";
import type { ToolResultBlock } from "../llm.js";
import { orgById } from "../orgs.js";
import { addEvent, getTask, updateTask, type Task } from "../tasks.js";
import { localStamp } from "../time.js";
import { sendEmailPayload } from "./execute.js";

/**
 * How a paused task gets going again: the user's answer or decision becomes the tool_result of the
 * call that paused it, together with the results of the other calls from that turn, in one message.
 */
type WaitingFull = NonNullable<Task["waiting"]> & { pending_results?: ToolResultBlock[]; on_approve?: { type: "email_send"; payload: { to: string; cc?: string; subject: string; markdown: string; attachments: string[]; reply_to_message_id?: string } }; reason?: string };

export async function answerTask(task: Task, answer: { text?: string; approved?: boolean }, by = "user"): Promise<void> {
  const org = (await orgById(task.org_id))!;
  const w = task.waiting as WaitingFull | null;
  const text = (answer.text ?? "").trim();
  await addEvent(task, "user", answer.approved === true ? `Approved${text ? `: ${text}` : ""}` : answer.approved === false ? `Declined${text ? `: ${text}` : ""}` : text, { by });
  if (task.status !== "waiting_user" || !w) {
    // Not waiting: treat as a message to the task (delivered at the next step, or restarts a finished task).
    await q("insert into task_inbox (id, task_id, text) values ($1,$2,$3)", [id("msg"), task.id, text || (answer.approved ? "Approved." : "Declined.")]);
    if (task.status === "waiting_time") await updateTask(task.id, { status: "queued", scheduled_at: new Date(), wake_at: null });
    else if (["done", "failed", "cancelled"].includes(task.status)) await updateTask(task.id, { status: "queued", scheduled_at: new Date(), outcome: null, result: null, error: null, finished_at: null, waiting: null });
    return;
  }
  let content: string;
  if (w.kind === "approval") {
    if (answer.approved === true) {
      content = `Approved by the user${text ? `: ${text}` : "."}`;
      if (w.on_approve?.type === "email_send") {
        try {
          content = `Approved by the user. ${await sendEmailPayload(org, task, w.on_approve.payload)}`;
        } catch (e) {
          content = `Approved by the user, but sending failed: ${e instanceof Error ? e.message : String(e)}. Fix or try another way.`;
        }
      }
    } else if (answer.approved === false) content = `Declined by the user${text ? `: ${text}` : "."} Do not do this; continue with what else is possible or finish_task with outcome blocked.`;
    else content = `User replied: ${text}`;
  } else content = `User replied: ${text}`;
  const results: ToolResultBlock[] = [...(w.pending_results ?? []), { type: "tool_result", tool_use_id: w.tool_use_id, content: `${content}\n(Now: ${localStamp(org.timezone)})` }];
  const conv = task.conversation.slice();
  conv.push({ role: "user", content: results });
  await updateTask(task.id, { conversation: conv, waiting: null, status: "queued", scheduled_at: new Date(), last_progress: null });
}

/** A task whose wake_at passed: the sleep's tool_result says the time is up, and it runs again. */
export async function wakeTask(taskId: string): Promise<void> {
  const task = await getTask(taskId);
  if (!task || task.status !== "waiting_time") return;
  const org = (await orgById(task.org_id))!;
  const w = task.waiting as WaitingFull | null;
  const conv = task.conversation.slice();
  if (w) {
    const results: ToolResultBlock[] = [...(w.pending_results ?? []), { type: "tool_result", tool_use_id: w.tool_use_id, content: `The wait is over. Now: ${localStamp(org.timezone)}. You were waiting for: ${w.reason ?? "(unspecified)"}. Check and continue.` }];
    conv.push({ role: "user", content: results });
  }
  await updateTask(task.id, { conversation: conv, waiting: null, wake_at: null, status: "queued", scheduled_at: new Date(), last_progress: null });
  await addEvent(task, "system", "Resumed after the wait");
}

/** A plain message to a task (not an answer): queued for its next step; a finished task restarts on it. */
export async function messageTask(task: Task, text: string, attachments: Array<{ file_id: string; name: string }> = []): Promise<void> {
  if (task.status === "waiting_user") return answerTask(task, { text });
  await addEvent(task, "user", text, attachments.length ? { attachments } : undefined);
  await q("insert into task_inbox (id, task_id, text, attachments) values ($1,$2,$3,$4)", [id("msg"), task.id, text, JSON.stringify(attachments)]);
  if (task.status === "waiting_time") await updateTask(task.id, { status: "queued", scheduled_at: new Date(), wake_at: null });
  else if (["done", "failed", "cancelled"].includes(task.status)) await updateTask(task.id, { status: "queued", scheduled_at: new Date(), outcome: null, result: null, error: null, finished_at: null, waiting: null });
}
