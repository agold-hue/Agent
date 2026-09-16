import type { VercelRequest, VercelResponse } from "@vercel/node";
import { requireTenant } from "../../../lib/auth.js";
import { activityOf, chatHistory, currentChatSession, recentNotices, taskStrip } from "../../../lib/chat.js";
import { liveViewIfRunning } from "../../../lib/browser.js";
import { env } from "../../../lib/env.js";
import { one } from "../../../lib/db.js";

/** GET -> { session_id, status, pending, items[] }. The page polls this while the agent is running. */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  const t = await requireTenant(req, res);
  if (!t) return;
  // Cheap poll: the page sends the fingerprint it last saw; nothing changed means a tiny reply.
  const fp = await one<{ v: string }>("select coalesce(max(updated_at)::text, '') || ':' || count(*)::text || ':' || coalesce(sum(case when status in ('running','waiting') then 1 else 0 end), 0)::text || ':' || coalesce(sum(length(draft)), 0)::text as v from agent_sessions where user_id = $1", [t.id]);
  const version = fp?.v ?? "";
  if (typeof req.query.v === "string" && req.query.v === version) {
    res.setHeader("Cache-Control", "no-store");
    return res.status(200).json({ unchanged: true, version });
  }
  const session = await currentChatSession(t);
  // While the agent works in the browser (or waits for a code), the user can watch or take over.
  const wantsLive = !!session?.browserbase_session_id && (session.status === "running" || session.status === "waiting") && env.browserbase.configured();
  const [items, notices, liveView, tasks] = await Promise.all([chatHistory(t, session), recentNotices(t, 30).catch(() => []), wantsLive ? liveViewIfRunning(session!.browserbase_session_id!) : Promise.resolve(null), taskStrip(t)]);
  const floor = Date.now() - 7 * 86_400_000;
  // Notices (reminders, briefs, heads-ups) slot into the timeline by time, so the page reads as one conversation.
  const merged = [...items, ...notices.filter((n) => new Date(n.at).getTime() > floor)].sort((a, b) => (a.kind === "status" ? 1 : b.kind === "status" ? -1 : new Date(a.at).getTime() - new Date(b.at).getTime()));
  res.setHeader("Cache-Control", "no-store");
  return res.status(200).json({ version, session_id: session?.id ?? null, status: session?.status ?? "none", pending: session?.pending_kind ?? null, activity: activityOf(session), draft: session?.status === "running" ? session.draft ?? null : null, live_view_url: liveView, tasks, items: merged });
}
