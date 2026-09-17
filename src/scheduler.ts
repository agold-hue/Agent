import { Cron } from "croner";
import { closeIdleBrowsers } from "./browser/pool.js";
import { config } from "./config.js";
import { q } from "./db.js";
import { log } from "./log.js";
import { pollAccount } from "./mail/imap.js";
import { mailAccounts } from "./mail/smtp.js";
import { triageMail } from "./mail/triage.js";
import { allActiveOrgs, orgById } from "./orgs.js";
import { createTask } from "./tasks.js";
import { wakeTask } from "./agent/resume.js";
import { heartbeatAll } from "./agent/worker.js";

/**
 * The clock of the service, in-process: every few seconds it wakes sleeping tasks, fires schedules,
 * polls mailboxes, requeues tasks whose worker died, and closes idle browsers. Each concern is one
 * query, and a failure in one never stops the others.
 */
let timer: NodeJS.Timeout | undefined;
let busy = false;
let lastMailPoll = 0;

export function startScheduler(): void {
  timer = setInterval(() => void tick(), 5000);
  log.info("scheduler", "started");
}

export function stopScheduler(): void {
  if (timer) clearInterval(timer);
}

async function tick(): Promise<void> {
  if (busy) return;
  busy = true;
  try {
    heartbeatAll();
    await Promise.allSettled([wakeSleepers(), fireSchedules(), requeueStale(), closeIdleBrowsers()]);
    if (Date.now() - lastMailPoll > config.mail.pollSeconds() * 1000) {
      lastMailPoll = Date.now();
      await pollMail();
    }
  } catch (e) {
    log.error("scheduler", "tick failed", e);
  } finally {
    busy = false;
  }
}

async function wakeSleepers(): Promise<void> {
  const rows = await q<{ id: string }>("select id from tasks where status = 'waiting_time' and wake_at <= now() limit 50");
  for (const r of rows) await wakeTask(r.id).catch((e) => log.error("scheduler", "wake failed", e, { task: r.id }));
}

export async function fireSchedules(now = new Date()): Promise<number> {
  const due = await q<{ id: string; org_id: string; title: string; instruction: string; cron: string; timezone: string }>("select id, org_id, title, instruction, cron, timezone from schedules where active and (next_run_at is null or next_run_at <= $1) limit 50", [now]);
  let fired = 0;
  for (const s of due) {
    let next: Date | null = null;
    try {
      next = new Cron(s.cron, { timezone: s.timezone }).nextRun(now);
    } catch (e) {
      log.error("scheduler", "bad cron; disabling", e, { schedule: s.id });
      await q("update schedules set active = false where id = $1", [s.id]);
      continue;
    }
    const wasNull = (await q<{ next_run_at: Date | null }>("select next_run_at from schedules where id = $1", [s.id]))[0]?.next_run_at == null;
    await q("update schedules set next_run_at = $2, last_run_at = case when $3 then last_run_at else $4 end where id = $1", [s.id, next, wasNull, now]);
    if (wasNull) continue; // first sight of a schedule: only compute its next run
    const org = await orgById(s.org_id);
    if (!org) continue;
    await createTask({ orgId: s.org_id, title: s.title, instruction: `${s.instruction}\n\n(This is a scheduled task: "${s.title}", cron ${s.cron}.)`, source: "schedule", scheduleId: s.id, createdBy: "system" });
    fired++;
  }
  return fired;
}

async function requeueStale(): Promise<void> {
  const r = await q<{ id: string }>("update tasks set status = 'queued', worker = null where status = 'running' and heartbeat_at < now() - ($1::int || ' seconds')::interval returning id", [config.tasks.staleAfterSeconds()]);
  for (const t of r) log.warn("scheduler", "requeued a stale task", { task: t.id });
}

async function pollMail(): Promise<void> {
  for (const org of await allActiveOrgs()) {
    for (const acc of await mailAccounts(org.id)) {
      if (!acc.active || !acc.imap_host) continue;
      const fresh = await pollAccount(acc);
      for (const m of fresh) await triageMail(org, m).catch((e) => log.error("scheduler", "triage failed", e, { mail: m.id }));
    }
  }
}
