import type { VercelRequest, VercelResponse } from "@vercel/node";
import { chatAuthorized } from "../../lib/chat-auth.js";
import { anthropic } from "../../lib/anthropic.js";
import { toChatItems } from "../../lib/chat.js";

const MAX_MS = 280_000; // stay under the function's max duration; the client reconnects

/**
 * GET ?session=sesn_... -> Server-Sent Events. Forwards the session's live events, including
 * token-by-token previews of the agent's reply, in the ChatItem shape the UI already renders.
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (!chatAuthorized(req)) return res.status(401).json({ error: "unauthorized" });
  const sessionId = typeof req.query.session === "string" ? req.query.session : "";
  if (!sessionId) return res.status(400).json({ error: "session required" });

  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  const send = (data: unknown) => res.write(`data: ${JSON.stringify(data)}\n\n`);
  send({ kind: "hello", session_id: sessionId });

  const stream = await anthropic().beta.sessions.events.stream(sessionId, { event_deltas: ["agent.message"] });
  const timer = setTimeout(() => stream.controller.abort(), MAX_MS);
  const heartbeat = setInterval(() => res.write(": ping\n\n"), 15_000);
  req.on("close", () => stream.controller.abort());

  try {
    for await (const ev of stream) {
      if (ev.type === "event_delta") {
        if (ev.delta.type === "content_delta") send({ kind: "delta", id: ev.event_id, text: ev.delta.content.text });
        continue;
      }
      if (ev.type === "event_start") continue;
      if (ev.type === "user.custom_tool_result") {
        send({ kind: "tool_resolved", id: ev.custom_tool_use_id });
        continue;
      }
      for (const item of toChatItems([ev])) send(item);
      if (ev.type === "session.status_terminated") break;
    }
  } catch {
    /* aborted or dropped: the client reconnects and refetches history */
  } finally {
    clearTimeout(timer);
    clearInterval(heartbeat);
    send({ kind: "bye" });
    res.end();
  }
}
