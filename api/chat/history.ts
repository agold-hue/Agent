import type { VercelRequest, VercelResponse } from "@vercel/node";
import { requireTenant } from "../../lib/auth.js";
import { currentChatSession, recentNotices, toChatItems } from "../../lib/chat.js";
import { listAllEvents } from "../../lib/anthropic.js";

/** GET -> { session_id, status, pending, items[] } for the tenant's current chat session plus recent heads-ups. */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  const t = await requireTenant(req, res);
  if (!t) return;
  const [session, notices] = await Promise.all([currentChatSession(t), recentNotices(t).catch(() => [])]);
  const items = session ? toChatItems(await listAllEvents(session.id)) : [];
  const floor = items.length ? new Date(items[0].at).getTime() - 24 * 3_600_000 : Date.now() - 7 * 86_400_000;
  const merged = [...items, ...notices.filter((n) => new Date(n.at).getTime() > floor)].sort((a, b) => new Date(a.at).getTime() - new Date(b.at).getTime());
  return res.status(200).json({
    session_id: session?.id ?? null,
    status: session?.status ?? "none",
    pending: session?.pending_kind ?? null,
    items: merged,
  });
}
