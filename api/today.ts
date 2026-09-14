import type { VercelRequest, VercelResponse } from "@vercel/node";
import { requireTenant } from "../lib/auth.js";
import { listItems } from "../lib/daily.js";
import { listFollowUps } from "../lib/followups.js";
import { runCalendar } from "../lib/google.js";
import { localClock } from "../lib/transcript.js";

/**
 * GET ?days=N (default 3): the "what's today" screen. Tracked items due within N days (bills, packages,
 * appointments, reservations, school, reminders), everything overdue, the agent's own upcoming timers,
 * and the customer's real calendar for the same window when Google is connected.
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "GET") return res.status(405).end();
  const t = await requireTenant(req, res);
  if (!t) return;
  const days = Math.max(0, Math.min(Number(req.query.days ?? 3) || 3, 30));
  const now = new Date();
  const until = new Date(now.getTime() + (days + 1) * 86_400_000);

  const items = await listItems(t, { status: "open", dueBefore: until, limit: 200 });
  const undated = await listItems(t, { status: "open", limit: 100 });
  const followups = (await listFollowUps(t.id)).filter((f) => new Date(f.due).getTime() <= until.getTime()).slice(0, 30);
  let calendar: unknown[] = [];
  let calendar_error: string | undefined;
  if (t.googleRefreshToken) {
    try {
      calendar = (await runCalendar(t, { action: "list", from: now.toISOString(), to: until.toISOString() })) as unknown[];
    } catch (e) {
      calendar_error = (e as Error).message;
    }
  }
  return res.status(200).json({
    now: now.toISOString(),
    local: localClock(t.timezone),
    timezone: t.timezone,
    days,
    items: items.map(row),
    undated: undated.filter((i) => !i.due_at).map(row),
    followups: followups.map((f) => ({ id: f.id, due: f.due, what: f.what, project: f.project, recurring: !!f.repeat_ms })),
    calendar,
    calendar_error,
    google_connected: !!t.googleRefreshToken,
  });
}

function row(i: Awaited<ReturnType<typeof listItems>>[number]) {
  return {
    id: i.id,
    kind: i.kind,
    title: i.title,
    due_at: i.due_at,
    status: i.status,
    amount_usd: i.amount_cents != null ? Number(i.amount_cents) / 100 : null,
    details: i.details ?? {},
    overdue: !!i.due_at && new Date(i.due_at).getTime() < Date.now(),
  };
}
