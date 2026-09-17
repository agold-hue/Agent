import type { VercelRequest, VercelResponse } from "@vercel/node";
import { requireTenant } from "../../../lib/auth.js";
import { activityOf, chatHistory, currentChatSession, recentNotices, taskStrip, threadReplies } from "../../../lib/chat.js";
import { liveViewIfRunning } from "../../../lib/browser.js";
import { env } from "../../../lib/env.js";
import { one } from "../../../lib/db.js";
import { activeAsideSessions } from "../../../lib/sessions.js";
import { quickReplies } from "../../../lib/proactive.js";
import { kick } from "../../../lib/runtime.js";
import type { Tenant } from "../../../lib/tenant.js";

const STALL_KICK_MS = Number(process.env.STALL_KICK_MS ?? 4000);

/**
 * A cheap fingerprint of everything the page shows: nothing changed means a tiny reply (or no event).
 * The last field is whether a reply is being written (the page shows typing dots for it), not how
 * much of it: the draft grows every 700 ms, and each growth used to rebuild and push the whole week
 * of sessions for a page that never renders the draft text.
 */
export async function historyVersion(t: Tenant): Promise<string> {
  const fp = await one<{ v: string }>("select coalesce(max(updated_at)::text, '') || ':' || count(*)::text || ':' || coalesce(sum(case when status in ('running','waiting') then 1 else 0 end), 0)::text || ':' || coalesce(sum(case when status = 'running' and coalesce(draft, '') <> '' then 1 else 0 end), 0)::text as v from agent_sessions where user_id = $1", [t.id]);
  return fp?.v ?? "";
}

/** Everything the chat page renders, in one object; the poll and the stream both send it. */
export async function historyPayload(t: Tenant, version: string): Promise<Record<string, unknown>> {
  const session = await currentChatSession(t);
  // A run that never started (the worker kick did not land) used to wait for the cron sweep, up to a
  // minute. The page polls every second or two while a reply is due: a running session with no lease
  // and nothing written for a few seconds is kicked again from here. Duplicates are harmless (the
  // lease makes a second worker return "busy" at once). Awaited, so the kick is delivered before this
  // function returns; it costs this one poll at most a second.
  if (session?.status === "running" && !session.lease_until && Date.now() - new Date(session.updated_at).getTime() > STALL_KICK_MS) await kick(session.id).catch(() => {});
  // While the agent works in the browser (or waits for a code), the user can watch or take over.
  const wantsLive = !!session?.browserbase_session_id && (session.status === "running" || session.status === "waiting") && env.browserbase.configured();
  // A week of sessions, not a month: every session's full message array is loaded to render the
  // timeline, and a month of them took seconds per poll. Older history is in the conversation files.
  const [items, notices, liveView, tasks, asides] = await Promise.all([chatHistory(t, session, Number(process.env.HISTORY_DAYS ?? 7)), recentNotices(t, 20).catch(() => []), wantsLive ? liveViewIfRunning(session!.browserbase_session_id!) : Promise.resolve(null), taskStrip(t), activeAsideSessions(t.id).catch(() => [])]);
  // The reply being written right now: the thread's, or a side reply's (a question answered while the thread works).
  const draft = (session?.status === "running" ? session.draft : null) || asides.find((a) => a.draft)?.draft || null;
  const floor = Date.now() - 7 * 86_400_000;
  // Notices (reminders, briefs, heads-ups) slot into the timeline by time, so the page reads as one
  // conversation; then every reply that is not right under its request gets a quote of it.
  const merged = threadReplies([...items, ...notices.filter((n) => new Date(n.at).getTime() > floor)].sort((a, b) => (a.kind === "status" ? 1 : b.kind === "status" ? -1 : new Date(a.at).getTime() - new Date(b.at).getTime())));
  const lastAgent = [...items].reverse().find((i) => i.kind === "agent") as { text?: string } | undefined;
  // The chips the model wrote for this reply once it was on the page; the shape-based ones until then.
  const written = session?.status === "idle" && !session.pending_kind && Array.isArray(session.chips) ? session.chips : null;
  const chips = written ?? quickReplies(lastAgent?.text ?? "", session?.status ?? "none", session?.pending_kind ?? null);
  return { chips, version, session_id: session?.id ?? null, status: session?.status ?? "none", pending: session?.pending_kind ?? null, activity: activityOf(session), draft, live_view_url: liveView, tasks, items: merged };
}

/** GET -> { session_id, status, pending, items[] }. The page polls this while the agent is running (the stream is the fast path). */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  const t = await requireTenant(req, res);
  if (!t) return;
  const version = await historyVersion(t);
  res.setHeader("Cache-Control", "no-store");
  if (typeof req.query.v === "string" && req.query.v === version) return res.status(200).json({ unchanged: true, version });
  return res.status(200).json(await historyPayload(t, version));
}
