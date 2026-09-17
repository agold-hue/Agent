import os from "node:os";
import { config } from "../config.js";
import { q } from "../db.js";
import { log, errText } from "../log.js";
import { claimTask, orgTaskCounts, updateTask } from "../tasks.js";
import { runTask } from "./loop.js";

/**
 * The worker pool: a few concurrent task runs in this process, claimed from the queue. On shutdown the
 * running tasks are told to stop and go back to the queue; on start-up, anything left "running" by a
 * dead process is requeued.
 */
const workerName = `${os.hostname()}:${process.pid}`;
const running = new Map<string, AbortController>();
let stopping = false;
let claiming = false;
let timer: NodeJS.Timeout | undefined;

export function runningTasks(): string[] {
  return [...running.keys()];
}

export async function startWorkers(): Promise<void> {
  await q("update tasks set status = 'queued', worker = null where status = 'running'");
  timer = setInterval(() => void tick(), 1500);
  log.info("worker", "started", { name: workerName, concurrency: config.tasks.concurrency() });
}

async function tick(): Promise<void> {
  if (stopping || claiming) return;
  claiming = true;
  try {
    await claimLoop();
  } finally {
    claiming = false;
  }
}

async function claimLoop(): Promise<void> {
  while (running.size < config.tasks.concurrency()) {
    const busy = await orgTaskCounts().catch(() => new Map<string, number>());
    const task = await claimTask(workerName, busy, config.tasks.perOrg()).catch((e) => {
      log.error("worker", "claim failed", e);
      return undefined;
    });
    if (!task) return;
    const ac = new AbortController();
    running.set(task.id, ac);
    log.info("worker", "claimed", { task: task.id, org: task.org_id, title: task.title });
    void runTask(task.id, { worker: workerName, signal: ac.signal })
      .catch(async (e) => {
        log.error("worker", "task crashed", e, { task: task.id });
        await updateTask(task.id, { status: "queued", worker: null, error: errText(e).slice(0, 500), scheduled_at: new Date(Date.now() + 60_000) }).catch(() => {});
      })
      .finally(() => running.delete(task.id));
  }
}

/** Heartbeats keep the stale-task sweep from requeueing a live task. */
export function heartbeatAll(): void {
  for (const taskId of running.keys()) void q("update tasks set heartbeat_at = now() where id = $1 and status = 'running'", [taskId]).catch(() => {});
}

export async function stopWorkers(): Promise<void> {
  stopping = true;
  if (timer) clearInterval(timer);
  for (const ac of running.values()) ac.abort();
  const deadline = Date.now() + 20_000;
  while (running.size && Date.now() < deadline) await new Promise((r) => setTimeout(r, 200));
  for (const taskId of running.keys()) await updateTask(taskId, { status: "queued", worker: null }).catch(() => {});
}
