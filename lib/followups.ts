import { one, q } from "./db.js";

/** Timers and recurring watches the agent sets for itself, per tenant, fired by the cron. */
export interface FollowUp {
  id: string;
  user_id: string;
  due: Date;
  what: string;
  project: string | null;
  repeat_ms: string | null;
  until_at: Date | null;
  fired: number;
  channel: "chat" | "email";
  created_at: Date;
}

export function durationMs(d: string): number | null {
  const m = d.trim().match(/^(\d+(?:\.\d+)?)\s*(m|min|mins|minutes?|h|hr|hrs|hours?|d|days?|w|weeks?)$/i);
  if (!m) return null;
  const n = Number(m[1]);
  const u = m[2].toLowerCase();
  return u.startsWith("m") ? n * 60_000 : u.startsWith("h") ? n * 3_600_000 : u.startsWith("d") ? n * 86_400_000 : n * 7 * 86_400_000;
}

/** "2h", "45m", "1d", or an ISO timestamp -> Date (null if unparseable or clearly in the past). */
export function parseWhen(when: string, now = new Date()): Date | null {
  const ms = durationMs(when);
  if (ms != null) return new Date(now.getTime() + ms);
  const t = new Date(when);
  if (Number.isNaN(t.getTime())) return null;
  return t.getTime() < now.getTime() - 60_000 ? null : t;
}

export async function addFollowUp(userId: string, f: { due: Date; what: string; project?: string; repeatMs?: number; until?: Date; channel?: "chat" | "email" }): Promise<FollowUp> {
  const r = await one<FollowUp>(
    "insert into followups (user_id, due, what, project, repeat_ms, until_at, channel) values ($1,$2,$3,$4,$5,$6,$7) returning *",
    [userId, f.due, f.what, f.project ?? null, f.repeatMs ?? null, f.until ?? null, f.channel ?? "chat"],
  );
  return r!;
}

export async function cancelFollowUp(userId: string, id: string): Promise<number> {
  const rows = await q("delete from followups where user_id = $1 and id = $2 returning id", [userId, id]);
  return rows.length;
}

export async function listFollowUps(userId: string): Promise<FollowUp[]> {
  return q<FollowUp>("select * from followups where user_id = $1 order by due", [userId]);
}

/**
 * Claim every due follow-up across all tenants. One-shots are deleted; recurring watches are
 * re-armed for their next slot (or dropped once past until_at).
 */
export async function takeDueFollowUps(limit = 200): Promise<FollowUp[]> {
  // One statement claims, re-arms and deletes: two cron runs that overlap (a run takes longer than
  // the minute between them) cannot both take the same timer, which fired a watch twice before.
  // The rows locked in `due` are skipped by the other run; the final select reads the pre-update
  // snapshot, so the caller sees each timer as it was when it fired.
  return q<FollowUp>(
    `with due as (
       select id, until_at, case when coalesce(repeat_ms, 0) > 0 then greatest(now(), due) + (repeat_ms::text || ' milliseconds')::interval end as next
         from followups where due <= now() order by due limit $1 for update skip locked
     ),
     armed as (
       update followups f set due = d.next, fired = f.fired + 1 from due d
        where f.id = d.id and d.next is not null and (d.until_at is null or d.next <= d.until_at) returning f.id
     ),
     gone as (
       delete from followups f using due d
        where f.id = d.id and (d.next is null or (d.until_at is not null and d.next > d.until_at)) returning f.id
     )
     select f.* from followups f join due d on d.id = f.id order by f.due`,
    [limit],
  );
}
