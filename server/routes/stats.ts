import type { VercelRequest, VercelResponse } from "@vercel/node";
import { requireTenant } from "../../lib/auth.js";
import { stats } from "../../lib/daily.js";
import { latestEvalSummary } from "../../lib/search-eval.js";

/** GET: the scoreboard. Tasks done, money back, hours saved; this month and all time; latest wins. */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "GET") return res.status(405).end();
  const t = await requireTenant(req, res);
  if (!t) return;
  const s = await stats(t);
  // Service-level: how the search pipeline did on its last golden-set run (answer rate, cost per success).
  const search = await latestEvalSummary();
  const usd = (c: number) => Math.round(c) / 100;
  return res.status(200).json({
    month: { tasks_done: s.month.tasks_done, wins: s.month.wins, saved_usd: usd(s.month.saved_cents), minutes_saved: s.month.minutes_saved },
    all_time: { tasks_done: s.all_time.tasks_done, saved_usd: usd(s.all_time.saved_cents), minutes_saved: s.all_time.minutes_saved },
    recent_wins: s.recent_wins.map((w) => ({ kind: w.kind, amount_usd: usd(Number(w.amount_cents)), minutes: w.minutes, label: w.label, at: w.created_at })),
    search_eval: search ? { run: search.run_id, at: search.at, answered: search.ok, total: search.total, rate: Math.round(search.rate * 100) / 100, median_ms: search.median_ms, pages_per_question: search.pages_per_question, cost_per_success_usd: Math.round(search.cost_per_success_cents * 1000) / 100000 } : null,
  });
}
