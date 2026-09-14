import type { VercelRequest, VercelResponse } from "@vercel/node";
import { requireTenant } from "../../lib/auth.js";
import { currentChatSession, startChatSession } from "../../lib/chat.js";
import { sendUserMessage, UsageCapError } from "../../lib/anthropic.js";
import { resolvePending } from "../../lib/tools.js";
import { isApprovalReply } from "../../lib/policy.js";
import { appendTranscript, stampMessage } from "../../lib/transcript.js";

/** POST { text } -> { session_id, action }. Sends into the tenant's live chat session (or starts one). */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "POST") return res.status(405).end();
  const t = await requireTenant(req, res);
  if (!t) return;
  const text = String((req.body as { text?: unknown })?.text ?? "").trim();
  if (!text) return res.status(400).json({ error: "text required" });

  try {
    let session = await currentChatSession(t);
    let action: string;
    if (!session) {
      session = await startChatSession(t, text);
      action = "started";
    } else if (session.pending_kind === "checkpoint" || session.pending_kind === "send_email") {
      await resolvePending(t, session, text, isApprovalReply(text));
      action = `${session.pending_kind}_resolved`;
    } else if (session.pending_kind === "ask_user") {
      await resolvePending(t, session, text, null);
      action = "question_answered";
    } else {
      await sendUserMessage(session.id, stampMessage(t, text, "chat"));
      action = "sent";
    }
    await appendTranscript(t, { channel: "chat", role: "user", text }).catch(() => {});
    return res.status(200).json({ session_id: session.id, action });
  } catch (err) {
    if (err instanceof UsageCapError) return res.status(402).json({ error: err.message });
    throw err;
  }
}
