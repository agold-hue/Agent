import type { VercelRequest, VercelResponse } from "@vercel/node";
import { requireTenant } from "../../../lib/auth.js";
import { activityOf, chatHistory, currentChatSession, recentNotices, taskStrip } from "../../../lib/chat.js";
import { liveViewIfRunning } from "../../../lib/browser.js";
import { env } from "../../../lib/env.js";
import { one } from "../../../lib/db.js";
import { quickReplies } from "../../../lib/proactive.js";
import { kick } from "../../../lib/runtime.js";

const STALL_KICK_MS = Number(process.env.STALL_KICK_MS ?? 4000);

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
  // A run that never started (the worker kick did not land) used to wait for the cron sweep, up to a
  // minute. The page polls every second or two while a reply is due: a running session with no lease
  // and nothing written for a few seconds is kicked again from here. Duplicates are harmless (the
  // lease makes a second worker return "busy" at once). Awaited, so the kick is delivered before this
  // function returns; it costs this one poll at most a second.
  if (session?.status === "running" && !session.lease_until && Date.now() - new Date(session.updated_at).getTime() > STALL_KICK_MS) await kick(session.id).catch(() => {});
  // While the agent works in the browser (or waits for a code), the user can watch or take over.
  const wantsLive = !!session?.browserbase_session_id && (session.status === "running" || session.status === "waiting") && env.browserbase.configured();
  const [items, notices, liveView, tasks] = await Promise.all([chatHistory(t, session), recentNotices(t, 30).catch(() => []), wantsLive ? liveViewIfRunning(session!.browserbase_session_id!) : Promise.resolve(null), taskStrip(t)]);
  const floor = Date.now() - 7 * 86_400_000;
  // Notices (reminders, briefs, heads-ups) slot into the timeline by time, so the page reads as one conversation.
  const merged = [...items, ...notices.filter((n) => new Date(n.at).getTime() > floor)].sort((a, b) => (a.kind === "status" ? 1 : b.kind === "status" ? -1 : new Date(a.at).getTime() - new Date(b.at).getTime()));
  res.setHeader("Cache-Control", "no-store");
  const lastAgent = [...items].reverse().find((i) => i.kind === "agent") as { text?: string } | undefined;
  // The chips the model wrote for this reply once it was on the page; the shape-based ones until then.
  const written = session?.status === "idle" && !session.pending_kind && Array.isArray(session.chips) ? session.chips : null;
  const chips = written ?? quickReplies(lastAgent?.text ?? "", session?.status ?? "none", session?.pending_kind ?? null);
  return res.status(200).json({ chips, version, session_id: session?.id ?? null, status: session?.status ?? "none", pending: session?.pending_kind ?? null, activity: activityOf(session), draft: session?.status === "running" ? session.draft ?? null : null, live_view_url: liveView, tasks, items: merged });
}
