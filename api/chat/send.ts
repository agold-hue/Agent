import type { VercelRequest, VercelResponse } from "@vercel/node";
import { chatAuthorized } from "../../lib/chat-auth.js";
import { currentChatSession, startChatSession } from "../../lib/chat.js";
import { meta, sendUserMessage } from "../../lib/anthropic.js";
import { resolvePending } from "../../lib/tools.js";
import { isApprovalReply } from "../../lib/policy.js";
import { appendTranscript, stampMessage } from "../../lib/transcript.js";

/** POST { text } -> { session_id, action }. Sends into the live chat session (or starts one). */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "POST") return res.status(405).end();
  if (!chatAuthorized(req)) return res.status(401).json({ error: "unauthorized" });
  const text = String((req.body as { text?: unknown })?.text ?? "").trim();
  if (!text) return res.status(400).json({ error: "text required" });

  let session = await currentChatSession();
  let action: string;
  if (!session) {
    session = await startChatSession(text);
    action = "started";
  } else {
    const m = meta(session);
    if (m.pending_kind === "checkpoint") {
      await resolvePending(session, text, isApprovalReply(text));
      action = "checkpoint_resolved";
    } else if (m.pending_kind === "ask_user") {
      await resolvePending(session, text, null);
      action = "question_answered";
    } else {
      await sendUserMessage(session.id, stampMessage(text, "chat"));
      action = "sent";
    }
  }
  // Durable log: the agent can grep this later ("what did I say about Florida?").
  await appendTranscript({ channel: "chat", role: "user", text }).catch(() => {});
  return res.status(200).json({ session_id: session.id, action });
}
