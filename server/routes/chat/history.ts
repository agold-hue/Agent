import type { VercelRequest, VercelResponse } from "@vercel/node";
import { requireTenant } from "../../../lib/auth.js";
import { currentChatSession, recentNotices, toChatItems } from "../../../lib/chat.js";

/** GET -> { session_id, status, pending, items[] }. The page polls this while the agent is running. */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  const t = await requireTenant(req, res);
  if (!t) return;
  const [session, notices] = await Promise.all([currentChatSession(t), recentNotices(t).catch(() => [])]);
  const items = session ? toChatItems(session) : [];
  const floor = session ? new Date(session.created_at).getTime() - 24 * 3_600_000 : Date.now() - 7 * 86_400_000;
  const merged = [...notices.filter((n) => new Date(n.at).getTime() > floor), ...items];
  res.setHeader("Cache-Control", "no-store");
  return res.status(200).json({ session_id: session?.id ?? null, status: session?.status ?? "none", pending: session?.pending_kind ?? null, items: merged });
}
