import type { VercelRequest, VercelResponse } from "@vercel/node";
import { chatAuthorized } from "../../lib/chat-auth.js";
import { currentChatSession, recentNotices, toChatItems } from "../../lib/chat.js";
import { listAllEvents, meta } from "../../lib/anthropic.js";

/** GET -> { session_id, status, pending, items[] } for the current chat session. */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (!chatAuthorized(req)) return res.status(401).json({ error: "unauthorized" });
  const [session, notices] = await Promise.all([currentChatSession(), recentNotices().catch(() => [])]);
  const items = session ? toChatItems(await listAllEvents(session.id)) : [];
  // Merge heads-ups into the timeline by time; keep only ones newer than the chat's first message so
  // old notices do not pile up above every conversation.
  const floor = items.length ? new Date(items[0].at).getTime() - 24 * 3_600_000 : Date.now() - 7 * 86_400_000;
  const merged = [...items, ...notices.filter((n) => new Date(n.at).getTime() > floor)].sort((a, b) => new Date(a.at).getTime() - new Date(b.at).getTime());
  return res.status(200).json({
    session_id: session?.id ?? null,
    status: session?.status ?? "none",
    pending: session ? meta(session).pending_kind ?? null : null,
    items: merged,
  });
}
