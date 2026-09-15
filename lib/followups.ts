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
  const due = await q<FollowUp>("select * from followups where due <= now() order by due limit $1", [limit]);
  for (const f of due) {
    const step = f.repeat_ms ? Number(f.repeat_ms) : 0;
    const next = step > 0 ? new Date(Math.max(Date.now(), new Date(f.due).getTime()) + step) : null;
    if (next && (!f.until_at || next.getTime() <= new Date(f.until_at).getTime())) {
      await q("update followups set due = $2, fired = fired + 1 where id = $1", [f.id, next]);
    } else {
      await q("delete from followups where id = $1", [f.id]);
    }
  }
  return due;
}
