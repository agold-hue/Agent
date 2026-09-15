import type { VercelRequest, VercelResponse } from "@vercel/node";
import { requireTenant } from "../../../lib/auth.js";
import { chatHistory, currentChatSession, recentNotices } from "../../../lib/chat.js";

/** GET -> { session_id, status, pending, items[] }. The page polls this while the agent is running. */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  const t = await requireTenant(req, res);
  if (!t) return;
  const session = await currentChatSession(t);
  const [items, notices] = await Promise.all([chatHistory(t, session), recentNotices(t, 30).catch(() => [])]);
  const floor = Date.now() - 7 * 86_400_000;
  // Notices (reminders, briefs, heads-ups) slot into the timeline by time, so the page reads as one conversation.
  const merged = [...items, ...notices.filter((n) => new Date(n.at).getTime() > floor)].sort((a, b) => (a.kind === "status" ? 1 : b.kind === "status" ? -1 : new Date(a.at).getTime() - new Date(b.at).getTime()));
  res.setHeader("Cache-Control", "no-store");
  return res.status(200).json({ session_id: session?.id ?? null, status: session?.status ?? "none", pending: session?.pending_kind ?? null, items: merged });
}
