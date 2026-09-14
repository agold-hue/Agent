import type { VercelRequest, VercelResponse } from "@vercel/node";
import { chatAuthorized } from "../../lib/chat-auth.js";
import { currentChatSession, toChatItems } from "../../lib/chat.js";
import { listAllEvents, meta } from "../../lib/anthropic.js";

/** GET -> { session_id, status, pending, items[] } for the current chat session. */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (!chatAuthorized(req)) return res.status(401).json({ error: "unauthorized" });
  const session = await currentChatSession();
  if (!session) return res.status(200).json({ session_id: null, status: "none", pending: null, items: [] });
  const events = await listAllEvents(session.id);
  return res.status(200).json({
    session_id: session.id,
    status: session.status,
    pending: meta(session).pending_kind ?? null,
    items: toChatItems(events),
  });
}
