import type { VercelRequest, VercelResponse } from "@vercel/node";
import { requireTenant } from "../../lib/auth.js";
import { stats } from "../../lib/daily.js";

/** GET: the scoreboard. Tasks done, money back, hours saved; this month and all time; latest wins. */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "GET") return res.status(405).end();
  const t = await requireTenant(req, res);
  if (!t) return;
  const s = await stats(t);
  const usd = (c: number) => Math.round(c) / 100;
  return res.status(200).json({
    month: { tasks_done: s.month.tasks_done, wins: s.month.wins, saved_usd: usd(s.month.saved_cents), minutes_saved: s.month.minutes_saved },
    all_time: { tasks_done: s.all_time.tasks_done, saved_usd: usd(s.all_time.saved_cents), minutes_saved: s.all_time.minutes_saved },
    recent_wins: s.recent_wins.map((w) => ({ kind: w.kind, amount_usd: usd(Number(w.amount_cents)), minutes: w.minutes, label: w.label, at: w.created_at })),
  });
}
